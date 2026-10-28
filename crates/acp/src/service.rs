use crate::adapter::{map::config_options_value, Adapter, AgentKind, ConfigRoute, McpCaps};
use crate::{
    AgentCommand, AgentEvent, AgentFeatures, AgentHint, AuthCredential, AuthInput, AuthMethodInfo,
    PermissionOption, PromptAttachment, SessionSummary,
};
use agent_client_protocol::schema::{v1::*, ProtocolVersion};
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo, UntypedMessage};
use serde_json::{json, Value};
use span_core::CoreWorkspace;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot, watch};

pub type EventSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;
type Reply<T> = oneshot::Sender<Result<T, String>>;

#[derive(Clone)]
pub struct AgentService {
    tx: mpsc::UnboundedSender<Command>,
    state: Arc<Mutex<Bridge>>,
    workspace: Arc<Mutex<CoreWorkspace>>,
    completion: watch::Receiver<bool>,
}

enum Command {
    NewSession(Vec<Value>, Reply<String>),
    Prompt(String, Vec<ContentBlock>, Reply<()>),
    Authenticate(String, Option<Meta>, Reply<()>),
    Cancel(String),
    SetConfig(String, String, String, Reply<()>),
    ListSessions(Reply<Vec<SessionSummary>>),
    LoadSession(String, Vec<Value>, Reply<()>),
    CloseSession(String, Reply<()>),
    DeleteSession(String, Reply<()>),
    Shutdown,
}
struct Permission {
    session: String,
    scope: String,
    options: Vec<agent_client_protocol::schema::v1::PermissionOption>,
    reply: oneshot::Sender<Option<String>>,
}
struct Elicitation {
    session: Option<String>,
    mode: String,
    schema: Option<Value>,
    reply: oneshot::Sender<ElicitationAction>,
}
struct Proposal {
    session: String,
    path: String,
    hunk_ids: Vec<String>,
    reply: oneshot::Sender<ReviewDecision>,
}
#[derive(Default)]
struct ReviewDecision {
    applied: bool,
    complete: bool,
}
#[derive(Default)]
struct Bridge {
    sequence: u64,
    closed: bool,
    sessions: HashSet<String>,
    running: HashSet<String>,
    cancelled: HashSet<String>,
    /// Sessions Span started for a lead. A Stop that one of these ignores
    /// ends only its turn; an ignored Stop on any other session ends the
    /// connection.
    delegated: HashSet<String>,
    /// Ends the turn of a running session whose Stop was ignored.
    abandon: HashMap<String, oneshot::Sender<()>>,
    permissions: HashMap<String, Permission>,
    proposals: HashMap<String, Proposal>,
    remembered: HashMap<(String, String), PermissionOptionKind>,
    revisions: HashMap<(String, String), u64>,
    elicitations: HashMap<String, Elicitation>,
    prompt_image: bool,
    prompt_embedded: bool,
    can_close: bool,
    can_delete: bool,
    auth_methods: Vec<AuthMethodInfo>,
    auth_required: bool,
    /// Normalises this agent's quirks; generic until `initialize` names the agent.
    adapter: Arc<Adapter>,
    mcp_caps: McpCaps,
    /// Sessions whose replay may still be streaming, with the last update time.
    replaying: HashMap<String, tokio::time::Instant>,
}

/// Send a request whose response is needed as raw JSON: legacy `modes` and
/// `models`, prompt `usage` and unstable methods are not in the pinned schema.
async fn raw_request(
    cx: &ConnectionTo<Agent>,
    method: &str,
    params: Value,
) -> agent_client_protocol::Result<Value> {
    cx.send_request(UntypedMessage::new(method, params)?)
        .block_task()
        .await
}

const REDACTED: &str = "[redacted]";
/// Methods whose `params.mcpServers` may carry credentials.
const MCP_SERVER_METHODS: &[&str] = &["session/new", "session/load", "session/resume"];

/// Debug lines go to the UI log. Secrets never do: `authenticate` `_meta`,
/// and the header values (HTTP, SSE) and environment values (stdio) of
/// every MCP server offered in `session/new`, `session/load` and
/// `session/resume`, such as the span-agents bearer token. A line that
/// mentions one of these methods but does not parse is dropped whole.
fn redact_log(line: &str) -> String {
    let sensitive = line.contains("authenticate")
        || line.contains("mcpServers")
        || MCP_SERVER_METHODS.iter().any(|m| line.contains(m));
    if !sensitive {
        return line.chars().take(16_384).collect();
    }
    let Ok(mut message) = serde_json::from_str::<Value>(line) else {
        return "[message redacted]".into();
    };
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if method.as_deref() == Some("authenticate") {
        if let Some(meta) = message.pointer_mut("/params/_meta") {
            *meta = json!(REDACTED);
        }
    }
    // Redact any `mcpServers` list wherever it appears in params, whatever
    // the method, so an unexpected shape cannot carry a secret through.
    if let Some(servers) = message
        .pointer_mut("/params/mcpServers")
        .and_then(Value::as_array_mut)
    {
        for server in servers {
            redact_mcp_server(server);
        }
    }
    // Secrets are gone at this point, so truncation is safe.
    message.to_string().chars().take(16_384).collect()
}

/// Replace every header and environment value of one ACP `McpServer`.
fn redact_mcp_server(server: &mut Value) {
    for key in ["headers", "env"] {
        match server.get_mut(key) {
            Some(Value::Array(entries)) => {
                for entry in entries {
                    match entry.as_object_mut() {
                        Some(pair) => {
                            if let Some(value) = pair.get_mut("value") {
                                *value = json!(REDACTED);
                            }
                        }
                        None => *entry = json!(REDACTED),
                    }
                }
            }
            Some(Value::Object(map)) => {
                for value in map.values_mut() {
                    *value = json!(REDACTED);
                }
            }
            Some(Value::Null) | None => {}
            Some(other) => *other = json!(REDACTED),
        }
    }
    // A URL may embed credentials (userinfo or a query string token).
    if let Some(url) = server.get_mut("url") {
        if let Some(text) = url.as_str() {
            if text.contains('@') || text.contains('?') {
                *url = json!(REDACTED);
            }
        }
    }
}

fn spoken_seconds(duration: std::time::Duration) -> String {
    match duration.as_secs() {
        5 => "five seconds".into(),
        8 => "eight seconds".into(),
        n => format!("{n} seconds"),
    }
}

/// Largest base64 payload accepted for an image or blob attachment.
const MAX_ATTACHMENT_BASE64: usize = 20 * 1024 * 1024;

impl AgentService {
    pub async fn start(
        config: AgentCommand,
        cwd: String,
        workspace: Arc<Mutex<CoreWorkspace>>,
        emit: EventSink,
    ) -> Result<Self, String> {
        if config.command.trim().is_empty() {
            return Err("Agent executable is required".into());
        }
        let original = config.clone();
        let config = crate::launch::prepare_command(config)?;
        let _mutation = crate::managed::mutation_guard().await;
        let active_launch = crate::managed::register_launch(&config)?;
        let cwd = std::fs::canonicalize(cwd).map_err(|e| format!("Agent workspace: {e}"))?;
        let workspace_root = workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned")?
            .workspace()
            .root;
        if cwd != std::path::Path::new(&workspace_root) {
            return Err("Agent cwd must match the open workspace".into());
        }
        let state = Arc::new(Mutex::new(Bridge::default()));
        let (tx, rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(false);
        let shared = state.clone();
        let service_workspace = workspace.clone();
        std::thread::Builder::new()
            .name("span-acp".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                match runtime {
                    Ok(runtime) => runtime.block_on(async move {
                        let result = run(
                            config,
                            original,
                            cwd,
                            workspace.clone(),
                            shared.clone(),
                            emit.clone(),
                            rx,
                            ready_tx,
                        )
                        .await;
                        cancel_pending(&shared, &workspace, &emit, None);
                        if let Err(error) = result {
                            emit(AgentEvent::Error {
                                session_id: None,
                                message: error.to_string(),
                            });
                        }
                        emit(AgentEvent::Status {
                            state: "disconnected".into(),
                            message: "Agent process disconnected".into(),
                        });
                    }),
                    Err(error) => {
                        let _ = ready_tx.send(Err(format!("ACP runtime: {error}")));
                    }
                }
                drop(active_launch);
                let _ = completion_tx.send(true);
            })
            .map_err(|e| format!("Start agent thread: {e}"))?;
        tokio::time::timeout(std::time::Duration::from_secs(45), ready_rx)
            .await
            .map_err(|_| "Agent initialization timed out after 45 seconds".to_string())?
            .map_err(|_| "Agent exited before initialization completed".to_string())??;
        Ok(Self {
            tx,
            state,
            workspace: service_workspace,
            completion: completion_rx,
        })
    }

    /// Connection identity guards desktop mutations after an asynchronous request finishes.
    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }

    /// Create a session with no MCP servers.
    pub async fn new_session(&self) -> Result<String, String> {
        self.new_session_with(Vec::new()).await
    }
    /// Create a session offering `mcp_servers` (ACP `McpServer` JSON) in this
    /// one `session/new` only. Nothing is kept on the connection, so later
    /// sessions on the same agent process (other user sessions, delegated
    /// children) never receive these entries or their credentials. The
    /// request carries only the servers whose transport the agent
    /// advertised, after agent specific rules.
    pub async fn new_session_with(&self, mcp_servers: Vec<Value>) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::NewSession(mcp_servers, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Send a prompt. Slash commands are ordinary text such as `/web query`.
    /// Image and embedded resource attachments are rejected unless the agent advertised them.
    pub async fn prompt(
        &self,
        session_id: String,
        text: String,
        attachments: Vec<PromptAttachment>,
    ) -> Result<(), String> {
        self.start_prompt(session_id, text, attachments)?
            .await
            .map_err(|_| "Agent disconnected".to_string())?
    }
    /// The synchronous half of [`Self::prompt`]: the prompt command is in the
    /// service's queue when this returns, so a `cancel` issued afterwards is
    /// processed after it. The receiver resolves when the turn ends.
    pub fn start_prompt(
        &self,
        session_id: String,
        text: String,
        attachments: Vec<PromptAttachment>,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        if text.trim().is_empty() && attachments.is_empty() {
            return Err("Prompt cannot be empty".into());
        }
        let (image, embedded) = {
            let bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
            (bridge.prompt_image, bridge.prompt_embedded)
        };
        let blocks = prompt_blocks(text, attachments, image, embedded)?;
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Prompt(session_id, blocks, tx))
            .map_err(|_| "Agent disconnected")?;
        Ok(rx)
    }
    /// Call `authenticate` with an advertised `agent` method. Create the session afterwards.
    pub async fn authenticate(&self, method_id: String) -> Result<(), String> {
        self.check_auth_method(&method_id, None)?;
        self.send_authenticate(method_id, None).await
    }
    /// Call `authenticate` for a method that needs a value from the user (an
    /// API key or a gateway). The secret goes to the agent in `_meta` only:
    /// it is redacted from the protocol log and not kept after the call.
    pub async fn authenticate_with(
        &self,
        method_id: String,
        credential: AuthCredential,
    ) -> Result<(), String> {
        let meta = match credential {
            AuthCredential::ApiKey { key } => {
                self.check_auth_method(&method_id, Some(AuthInput::ApiKey))?;
                if key.trim().is_empty() {
                    return Err("API key is required".into());
                }
                json!({ "api-key": key })
            }
            AuthCredential::Gateway { base_url, headers } => {
                self.check_auth_method(&method_id, Some(AuthInput::Gateway))?;
                let lower = base_url.to_ascii_lowercase();
                if !lower.starts_with("https://") && !lower.starts_with("http://") {
                    return Err("Gateway URL must start with https:// or http://".into());
                }
                json!({ "gateway": { "baseUrl": base_url, "headers": headers } })
            }
        };
        let meta = meta.as_object().cloned();
        self.send_authenticate(method_id, meta).await
    }
    fn check_auth_method(&self, method_id: &str, input: Option<AuthInput>) -> Result<(), String> {
        let bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
        let method = bridge
            .auth_methods
            .iter()
            .find(|m| m.id == method_id)
            .ok_or("Unknown authentication method")?;
        if method.hint == Some(AgentHint::RunOpencodeAuthLogin) {
            return Err("Run `opencode auth login` in a terminal, then connect again".into());
        }
        if !method.supported {
            return Err("Terminal sign-in is not supported by this client".into());
        }
        match (method.input, input) {
            (None, None) => Ok(()),
            (Some(_), None) => Err("This sign-in method needs a key or gateway".into()),
            (expected, given) if expected == given => Ok(()),
            _ => Err("This sign-in method needs a different kind of credential".into()),
        }
    }
    async fn send_authenticate(&self, method_id: String, meta: Option<Meta>) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Authenticate(method_id, meta, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// True when the last session creation failed because the agent wants authentication.
    pub fn auth_required(&self) -> bool {
        self.state.lock().map(|b| b.auth_required).unwrap_or(false)
    }
    /// Answer an elicitation. `action` is `accept`, `decline` or `cancel`.
    /// `content_json` is a JSON object of field values and applies to `accept` only.
    pub fn respond_elicitation(
        &self,
        request_id: String,
        action: String,
        content_json: Option<String>,
    ) -> Result<(), String> {
        let mut bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
        let pending = bridge
            .elicitations
            .get(&request_id)
            .ok_or("Input request is no longer pending")?;
        let decision = match action.as_str() {
            "accept" => {
                let content = match content_json.as_deref().filter(|c| !c.trim().is_empty()) {
                    Some(json) => Some(elicitation_content(json, pending.schema.as_ref())?),
                    None if pending.mode == "form" => {
                        elicitation_content("{}", pending.schema.as_ref())?;
                        None
                    }
                    None => None,
                };
                ElicitationAction::Accept(ElicitationAcceptAction::new().content(content))
            }
            "decline" => ElicitationAction::Decline,
            "cancel" => ElicitationAction::Cancel,
            _ => return Err("Action must be accept, decline or cancel".into()),
        };
        let pending = bridge
            .elicitations
            .remove(&request_id)
            .ok_or("Input request is no longer pending")?;
        pending
            .reply
            .send(decision)
            .map_err(|_| "Input request expired".into())
    }
    pub async fn set_config(
        &self,
        session_id: String,
        config_id: String,
        value: String,
    ) -> Result<(), String> {
        {
            let bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
            if bridge.closed || !bridge.sessions.contains(&session_id) {
                return Err("Unknown or disconnected session".into());
            }
        }
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::SetConfig(session_id, config_id, value, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::ListSessions(tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Ask the agent to restore an earlier session. The agent replays the
    /// conversation as notifications before this resolves.
    pub async fn load_session(&self, session_id: String) -> Result<(), String> {
        self.load_session_with(session_id, Vec::new()).await
    }
    /// [`Self::load_session`] offering `mcp_servers` in this one
    /// `session/load`. ACP does not carry MCP servers across a load, so a
    /// restored session only has the servers passed here.
    pub async fn load_session_with(
        &self,
        session_id: String,
        mcp_servers: Vec<Value>,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::LoadSession(session_id, mcp_servers, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Close a session the agent is holding (`session/close`). Requires the
    /// `sessionCapabilities.close` capability. Pending permission and
    /// elicitation requests for the session are cancelled.
    pub async fn close_session(&self, session_id: String) -> Result<(), String> {
        {
            let bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
            if bridge.closed {
                return Err("Agent disconnected".into());
            }
            if !bridge.can_close {
                return Err("This agent cannot close sessions".into());
            }
            if !bridge.sessions.contains(&session_id) {
                return Err("Unknown session".into());
            }
        }
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::CloseSession(session_id, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Permanently delete a session from the agent's history
    /// (`session/delete`). Requires `sessionCapabilities.delete`. A prompt
    /// still running in that session is cancelled first.
    pub async fn delete_session(&self, session_id: String) -> Result<(), String> {
        {
            let bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
            if bridge.closed {
                return Err("Agent disconnected".into());
            }
            if !bridge.can_delete {
                return Err("This agent cannot delete sessions".into());
            }
        }
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::DeleteSession(session_id, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Mark a session as delegated (a child of another session). See
    /// `Bridge::delegated`.
    pub fn mark_delegated(&self, session_id: &str) {
        if let Ok(mut bridge) = self.state.lock() {
            bridge.delegated.insert(session_id.to_owned());
        }
    }
    pub fn cancel(&self, session_id: String) -> Result<(), String> {
        {
            let mut bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
            if bridge.closed || !bridge.sessions.contains(&session_id) {
                return Err("Unknown or disconnected session".into());
            }
            bridge.cancelled.insert(session_id.clone());
        }
        self.tx
            .send(Command::Cancel(session_id))
            .map_err(|_| "Agent disconnected".into())
    }
    pub fn shutdown(&self) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Agent state lock poisoned")?
            .closed = true;
        self.tx
            .send(Command::Shutdown)
            .map_err(|_| "Agent disconnected".into())
    }
    /// Explicit disconnect waits for all pending callbacks and the managed subprocess to close.
    pub async fn shutdown_and_wait(&self) -> Result<(), String> {
        let mut completion = self.completion.clone();
        if *completion.borrow() {
            return Ok(());
        }
        let _ = self.shutdown();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let finished = *completion.borrow();
                if finished {
                    return Ok(());
                }
                completion
                    .changed()
                    .await
                    .map_err(|_| "Agent completion state is unavailable".to_string())?;
            }
        })
        .await
        .map_err(|_| {
            "Agent is still closing. Wait before removing its managed files.".to_string()
        })?
    }
    pub fn respond_permission(
        &self,
        session_id: String,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let mut bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
        let permission = bridge
            .permissions
            .get(&request_id)
            .ok_or("Permission request is no longer pending")?;
        if permission.session != session_id {
            return Err("Permission belongs to a different session".into());
        }
        if bridge.closed || bridge.cancelled.contains(&session_id) {
            return Err("Session was cancelled".into());
        }
        let selected = match &option_id {
            Some(id) => Some(
                permission
                    .options
                    .iter()
                    .find(|o| o.option_id.to_string() == *id)
                    .ok_or("Unknown permission option")?
                    .kind,
            ),
            None => None,
        };
        let permission = bridge
            .permissions
            .remove(&request_id)
            .ok_or("Permission request is no longer pending")?;
        if matches!(
            selected,
            Some(PermissionOptionKind::AllowAlways | PermissionOptionKind::RejectAlways)
        ) {
            if let Some(kind) = selected {
                bridge
                    .remembered
                    .insert((session_id, permission.scope), kind);
            }
        }
        permission
            .reply
            .send(option_id)
            .map_err(|_| "Permission request expired".into())
    }
    /// Validation, editor mutation and ACP reply are serialized against Stop.
    pub fn review_proposal(
        &self,
        proposal_id: String,
        accepted: bool,
        expected_revision: u64,
    ) -> Result<span_core::BufferSnapshot, String> {
        self.review_selection(
            proposal_id,
            if accepted { None } else { Some(Vec::new()) },
            expected_revision,
        )
    }

    pub fn review_proposal_hunks(
        &self,
        proposal_id: String,
        accepted_hunk_ids: Vec<String>,
        expected_revision: u64,
    ) -> Result<span_core::BufferSnapshot, String> {
        self.review_selection(proposal_id, Some(accepted_hunk_ids), expected_revision)
    }

    fn review_selection(
        &self,
        proposal_id: String,
        selection: Option<Vec<String>>,
        expected_revision: u64,
    ) -> Result<span_core::BufferSnapshot, String> {
        let mut bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
        let pending = bridge
            .proposals
            .get(&proposal_id)
            .ok_or("Proposal is no longer pending")?;
        if bridge.closed || bridge.cancelled.contains(&pending.session) {
            return Err("Proposal session was cancelled".into());
        }
        let selected = selection.unwrap_or_else(|| pending.hunk_ids.clone());
        let complete = pending.hunk_ids.iter().all(|id| selected.contains(id));
        let snapshot = self
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned")?
            .resolve_proposal_hunks(&proposal_id, &selected, expected_revision)
            .map_err(|error| error.to_string())?;
        let proposal = bridge
            .proposals
            .remove(&proposal_id)
            .ok_or("Proposal is no longer pending")?;
        bridge.revisions.insert(
            (proposal.session.clone(), snapshot.path.clone()),
            snapshot.revision,
        );
        let _ = proposal.reply.send(ReviewDecision {
            applied: !selected.is_empty(),
            complete,
        });
        Ok(snapshot)
    }
}

#[allow(clippy::too_many_arguments)]
async fn run(
    config: AgentCommand,
    original: AgentCommand,
    cwd: std::path::PathBuf,
    workspace: Arc<Mutex<CoreWorkspace>>,
    state: Arc<Mutex<Bridge>>,
    emit: EventSink,
    mut rx: mpsc::UnboundedReceiver<Command>,
    ready: Reply<()>,
) -> agent_client_protocol::Result<()> {
    let logger = emit.clone();
    let agent = AcpAgent::new(
        AcpAgentConfig::new(config.command)
            .args(config.args)
            .envs(config.env),
    )
    .with_debug(move |line, direction| {
        logger(AgentEvent::Log {
            direction: format!("{direction:?}"),
            line: redact_log(line),
        })
    });
    let notifications = emit.clone();
    let notification_state = state.clone();
    let permission_state = state.clone();
    let permission_emit = emit.clone();
    let complete_emit = emit.clone();
    let elicit_state = state.clone();
    let elicit_emit = emit.clone();
    let read_workspace = workspace.clone();
    let read_state = state.clone();
    let write_workspace = workspace.clone();
    let write_state = state.clone();
    let write_emit = emit.clone();
    agent_client_protocol::Client.builder()
        .on_receive_notification(async move |notification: SessionNotification, _cx| {
            let session = notification.session_id.to_string();
            let adapter = notification_state.lock().map(|mut bridge| {
                if let Some(seen) = bridge.replaying.get_mut(&session) { *seen = tokio::time::Instant::now(); }
                bridge.adapter.clone()
            });
            if let (Ok(adapter), Ok(update)) = (adapter, serde_json::to_value(notification.update)) {
                for event in adapter.normalise(&session, update) { notifications(event); }
            }
            Ok(())
        }, agent_client_protocol::on_receive_notification!())
        .on_receive_request(async move |request: RequestPermissionRequest, responder, cx| {
            let state = permission_state.clone(); let emit = permission_emit.clone();
            cx.spawn(async move {
                let session = request.session_id.to_string();
                let scope = format!("{}:{}:{}", request.tool_call.fields.title.as_deref().unwrap_or(""),
                    serde_json::to_string(&request.tool_call.fields.kind).unwrap_or_default(),
                    serde_json::to_string(&request.tool_call.fields.raw_input).unwrap_or_default());
                let (tx, rx) = oneshot::channel();
                let pending = (|| -> Result<(String, Option<String>), String> {
                    let mut bridge = state.lock().map_err(|_| "Agent state lock poisoned")?;
                    if bridge.closed || !bridge.sessions.contains(&session) || bridge.cancelled.contains(&session) { return Ok((String::new(), None)); }
                    if let Some(kind) = bridge.remembered.get(&(session.clone(), scope.clone())) {
                        if let Some(option) = request.options.iter().find(|o| o.kind == *kind) {
                            return Ok((String::new(), Some(option.option_id.to_string())));
                        }
                    }
                    bridge.sequence += 1;
                    let id = format!("permission-{}", bridge.sequence);
                    bridge.permissions.insert(id.clone(), Permission { session: session.clone(), scope, options: request.options.clone(), reply: tx });
                    Ok((id, None))
                })();
                let (id, automatic) = match pending { Ok(value) => value, Err(error) => return responder.respond_with_internal_error(error) };
                let adapter = state.lock().map(|bridge| bridge.adapter.clone()).unwrap_or_default();
                let selected = if id.is_empty() { automatic } else {
                    let options = request.options.iter().map(|o| PermissionOption { option_id: o.option_id.to_string(), name: o.name.clone(), kind: enum_string(&o.kind) }).collect();
                    let raw = serde_json::to_value(&request).unwrap_or_default();
                    emit(adapter.permission(&session, &id, &raw, options));
                    let decision = rx.await.ok().flatten();
                    emit(AgentEvent::PermissionResolved { session_id: session.clone(), request_id: id });
                    decision
                };
                let allowed = selected.as_ref().is_some_and(|choice| request.options.iter().any(|o| o.option_id.to_string() == *choice
                    && matches!(o.kind, PermissionOptionKind::AllowOnce | PermissionOptionKind::AllowAlways)));
                for event in adapter.after_permission(&session, &request.tool_call.tool_call_id.to_string(), allowed) { emit(event); }
                responder.respond(RequestPermissionResponse::new(match selected {
                    Some(id) => RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(id)),
                    None => RequestPermissionOutcome::Cancelled,
                }))
            })
        }, agent_client_protocol::on_receive_request!())
        .on_receive_notification(async move |notification: CompleteElicitationNotification, _cx| {
            complete_emit(AgentEvent::ElicitationComplete { elicitation_id: notification.elicitation_id.to_string() });
            Ok(())
        }, agent_client_protocol::on_receive_notification!())
        .on_receive_request(async move |request: CreateElicitationRequest, responder, cx| {
            let state = elicit_state.clone(); let emit = elicit_emit.clone();
            cx.spawn(async move {
                let (mode, session, tool_call, schema, url, elicitation_id) = match &request.mode {
                    ElicitationMode::Form(form) => {
                        let (session, tool) = scope_parts(&form.scope);
                        ("form", session, tool, serde_json::to_value(&form.requested_schema).ok(), None, None)
                    }
                    ElicitationMode::Url(link) => {
                        let (session, tool) = scope_parts(&link.scope);
                        ("url", session, tool, None, Some(link.url.clone()), Some(link.elicitation_id.to_string()))
                    }
                    _ => return responder.respond_with_error(agent_client_protocol::Error::invalid_params().data("Unsupported elicitation mode")),
                };
                let safe_url = url.as_ref().is_none_or(|u| { let lower = u.to_ascii_lowercase(); lower.starts_with("https://") || lower.starts_with("http://") });
                let (tx, rx) = oneshot::channel();
                let pending = (|| -> Result<Option<String>, String> {
                    let mut bridge = state.lock().map_err(|_| "Agent state lock poisoned")?;
                    if bridge.closed || !safe_url { return Ok(None); }
                    if let Some(id) = &session { if !bridge.sessions.contains(id) || bridge.cancelled.contains(id) { return Ok(None); } }
                    bridge.sequence += 1;
                    let id = format!("elicitation-{}", bridge.sequence);
                    bridge.elicitations.insert(id.clone(), Elicitation { session: session.clone(), mode: mode.to_owned(), schema: schema.clone(), reply: tx });
                    Ok(Some(id))
                })();
                let id = match pending { Ok(value) => value, Err(error) => return responder.respond_with_internal_error(error) };
                let action = match id {
                    None => ElicitationAction::Decline,
                    Some(id) => {
                        emit(AgentEvent::Elicitation { request_id: id.clone(), session_id: session, tool_call_id: tool_call, mode: mode.into(),
                            message: request.message.clone(), schema_json: schema.map(|v| v.to_string()), url, elicitation_id });
                        let action = rx.await.unwrap_or(ElicitationAction::Cancel);
                        emit(AgentEvent::ElicitationResolved { request_id: id });
                        action
                    }
                };
                responder.respond(CreateElicitationResponse::new(action))
            })
        }, agent_client_protocol::on_receive_request!())
        .on_receive_request(async move |request: ReadTextFileRequest, responder, _cx| {
            let result = (|| -> Result<String, String> {
                let session = request.session_id.to_string();
                let mut bridge = read_state.lock().map_err(|_| "Agent state lock poisoned")?;
                if bridge.closed || !bridge.sessions.contains(&session) || bridge.cancelled.contains(&session) { return Err("Unknown or cancelled session".into()); }
                if request.line == Some(0) { return Err("Read line must be 1-based".into()); }
                let snapshot = read_workspace.lock().map_err(|_| "Workspace lock poisoned")?.agent_read(&request.path.to_string_lossy()).map_err(|e| e.to_string())?;
                bridge.revisions.insert((session, snapshot.path.clone()), snapshot.revision);
                if request.line.is_none() && request.limit.is_none() { return Ok(snapshot.text); }
                Ok(snapshot.text.split_inclusive('\n').skip(request.line.unwrap_or(1).saturating_sub(1) as usize)
                    .take(request.limit.map(|n| n as usize).unwrap_or(usize::MAX)).collect())
            })();
            match result { Ok(content) => responder.respond(ReadTextFileResponse::new(content)), Err(error) => responder.respond_with_internal_error(error) }
        }, agent_client_protocol::on_receive_request!())
        .on_receive_request(async move |request: WriteTextFileRequest, responder, cx| {
            let state = write_state.clone(); let workspace = write_workspace.clone(); let emit = write_emit.clone();
            cx.spawn(async move {
                let session = request.session_id.to_string();
                let staged = (|| -> Result<Option<(span_core::EditProposal, oneshot::Receiver<ReviewDecision>)>, String> {
                    let mut bridge = state.lock().map_err(|_| "Agent state lock poisoned")?;
                    if bridge.closed || !bridge.sessions.contains(&session) || bridge.cancelled.contains(&session) { return Err("Unknown or cancelled session".into()); }
                    let mut workspace = workspace.lock().map_err(|_| "Workspace lock poisoned")?;
                    let snapshot = workspace.agent_read(&request.path.to_string_lossy()).map_err(|e| e.to_string())?;
                    let revision = bridge.revisions.get(&(session.clone(), snapshot.path.clone())).copied().unwrap_or(snapshot.revision);
                    let proposal = workspace.stage_proposal(&snapshot.path, revision, request.content).map_err(|e| e.to_string())?;
                    if proposal.hunks.is_empty() {
                        workspace.resolve_proposal(&proposal.id, false, snapshot.revision).map_err(|error| error.to_string())?;
                        return Ok(None);
                    }
                    let (tx, rx) = oneshot::channel();
                    let hunk_ids = proposal.hunks.iter().map(|hunk| hunk.id.clone()).collect();
                    bridge.proposals.insert(proposal.id.clone(), Proposal { session: session.clone(), path: proposal.path.clone(), hunk_ids, reply: tx });
                    Ok(Some((proposal, rx)))
                })();
                let (proposal, decision) = match staged {
                    Ok(Some(value)) => value,
                    Ok(None) => return responder.respond(WriteTextFileResponse::new()),
                    Err(error) => return responder.respond_with_internal_error(error),
                };
                let id = proposal.id.clone();
                emit(AgentEvent::Proposal { session_id: session.clone(), proposal });
                let decision = decision.await.unwrap_or_default();
                emit(AgentEvent::ProposalResolved { session_id: session, proposal_id: id, accepted: decision.applied });
                if decision.complete { responder.respond(WriteTextFileResponse::new()) }
                else if decision.applied { responder.respond_with_internal_error("Only selected edit hunks were accepted. Other changes were rejected. Read the editor buffer again before continuing.") }
                else { responder.respond_with_internal_error("User rejected or cancelled the proposed editor edit") }
            })
        }, agent_client_protocol::on_receive_request!())
        .connect_with(agent, async move |cx: ConnectionTo<Agent>| {
            let initialized = tokio::time::timeout(std::time::Duration::from_secs(40), cx.send_request(InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
                ClientCapabilities::new().fs(FileSystemCapabilities::new().read_text_file(true).write_text_file(true)).terminal(false)
                    .session(ClientSessionCapabilities::new().notices(NoticeCapabilities::new()).compaction(CompactionCapabilities::new()))
                    .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()).url(ElicitationUrlCapabilities::new()))))
                .block_task()).await;
            let initialized = match initialized {
                Ok(result) => result,
                Err(_) => { let _ = ready.send(Err("Agent initialization timed out after 40 seconds".into())); return Ok(()); }
            };
            if let Err(error) = initialized { let message = crate::compatibility::user_error("initialize", &error, &emit); let _ = ready.send(Err(message)); return Ok(()); }
            if initialized.as_ref().is_ok_and(|response| response.protocol_version != ProtocolVersion::V1) {
                let _ = ready.send(Err("Agent negotiated an unsupported protocol version".into())); return Ok(());
            }
            let (can_load, can_list) = initialized.as_ref().ok().map(|response| (response.agent_capabilities.load_session, response.agent_capabilities.session_capabilities.list.is_some())).unwrap_or((false, false));
            let agent_name = initialized.as_ref().ok().and_then(|response| response.agent_info.as_ref()).map(|info| info.name.clone());
            let adapter = Arc::new(Adapter::new(AgentKind::detect(agent_name.as_deref(), &original), cwd.clone()));
            let profile = adapter.profile();
            let (ready_event, auth_methods) = match initialized.as_ref().ok() {
                Some(response) => ready_event(response, &adapter),
                None => (AgentEvent::Ready { agent_name: None, agent_title: None, agent_version: None, features: AgentFeatures::default(), auth_methods: Vec::new() }, Vec::new()),
            };
            let mcp_caps = initialized.as_ref().ok().and_then(|response| serde_json::to_value(&response.agent_capabilities.mcp_capabilities).ok())
                .map(|caps| McpCaps { http: caps["http"].as_bool().unwrap_or(false), sse: caps["sse"].as_bool().unwrap_or(false), acp: caps["acp"].as_bool().unwrap_or(false) })
                .unwrap_or_default();
            if let (Ok(mut bridge), AgentEvent::Ready { features, .. }) = (state.lock(), &ready_event) {
                bridge.prompt_image = features.image;
                bridge.prompt_embedded = features.embedded_context;
                bridge.can_close = features.can_close_sessions;
                bridge.can_delete = features.can_delete_sessions;
                bridge.auth_methods = auth_methods.clone();
                bridge.adapter = adapter.clone();
                bridge.mcp_caps = mcp_caps;
            }
            let _ = ready.send(Ok(()));
            emit(ready_event);
            emit(AgentEvent::Capabilities { can_load_session: can_load, can_list_sessions: can_list });
            emit(AgentEvent::Status { state: "connected".into(), message: "ACP initialized. Agent process has your OS privileges.".into() });
            let mut cancel_deadline: Option<tokio::time::Instant> = None;
            let (compatibility_failed, mut compatibility_failures) = mpsc::unbounded_channel::<()>();
            loop {
                let command = tokio::select! {
                    command = rx.recv() => match command { Some(command) => command, None => break },
                    _ = cx.incoming_closed() => break,
                    _ = compatibility_failures.recv() => break,
                    _ = tokio::time::sleep_until(cancel_deadline.unwrap_or_else(|| tokio::time::Instant::now() + std::time::Duration::from_secs(86400))), if cancel_deadline.is_some() => {
                        cancel_deadline = None;
                        // A delegated child that ignores Stop only loses its own
                        // turn; anything else that ignores it ends the connection.
                        let unresponsive = state.lock().map(|mut bridge| {
                            let stuck: Vec<String> = bridge.running.iter().filter(|id| bridge.cancelled.contains(*id)).cloned().collect();
                            let (children, roots): (Vec<String>, Vec<String>) = stuck.into_iter().partition(|id| bridge.delegated.contains(id));
                            if roots.is_empty() {
                                for id in &children { if let Some(abandon) = bridge.abandon.remove(id) { let _ = abandon.send(()); } }
                            }
                            !roots.is_empty()
                        }).unwrap_or(true);
                        if unresponsive {
                            emit(AgentEvent::Error { session_id: None, message: format!("Agent did not acknowledge Stop within {}. Its connection was terminated.", spoken_seconds(profile.stop_deadline)) });
                            break;
                        }
                        continue;
                    },
                };
                match command {
                    Command::NewSession(servers, reply) => {
                        let mut params = serde_json::to_value(NewSessionRequest::new(cwd.clone())).unwrap_or_default();
                        params["mcpServers"] = json!(gated_mcp_servers(&state, &servers));
                        let result = tokio::time::timeout(std::time::Duration::from_secs(30), raw_request(&cx, "session/new", params)).await;
                        let result = match result {
                            Ok(result) => result,
                            Err(_) => { let _ = reply.send(Err("Agent session creation timed out after 30 seconds".into())); break; }
                        };
                        let result = result.and_then(|response| match response.get("sessionId").and_then(Value::as_str) {
                            Some(id) => Ok((id.to_owned(), response.clone())),
                            None => Err(agent_client_protocol::Error::invalid_params().data("session/new response has no sessionId")),
                        });
                        let needs_auth = result.as_ref().err().is_some_and(|e| e.code == ErrorCode::AuthRequired);
                        if let Ok(mut bridge) = state.lock() { bridge.auth_required = needs_auth; }
                        if let (true, Err(error)) = (needs_auth, &result) { auth_required(&state, &emit, error); }
                        // An agent without ACP sessions cannot be used at all, so its
                        // connection ends; other failures keep the connection for the
                        // remaining sessions.
                        let unsupported = result.as_ref().err().is_some_and(|e| matches!(e.code, ErrorCode::MethodNotFound));
                        let result = result.map_err(|e| if needs_auth { format!("Authentication required: {e}") } else { crate::compatibility::user_error("session/new", &e, &emit) });
                        let result = result.map(|(id, response)| {
                            if let Ok(mut bridge) = state.lock() { bridge.sessions.insert(id.clone()); }
                            emit(AgentEvent::Session { session_id: id.clone() });
                            let options = adapter.session_config(&id, &response);
                            if !options.is_empty() { emit(AgentEvent::Config { session_id: id.clone(), options }); }
                            id
                        });
                        let _ = reply.send(result);
                        if unsupported { break; }
                    }
                    Command::Authenticate(method_id, meta, reply) => {
                        let auth_cx = cx.clone(); let auth_state = state.clone();
                        cx.spawn(async move {
                            let result = tokio::time::timeout(std::time::Duration::from_secs(120), auth_cx.send_request(AuthenticateRequest::new(method_id).meta(meta)).block_task()).await;
                            let result = match result {
                                Ok(Ok(_)) => { if let Ok(mut bridge) = auth_state.lock() { bridge.auth_required = false; } Ok(()) }
                                Ok(Err(error)) => Err(error.to_string()),
                                Err(_) => Err("The agent did not finish authentication within 120 seconds".to_string()),
                            };
                            let _ = reply.send(result);
                            Ok(())
                        })?;
                    }
                    Command::Prompt(id, blocks, reply) => {
                        let valid = state.lock().map(|mut bridge| {
                            if bridge.closed || !bridge.sessions.contains(&id) { return Err("Unknown session".to_string()); }
                            // Gemini silently aborts the running turn when a second prompt arrives, so none is ever sent.
                            if bridge.replaying.contains_key(&id) { return Err("The session is still being restored".to_string()); }
                            if !bridge.running.insert(id.clone()) { return Err("A prompt is already running in this session".to_string()); }
                            bridge.cancelled.remove(&id); Ok(())
                        }).unwrap_or_else(|_| Err("Agent state lock poisoned".into()));
                        if let Err(error) = valid { let _ = reply.send(Err(error)); continue; }
                        let slash = matches!(blocks.first(), Some(ContentBlock::Text(text)) if text.text.trim_start().starts_with('/'));
                        adapter.begin_turn(&id, slash);
                        let prompt_cx = cx.clone(); let prompt_emit = emit.clone(); let prompt_state = state.clone(); let prompt_adapter = adapter.clone(); let compatibility_failed = compatibility_failed.clone();
                        let (abandon_tx, abandon_rx) = oneshot::channel::<()>();
                        if let Ok(mut bridge) = state.lock() { bridge.abandon.insert(id.clone(), abandon_tx); }
                        let stop_wait = spoken_seconds(profile.stop_deadline);
                        cx.spawn(async move {
                            let params = serde_json::to_value(PromptRequest::new(id.clone(), blocks)).unwrap_or_default();
                            let result = tokio::select! {
                                result = raw_request(&prompt_cx, "session/prompt", params) => result,
                                Ok(()) = abandon_rx => {
                                    if let Ok(mut bridge) = prompt_state.lock() { bridge.running.remove(&id); }
                                    let message = format!("The agent did not acknowledge Stop within {stop_wait}. The turn was abandoned and the connection kept.");
                                    prompt_emit(AgentEvent::Error { session_id: Some(id.clone()), message: message.clone() });
                                    let _ = reply.send(Err(message));
                                    return Ok(());
                                }
                            };
                            if let Ok(mut bridge) = prompt_state.lock() { bridge.running.remove(&id); bridge.abandon.remove(&id); }
                            match result {
                                Ok(response) => { prompt_emit(prompt_adapter.complete(&id, &response)); let _ = reply.send(Ok(())); }
                                Err(error) => {
                                    // OpenCode reports a missing sign-in only here; any agent may.
                                    if error.code == ErrorCode::AuthRequired { auth_required(&prompt_state, &prompt_emit, &error); }
                                    let message = crate::compatibility::user_error("session/prompt", &error, &prompt_emit);
                                    prompt_emit(AgentEvent::Error { session_id: Some(id.clone()), message: message.clone() }); let _ = reply.send(Err(message));
                                    if matches!(&error.code, ErrorCode::MethodNotFound) { let _ = compatibility_failed.send(()); }
                                }
                            }
                            Ok(())
                        })?;
                    }
                    Command::SetConfig(id, config_id, value, reply) => {
                        let known = state.lock().map(|bridge| !bridge.closed && bridge.sessions.contains(&id)).unwrap_or(false);
                        if !known { let _ = reply.send(Err("Unknown session".into())); continue; }
                        let set_cx = cx.clone(); let set_emit = emit.clone(); let set_adapter = adapter.clone();
                        cx.spawn(async move {
                            // Options synthesised from legacy modes and models go to set_mode and set_model.
                            let route = set_adapter.route(&id, &config_id);
                            let request = match route {
                                ConfigRoute::Option => raw_request(&set_cx, "session/set_config_option", serde_json::to_value(SetSessionConfigOptionRequest::new(id.clone(), config_id.clone(), value.as_str())).unwrap_or_default()),
                                ConfigRoute::Mode => raw_request(&set_cx, "session/set_mode", serde_json::to_value(SetSessionModeRequest::new(id.clone(), value.clone())).unwrap_or_default()),
                                ConfigRoute::Model => raw_request(&set_cx, "session/set_model", json!({ "sessionId": id, "modelId": value })),
                            };
                            let result = tokio::time::timeout(std::time::Duration::from_secs(20), request).await;
                            match result {
                                Ok(Ok(response)) => {
                                    let options = match route {
                                        ConfigRoute::Option => config_options_value(response.get("configOptions")),
                                        _ => set_adapter.legacy_applied(&id, &config_id, &value),
                                    };
                                    set_emit(AgentEvent::Config { session_id: id, options });
                                    let _ = reply.send(Ok(()));
                                }
                                Ok(Err(error)) => { let _ = reply.send(Err(error.to_string())); }
                                Err(_) => { let _ = reply.send(Err("The agent did not apply the change within 20 seconds".into())); }
                            }
                            Ok(())
                        })?;
                    }
                    Command::ListSessions(reply) => {
                        if !can_list { let _ = reply.send(Err("This agent cannot list earlier sessions".into())); continue; }
                        let list_cx = cx.clone(); let list_cwd = cwd.clone();
                        cx.spawn(async move {
                            let mut found: Vec<SessionSummary> = Vec::new();
                            let mut cursor: Option<String> = None;
                            for _ in 0..5 {
                                let request = ListSessionsRequest::new().cwd(list_cwd.clone()).cursor(cursor.clone());
                                let page = tokio::time::timeout(std::time::Duration::from_secs(20), list_cx.send_request(request).block_task()).await;
                                match page {
                                    Ok(Ok(page)) => {
                                        found.extend(page.sessions.into_iter().map(|info| SessionSummary { session_id: info.session_id.to_string(), title: info.title, updated_at: info.updated_at }));
                                        cursor = page.next_cursor;
                                        if cursor.is_none() { break; }
                                    }
                                    Ok(Err(error)) => { let _ = reply.send(Err(error.to_string())); return Ok(()); }
                                    Err(_) => { let _ = reply.send(Err("The agent did not list sessions within 20 seconds".into())); return Ok(()); }
                                }
                            }
                            found.truncate(100);
                            let _ = reply.send(Ok(found));
                            Ok(())
                        })?;
                    }
                    Command::LoadSession(id, servers, reply) => {
                        if !can_load { let _ = reply.send(Err("This agent cannot restore earlier sessions".into())); continue; }
                        if let Ok(mut bridge) = state.lock() { bridge.sessions.insert(id.clone()); }
                        let load_cx = cx.clone(); let load_emit = emit.clone(); let load_cwd = cwd.clone(); let load_state = state.clone(); let load_adapter = adapter.clone();
                        let mut params = serde_json::to_value(LoadSessionRequest::new(id.clone(), load_cwd)).unwrap_or_default();
                        params["mcpServers"] = json!(gated_mcp_servers(&state, &servers));
                        if profile.replay_quiet.is_some() {
                            if let Ok(mut bridge) = state.lock() { bridge.replaying.insert(id.clone(), tokio::time::Instant::now()); }
                        }
                        cx.spawn(async move {
                            let result = tokio::time::timeout(std::time::Duration::from_secs(60), raw_request(&load_cx, "session/load", params)).await;
                            match result {
                                Ok(Ok(response)) => {
                                    let options = load_adapter.session_config(&id, &response);
                                    if !options.is_empty() { load_emit(AgentEvent::Config { session_id: id.clone(), options }); }
                                    if let Some(quiet) = profile.replay_quiet { replay_settled(&load_state, &id, quiet).await; }
                                    let _ = reply.send(Ok(()));
                                }
                                other => {
                                    if let Ok(mut bridge) = load_state.lock() { bridge.sessions.remove(&id); bridge.replaying.remove(&id); }
                                    if let Ok(Err(error)) = other.as_ref() {
                                        if error.code == ErrorCode::AuthRequired { auth_required(&load_state, &load_emit, error); }
                                    }
                                    let _ = reply.send(Err(match other {
                                        Ok(Err(error)) => error.to_string(),
                                        _ => "The agent did not restore the session within 60 seconds".into(),
                                    }));
                                }
                            }
                            Ok(())
                        })?;
                    }
                    Command::CloseSession(id, reply) => {
                        if let Ok(mut bridge) = state.lock() { bridge.cancelled.insert(id.clone()); }
                        cancel_pending(&state, &workspace, &emit, Some(&id));
                        let close_cx = cx.clone(); let close_state = state.clone();
                        cx.spawn(async move {
                            let result = tokio::time::timeout(std::time::Duration::from_secs(20), close_cx.send_request(CloseSessionRequest::new(id.clone())).block_task()).await;
                            let result = match result {
                                Ok(Ok(_)) => Ok(()),
                                // -32002: the agent no longer knows the session, so it is closed.
                                Ok(Err(error)) if error.code == ErrorCode::ResourceNotFound => Ok(()),
                                Ok(Err(error)) => Err(error.to_string()),
                                Err(_) => Err("The agent did not close the session within 20 seconds".to_string()),
                            };
                            if result.is_ok() { forget_session(&close_state, &id); }
                            let _ = reply.send(result);
                            Ok(())
                        })?;
                    }
                    Command::DeleteSession(id, reply) => {
                        let running = state.lock().map(|mut bridge| {
                            let running = bridge.running.contains(&id);
                            if running { bridge.cancelled.insert(id.clone()); }
                            running
                        }).unwrap_or(false);
                        if running {
                            // Cancel the active turn first; the notification is written before the delete request.
                            cx.send_notification(CancelNotification::new(id.clone()))?;
                            cancel_deadline = Some(tokio::time::Instant::now() + profile.stop_deadline);
                        }
                        cancel_pending(&state, &workspace, &emit, Some(&id));
                        let delete_cx = cx.clone(); let delete_state = state.clone();
                        cx.spawn(async move {
                            let result = tokio::time::timeout(std::time::Duration::from_secs(20), delete_cx.send_request(DeleteSessionRequest::new(id.clone())).block_task()).await;
                            let result = match result {
                                Ok(Ok(_)) => Ok(()),
                                Ok(Err(error)) => Err(error.to_string()),
                                Err(_) => Err("The agent did not delete the session within 20 seconds".to_string()),
                            };
                            if result.is_ok() { forget_session(&delete_state, &id); }
                            let _ = reply.send(result);
                            Ok(())
                        })?;
                    }
                    Command::Cancel(id) => {
                        if let Ok(mut bridge) = state.lock() { bridge.cancelled.insert(id.clone()); }
                        cx.send_notification(CancelNotification::new(id.clone()))?;
                        cancel_pending(&state, &workspace, &emit, Some(&id));
                        cancel_deadline = Some(tokio::time::Instant::now() + profile.stop_deadline);
                    }
                    Command::Shutdown => { cancel_pending(&state, &workspace, &emit, None); break; }
                }
            }
            Ok(())
        }).await
}

fn forget_session(state: &Arc<Mutex<Bridge>>, id: &str) {
    if let Ok(mut bridge) = state.lock() {
        bridge.sessions.remove(id);
        bridge.remembered.retain(|(session, _), _| session != id);
        bridge.replaying.remove(id);
        bridge.delegated.remove(id);
        bridge.abandon.remove(id);
        bridge.adapter.forget(id);
    }
}

/// The subset of one request's MCP servers this agent may receive.
fn gated_mcp_servers(state: &Arc<Mutex<Bridge>>, servers: &[Value]) -> Vec<Value> {
    if servers.is_empty() {
        return Vec::new();
    }
    state
        .lock()
        .map(|bridge| bridge.adapter.mcp_servers(bridge.mcp_caps, servers))
        .unwrap_or_default()
}

/// Emit `AuthRequired` for an `-32000` error from any request.
fn auth_required(
    state: &Arc<Mutex<Bridge>>,
    emit: &EventSink,
    error: &agent_client_protocol::Error,
) {
    let (methods, hint) = state
        .lock()
        .map(|mut bridge| {
            bridge.auth_required = true;
            (bridge.auth_methods.clone(), bridge.adapter.auth_hint())
        })
        .unwrap_or_default();
    emit(AgentEvent::AuthRequired {
        message: format!("Authentication required: {error}"),
        auth_methods: methods,
        hint,
    });
}

/// Wait until a replaying session has been quiet for `quiet` (at most 15
/// seconds in total), then allow prompts again.
async fn replay_settled(state: &Arc<Mutex<Bridge>>, id: &str, quiet: std::time::Duration) {
    let limit = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let last = state
            .lock()
            .ok()
            .and_then(|bridge| bridge.replaying.get(id).copied());
        let Some(last) = last else { return };
        let due = last + quiet;
        let now = tokio::time::Instant::now();
        if now >= due || now >= limit {
            break;
        }
        tokio::time::sleep_until(due.min(limit)).await;
    }
    if let Ok(mut bridge) = state.lock() {
        bridge.replaying.remove(id);
    }
}

fn cancel_pending(
    state: &Arc<Mutex<Bridge>>,
    workspace: &Arc<Mutex<CoreWorkspace>>,
    emit: &EventSink,
    session: Option<&str>,
) {
    if let Ok(mut bridge) = state.lock() {
        let permissions: Vec<_> = bridge
            .permissions
            .iter()
            .filter(|(_, p)| session.is_none_or(|s| p.session == s))
            .map(|(id, _)| id.clone())
            .collect();
        for id in permissions {
            if let Some(p) = bridge.permissions.remove(&id) {
                let _ = p.reply.send(None);
            }
        }
        let proposals: Vec<_> = bridge
            .proposals
            .iter()
            .filter(|(_, p)| session.is_none_or(|s| p.session == s))
            .map(|(id, _)| id.clone())
            .collect();
        for id in proposals {
            if let Some(p) = bridge.proposals.remove(&id) {
                if let Ok(mut workspace) = workspace.lock() {
                    if let Ok(snapshot) = workspace.agent_read(&p.path) {
                        let _ = workspace.resolve_proposal(&id, false, snapshot.revision);
                    }
                }
                let _ = p.reply.send(ReviewDecision::default());
            }
        }
        let elicitations: Vec<_> = bridge
            .elicitations
            .iter()
            .filter(|(_, e)| session.is_none_or(|s| e.session.as_deref() == Some(s)))
            .map(|(id, _)| id.clone())
            .collect();
        for id in elicitations {
            if let Some(e) = bridge.elicitations.remove(&id) {
                let _ = e.reply.send(ElicitationAction::Cancel);
            }
        }
        if session.is_none() {
            bridge.closed = true;
            bridge.remembered.clear();
        }
    }
    let _ = emit;
}

fn scope_parts(scope: &ElicitationScope) -> (Option<String>, Option<String>) {
    match scope {
        ElicitationScope::Session(s) => (
            Some(s.session_id.to_string()),
            s.tool_call_id.as_ref().map(|id| id.to_string()),
        ),
        _ => (None, None),
    }
}

/// Build the `Ready` event and the auth method list from the initialize response.
fn ready_event(
    response: &InitializeResponse,
    adapter: &Adapter,
) -> (AgentEvent, Vec<AuthMethodInfo>) {
    let caps = &response.agent_capabilities;
    let info =
        |id: String, name: String, description: Option<String>, kind: &str, supported: bool| {
            AuthMethodInfo {
                id,
                name,
                description,
                kind: kind.into(),
                supported,
                input: None,
                hint: None,
            }
        };
    let auth_methods: Vec<AuthMethodInfo> = response
        .auth_methods
        .iter()
        .map(|method| match method {
            AuthMethod::Agent(m) => {
                let mut method = info(
                    m.id.to_string(),
                    m.name.clone(),
                    m.description.clone(),
                    "agent",
                    true,
                );
                let meta = m.meta.as_ref().map(|meta| Value::Object(meta.clone()));
                adapter.auth_method(&mut method, meta.as_ref());
                method
            }
            AuthMethod::Terminal(m) => info(
                m.id.to_string(),
                m.name.clone(),
                m.description.clone(),
                "terminal",
                false,
            ),
            _ => info(
                String::new(),
                "Unknown method".into(),
                None,
                "unknown",
                false,
            ),
        })
        .filter(|method| !method.id.is_empty())
        .collect();
    let session = &caps.session_capabilities;
    let event = AgentEvent::Ready {
        agent_name: response.agent_info.as_ref().map(|i| i.name.clone()),
        agent_title: response.agent_info.as_ref().and_then(|i| i.title.clone()),
        agent_version: response.agent_info.as_ref().map(|i| i.version.clone()),
        features: AgentFeatures {
            load_session: caps.load_session,
            image: caps.prompt_capabilities.image,
            audio: caps.prompt_capabilities.audio,
            embedded_context: caps.prompt_capabilities.embedded_context,
            mcp_http: caps.mcp_capabilities.http,
            mcp_sse: caps.mcp_capabilities.sse,
            can_list_sessions: session.list.is_some(),
            can_resume_sessions: session.resume.is_some(),
            can_close_sessions: session.close.is_some(),
            can_delete_sessions: session.delete.is_some(),
            adapter: Some(adapter.kind().id().into()),
            edits_bypass_review: Some(adapter.profile().edits_bypass_review),
            double_approval: Some(adapter.profile().double_approval),
        },
        auth_methods: auth_methods.clone(),
    };
    (event, auth_methods)
}

/// Turn the prompt text and attachments into ACP content blocks, enforcing
/// the capabilities the agent advertised.
fn prompt_blocks(
    text: String,
    attachments: Vec<PromptAttachment>,
    image: bool,
    embedded: bool,
) -> Result<Vec<ContentBlock>, String> {
    let mut blocks = Vec::new();
    if !text.trim().is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(text)));
    }
    for attachment in attachments {
        match attachment {
            PromptAttachment::Image {
                data,
                mime_type,
                uri,
            } => {
                if !image {
                    return Err("This agent does not accept image attachments".into());
                }
                if !mime_type.starts_with("image/") {
                    return Err("Image attachment needs an image/* MIME type".into());
                }
                if data.len() > MAX_ATTACHMENT_BASE64 {
                    return Err("Image attachment is too large".into());
                }
                let mut content = ImageContent::new(data, mime_type);
                content.uri = uri;
                blocks.push(ContentBlock::Image(content));
            }
            PromptAttachment::ResourceLink {
                uri,
                name,
                mime_type,
                description,
            } => {
                let mut link = ResourceLink::new(name, uri);
                link.mime_type = mime_type;
                link.description = description;
                blocks.push(ContentBlock::ResourceLink(link));
            }
            PromptAttachment::Resource {
                uri,
                mime_type,
                text,
                blob,
            } => {
                if !embedded {
                    return Err("This agent does not accept embedded resources".into());
                }
                let resource = match (text, blob) {
                    (Some(text), None) => {
                        let mut contents = TextResourceContents::new(text, uri);
                        contents.mime_type = mime_type;
                        EmbeddedResourceResource::TextResourceContents(contents)
                    }
                    (None, Some(blob)) => {
                        if blob.len() > MAX_ATTACHMENT_BASE64 {
                            return Err("Embedded resource is too large".into());
                        }
                        let mut contents = BlobResourceContents::new(blob, uri);
                        contents.mime_type = mime_type;
                        EmbeddedResourceResource::BlobResourceContents(contents)
                    }
                    _ => return Err("Embedded resource needs exactly one of text or blob".into()),
                };
                blocks.push(ContentBlock::Resource(EmbeddedResource::new(resource)));
            }
        }
    }
    Ok(blocks)
}

/// Parse form answers and check them against the flat schema the agent sent.
fn elicitation_content(
    json: &str,
    schema: Option<&Value>,
) -> Result<std::collections::BTreeMap<String, ElicitationContentValue>, String> {
    let value: Value = serde_json::from_str(json).map_err(|e| format!("Invalid answers: {e}"))?;
    let object = value.as_object().ok_or("Answers must be a JSON object")?;
    let properties = schema
        .and_then(|s| s.get("properties"))
        .and_then(Value::as_object);
    if let Some(properties) = properties {
        if let Some(unknown) = object.keys().find(|key| !properties.contains_key(*key)) {
            return Err(format!("Unknown field: {unknown}"));
        }
    }
    if let Some(required) = schema
        .and_then(|s| s.get("required"))
        .and_then(Value::as_array)
    {
        for key in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(key) {
                return Err(format!("Missing required field: {key}"));
            }
        }
    }
    object
        .iter()
        .map(|(key, value)| {
            serde_json::from_value::<ElicitationContentValue>(value.clone())
                .map(|parsed| (key.clone(), parsed))
                .map_err(|_| format!("Unsupported value for {key}"))
        })
        .collect()
}

fn enum_string<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "s3cr3t-token-value";

    fn servers() -> Value {
        json!([
            {"type": "http", "name": "span-agents", "url": "http://127.0.0.1:1/mcp",
             "headers": [{"name": "Authorization", "value": format!("Bearer {SECRET}")}]},
            {"type": "sse", "name": "events", "url": "https://sse.example",
             "headers": [{"name": "X-Key", "value": SECRET}]},
            {"name": "local", "command": "node", "args": [], "env": [{"name": "TOKEN", "value": SECRET}]},
            {"type": "http", "name": "query", "url": format!("https://mcp.example/?key={SECRET}"), "headers": []},
        ])
    }

    #[test]
    fn mcp_server_secrets_are_redacted_for_every_session_method() {
        for method in ["session/new", "session/load", "session/resume"] {
            let line = json!({"jsonrpc": "2.0", "id": 1, "method": method,
                "params": {"sessionId": "s", "cwd": "/w", "mcpServers": servers()}})
            .to_string();
            let redacted = redact_log(&line);
            assert!(!redacted.contains(SECRET), "{method}: {redacted}");
            let parsed: Value = serde_json::from_str(&redacted).unwrap();
            let list = &parsed["params"]["mcpServers"];
            assert_eq!(list[0]["name"], "span-agents");
            assert_eq!(list[0]["headers"][0]["name"], "Authorization");
            assert_eq!(list[0]["headers"][0]["value"], REDACTED);
            assert_eq!(list[1]["headers"][0]["value"], REDACTED);
            assert_eq!(list[2]["env"][0]["name"], "TOKEN");
            assert_eq!(list[2]["env"][0]["value"], REDACTED);
            assert_eq!(list[3]["url"], REDACTED);
            assert_eq!(list[0]["url"], "http://127.0.0.1:1/mcp");
        }
    }

    #[test]
    fn unparseable_session_lines_are_dropped_and_others_pass() {
        let broken =
            format!("{{\"method\":\"session/new\",\"params\":{{\"mcpServers\":[\"{SECRET}\"");
        assert_eq!(redact_log(&broken), "[message redacted]");
        let auth = json!({"method": "authenticate", "params": {"methodId": "k", "_meta": {"api-key": SECRET}}}).to_string();
        assert!(!redact_log(&auth).contains(SECRET));
        let plain = json!({"method": "session/prompt", "params": {"sessionId": "s"}}).to_string();
        assert_eq!(redact_log(&plain), plain);
    }
}
