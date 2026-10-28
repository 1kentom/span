use crate::{
    AgentCommand, AgentEvent, AgentFeatures, AuthMethodInfo, ConfigChoice, ConfigGroup,
    ConfigOption, PermissionOption, PlanEntry, PromptAttachment, SessionSummary, SlashCommand,
};
use agent_client_protocol::schema::{v1::*, ProtocolVersion};
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo};
use serde_json::Value;
use span_core::CoreWorkspace;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

pub type EventSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;
type Reply<T> = oneshot::Sender<Result<T, String>>;

#[derive(Clone)]
pub struct AgentService {
    tx: mpsc::UnboundedSender<Command>,
    state: Arc<Mutex<Bridge>>,
    workspace: Arc<Mutex<CoreWorkspace>>,
}

enum Command {
    NewSession(Reply<String>),
    Prompt(String, Vec<ContentBlock>, Reply<()>),
    Authenticate(String, Reply<()>),
    Cancel(String),
    SetConfig(String, String, String, Reply<()>),
    ListSessions(Reply<Vec<SessionSummary>>),
    LoadSession(String, Reply<()>),
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
        let config = crate::launch::prepare_command(config)?;
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
        })
    }

    pub async fn new_session(&self) -> Result<String, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::NewSession(tx))
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
        rx.await.map_err(|_| "Agent disconnected".to_string())?
    }
    /// Call `authenticate` with an advertised `agent` method. Create the session afterwards.
    pub async fn authenticate(&self, method_id: String) -> Result<(), String> {
        {
            let bridge = self.state.lock().map_err(|_| "Agent state lock poisoned")?;
            match bridge.auth_methods.iter().find(|m| m.id == method_id) {
                None => return Err("Unknown authentication method".into()),
                Some(method) if !method.supported => {
                    return Err("Terminal sign-in is not supported by this client".into())
                }
                Some(_) => {}
            }
        }
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Authenticate(method_id, tx))
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
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::LoadSession(session_id, tx))
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

async fn run(
    config: AgentCommand,
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
            line: line.chars().take(16_384).collect(),
        })
    });
    let notifications = emit.clone();
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
            if let Ok(update) = serde_json::to_value(notification.update) {
                session_update(&notifications, notification.session_id.to_string(), update);
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
                let selected = if id.is_empty() { automatic } else {
                    emit(AgentEvent::Permission { session_id: session.clone(), request_id: id.clone(), tool_call_id: request.tool_call.tool_call_id.to_string(),
                        title: request.tool_call.fields.title.unwrap_or_else(|| "Agent operation".into()), options: request.options.iter().map(|o| PermissionOption {
                            option_id: o.option_id.to_string(), name: o.name.clone(), kind: enum_string(&o.kind) }).collect() });
                    let decision = rx.await.ok().flatten();
                    emit(AgentEvent::PermissionResolved { session_id: session.clone(), request_id: id });
                    decision
                };
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
            if let Err(error) = initialized { let message = error.to_string(); let _ = ready.send(Err(message)); return Err(error); }
            if initialized.as_ref().is_ok_and(|response| response.protocol_version != ProtocolVersion::V1) {
                let _ = ready.send(Err("Agent negotiated an unsupported protocol version".into())); return Ok(());
            }
            let (can_load, can_list) = initialized.as_ref().ok().map(|response| (response.agent_capabilities.load_session, response.agent_capabilities.session_capabilities.list.is_some())).unwrap_or((false, false));
            let (ready_event, auth_methods) = match initialized.as_ref().ok() {
                Some(response) => ready_event(response),
                None => (AgentEvent::Ready { agent_name: None, agent_title: None, agent_version: None, features: AgentFeatures::default(), auth_methods: Vec::new() }, Vec::new()),
            };
            if let (Ok(mut bridge), AgentEvent::Ready { features, .. }) = (state.lock(), &ready_event) {
                bridge.prompt_image = features.image;
                bridge.prompt_embedded = features.embedded_context;
                bridge.can_close = features.can_close_sessions;
                bridge.can_delete = features.can_delete_sessions;
                bridge.auth_methods = auth_methods.clone();
            }
            let _ = ready.send(Ok(()));
            emit(ready_event);
            emit(AgentEvent::Capabilities { can_load_session: can_load, can_list_sessions: can_list });
            emit(AgentEvent::Status { state: "connected".into(), message: "ACP initialized. Agent process has your OS privileges.".into() });
            let mut cancel_deadline: Option<tokio::time::Instant> = None;
            loop {
                let command = tokio::select! {
                    command = rx.recv() => match command { Some(command) => command, None => break },
                    _ = cx.incoming_closed() => break,
                    _ = tokio::time::sleep_until(cancel_deadline.unwrap_or_else(|| tokio::time::Instant::now() + std::time::Duration::from_secs(86400))), if cancel_deadline.is_some() => {
                        cancel_deadline = None;
                        let unresponsive = state.lock().map(|bridge| bridge.running.iter().any(|id| bridge.cancelled.contains(id))).unwrap_or(true);
                        if unresponsive {
                            emit(AgentEvent::Error { message: "Agent did not acknowledge Stop within five seconds. Its connection was terminated.".into() });
                            break;
                        }
                        continue;
                    },
                };
                match command {
                    Command::NewSession(reply) => {
                        let result = tokio::time::timeout(std::time::Duration::from_secs(30), cx.send_request(NewSessionRequest::new(cwd.clone())).block_task()).await;
                        let result = match result {
                            Ok(result) => result,
                            Err(_) => { let _ = reply.send(Err("Agent session creation timed out after 30 seconds".into())); break; }
                        };
                        let options = result.as_ref().ok().and_then(|response| response.config_options.as_ref()).map(|options| config_options(options)).unwrap_or_default();
                        let needs_auth = result.as_ref().err().is_some_and(|e| e.code == ErrorCode::AuthRequired);
                        if let Ok(mut bridge) = state.lock() { bridge.auth_required = needs_auth; }
                        if needs_auth {
                            let message = result.as_ref().err().map(|e| e.to_string()).unwrap_or_default();
                            let methods = state.lock().map(|b| b.auth_methods.clone()).unwrap_or_default();
                            emit(AgentEvent::AuthRequired { message: format!("Authentication required: {message}"), auth_methods: methods });
                        }
                        let result = result.map(|response| response.session_id.to_string()).map_err(|e| if needs_auth { format!("Authentication required: {e}") } else { e.to_string() });
                        if let Ok(id) = &result {
                            if let Ok(mut bridge) = state.lock() { bridge.sessions.insert(id.clone()); }
                            emit(AgentEvent::Session { session_id: id.clone() });
                            if !options.is_empty() { emit(AgentEvent::Config { session_id: id.clone(), options }); }
                        }
                        let _ = reply.send(result);
                    }
                    Command::Authenticate(method_id, reply) => {
                        let auth_cx = cx.clone(); let auth_state = state.clone();
                        cx.spawn(async move {
                            let result = tokio::time::timeout(std::time::Duration::from_secs(120), auth_cx.send_request(AuthenticateRequest::new(method_id)).block_task()).await;
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
                            if !bridge.running.insert(id.clone()) { return Err("A prompt is already running in this session".to_string()); }
                            bridge.cancelled.remove(&id); Ok(())
                        }).unwrap_or_else(|_| Err("Agent state lock poisoned".into()));
                        if let Err(error) = valid { let _ = reply.send(Err(error)); continue; }
                        let prompt_cx = cx.clone(); let prompt_emit = emit.clone(); let prompt_state = state.clone();
                        cx.spawn(async move {
                            let result = prompt_cx.send_request(PromptRequest::new(id.clone(), blocks)).block_task().await;
                            if let Ok(mut bridge) = prompt_state.lock() { bridge.running.remove(&id); }
                            match result {
                                Ok(response) => { prompt_emit(AgentEvent::Complete { session_id: id, stop_reason: enum_string(&response.stop_reason) }); let _ = reply.send(Ok(())); }
                                Err(error) => { let message = error.to_string(); prompt_emit(AgentEvent::Error { message: message.clone() }); let _ = reply.send(Err(message)); }
                            }
                            Ok(())
                        })?;
                    }
                    Command::SetConfig(id, config_id, value, reply) => {
                        let known = state.lock().map(|bridge| !bridge.closed && bridge.sessions.contains(&id)).unwrap_or(false);
                        if !known { let _ = reply.send(Err("Unknown session".into())); continue; }
                        let set_cx = cx.clone(); let set_emit = emit.clone();
                        cx.spawn(async move {
                            let request = SetSessionConfigOptionRequest::new(id.clone(), config_id, value.as_str());
                            let result = tokio::time::timeout(std::time::Duration::from_secs(20), set_cx.send_request(request).block_task()).await;
                            match result {
                                Ok(Ok(response)) => {
                                    set_emit(AgentEvent::Config { session_id: id, options: config_options(&response.config_options) });
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
                    Command::LoadSession(id, reply) => {
                        if !can_load { let _ = reply.send(Err("This agent cannot restore earlier sessions".into())); continue; }
                        if let Ok(mut bridge) = state.lock() { bridge.sessions.insert(id.clone()); }
                        let load_cx = cx.clone(); let load_emit = emit.clone(); let load_cwd = cwd.clone(); let load_state = state.clone();
                        cx.spawn(async move {
                            let request = LoadSessionRequest::new(id.clone(), load_cwd);
                            let result = tokio::time::timeout(std::time::Duration::from_secs(60), load_cx.send_request(request).block_task()).await;
                            match result {
                                Ok(Ok(response)) => {
                                    if let Some(options) = response.config_options.as_ref().map(|options| config_options(options)).filter(|options| !options.is_empty()) {
                                        load_emit(AgentEvent::Config { session_id: id, options });
                                    }
                                    let _ = reply.send(Ok(()));
                                }
                                other => {
                                    if let Ok(mut bridge) = load_state.lock() { bridge.sessions.remove(&id); }
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
                            cancel_deadline = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(5));
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
                        cancel_deadline = Some(tokio::time::Instant::now() + std::time::Duration::from_secs(5));
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

fn blocks_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
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
fn ready_event(response: &InitializeResponse) -> (AgentEvent, Vec<AuthMethodInfo>) {
    let caps = &response.agent_capabilities;
    let auth_methods: Vec<AuthMethodInfo> = response
        .auth_methods
        .iter()
        .map(|method| match method {
            AuthMethod::Agent(m) => AuthMethodInfo {
                id: m.id.to_string(),
                name: m.name.clone(),
                description: m.description.clone(),
                kind: "agent".into(),
                supported: true,
            },
            AuthMethod::Terminal(m) => AuthMethodInfo {
                id: m.id.to_string(),
                name: m.name.clone(),
                description: m.description.clone(),
                kind: "terminal".into(),
                supported: false,
            },
            _ => AuthMethodInfo {
                id: String::new(),
                name: "Unknown method".into(),
                description: None,
                kind: "unknown".into(),
                supported: false,
            },
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
/// Reduce the agent's select options to the shape the panel renders.
/// Other option kinds are dropped: the panel has no control for them.
fn config_options(options: &[SessionConfigOption]) -> Vec<ConfigOption> {
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let choice = |value: &Value| {
        Some(ConfigChoice {
            value: text(value, "value")?,
            name: text(value, "name").or_else(|| text(value, "value"))?,
            description: text(value, "description"),
        })
    };
    options
        .iter()
        .filter_map(|option| {
            let value = serde_json::to_value(option).ok()?;
            let current_value = text(&value, "currentValue")?;
            let entries = value.get("options")?.as_array()?;
            let mut groups: Vec<ConfigGroup> = Vec::new();
            let mut loose: Vec<ConfigChoice> = Vec::new();
            for entry in entries {
                if let Some(members) = entry.get("options").and_then(Value::as_array) {
                    groups.push(ConfigGroup {
                        name: text(entry, "name").unwrap_or_default(),
                        choices: members.iter().filter_map(choice).collect(),
                    });
                } else if let Some(found) = choice(entry) {
                    loose.push(found);
                }
            }
            if !loose.is_empty() {
                groups.insert(
                    0,
                    ConfigGroup {
                        name: String::new(),
                        choices: loose,
                    },
                );
            }
            Some(ConfigOption {
                id: text(&value, "id")?,
                name: text(&value, "name")?,
                description: text(&value, "description"),
                category: text(&value, "category"),
                current_value,
                groups,
            })
        })
        .collect()
}
fn session_update(emit: &EventSink, session_id: String, update: Value) {
    let string = |key: &str| {
        update
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    match string("sessionUpdate").as_str() {
        "agent_message_chunk" | "agent_thought_chunk" => {
            let text = update
                .pointer("/content/text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if string("sessionUpdate") == "agent_message_chunk" {
                emit(AgentEvent::Text { session_id, text });
            } else {
                emit(AgentEvent::Thought { session_id, text });
            }
        }
        "user_message_chunk" => {
            let text = update
                .pointer("/content/text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if !text.is_empty() {
                emit(AgentEvent::User { session_id, text });
            }
        }
        "available_commands_update" => {
            let commands = update
                .get("availableCommands")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            Some(SlashCommand {
                                name: item.get("name")?.as_str()?.to_owned(),
                                description: item
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                                input_hint: item
                                    .pointer("/input/hint")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            emit(AgentEvent::AvailableCommands {
                session_id,
                commands,
            });
        }
        "current_mode_update" => {
            if let Some(mode_id) = update.get("currentModeId").and_then(Value::as_str) {
                emit(AgentEvent::CurrentMode {
                    session_id,
                    mode_id: mode_id.to_owned(),
                });
            }
        }
        "session_info_update" => emit(AgentEvent::SessionInfo {
            session_id,
            title: update
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned),
            updated_at: update
                .get("updatedAt")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        "usage_update" => {
            if let (Some(used), Some(size)) = (
                update.get("used").and_then(Value::as_u64),
                update.get("size").and_then(Value::as_u64),
            ) {
                emit(AgentEvent::Usage {
                    session_id,
                    used,
                    size,
                    cost_amount: update.pointer("/cost/amount").and_then(Value::as_f64),
                    cost_currency: update
                        .pointer("/cost/currency")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
        }
        "notice" => {
            if let Some(title) = update.get("title").and_then(Value::as_str) {
                emit(AgentEvent::Notice {
                    session_id,
                    severity: string("severity"),
                    title: title.to_owned(),
                    description: update
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
        }
        "compaction_update" => emit(AgentEvent::Compaction {
            session_id,
            compaction_id: string("compactionId"),
            status: string("status"),
            summary: update
                .get("summary")
                .and_then(Value::as_array)
                .map(|blocks| blocks_text(blocks))
                .filter(|text| !text.is_empty()),
            error: update
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        "compaction_summary_chunk" => {
            let text = blocks_text(std::slice::from_ref(
                update.get("content").unwrap_or(&Value::Null),
            ));
            if !text.is_empty() {
                emit(AgentEvent::CompactionSummary {
                    session_id,
                    compaction_id: string("compactionId"),
                    text,
                });
            }
        }
        "config_option_update" => {
            let options = update
                .get("configOptions")
                .and_then(|value| {
                    serde_json::from_value::<Vec<SessionConfigOption>>(value.clone()).ok()
                })
                .map(|options| config_options(&options))
                .unwrap_or_default();
            if !options.is_empty() {
                emit(AgentEvent::Config {
                    session_id,
                    options,
                });
            }
        }
        "plan" => {
            let entries = update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| PlanEntry {
                            content: entry["content"].as_str().unwrap_or_default().into(),
                            priority: entry["priority"].as_str().unwrap_or_default().into(),
                            status: entry["status"].as_str().unwrap_or_default().into(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            emit(AgentEvent::Plan {
                session_id,
                entries,
            });
        }
        "tool_call" | "tool_call_update" => emit(AgentEvent::Tool {
            session_id,
            tool_call_id: string("toolCallId"),
            title: update
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned),
            status: update
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned),
            tool_kind: update
                .get("kind")
                .and_then(Value::as_str)
                .map(str::to_owned),
            parent_tool_call_id: update
                .pointer("/_meta/claudeCode/parentToolUseId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            content_json: update.to_string(),
        }),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(json: Value) -> Vec<ConfigOption> {
        config_options(&serde_json::from_value::<Vec<SessionConfigOption>>(json).unwrap())
    }

    #[test]
    fn flat_and_grouped_select_options_are_reduced() {
        let parsed = options(serde_json::json!([
            {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "fast",
             "options": [{"value": "fast", "name": "Fast"}, {"value": "deep", "name": "Deep", "description": "Slower"}]},
            {"id": "mode", "name": "Mode", "type": "select", "currentValue": "b",
             "options": [{"group": "g", "name": "Group", "options": [{"value": "b", "name": "B"}]}]}
        ]));
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].category.as_deref(), Some("model"));
        assert_eq!(parsed[0].current_value, "fast");
        assert_eq!(parsed[0].groups[0].choices.len(), 2);
        assert_eq!(
            parsed[0].groups[0].choices[1].description.as_deref(),
            Some("Slower")
        );
        assert_eq!(parsed[1].groups[0].name, "Group");
        assert_eq!(parsed[1].groups[0].choices[0].value, "b");
    }
}
