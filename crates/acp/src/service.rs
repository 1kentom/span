use crate::{AgentCommand, AgentEvent, PermissionOption, PlanEntry};
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
    Prompt(String, String, Reply<()>),
    Cancel(String),
    Shutdown,
}
struct Permission {
    session: String,
    scope: String,
    options: Vec<agent_client_protocol::schema::v1::PermissionOption>,
    reply: oneshot::Sender<Option<String>>,
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
}

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
    pub async fn prompt(&self, session_id: String, text: String) -> Result<(), String> {
        if text.trim().is_empty() {
            return Err("Prompt cannot be empty".into());
        }
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Prompt(session_id, text, tx))
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
                ClientCapabilities::new().fs(FileSystemCapabilities::new().read_text_file(true).write_text_file(true)).terminal(false)))
                .block_task()).await;
            let initialized = match initialized {
                Ok(result) => result,
                Err(_) => { let _ = ready.send(Err("Agent initialization timed out after 40 seconds".into())); return Ok(()); }
            };
            if let Err(error) = initialized { let message = error.to_string(); let _ = ready.send(Err(message)); return Err(error); }
            if initialized.as_ref().is_ok_and(|response| response.protocol_version != ProtocolVersion::V1) {
                let _ = ready.send(Err("Agent negotiated an unsupported protocol version".into())); return Ok(());
            }
            let _ = ready.send(Ok(()));
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
                        let result = result.map(|response| response.session_id.to_string()).map_err(|e| e.to_string());
                        if let Ok(id) = &result {
                            if let Ok(mut bridge) = state.lock() { bridge.sessions.insert(id.clone()); }
                            emit(AgentEvent::Session { session_id: id.clone() });
                        }
                        let _ = reply.send(result);
                    }
                    Command::Prompt(id, text, reply) => {
                        let valid = state.lock().map(|mut bridge| {
                            if bridge.closed || !bridge.sessions.contains(&id) { return Err("Unknown session".to_string()); }
                            if !bridge.running.insert(id.clone()) { return Err("A prompt is already running in this session".to_string()); }
                            bridge.cancelled.remove(&id); Ok(())
                        }).unwrap_or_else(|_| Err("Agent state lock poisoned".into()));
                        if let Err(error) = valid { let _ = reply.send(Err(error)); continue; }
                        let prompt_cx = cx.clone(); let prompt_emit = emit.clone(); let prompt_state = state.clone();
                        cx.spawn(async move {
                            let result = prompt_cx.send_request(PromptRequest::new(id.clone(), vec![ContentBlock::Text(TextContent::new(text))])).block_task().await;
                            if let Ok(mut bridge) = prompt_state.lock() { bridge.running.remove(&id); }
                            match result {
                                Ok(response) => { prompt_emit(AgentEvent::Complete { session_id: id, stop_reason: enum_string(&response.stop_reason) }); let _ = reply.send(Ok(())); }
                                Err(error) => { let message = error.to_string(); prompt_emit(AgentEvent::Error { message: message.clone() }); let _ = reply.send(Err(message)); }
                            }
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
        if session.is_none() {
            bridge.closed = true;
            bridge.remembered.clear();
        }
    }
    let _ = emit;
}

fn enum_string<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
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
            content_json: update.to_string(),
        }),
        _ => {}
    }
}
