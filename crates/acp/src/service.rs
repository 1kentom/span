use crate::adapter::{map::config_options_value, Adapter, AgentKind, ConfigRoute, McpCaps};
use crate::{
    AgentCommand, AgentEvent, AgentFeatures, AgentHint, AuthCredential, AuthInput, AuthMethodInfo,
    ConfigOption, PermissionOption, PromptAttachment, SessionSummary,
};
use agent_client_protocol::schema::{v1::*, ProtocolVersion};
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo, UntypedMessage};
use serde_json::{json, Value};
use span_core::{CoreWorkspace, StartMode};
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
    #[cfg(test)]
    runtime_polls: Arc<std::sync::atomic::AtomicU64>,
}

/// Which sessions a `session/list` call returns.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Listing {
    /// The user's sessions of the workspace folder.
    Folder,
    /// The user's sessions of every folder.
    AllFolders,
    /// Only Span's own health check sessions, of every folder (for cleanup).
    Health,
}

/// What a new session is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opened {
    /// The user's chat: the user's start mode applies.
    User,
    /// A delegated child: always the approval start mode, whatever the
    /// user's start mode for this agent, so a child never runs looser than
    /// its lead could (ADR 0003, amendment of 2026-10-29). Kept out of the
    /// agent's own history where the agent allows it.
    Child,
    /// A hidden Span session (see [`AgentService::new_hidden_session`]),
    /// kept out of the agent's own history where the agent allows it.
    Hidden,
}

enum Command {
    /// MCP servers and what the session is for.
    NewSession(Vec<Value>, Opened, Reply<String>),
    Prompt(String, Vec<ContentBlock>, Reply<()>),
    Authenticate(String, Option<Meta>, Reply<()>),
    Cancel(String),
    SetConfig(String, String, String, Reply<()>),
    ListSessions(Listing, Reply<Vec<SessionSummary>>),
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
    /// Sessions the user deleted on this connection. Claude Code answers
    /// `session/delete` and still lists the session, so these stay hidden
    /// from `list_sessions` for the life of the connection.
    deleted: HashSet<String>,
    /// Deleted sessions the agent was seen still listing (reported once).
    deleted_listed: HashSet<String>,
    /// Sessions whose current turn had a permission or edit rejected by the user.
    rejected: HashSet<String>,
    /// Span's own hidden sessions on this connection and where their events go.
    hidden: Arc<Mutex<Hidden>>,
}

/// Sessions Span opens for itself (the agent health check, ADR 0010). Their
/// events never reach the connection's sink: they go to `sink` only, so the
/// user's chat, the session manager and the History list never see them.
#[derive(Default)]
struct Hidden {
    ids: HashSet<String>,
    sink: Option<EventSink>,
}

/// Every hidden session id Span opened in this process, on any connection.
/// `list_sessions` filters these out, so a hidden session never shows in
/// History even after a reconnect of the same agent.
static HIDDEN_SESSIONS: std::sync::LazyLock<Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(Mutex::default);

/// The prompt of the health check. Agents title a session after its first
/// prompt, so a health session left over from an earlier run of Span is
/// recognised by its title and kept out of History as well.
pub const HEALTH_PROMPT: &str = "Health check. Reply with exactly one word: OK";

/// What a health session's title starts with. Shorter than the prompt:
/// agents cut long titles (for example to "Health check. Reply with exactly
/// one word..."), so only this prefix is required. A title that merely
/// starts with "Health check" is a user's chat and is never matched.
pub const HEALTH_TITLE_PREFIX: &str = "Health check. Reply with exactly one word";

/// True for a title an agent gave a Span health session.
pub fn is_health_title(title: Option<&str>) -> bool {
    title.is_some_and(|t| t.trim_start().starts_with(HEALTH_TITLE_PREFIX))
}

/// True for a session Span opened for itself: one recorded in this process
/// (or remembered from an earlier run, see [`remember_hidden_sessions`]),
/// or one titled with the health check prompt.
pub fn is_hidden_session(session_id: &str, title: Option<&str>) -> bool {
    is_health_title(title)
        || HIDDEN_SESSIONS
            .lock()
            .map(|ids| ids.contains(session_id))
            .unwrap_or(false)
}

/// Add health session ids remembered from earlier runs of Span to the
/// process wide hidden set, so listings drop them even when the agent
/// titles them differently.
pub fn remember_hidden_sessions<I: IntoIterator<Item = String>>(ids: I) {
    if let Ok(mut set) = HIDDEN_SESSIONS.lock() {
        set.extend(ids);
    }
}

/// Wrap the connection sink so events of hidden sessions go to the hidden
/// sink instead. The hidden set has its own lock, never held while emitting.
fn divert_hidden(hidden: Arc<Mutex<Hidden>>, emit: EventSink) -> EventSink {
    Arc::new(move |event: AgentEvent| {
        let diverted = crate::manager::event_session(&event).and_then(|session| {
            let hidden = hidden.lock().ok()?;
            hidden.ids.contains(&session).then(|| hidden.sink.clone())
        });
        match diverted {
            Some(Some(sink)) => sink(event),
            Some(None) => {}
            None => emit(event),
        }
    })
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

/// Agent notifications under this prefix (`_auth/status_update` from Claude
/// Code and Codex) carry the signed-in account: email, plan, organization.
const AUTH_METHOD_PREFIX: &str = "_auth/";

/// Debug lines go to the UI log. Secrets never do: `authenticate` `_meta`,
/// the params of `_auth/*` methods (the method name stays), and the header
/// values (HTTP, SSE) and environment values (stdio) of every MCP server
/// offered in `session/new`, `session/load` and `session/resume`, such as the
/// span-agents bearer token. A line that mentions one of these methods but
/// does not parse is dropped whole.
fn redact_log(line: &str) -> String {
    let sensitive = line.contains("authenticate")
        || line.contains(AUTH_METHOD_PREFIX)
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
    if method
        .as_deref()
        .is_some_and(|m| m.starts_with(AUTH_METHOD_PREFIX))
    {
        if let Some(params) = message.get_mut("params") {
            *params = json!(REDACTED);
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
        let hidden = state
            .lock()
            .map_err(|_| "Agent state lock poisoned")?
            .hidden
            .clone();
        let emit = divert_hidden(hidden, emit);
        let (tx, rx) = mpsc::unbounded_channel();
        let (ready_tx, ready_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(false);
        let shared = state.clone();
        let service_workspace = workspace.clone();
        #[cfg(test)]
        let runtime_polls = Arc::new(std::sync::atomic::AtomicU64::new(0));
        #[cfg(test)]
        let observed_polls = runtime_polls.clone();
        std::thread::Builder::new()
            .name("span-acp".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                match runtime {
                    Ok(runtime) => runtime.block_on(async move {
                        let connection = run(
                            config,
                            original,
                            cwd,
                            workspace.clone(),
                            shared.clone(),
                            emit.clone(),
                            rx,
                            ready_tx,
                        );
                        #[cfg(test)]
                        let connection = {
                            use std::future::Future;
                            let mut connection = Box::pin(connection);
                            std::future::poll_fn(move |cx| {
                                observed_polls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                connection.as_mut().poll(cx)
                            })
                        };
                        let result = connection.await;
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
            #[cfg(test)]
            runtime_polls,
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
            .send(Command::NewSession(mcp_servers, Opened::User, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Create a delegated child session (no MCP servers). It always starts
    /// in the approval start mode, so its permission requests reach the user
    /// even when the user let this agent keep its own (looser) default for
    /// chats. Where the agent has an option for it (Claude:
    /// `persistSession: false`), the child is not saved to the agent's own
    /// history, so it never shows in the agent's resume list (ADR 0003,
    /// amendment of 2026-10-29).
    pub async fn new_child_session(&self) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::NewSession(Vec::new(), Opened::Child, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Create a hidden Span session (no MCP servers). Its events, from the
    /// `Session` event on, go only to the sink set with
    /// [`Self::set_hidden_sink`]; it is left out of [`Self::list_sessions`];
    /// a sign-in failure is returned as an error that starts with
    /// "Authentication required" without raising `AuthRequired` in the chat;
    /// and a Stop it ignores ends only its turn, never the connection.
    pub async fn new_hidden_session(&self) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::NewSession(Vec::new(), Opened::Hidden, tx))
            .map_err(|_| "Agent disconnected")?;
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Where events of hidden sessions go. `None` drops them.
    pub fn set_hidden_sink(&self, sink: Option<EventSink>) {
        let hidden = self.state.lock().map(|bridge| bridge.hidden.clone());
        if let Ok(hidden) = hidden {
            if let Ok(mut hidden) = hidden.lock() {
                hidden.sink = sink;
            }
        }
    }
    /// The agent advertised `session/close`.
    pub fn can_close_sessions(&self) -> bool {
        self.state.lock().is_ok_and(|bridge| bridge.can_close)
    }
    /// The agent advertised `session/delete`.
    pub fn can_delete_sessions(&self) -> bool {
        self.state.lock().is_ok_and(|bridge| bridge.can_delete)
    }
    /// The process is still running (no shutdown, not exited).
    pub fn is_open(&self) -> bool {
        !*self.completion.borrow() && self.state.lock().is_ok_and(|bridge| !bridge.closed)
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
        if method.hint == Some(AgentHint::NeedsEnvironmentSetup) {
            return Err(format!(
                "{} needs setup in a terminal or environment variables, which Span does not do. Set it up, then connect again",
                method.name
            ));
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
    /// Sessions of the connection's workspace folder.
    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>, String> {
        self.list_sessions_in(false).await
    }
    /// Sessions of the workspace folder, or with `all_folders` every session
    /// the agent lists (no `cwd` filter); each summary carries its `cwd`.
    pub async fn list_sessions_in(&self, all_folders: bool) -> Result<Vec<SessionSummary>, String> {
        let listing = if all_folders {
            Listing::AllFolders
        } else {
            Listing::Folder
        };
        self.list(listing).await
    }
    /// Span's own health check sessions the agent still lists, in every
    /// folder: the ones recorded as hidden and the ones titled with the
    /// check prompt. Used by the health check cleanup only.
    pub async fn list_health_sessions(&self) -> Result<Vec<SessionSummary>, String> {
        self.list(Listing::Health).await
    }
    async fn list(&self, listing: Listing) -> Result<Vec<SessionSummary>, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::ListSessions(listing, tx))
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
        // A health check session is never resumed as a chat.
        if is_hidden_session(&session_id, None) {
            return Err("That session is a Span health check, not a chat".into());
        }
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
    /// True while a turn of `session_id` is in flight on the agent.
    pub fn is_running(&self, session_id: &str) -> bool {
        self.state
            .lock()
            .is_ok_and(|bridge| bridge.running.contains(session_id))
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
        if selected.is_empty() {
            bridge.rejected.insert(proposal.session.clone());
        }
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

/// Workspace root as sent to the agent in `session/new`, `session/load` and
/// `session/list`. `fs::canonicalize` gives a Windows verbatim path
/// (`\\?\C:\w`); agents join file names onto the cwd they are told, often with
/// `/`, and under a verbatim prefix `/` is a literal name character, so every
/// path the agent then names falls outside the workspace. The prefix is dropped
/// where a plain spelling exists (`\\?\C:\w` to `C:\w`, `\\?\UNC\h\s` to
/// `\\h\s`); any other path is returned unchanged.
fn agent_protocol_cwd(cwd: &std::path::Path) -> std::path::PathBuf {
    let text = cwd.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}").into();
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return rest.into();
        }
    }
    cwd.to_owned()
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
    // The adapter keeps the canonical root for its own path checks; the agent is
    // told the plain spelling (see `agent_protocol_cwd`).
    let protocol_cwd = agent_protocol_cwd(&cwd);
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
                let rejected = selected.as_ref().is_some_and(|choice| request.options.iter().any(|o| o.option_id.to_string() == *choice
                    && matches!(o.kind, PermissionOptionKind::RejectOnce | PermissionOptionKind::RejectAlways)));
                if rejected { if let Ok(mut bridge) = state.lock() { bridge.rejected.insert(session.clone()); } }
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
        .connect_with(crate::process::Process(agent), async move |cx: ConnectionTo<Agent>| {
            let initialized = tokio::time::timeout(std::time::Duration::from_secs(40), cx.send_request(InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
                ClientCapabilities::new().fs(FileSystemCapabilities::new().read_text_file(true).write_text_file(true)).terminal(false)
                    .session(ClientSessionCapabilities::new().notices(NoticeCapabilities::new()).compaction(CompactionCapabilities::new()))
                    .elicitation(ElicitationCapabilities::new().form(ElicitationFormCapabilities::new()).url(ElicitationUrlCapabilities::new()))
                    .auth(gateway_auth_capabilities())))
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
            // Ready and Capabilities are emitted before `start` resolves, so
            // whoever records them (the session manager's features) has done
            // so by the time the caller opens a session.
            emit(ready_event);
            emit(AgentEvent::Capabilities { can_load_session: can_load, can_list_sessions: can_list });
            let _ = ready.send(Ok(()));
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
                    Command::NewSession(servers, opened, reply) => {
                        let hidden = opened == Opened::Hidden;
                        let ephemeral = opened != Opened::User;
                        // The start mode is read from the user's settings only. If it
                        // cannot be read the session starts in the approval mode. A
                        // delegated child always does: no permission laundering.
                        let approval = opened == Opened::Child || workspace.lock().ok().and_then(|w| w.agent_start_mode(adapter.kind().id()).ok()).unwrap_or_default() == StartMode::Approval;
                        let mut params = serde_json::to_value(NewSessionRequest::new(protocol_cwd.clone())).unwrap_or_default();
                        params["mcpServers"] = json!(gated_mcp_servers(&state, &servers));
                        if let Some(meta) = adapter.approval_session_meta().filter(|_| approval) { merge_meta(&mut params, meta); }
                        if let Some(meta) = adapter.ephemeral_session_meta().filter(|_| ephemeral) { merge_meta(&mut params, meta); }
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
                        // A hidden session never changes what the chat shows: no sign-in card, no notice.
                        let emit: EventSink = if hidden { Arc::new(|_| {}) } else { emit.clone() };
                        if !hidden { if let Ok(mut bridge) = state.lock() { bridge.auth_required = needs_auth; } }
                        if let (true, Err(error), false) = (needs_auth, &result, hidden) { auth_required(&state, &emit, error, None); }
                        // An agent without ACP sessions cannot be used at all, so its
                        // connection ends; other failures keep the connection for the
                        // remaining sessions.
                        let unsupported = result.as_ref().err().is_some_and(|e| matches!(e.code, ErrorCode::MethodNotFound));
                        let result = result.map_err(|e| if needs_auth { auth_message(&e) } else { crate::compatibility::user_error("session/new", &e, &emit) });
                        let result = result.map(|(id, response)| {
                            if hidden {
                                if let Ok(mut ids) = HIDDEN_SESSIONS.lock() { ids.insert(id.clone()); }
                                let set = state.lock().map(|mut bridge| { bridge.delegated.insert(id.clone()); bridge.hidden.clone() });
                                if let Ok(set) = set { if let Ok(mut set) = set.lock() { set.ids.insert(id.clone()); } }
                            }
                            if let Ok(mut bridge) = state.lock() { bridge.sessions.insert(id.clone()); }
                            emit(AgentEvent::Session { session_id: id.clone() });
                            let options = adapter.session_config(&id, &response);
                            (id, options)
                        });
                        let result = match result {
                            Ok((id, options)) => {
                                let options = if approval { apply_start_mode(&cx, &adapter, &id, options, &emit).await } else { options };
                                if !options.is_empty() { emit_config(&emit, &adapter, &id, options); }
                                Ok(id)
                            }
                            Err(error) => Err(error),
                        };
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
                            if !bridge.running.insert(id.clone()) { return Err(crate::manager::PROMPT_ALREADY_RUNNING.to_string()); }
                            bridge.cancelled.remove(&id); bridge.rejected.remove(&id); Ok(())
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
                                Ok(response) => {
                                    let mut complete = prompt_adapter.complete(&id, &response);
                                    // OpenCode ends a turn `cancelled` after the user rejects a
                                    // permission; say so unless the user pressed Stop.
                                    let (rejected, stopped) = prompt_state.lock().map(|mut bridge| (bridge.rejected.remove(&id), bridge.cancelled.contains(&id))).unwrap_or((false, false));
                                    if let AgentEvent::Complete { stop_reason, hint, .. } = &mut complete {
                                        if stop_reason == "cancelled" && rejected && !stopped && hint.is_none() { *hint = Some(AgentHint::RejectedByUser); }
                                    }
                                    prompt_emit(complete); let _ = reply.send(Ok(()));
                                }
                                Err(error) => {
                                    // OpenCode reports a missing sign-in only here; any agent may.
                                    let hidden = prompt_state.lock().ok().and_then(|bridge| bridge.hidden.lock().ok().map(|h| h.ids.contains(&id))).unwrap_or(false);
                                    if hidden && error.code == ErrorCode::AuthRequired { let _ = reply.send(Err(auth_message(&error))); return Ok(()); }
                                    if error.code == ErrorCode::AuthRequired { auth_required(&prompt_state, &prompt_emit, &error, Some(&id)); }
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
                                    emit_config(&set_emit, &set_adapter, &id, options);
                                    let _ = reply.send(Ok(()));
                                }
                                Ok(Err(error)) => { let _ = reply.send(Err(error.to_string())); }
                                Err(_) => { let _ = reply.send(Err("The agent did not apply the change within 20 seconds".into())); }
                            }
                            Ok(())
                        })?;
                    }
                    Command::ListSessions(listing, reply) => {
                        if !can_list { let _ = reply.send(Err("This agent cannot list earlier sessions".into())); continue; }
                        let list_cx = cx.clone(); let list_cwd = protocol_cwd.clone(); let list_state = state.clone(); let list_emit = emit.clone();
                        let list_adapter = state.lock().map(|bridge| bridge.adapter.clone()).unwrap_or_default();
                        cx.spawn(async move {
                            let span_own = list_state.lock().ok().and_then(|bridge| bridge.hidden.lock().ok().map(|h| h.ids.clone())).unwrap_or_default();
                            let health = move |summary: &SessionSummary| span_own.contains(&summary.session_id) || is_hidden_session(&summary.session_id, summary.title.as_deref());
                            let folder = (listing == Listing::Folder).then_some(list_cwd);
                            let result = if listing == Listing::Health {
                                list_all_sessions(&list_cx, None, health, |_, _| {}).await
                            } else {
                                // Health sessions and delegated children (ADR 0003) are dropped page by page, so they never use up the cap.
                                list_all_sessions(&list_cx, folder, move |summary| !health(summary) && !crate::delegated::is_delegated_session(&summary.session_id), move |summary, meta| list_adapter.mark_listed(summary, meta)).await.map(|found| {
                                    let mut kept = hide_deleted(&list_state, &list_emit, found);
                                    kept.truncate(LIST_MAX_SESSIONS);
                                    kept
                                })
                            };
                            let _ = reply.send(result);
                            Ok(())
                        })?;
                    }
                    Command::LoadSession(id, servers, reply) => {
                        if !can_load { let _ = reply.send(Err("This agent cannot restore earlier sessions".into())); continue; }
                        if let Ok(mut bridge) = state.lock() { bridge.sessions.insert(id.clone()); }
                        let load_cx = cx.clone(); let load_emit = emit.clone(); let load_cwd = protocol_cwd.clone(); let load_state = state.clone(); let load_adapter = adapter.clone();
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
                                    if !options.is_empty() { emit_config(&load_emit, &load_adapter, &id, options); }
                                    if let Some(quiet) = profile.replay_quiet { replay_settled(&load_state, &id, quiet).await; }
                                    let _ = reply.send(Ok(()));
                                }
                                other => {
                                    if let Ok(mut bridge) = load_state.lock() { bridge.sessions.remove(&id); bridge.replaying.remove(&id); }
                                    if let Ok(Err(error)) = other.as_ref() {
                                        if error.code == ErrorCode::AuthRequired { auth_required(&load_state, &load_emit, error, Some(&id)); }
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
                            if result.is_ok() {
                                forget_session(&delete_state, &id);
                                if let Ok(mut bridge) = delete_state.lock() { bridge.deleted.insert(id.clone()); }
                            }
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

const AUTH_PREFIX: &str = "Authentication required";

/// The user facing text of an `-32000` error. The prefix is added only when
/// the agent's text does not already start with it (OpenCode's does).
fn auth_message(error: &agent_client_protocol::Error) -> String {
    let text = error.to_string();
    if text
        .to_ascii_lowercase()
        .starts_with(&AUTH_PREFIX.to_ascii_lowercase())
    {
        text
    } else {
        format!("{AUTH_PREFIX}: {text}")
    }
}

/// Whether an `-32000` message reads as a request to sign in. Gemini 0.46.0
/// sends an account tier notice ("This client is no longer supported ...")
/// with the same code, which is not.
fn reads_as_sign_in(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "auth",
        "sign in",
        "sign-in",
        "log in",
        "login",
        "logged in",
        "credential",
        "api key",
        "unauthori",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

/// Emit `AuthRequired` for an `-32000` error from any request. `session` is
/// the session the failed request was for, when there is one.
fn auth_required(
    state: &Arc<Mutex<Bridge>>,
    emit: &EventSink,
    error: &agent_client_protocol::Error,
    session: Option<&str>,
) {
    let (methods, adapter) = state
        .lock()
        .map(|mut bridge| {
            bridge.auth_required = true;
            (bridge.auth_methods.clone(), bridge.adapter.clone())
        })
        .unwrap_or_default();
    emit(AgentEvent::AuthRequired {
        message: auth_message(error),
        auth_methods: methods,
        hint: adapter.auth_hint(session),
        agent_message: (!reads_as_sign_in(&error.message)).then(|| error.message.clone()),
    });
}

/// Emit a `Config` event and whatever the adapter derives from it (the
/// permission bypass notice).
/// Under the approval start mode, move a session that started in a bypass
/// mode (from the agent's own configuration) to the agent's approval mode
/// before the UI sees its options. When the agent refuses, the options come
/// back unchanged, so the mode chip and the bypass notice still say what the
/// session really runs in.
async fn apply_start_mode(
    cx: &ConnectionTo<Agent>,
    adapter: &Adapter,
    id: &str,
    options: Vec<ConfigOption>,
    emit: &EventSink,
) -> Vec<ConfigOption> {
    let Some((config_id, value)) = adapter.approval_change(&options) else {
        return options;
    };
    let route = adapter.route(id, &config_id);
    let request = match route {
        ConfigRoute::Option => raw_request(
            cx,
            "session/set_config_option",
            serde_json::to_value(SetSessionConfigOptionRequest::new(
                id.to_owned(),
                config_id.clone(),
                value.as_str(),
            ))
            .unwrap_or_default(),
        ),
        ConfigRoute::Mode => raw_request(
            cx,
            "session/set_mode",
            serde_json::to_value(SetSessionModeRequest::new(id.to_owned(), value.clone()))
                .unwrap_or_default(),
        ),
        ConfigRoute::Model => return options,
    };
    match tokio::time::timeout(std::time::Duration::from_secs(20), request).await {
        Ok(Ok(response)) => {
            let applied = match route {
                ConfigRoute::Option => config_options_value(response.get("configOptions")),
                _ => adapter.legacy_applied(id, &config_id, &value),
            };
            if !applied.is_empty() {
                return applied;
            }
            // An agent that answers `{}` accepted the change without listing options.
            let mut options = options;
            for option in options.iter_mut().filter(|o| o.id == config_id) {
                option.current_value = value.clone();
            }
            options
        }
        Ok(Err(error)) => {
            emit(AgentEvent::Log {
                direction: "Client".into(),
                line: format!("Start mode: the agent kept its own mode ({error})"),
            });
            options
        }
        Err(_) => {
            emit(AgentEvent::Log {
                direction: "Client".into(),
                line: "Start mode: the agent did not change mode within 20 seconds".into(),
            });
            options
        }
    }
}

fn emit_config(emit: &EventSink, adapter: &Adapter, session: &str, options: Vec<ConfigOption>) {
    let event = AgentEvent::Config {
        session_id: session.to_owned(),
        options,
    };
    let extra = adapter.observe(session, &event);
    emit(event);
    for event in extra {
        emit(event);
    }
}

/// Pages followed for one `session/list`. Codex 2.3.0 returns empty pages
/// that still carry a cursor (four pages to reach one session in a live
/// run), so the cursor is followed until it is null, a cursor repeats, the
/// page cap or the session cap is reached, or the time budget runs out.
const LIST_MAX_PAGES: usize = 50;
/// Overall time for one `list_sessions`, across pages.
const LIST_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);
/// Time for one page.
const LIST_PAGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// Sessions returned at most.
const LIST_MAX_SESSIONS: usize = 100;

async fn list_all_sessions(
    cx: &ConnectionTo<Agent>,
    cwd: Option<std::path::PathBuf>,
    keep: impl Fn(&SessionSummary) -> bool,
    mark: impl Fn(&mut SessionSummary, Option<&Value>),
) -> Result<Vec<SessionSummary>, String> {
    let deadline = tokio::time::Instant::now() + LIST_BUDGET;
    let mut found: Vec<SessionSummary> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen: HashSet<String> = HashSet::new();
    for _ in 0..LIST_MAX_PAGES {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let wait = remaining.min(LIST_PAGE_TIMEOUT);
        let request = ListSessionsRequest::new()
            .cwd(cwd.clone())
            .cursor(cursor.clone());
        match tokio::time::timeout(wait, cx.send_request(request).block_task()).await {
            Ok(Ok(page)) => {
                found.extend(
                    page.sessions
                        .into_iter()
                        .map(|info| {
                            let mut summary = SessionSummary {
                                session_id: info.session_id.to_string(),
                                title: info.title,
                                updated_at: info.updated_at,
                                cwd: Some(info.cwd.to_string_lossy().into_owned()),
                                parent_session_id: None,
                                native_subagent: false,
                            };
                            mark(&mut summary, info.meta.map(Value::Object).as_ref());
                            summary
                        })
                        .filter(|summary| keep(summary)),
                );
                cursor = page.next_cursor;
            }
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) if found.is_empty() => {
                return Err(format!(
                    "The agent did not list sessions within {}",
                    spoken_seconds(wait)
                ))
            }
            // Keep what earlier pages returned.
            Err(_) => break,
        }
        if found.len() >= LIST_MAX_SESSIONS {
            break;
        }
        match &cursor {
            Some(next) if seen.insert(next.clone()) => {}
            _ => break,
        }
    }
    Ok(found)
}

/// Remove sessions the user deleted on this connection from a listing. A
/// deleted session the agent still lists is reported once, as a notice for
/// that session with the `deletedStillListed` hint.
fn hide_deleted(
    state: &Arc<Mutex<Bridge>>,
    emit: &EventSink,
    found: Vec<SessionSummary>,
) -> Vec<SessionSummary> {
    let mut newly_seen = Vec::new();
    let kept = match state.lock() {
        Ok(mut bridge) => {
            let span_own = bridge
                .hidden
                .lock()
                .map(|h| h.ids.clone())
                .unwrap_or_default();
            let (hidden, kept): (Vec<_>, Vec<_>) = found
                .into_iter()
                .filter(|summary| {
                    !span_own.contains(&summary.session_id)
                        && !is_hidden_session(&summary.session_id, summary.title.as_deref())
                })
                .partition(|summary| bridge.deleted.contains(&summary.session_id));
            for summary in hidden {
                if bridge.deleted_listed.insert(summary.session_id.clone()) {
                    newly_seen.push(summary.session_id);
                }
            }
            kept
        }
        Err(_) => found,
    };
    for session_id in newly_seen {
        emit(AgentEvent::Notice {
            session_id,
            severity: "info".into(),
            title: String::new(),
            description: None,
            notice_id: Some("span/deleted-still-listed".into()),
            hint: Some(AgentHint::DeletedStillListed),
        });
    }
    kept
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
/// `auth._meta.gateway = true`: the client can send a gateway base URL and
/// headers in `authenticate` `_meta`, so Claude Code and Codex offer their
/// `gateway` sign-in methods. The values are typed by the user, passed once and
/// never stored by Span.
fn gateway_auth_capabilities() -> AuthCapabilities {
    let mut meta = Meta::new();
    meta.insert("gateway".into(), json!(true));
    AuthCapabilities::new().meta(meta)
}

/// A method with `_meta.gateway` takes a gateway base URL and headers, from
/// any agent. Its `protocol`, when given, names what the gateway must speak.
fn gateway_method(method: &mut AuthMethodInfo, meta: Option<&Value>) {
    let Some(gateway) = meta.and_then(|meta| meta.get("gateway")) else {
        return;
    };
    if gateway.is_null() {
        return;
    }
    method.input = Some(AuthInput::Gateway);
    method.gateway_protocol = gateway
        .get("protocol")
        .and_then(Value::as_str)
        .map(str::to_owned);
}

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
                gateway_protocol: None,
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
                gateway_method(&mut method, meta.as_ref());
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

/// Merge `meta` into the request's `_meta`, object by object, so two
/// adapter options (the approval mode's and an ephemeral session's) both
/// reach the agent.
fn merge_meta(params: &mut Value, meta: Value) {
    fn merge(into: &mut Value, from: Value) {
        match (into, from) {
            (Value::Object(into), Value::Object(from)) => {
                for (key, value) in from {
                    merge(into.entry(key).or_insert(Value::Null), value);
                }
            }
            (into, from) => *into = from,
        }
    }
    merge(&mut params["_meta"], meta);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "s3cr3t-token-value";

    #[test]
    fn the_agent_is_told_a_plain_cwd_without_the_verbatim_prefix() {
        let plain = |text: &str| agent_protocol_cwd(std::path::Path::new(text));
        assert_eq!(
            plain(r"\\?\C:\Users\runner\Temp\.tmpX"),
            std::path::PathBuf::from(r"C:\Users\runner\Temp\.tmpX")
        );
        assert_eq!(
            plain(r"\\?\UNC\host\share\w"),
            std::path::PathBuf::from(r"\\host\share\w")
        );
        // Verbatim forms without a drive spelling and ordinary paths are kept.
        let guid = r"\\?\Volume{0b1c2d3e-0000-0000-0000-000000000000}\w";
        assert_eq!(plain(guid), std::path::PathBuf::from(guid));
        assert_eq!(plain(r"C:\w"), std::path::PathBuf::from(r"C:\w"));
        assert_eq!(plain("/private/w"), std::path::PathBuf::from("/private/w"));
    }

    #[test]
    fn a_child_session_meta_keeps_the_approval_options_and_adds_persist_session() {
        let mut params = json!({"cwd": "/w", "mcpServers": []});
        merge_meta(
            &mut params,
            json!({"claudeCode": {"options": {"disallowedTools": ["ListAgents"]}}}),
        );
        merge_meta(
            &mut params,
            json!({"claudeCode": {"options": {"persistSession": false}}}),
        );
        assert_eq!(
            params["_meta"],
            json!({"claudeCode": {"options": {"disallowedTools": ["ListAgents"], "persistSession": false}}})
        );
        assert_eq!(params["cwd"], "/w");
    }

    #[tokio::test]
    async fn completed_prompt_leaves_the_process_client_idle() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Arc::new(Mutex::new(
            CoreWorkspace::open(directory.path())
                .unwrap()
                .with_user_settings(None),
        ));
        let service = AgentService::start(
            AgentCommand {
                command: "node".into(),
                args: vec![format!(
                    "{}/tests/fixtures/agent.mjs",
                    env!("CARGO_MANIFEST_DIR")
                )],
                env: Default::default(),
            },
            directory.path().to_string_lossy().into_owned(),
            workspace,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let session = service.new_session().await.unwrap();
        service
            .prompt(session.clone(), "echo".into(), vec![])
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let before = service
            .runtime_polls
            .load(std::sync::atomic::Ordering::Relaxed);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let polls = service
            .runtime_polls
            .load(std::sync::atomic::Ordering::Relaxed)
            - before;
        // Readiness must still deliver the next request after the idle window.
        service
            .prompt(session, "echo".into(), vec![])
            .await
            .unwrap();
        service.shutdown_and_wait().await.unwrap();
        assert!(
            polls < 100,
            "Idle ACP connection was polled {polls} times in 200 ms"
        );
    }

    /// Claude Code and Codex offer their gateway methods only when the client
    /// sets `clientCapabilities.auth._meta.gateway` to true.
    #[test]
    fn initialize_advertises_gateway_auth() {
        let caps = ClientCapabilities::new().auth(gateway_auth_capabilities());
        let value = serde_json::to_value(&caps).unwrap();
        assert_eq!(value.pointer("/auth/_meta/gateway"), Some(&json!(true)));
    }

    /// Captured method shapes: Claude Code 0.98.0 `gateway` (anthropic) and
    /// `gateway-bedrock`, Codex `gateway` (openai).
    #[test]
    fn gateway_methods_take_a_gateway_and_keep_the_protocol() {
        let method = |meta: Value| {
            let mut info = AuthMethodInfo {
                id: "gateway".into(),
                name: "Custom model gateway".into(),
                description: None,
                kind: "agent".into(),
                supported: true,
                input: None,
                gateway_protocol: None,
                hint: None,
            };
            gateway_method(&mut info, Some(&meta));
            info
        };
        for protocol in ["anthropic", "bedrock", "openai"] {
            let info =
                method(json!({"gateway": {"protocol": protocol, "restartRequired": "false"}}));
            assert_eq!(info.input, Some(AuthInput::Gateway));
            assert_eq!(info.gateway_protocol.as_deref(), Some(protocol));
        }
        let bare = method(json!({"gateway": {}}));
        assert_eq!(bare.input, Some(AuthInput::Gateway));
        assert_eq!(bare.gateway_protocol, None);
        let other = method(json!({"api-key": {"provider": "openai"}}));
        assert_eq!(other.input, None);
        assert_eq!(method(json!({"gateway": null})).input, None);
    }

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

    /// Live captures (Claude Code 0.98.0, Codex 2.3.0): `_auth/status_update`
    /// names the signed-in account.
    #[test]
    fn auth_status_params_are_redacted_and_the_method_kept() {
        let line = json!({"jsonrpc": "2.0", "method": "_auth/status_update", "params": {"authStatus": {"kind": "account", "label": "Claude Max",
            "account": {"plan": "Claude Max", "email": "person@example.com", "organization": "person@example.com's Organization"}}}}).to_string();
        let redacted = redact_log(&line);
        assert!(!redacted.contains("person@example.com"), "{redacted}");
        assert!(!redacted.contains("Claude Max"), "{redacted}");
        let parsed: Value = serde_json::from_str(&redacted).unwrap();
        assert_eq!(parsed["method"], "_auth/status_update");
        assert_eq!(parsed["params"], REDACTED);
    }

    #[test]
    fn auth_messages_are_prefixed_once() {
        let error = |message: &str| agent_client_protocol::Error::new(-32000, message.to_owned());
        // OpenCode 2.0.32 already starts with the prefix.
        let opencode = error("Authentication required: provider authentication required");
        assert_eq!(
            auth_message(&opencode),
            "Authentication required: provider authentication required"
        );
        let tier =
            error("This client is no longer supported for Gemini Code Assist for individuals.");
        assert_eq!(
            auth_message(&tier),
            "Authentication required: This client is no longer supported for Gemini Code Assist for individuals."
        );
        assert!(reads_as_sign_in(&opencode.message));
        assert!(reads_as_sign_in("Unauthorized: no provider credentials"));
        assert!(!reads_as_sign_in(&tier.message));
    }
}
