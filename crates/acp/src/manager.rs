//! Several agent connections and their sessions, run at the same time.
//!
//! One connection is one agent process (an [`AgentService`]). Sessions are
//! keyed by connection id and session id. Each session runs one prompt at a
//! time and queues follow-ups in order. Sessions can have a parent, which
//! forms a tree rooted at a user session: cancelling, closing or
//! disconnecting a session stops everything below it.
//!
//! Permission, elicitation and edit review answers are only reachable
//! through [`SessionManager`], which is the user's handle. Agents get an
//! [`AgentControl`], which has no way to answer them. See
//! docs/decisions/0001-session-manager.md.
use crate::{AgentCommand, AgentEvent, AgentFeatures, AgentService, EventSink, PromptAttachment};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use span_core::CoreWorkspace;
use specta::Type;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use tokio::sync::oneshot;

/// Receives every event from every managed connection, tagged with its origin.
pub type SessionEventSink = Arc<dyn Fn(SessionEvent) + Send + Sync>;

/// Identifies a session across connections. Session ids are only unique
/// within one agent process, so the connection id is always part of the key.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionKey {
    pub connection_id: String,
    pub session_id: String,
}

impl SessionKey {
    pub fn new(connection_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            connection_id: connection_id.into(),
            session_id: session_id.into(),
        }
    }
}

/// Who started a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionOrigin {
    /// Created by the user through the editor.
    User,
    /// Created by another agent's delegation.
    Delegated,
}

/// A snapshot of one managed session.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub key: SessionKey,
    pub agent_name: String,
    pub parent: Option<SessionKey>,
    /// 0 for a root session, parent depth plus one for a child.
    pub depth: u32,
    pub origin: SessionOrigin,
    /// A prompt is in flight.
    pub busy: bool,
    /// Follow-ups waiting for the prompt in flight.
    pub queued: u32,
}

/// An [`AgentEvent`] with the identity of the connection and session it came
/// from. `session_id` is `None` for connection level events such as `Ready`,
/// `Status`, `Log` and `Error`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub connection_id: String,
    pub agent_name: String,
    pub session_id: Option<String>,
    pub event: AgentEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PendingKind {
    Permission,
    Elicitation,
}

/// One agent connection as seen by delegation: who it is and what it said
/// it supports in `initialize`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub connection_id: String,
    pub agent_name: String,
    /// `None` until the agent finished `initialize`.
    pub features: Option<AgentFeatures>,
    /// False once the process exited.
    pub open: bool,
}

/// Why [`AgentControl::delegate_limited`] refused to start a child.
pub const DEPTH_EXCEEDED: &str = "Delegation depth limit reached";

/// Runs once when a session leaves the manager (closed, deleted, its
/// process exited or its connection was disconnected).
pub type SessionEndHook = Box<dyn FnOnce() + Send>;

/// What a session is doing right now, as the user should see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SessionActivity {
    /// No turn in flight.
    Idle,
    /// A turn is in flight and nothing waits for the user.
    Running,
    /// A turn waits for the user to answer a permission request.
    WaitingForApproval,
    /// A turn waits for the user to answer an input request (elicitation).
    WaitingForAnswer,
}

/// Runtime state of one managed session: the source of truth the UI shows in
/// the session list and the activity bar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeState {
    pub connection_id: String,
    pub session_id: String,
    pub origin: SessionOrigin,
    pub state: SessionActivity,
    /// Follow-ups waiting behind the turn in flight.
    pub queued: u32,
    /// Unix time in milliseconds when the current turn started. `None` while idle.
    pub started_at_ms: Option<u64>,
    /// Title of the newest tool call of the current turn that has not finished.
    pub current_tool: Option<String>,
}

/// Every session of one connection, sorted by session id. Published whenever
/// any of them changes (turn start, turn end, request raised or resolved, a
/// session added or removed). An ended connection is published once with no
/// sessions. `connection_id` is `None` when no agent is connected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionStates {
    pub connection_id: Option<String>,
    pub sessions: Vec<SessionRuntimeState>,
}

/// One live session as the agent mode rail lists it: identity, place in the
/// session tree, runtime state and the metadata the agent last reported.
/// Built only from the manager, so it never mixes up two sessions with the
/// same id on different connections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub key: SessionKey,
    pub agent_name: String,
    /// The installed agent id the connection was started for, when the
    /// desktop knows it (registry installs). `None` from the manager.
    pub agent_id: Option<String>,
    /// The lead session of a delegated child. `None` for a root session.
    pub parent: Option<SessionKey>,
    pub depth: u32,
    pub origin: SessionOrigin,
    pub state: SessionActivity,
    pub queued: u32,
    pub started_at_ms: Option<u64>,
    pub current_tool: Option<String>,
    /// The latest `session_info_update` title.
    pub title: Option<String>,
    /// The current value of the agent's `model` config option.
    pub model: Option<String>,
    /// The latest `current_mode_update` mode id.
    pub mode: Option<String>,
    /// The agent's latest health check result, filled in by the desktop when
    /// checks run. `None` from the manager.
    pub health: Option<crate::HealthState>,
}

/// Metadata an agent reported for one session. Recorded even before the
/// session is registered, because agents send it right after `session/new`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SessionMeta {
    title: Option<String>,
    model: Option<String>,
    mode: Option<String>,
}

/// Receives [`SessionStates`] whenever a connection's session states change.
pub type SessionStateSink = Arc<dyn Fn(SessionStates) + Send + Sync>;

/// The agent's own wording when a session already runs a turn. Kept for the
/// log; callers match the typed [`PromptError::Busy`], never this text.
pub const PROMPT_ALREADY_RUNNING: &str = "A prompt is already running in this session";

/// Why a user prompt did not start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PromptError {
    /// The session already runs a turn. Nothing was sent or queued. `state`
    /// is the session's state at the time of the refusal, when known.
    Busy {
        message: String,
        state: Option<SessionRuntimeState>,
    },
    /// Any other failure, with the message for the user.
    Failed { message: String },
}

impl PromptError {
    pub fn message(&self) -> &str {
        match self {
            PromptError::Busy { message, .. } | PromptError::Failed { message } => message,
        }
    }
}

impl std::fmt::Display for PromptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// Tool calls remembered per running turn, for the current tool title.
const TOOL_LIMIT: usize = 32;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A permission or elicitation request waiting for the user.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub connection_id: String,
    pub agent_name: String,
    pub session_id: Option<String>,
    pub request_id: String,
    pub kind: PendingKind,
}

struct Connection {
    service: Option<AgentService>,
    reported_name: Option<String>,
    label: String,
    features: Option<AgentFeatures>,
    /// False once the process exited. The entry stays until `disconnect`.
    open: bool,
}

impl Connection {
    fn name(&self) -> String {
        self.reported_name
            .clone()
            .unwrap_or_else(|| self.label.clone())
    }
}

struct Turn {
    text: String,
    attachments: Vec<PromptAttachment>,
    reply: oneshot::Sender<Result<(), String>>,
    /// The session's `cancel_epoch` when the turn was accepted.
    epoch: u64,
}

struct Session {
    parent: Option<SessionKey>,
    depth: u32,
    origin: SessionOrigin,
    busy: bool,
    queue: VecDeque<Turn>,
    /// Bumped by every cancel. A turn accepted before a cancel but not yet
    /// sent to the agent is refused, so the cancel cannot be lost to the
    /// gap between accepting a turn and writing its prompt.
    cancel_epoch: u64,
    /// The turn in flight already reported its end (`Complete` or `Error`)
    /// and only waits for the driver to collect it. A user prompt arriving
    /// in this gap runs next instead of being refused as busy.
    finished: bool,
    /// When the turn in flight started.
    started_at_ms: Option<u64>,
    /// Unfinished tool calls of the turn in flight: id and title.
    tools: Vec<(String, Option<String>)>,
}

impl Session {
    fn new(parent: Option<SessionKey>, depth: u32, origin: SessionOrigin) -> Self {
        Self {
            parent,
            depth,
            origin,
            busy: false,
            queue: VecDeque::new(),
            cancel_epoch: 0,
            finished: false,
            started_at_ms: None,
            tools: Vec::new(),
        }
    }

    /// Forget the per-turn state once no turn is in flight.
    fn settle(&mut self) {
        self.finished = false;
        self.started_at_ms = None;
        self.tools.clear();
    }
}

#[derive(Default)]
struct State {
    next_connection: u64,
    connections: HashMap<String, Connection>,
    sessions: HashMap<SessionKey, Session>,
    /// Keyed by connection id and request id: request ids repeat across processes.
    pending: HashMap<(String, String), PendingRequest>,
    /// Option kinds of pending permissions, to tell a rejection from an approval.
    permission_kinds: HashMap<(String, String), HashMap<String, String>>,
    /// Sessions whose user rejected a permission during the current turn.
    rejected: HashSet<SessionKey>,
    next_subscriber: u64,
    subscribers: HashMap<u64, SessionEventSink>,
    end_hooks: HashMap<SessionKey, Vec<SessionEndHook>>,
    /// Hooks of sessions that were removed, run once the lock is released.
    ended: Vec<SessionEndHook>,
    state_watchers: HashMap<u64, SessionStateSink>,
    /// The states last published per connection, to publish only changes.
    published: HashMap<String, SessionStates>,
    /// When each connection's session states last changed.
    activity: HashMap<String, std::time::Instant>,
    /// Title, model and mode per session, as the agent last reported them.
    meta: HashMap<SessionKey, SessionMeta>,
}

impl State {
    /// `roots` followed by every session below them, parents before children.
    fn tree(&self, roots: &[SessionKey]) -> Vec<SessionKey> {
        let mut found: Vec<SessionKey> = roots
            .iter()
            .filter(|key| self.sessions.contains_key(*key))
            .cloned()
            .collect();
        let mut index = 0;
        while index < found.len() {
            let parent = found[index].clone();
            found.extend(
                self.sessions
                    .iter()
                    .filter(|(_, session)| session.parent.as_ref() == Some(&parent))
                    .map(|(key, _)| key.clone()),
            );
            index += 1;
        }
        found
    }

    fn is_descendant(&self, key: &SessionKey, ancestor: &SessionKey) -> bool {
        let mut current = self.sessions.get(key).and_then(|s| s.parent.as_ref());
        while let Some(parent) = current {
            if parent == ancestor {
                return true;
            }
            current = self.sessions.get(parent).and_then(|s| s.parent.as_ref());
        }
        false
    }

    fn service(&self, connection_id: &str) -> Option<AgentService> {
        self.connections
            .get(connection_id)
            .and_then(|c| c.service.clone())
    }

    fn info(&self, key: &SessionKey, session: &Session) -> SessionInfo {
        SessionInfo {
            key: key.clone(),
            agent_name: self
                .connections
                .get(&key.connection_id)
                .map(Connection::name)
                .unwrap_or_default(),
            parent: session.parent.clone(),
            depth: session.depth,
            origin: session.origin,
            busy: session.busy,
            queued: session.queue.len() as u32,
        }
    }

    fn runtime(&self, key: &SessionKey, session: &Session) -> SessionRuntimeState {
        let waiting = |kind: PendingKind| {
            self.pending.values().any(|request| {
                request.kind == kind
                    && request.connection_id == key.connection_id
                    && request.session_id.as_deref() == Some(key.session_id.as_str())
            })
        };
        let running = session.busy && !(session.finished && session.queue.is_empty());
        let state = if waiting(PendingKind::Elicitation) {
            SessionActivity::WaitingForAnswer
        } else if waiting(PendingKind::Permission) {
            SessionActivity::WaitingForApproval
        } else if running {
            SessionActivity::Running
        } else {
            SessionActivity::Idle
        };
        let active = state != SessionActivity::Idle;
        SessionRuntimeState {
            connection_id: key.connection_id.clone(),
            session_id: key.session_id.clone(),
            origin: session.origin,
            state,
            queued: session.queue.len() as u32,
            started_at_ms: session.started_at_ms.filter(|_| active),
            current_tool: session
                .tools
                .iter()
                .rev()
                .find_map(|(_, title)| title.clone())
                .filter(|_| active),
        }
    }

    fn states(&self, connection_id: &str) -> SessionStates {
        let mut sessions: Vec<SessionRuntimeState> = self
            .sessions
            .iter()
            .filter(|(key, _)| key.connection_id == connection_id)
            .map(|(key, session)| self.runtime(key, session))
            .collect();
        sessions.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        SessionStates {
            connection_id: Some(connection_id.to_owned()),
            sessions,
        }
    }

    fn live(&self, key: &SessionKey, session: &Session) -> LiveSession {
        let runtime = self.runtime(key, session);
        let meta = self.meta.get(key).cloned().unwrap_or_default();
        LiveSession {
            key: key.clone(),
            agent_name: self
                .connections
                .get(&key.connection_id)
                .map(Connection::name)
                .unwrap_or_default(),
            agent_id: None,
            parent: session.parent.clone(),
            depth: session.depth,
            origin: session.origin,
            state: runtime.state,
            queued: runtime.queued,
            started_at_ms: runtime.started_at_ms,
            current_tool: runtime.current_tool,
            title: meta.title,
            model: meta.model,
            mode: meta.mode,
            health: None,
        }
    }

    /// Forget everything kept for a connection's sessions that are not
    /// registered (metadata of sessions the manager never tracked).
    fn forget_connection_meta(&mut self, connection_id: &str) {
        self.meta
            .retain(|key, _| key.connection_id != connection_id);
    }

    /// Remove sessions from the manager. Returns their queued turns and the
    /// services to stop them on, deepest first.
    fn detach(&mut self, keys: &[SessionKey]) -> (Vec<Turn>, Vec<(SessionKey, AgentService)>) {
        let mut turns = Vec::new();
        let mut stops = Vec::new();
        for key in keys.iter().rev() {
            if let Some(session) = self.sessions.remove(key) {
                turns.extend(session.queue);
            }
            self.rejected.remove(key);
            self.meta.remove(key);
            if let Some(hooks) = self.end_hooks.remove(key) {
                self.ended.extend(hooks);
            }
            if let Some(service) = self.service(&key.connection_id) {
                stops.push((key.clone(), service));
            }
        }
        (turns, stops)
    }
}

/// The user's handle on every agent connection and session.
#[derive(Clone)]
pub struct SessionManager {
    state: Arc<Mutex<State>>,
    emit: SessionEventSink,
    /// Held while computing and delivering published states, so watchers see
    /// them in the order they were computed.
    publish_gate: Arc<Mutex<()>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new(Arc::new(|_| {}))
    }
}

/// Every connection a set of session keys belongs to, without repeats.
fn connections_of<'a>(keys: impl IntoIterator<Item = &'a SessionKey>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for key in keys {
        if !found.contains(&key.connection_id) {
            found.push(key.connection_id.clone());
        }
    }
    found
}

fn refuse(turns: Vec<Turn>, message: &str) {
    for turn in turns {
        let _ = turn.reply.send(Err(message.to_owned()));
    }
}

pub(crate) fn event_session(event: &AgentEvent) -> Option<String> {
    use AgentEvent::*;
    match event {
        Session { session_id }
        | Text { session_id, .. }
        | Thought { session_id, .. }
        | User { session_id, .. }
        | AvailableCommands { session_id, .. }
        | CurrentMode { session_id, .. }
        | SessionInfo { session_id, .. }
        | Usage { session_id, .. }
        | Notice { session_id, .. }
        | NoticeCleared { session_id, .. }
        | Compaction { session_id, .. }
        | CompactionSummary { session_id, .. }
        | Plan { session_id, .. }
        | Config { session_id, .. }
        | Tool { session_id, .. }
        | Permission { session_id, .. }
        | PermissionResolved { session_id, .. }
        | Proposal { session_id, .. }
        | ProposalResolved { session_id, .. }
        | Complete { session_id, .. } => Some(session_id.clone()),
        Elicitation { session_id, .. } | Error { session_id, .. } => session_id.clone(),
        Status { .. }
        | Capabilities { .. }
        | Ready { .. }
        | AuthRequired { .. }
        | ElicitationResolved { .. }
        | ElicitationComplete { .. }
        | Log { .. }
        | Delegation { .. } => None,
    }
}

impl SessionManager {
    pub fn new(emit: SessionEventSink) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            emit,
            publish_gate: Arc::new(Mutex::new(())),
        }
    }

    /// Publish the session states of `connection_id` to every watcher if
    /// they changed since the last publication. Never called with the state
    /// lock held.
    fn publish(&self, connection_id: &str) {
        let _gate = self
            .publish_gate
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let (states, watchers) = {
            let mut state = self.state();
            let current = state.states(connection_id);
            let gone = !state.connections.contains_key(connection_id);
            let previous = state.published.get(connection_id);
            let unchanged = match previous {
                Some(previous) => *previous == current,
                None => current.sessions.is_empty(),
            };
            if unchanged {
                if gone {
                    state.published.remove(connection_id);
                }
                return;
            }
            if gone {
                state.published.remove(connection_id);
                state.activity.remove(connection_id);
            } else {
                state
                    .published
                    .insert(connection_id.to_owned(), current.clone());
                state
                    .activity
                    .insert(connection_id.to_owned(), std::time::Instant::now());
            }
            let watchers: Vec<SessionStateSink> = state.state_watchers.values().cloned().collect();
            (current, watchers)
        };
        for watcher in watchers {
            watcher(states.clone());
        }
    }

    fn publish_all(&self, connections: &[String]) {
        for connection in connections {
            self.publish(connection);
        }
    }

    /// The runtime state of every session on one connection.
    pub fn session_states(&self, connection_id: &str) -> SessionStates {
        self.state().states(connection_id)
    }

    /// When the session states of `connection_id` last changed: a turn
    /// started or ended, a request was raised or answered, a session was
    /// added or removed. `None` when they never changed.
    pub fn last_activity(&self, connection_id: &str) -> Option<std::time::Instant> {
        self.state().activity.get(connection_id).copied()
    }

    /// The runtime state of one session.
    pub fn session_state(&self, key: &SessionKey) -> Option<SessionRuntimeState> {
        let state = self.state();
        state.sessions.get(key).map(|s| state.runtime(key, s))
    }

    /// Receive [`SessionStates`] whenever a connection's session states
    /// change, until the returned guard is dropped. Called on whichever
    /// thread made the change; the sink must not call back into the manager.
    pub fn watch_states(&self, sink: SessionStateSink) -> Subscription {
        let mut state = self.state();
        state.next_subscriber += 1;
        let id = state.next_subscriber;
        state.state_watchers.insert(id, sink);
        Subscription {
            id,
            state: Arc::downgrade(&self.state),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Every mutation leaves the maps consistent, so a poisoned lock is still usable.
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Start one agent process. Its events go to the manager sink as
    /// [`SessionEvent`]s and, unchanged, to `direct` when given (the
    /// existing single agent UI channel).
    pub async fn connect(
        &self,
        command: AgentCommand,
        cwd: String,
        workspace: Arc<Mutex<CoreWorkspace>>,
        direct: Option<EventSink>,
    ) -> Result<String, String> {
        let label = std::path::Path::new(command.args.first().unwrap_or(&command.command))
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| command.command.clone());
        let id = {
            let mut state = self.state();
            state.next_connection += 1;
            let id = format!("connection-{}", state.next_connection);
            state.connections.insert(
                id.clone(),
                Connection {
                    service: None,
                    reported_name: None,
                    label,
                    features: None,
                    open: true,
                },
            );
            id
        };
        let sink = self.connection_sink(id.clone(), direct);
        match AgentService::start(command, cwd, workspace, sink).await {
            Ok(service) => {
                let mut state = self.state();
                match state.connections.get_mut(&id) {
                    Some(connection) => connection.service = Some(service),
                    None => {
                        drop(state);
                        let _ = service.shutdown();
                        return Err("Agent disconnected".into());
                    }
                }
                Ok(id)
            }
            Err(error) => {
                self.state().connections.remove(&id);
                Err(error)
            }
        }
    }

    fn connection_sink(&self, id: String, direct: Option<EventSink>) -> EventSink {
        let state: Weak<Mutex<State>> = Arc::downgrade(&self.state);
        let emit = self.emit.clone();
        let publish_gate = self.publish_gate.clone();
        Arc::new(move |event: AgentEvent| {
            if let Some(direct) = &direct {
                direct(event.clone());
            }
            let Some(state) = state.upgrade() else {
                return;
            };
            let manager = SessionManager {
                state,
                emit: emit.clone(),
                publish_gate: publish_gate.clone(),
            };
            let (agent_name, session_id) = manager.observe(&id, &event);
            if session_id.is_some() {
                manager.publish(&id);
            }
            let gone =
                matches!(&event, AgentEvent::Status { state, .. } if state == "disconnected");
            let tagged = SessionEvent {
                connection_id: id.clone(),
                agent_name,
                session_id,
                event,
            };
            let subscribers: Vec<SessionEventSink> =
                manager.state().subscribers.values().cloned().collect();
            for subscriber in subscribers {
                subscriber(tagged.clone());
            }
            emit(tagged);
            if gone {
                manager.connection_exited(&id);
            }
        })
    }

    /// Bookkeeping for one event: agent identity and pending user requests.
    fn observe(&self, connection_id: &str, event: &AgentEvent) -> (String, Option<String>) {
        let mut state = self.state();
        if let (
            AgentEvent::Ready {
                agent_name,
                features,
                ..
            },
            Some(connection),
        ) = (event, state.connections.get_mut(connection_id))
        {
            connection.reported_name = agent_name.clone();
            connection.features = Some(features.clone());
        }
        let agent_name = state
            .connections
            .get(connection_id)
            .map(Connection::name)
            .unwrap_or_default();
        let mut session_id = event_session(event);
        let mut kinds: Option<((String, String), HashMap<String, String>)> = None;
        let mut track = |request_id: &str, kind| {
            state.pending.insert(
                (connection_id.to_owned(), request_id.to_owned()),
                PendingRequest {
                    connection_id: connection_id.to_owned(),
                    agent_name: agent_name.clone(),
                    session_id: session_id.clone(),
                    request_id: request_id.to_owned(),
                    kind,
                },
            );
        };
        match event {
            AgentEvent::Permission {
                request_id,
                options,
                ..
            } => {
                track(request_id, PendingKind::Permission);
                kinds = Some((
                    (connection_id.to_owned(), request_id.clone()),
                    options
                        .iter()
                        .map(|o| (o.option_id.clone(), o.kind.clone()))
                        .collect(),
                ));
            }
            AgentEvent::Elicitation { request_id, .. } => {
                track(request_id, PendingKind::Elicitation)
            }
            AgentEvent::PermissionResolved { request_id, .. }
            | AgentEvent::ElicitationResolved { request_id } => {
                let removed = state
                    .pending
                    .remove(&(connection_id.to_owned(), request_id.clone()));
                state
                    .permission_kinds
                    .remove(&(connection_id.to_owned(), request_id.clone()));
                if session_id.is_none() {
                    session_id = removed.and_then(|r| r.session_id);
                }
            }
            _ => {}
        }
        if let Some((key, kinds)) = kinds {
            state.permission_kinds.insert(key, kinds);
        }
        // Session metadata for the live session list. Keyed by connection and
        // session, so an event of one session never touches another.
        match event {
            AgentEvent::SessionInfo {
                session_id, title, ..
            } if title.is_some() => {
                state
                    .meta
                    .entry(SessionKey::new(connection_id, session_id.clone()))
                    .or_default()
                    .title = title.clone();
            }
            AgentEvent::CurrentMode {
                session_id,
                mode_id,
            } => {
                state
                    .meta
                    .entry(SessionKey::new(connection_id, session_id.clone()))
                    .or_default()
                    .mode = Some(mode_id.clone());
            }
            AgentEvent::Config {
                session_id,
                options,
            } => {
                if let Some(model) = options
                    .iter()
                    .find(|o| o.category.as_deref() == Some("model") || o.id == "model")
                {
                    state
                        .meta
                        .entry(SessionKey::new(connection_id, session_id.clone()))
                        .or_default()
                        .model = Some(model.current_value.clone());
                }
            }
            _ => {}
        }
        // Per-turn runtime state: the tool calls still open and whether the
        // turn in flight already ended.
        match event {
            AgentEvent::Tool {
                session_id: tool_session,
                tool_call_id,
                title,
                status,
                internal,
                ..
            } if *internal != Some(true) => {
                let key = SessionKey::new(connection_id, tool_session.clone());
                if let Some(session) = state.sessions.get_mut(&key).filter(|s| s.busy) {
                    match status.as_deref() {
                        Some("completed") | Some("failed") => {
                            session.tools.retain(|(id, _)| id != tool_call_id)
                        }
                        _ => match session.tools.iter_mut().find(|(id, _)| id == tool_call_id) {
                            Some(entry) => {
                                if title.is_some() {
                                    entry.1 = title.clone();
                                }
                            }
                            None => {
                                session.tools.push((tool_call_id.clone(), title.clone()));
                                if session.tools.len() > TOOL_LIMIT {
                                    session.tools.remove(0);
                                }
                            }
                        },
                    }
                }
            }
            AgentEvent::Complete {
                session_id: ended, ..
            }
            | AgentEvent::Error {
                session_id: Some(ended),
                ..
            } => {
                let key = SessionKey::new(connection_id, ended.clone());
                if let Some(session) = state.sessions.get_mut(&key).filter(|s| s.busy) {
                    session.finished = true;
                    session.tools.clear();
                }
            }
            _ => {}
        }
        (agent_name, session_id)
    }

    /// The process exited: its sessions and every child of them end.
    fn connection_exited(&self, connection_id: &str) {
        let ((turns, stops), touched) = {
            let mut state = self.state();
            let Some(connection) = state.connections.get_mut(connection_id) else {
                return;
            };
            connection.open = false;
            state.forget_connection_meta(connection_id);
            state.pending.retain(|(id, _), _| id != connection_id);
            state
                .permission_kinds
                .retain(|(id, _), _| id != connection_id);
            let roots: Vec<SessionKey> = state
                .sessions
                .keys()
                .filter(|key| key.connection_id == connection_id)
                .cloned()
                .collect();
            let tree = state.tree(&roots);
            let detached = state.detach(&tree);
            (detached, connections_of(&tree))
        };
        self.run_end_hooks();
        self.publish_all(&touched);
        refuse(turns, "The agent process exited before the turn started");
        for (key, service) in stops {
            if key.connection_id != connection_id {
                let _ = service.cancel(key.session_id);
            }
        }
    }

    /// Stop the process. Every session on it, and every session below those
    /// on other connections, is cancelled and forgotten first. Returns the
    /// result of the process shutdown request.
    pub fn disconnect(&self, connection_id: &str) -> Result<(), String> {
        let (connection, turns, stops, touched) = {
            let mut state = self.state();
            let roots: Vec<SessionKey> = state
                .sessions
                .keys()
                .filter(|key| key.connection_id == connection_id)
                .cloned()
                .collect();
            let tree = state.tree(&roots);
            let (turns, stops) = state.detach(&tree);
            state.forget_connection_meta(connection_id);
            state.pending.retain(|(id, _), _| id != connection_id);
            state
                .permission_kinds
                .retain(|(id, _), _| id != connection_id);
            let mut touched = connections_of(&tree);
            if !touched.iter().any(|id| id == connection_id) {
                touched.push(connection_id.to_owned());
            }
            (
                state.connections.remove(connection_id),
                turns,
                stops,
                touched,
            )
        };
        self.run_end_hooks();
        self.publish_all(&touched);
        let connection = connection.ok_or("Unknown connection")?;
        refuse(turns, "The agent was disconnected before the turn started");
        // Sessions on this connection end with the process; children elsewhere are stopped.
        for (key, service) in stops {
            if key.connection_id != connection_id {
                let _ = service.cancel(key.session_id);
            }
        }
        match connection.service {
            Some(service) => service.shutdown(),
            None => Err("Agent disconnected".into()),
        }
    }

    /// The service behind a connection, for the single agent commands that
    /// address it directly.
    pub fn service(&self, connection_id: &str) -> Option<AgentService> {
        self.state().service(connection_id)
    }

    /// Create a session. A child records its parent and inherits a depth one
    /// below it; it is cancelled and closed whenever the parent is.
    pub async fn open_session(
        &self,
        connection_id: &str,
        parent: Option<SessionKey>,
        origin: SessionOrigin,
    ) -> Result<SessionKey, String> {
        self.open_session_with(connection_id, parent, origin, Vec::new())
            .await
    }

    /// [`Self::open_session`] offering `mcp_servers` in this session's
    /// `session/new` only (see [`AgentService::new_session_with`]). Delegated
    /// children are always opened without servers.
    pub async fn open_session_with(
        &self,
        connection_id: &str,
        parent: Option<SessionKey>,
        origin: SessionOrigin,
        mcp_servers: Vec<Value>,
    ) -> Result<SessionKey, String> {
        let (service, depth) = {
            let state = self.state();
            let service = state
                .connections
                .get(connection_id)
                .filter(|c| c.open)
                .and_then(|c| c.service.clone())
                .ok_or("Unknown or disconnected connection")?;
            let depth = match &parent {
                Some(parent) => {
                    state
                        .sessions
                        .get(parent)
                        .ok_or("Unknown parent session")?
                        .depth
                        + 1
                }
                None => 0,
            };
            (service, depth)
        };
        let session_id = if parent.is_some() {
            // Delegated children never get servers, and stay out of the
            // agent's own history where it allows that.
            service.new_child_session().await?
        } else {
            service.new_session_with(mcp_servers).await?
        };
        let key = SessionKey::new(connection_id, session_id);
        let is_child = parent.is_some();
        let registered = {
            let mut state = self.state();
            let alive = state.connections.get(connection_id).is_some_and(|c| c.open)
                && parent
                    .as_ref()
                    .is_none_or(|p| state.sessions.contains_key(p));
            if alive {
                state
                    .sessions
                    .insert(key.clone(), Session::new(parent, depth, origin));
            }
            alive
        };
        if registered {
            self.publish(connection_id);
        }
        if is_child {
            // Recorded before anything else sees the id, so the child is never
            // a History row of its own and can be ended later (ADR 0003).
            let agent = self
                .connection(connection_id)
                .map(|c| c.agent_name)
                .unwrap_or_default();
            crate::delegated::record_delegated_session(&agent, &key.session_id);
        }
        if registered && is_child {
            service.mark_delegated(&key.session_id);
        }
        if !registered {
            // The parent ended while the agent created the child.
            let _ = service.cancel(key.session_id.clone());
            let _ = service.close_session(key.session_id).await;
            return Err("The parent session ended before the child session started".into());
        }
        Ok(key)
    }

    /// Track a root session that was created or restored directly on the
    /// connection's service.
    pub fn adopt(&self, key: SessionKey, origin: SessionOrigin) -> Result<(), String> {
        {
            let mut state = self.state();
            if !state
                .connections
                .get(&key.connection_id)
                .is_some_and(|c| c.open)
            {
                return Err("Unknown or disconnected connection".into());
            }
            state
                .sessions
                .entry(key.clone())
                .or_insert_with(|| Session::new(None, 0, origin));
        }
        self.publish(&key.connection_id);
        Ok(())
    }

    pub fn session(&self, key: &SessionKey) -> Option<SessionInfo> {
        let state = self.state();
        state.sessions.get(key).map(|s| state.info(key, s))
    }

    pub fn sessions(&self) -> Vec<SessionInfo> {
        let state = self.state();
        state
            .sessions
            .iter()
            .map(|(key, session)| state.info(key, session))
            .collect()
    }

    /// Every session the manager tracks (user leads, delegated children and
    /// sessions adopted after a load), sorted by connection then session id.
    /// Health check sessions are never registered, so they never appear.
    pub fn live_sessions(&self) -> Vec<LiveSession> {
        let state = self.state();
        let mut found: Vec<LiveSession> = state
            .sessions
            .iter()
            .map(|(key, session)| state.live(key, session))
            .collect();
        found.sort_by(|a, b| {
            (&a.key.connection_id, &a.key.session_id)
                .cmp(&(&b.key.connection_id, &b.key.session_id))
        });
        found
    }

    /// One live session, `None` when the manager does not track it.
    pub fn live_session(&self, key: &SessionKey) -> Option<LiveSession> {
        let state = self.state();
        state.sessions.get(key).map(|s| state.live(key, s))
    }

    /// Requests from any connection that wait for the user.
    pub fn pending_requests(&self) -> Vec<PendingRequest> {
        self.state().pending.values().cloned().collect()
    }

    /// Every connection with its reported identity and features.
    pub fn connections(&self) -> Vec<ConnectionInfo> {
        let state = self.state();
        let mut found: Vec<ConnectionInfo> = state
            .connections
            .iter()
            .map(|(id, c)| ConnectionInfo {
                connection_id: id.clone(),
                agent_name: c.name(),
                features: c.features.clone(),
                open: c.open,
            })
            .collect();
        found.sort_by(|a, b| a.connection_id.cmp(&b.connection_id));
        found
    }

    pub fn connection(&self, connection_id: &str) -> Option<ConnectionInfo> {
        self.connections()
            .into_iter()
            .find(|c| c.connection_id == connection_id)
    }

    /// Receive every [`SessionEvent`] in addition to the manager sink, until
    /// the returned guard is dropped. Called on the agent's I/O thread.
    pub fn subscribe(&self, sink: SessionEventSink) -> Subscription {
        let mut state = self.state();
        state.next_subscriber += 1;
        let id = state.next_subscriber;
        state.subscribers.insert(id, sink);
        Subscription {
            id,
            state: Arc::downgrade(&self.state),
        }
    }

    /// Run `hook` once when `key` leaves the manager. Fails if the session
    /// is not tracked.
    pub fn on_session_end(&self, key: &SessionKey, hook: SessionEndHook) -> Result<(), String> {
        let mut state = self.state();
        if !state.sessions.contains_key(key) {
            return Err("Unknown session".into());
        }
        state.end_hooks.entry(key.clone()).or_default().push(hook);
        Ok(())
    }

    fn run_end_hooks(&self) {
        let hooks = std::mem::take(&mut self.state().ended);
        for hook in hooks {
            hook();
        }
    }

    /// Run a prompt. If the session is busy the prompt waits in a FIFO queue
    /// and starts when the turns before it finish. Resolves when this
    /// prompt's own turn finishes. Dropping the future does not withdraw it.
    pub async fn prompt(
        &self,
        key: &SessionKey,
        text: String,
        attachments: Vec<PromptAttachment>,
    ) -> Result<(), String> {
        let done = self.enqueue(key, text, attachments)?;
        done.await
            .map_err(|_| "The session ended before the turn finished".to_string())?
    }

    /// The synchronous half of [`Self::prompt`]: the turn is started or
    /// queued before this returns, so calls made in order queue in order.
    /// The receiver resolves when the turn finishes.
    pub fn enqueue(
        &self,
        key: &SessionKey,
        text: String,
        attachments: Vec<PromptAttachment>,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        if text.trim().is_empty() && attachments.is_empty() {
            return Err("Prompt cannot be empty".into());
        }
        let (reply, done) = oneshot::channel();
        let start = {
            let mut state = self.state();
            let session = state.sessions.get_mut(key).ok_or("Unknown session")?;
            let turn = Turn {
                text,
                attachments,
                reply,
                epoch: session.cancel_epoch,
            };
            if session.busy {
                session.queue.push_back(turn);
                None
            } else {
                session.busy = true;
                session.started_at_ms = Some(now_ms());
                Some(turn)
            }
        };
        if let Some(turn) = start {
            self.drive(key.clone(), turn);
        }
        self.publish(&key.connection_id);
        Ok(done)
    }

    /// Start a user prompt now. Unlike [`Self::enqueue`] a busy session
    /// refuses it with [`PromptError::Busy`] instead of queueing it, so the
    /// user decides whether to steer, queue or wait. A session also counts as
    /// busy while its agent still runs a turn the manager did not start (for
    /// example one that kept running after the session was closed and
    /// loaded again). A prompt that arrives after the turn in flight reported
    /// its end, but before the driver collected it, runs next.
    pub fn start_turn(
        &self,
        key: &SessionKey,
        text: String,
        attachments: Vec<PromptAttachment>,
    ) -> Result<oneshot::Receiver<Result<(), String>>, PromptError> {
        let failed = |message: &str| PromptError::Failed {
            message: message.to_owned(),
        };
        if text.trim().is_empty() && attachments.is_empty() {
            return Err(failed("Prompt cannot be empty"));
        }
        let service = self
            .service(&key.connection_id)
            .ok_or_else(|| failed("Unknown or disconnected connection"))?;
        // Read before the manager lock: the service has its own lock.
        let agent_busy = service.is_running(&key.session_id);
        let (reply, done) = oneshot::channel();
        let start = {
            let mut state = self.state();
            let session = state
                .sessions
                .get_mut(key)
                .ok_or_else(|| failed("Unknown session"))?;
            let turn = Turn {
                text,
                attachments,
                reply,
                epoch: session.cancel_epoch,
            };
            if session.busy && session.finished && session.queue.is_empty() {
                session.queue.push_back(turn);
                None
            } else if session.busy || agent_busy {
                let current = state.sessions.get(key).map(|s| state.runtime(key, s));
                let current = current.map(|mut runtime| {
                    // A turn the manager did not start still runs.
                    if runtime.state == SessionActivity::Idle {
                        runtime.state = SessionActivity::Running;
                    }
                    runtime
                });
                return Err(PromptError::Busy {
                    message: PROMPT_ALREADY_RUNNING.to_owned(),
                    state: current,
                });
            } else {
                session.busy = true;
                session.started_at_ms = Some(now_ms());
                Some(turn)
            }
        };
        if let Some(turn) = start {
            self.drive(key.clone(), turn);
        }
        self.publish(&key.connection_id);
        Ok(done)
    }

    /// Run turns for one session until its queue is empty.
    fn drive(&self, key: SessionKey, first: Turn) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut next = Some(first);
            while let Some(turn) = next.take() {
                manager.state().rejected.remove(&key);
                // Checked and written under the state lock: `cancel` bumps the
                // epoch under it and only then tells the agent, so either this
                // prompt is queued ahead of that cancel or it is refused here.
                let started = {
                    let state = manager.state();
                    match state.sessions.get(&key) {
                        Some(session) if session.cancel_epoch != turn.epoch => {
                            Err("Cancelled before the turn started".to_string())
                        }
                        _ => match state.service(&key.connection_id) {
                            Some(service) => service.start_prompt(
                                key.session_id.clone(),
                                turn.text,
                                turn.attachments,
                            ),
                            None => Err("Agent disconnected".to_string()),
                        },
                    }
                };
                let result = match started {
                    Ok(done) => done
                        .await
                        .map_err(|_| "Agent disconnected".to_string())
                        .and_then(|result| result),
                    Err(error) => Err(error),
                };
                manager.publish(&key.connection_id);
                let _ = turn.reply.send(result);
                {
                    let mut state = manager.state();
                    next = match state.sessions.get_mut(&key) {
                        Some(session) => {
                            let queued = session.queue.pop_front();
                            session.busy = queued.is_some();
                            session.settle();
                            if queued.is_some() {
                                session.started_at_ms = Some(now_ms());
                            }
                            queued
                        }
                        None => None,
                    };
                }
                manager.publish(&key.connection_id);
            }
        });
    }

    /// Stop the turn in a session and in every session below it, and drop
    /// their queued follow-ups. Each connection applies the existing five
    /// second Stop deadline. Sessions stay open.
    pub fn cancel(&self, key: &SessionKey) -> Result<(), String> {
        let (turns, stops, root, touched) = {
            let mut state = self.state();
            let root = state.service(&key.connection_id);
            let tree = state.tree(std::slice::from_ref(key));
            let mut turns = Vec::new();
            let mut stops = Vec::new();
            for child in tree.iter().skip(1).rev() {
                if let Some(session) = state.sessions.get_mut(child) {
                    session.cancel_epoch += 1;
                    turns.extend(session.queue.drain(..));
                }
                if let Some(service) = state.service(&child.connection_id) {
                    stops.push((service, child.session_id.clone()));
                }
            }
            if let Some(session) = state.sessions.get_mut(key) {
                session.cancel_epoch += 1;
                turns.extend(session.queue.drain(..));
            }
            (turns, stops, root, connections_of(&tree))
        };
        self.publish_all(&touched);
        refuse(turns, "Cancelled before the turn started");
        for (service, session) in stops {
            let _ = service.cancel(session);
        }
        root.ok_or("Unknown or disconnected connection")?
            .cancel(key.session_id.clone())
    }

    /// Close a session (`session/close`). Children are cancelled first; once
    /// the agent confirms the close, they are closed and forgotten too. If
    /// the close fails the children stay registered, cancelled. A turn still
    /// running in the session is stopped first (the usual Stop, with its
    /// deadline), so closing never leaves work running that the manager no
    /// longer tracks.
    pub async fn close(&self, key: &SessionKey) -> Result<(), String> {
        if self.session(key).is_some_and(|s| s.busy) {
            let _ = self.cancel(key);
        }
        let service = self.end_children(key)?;
        service.close_session(key.session_id.clone()).await?;
        self.forget_tree(key).await;
        Ok(())
    }

    /// Delete a session (`session/delete`), with the same cascade as `close`.
    pub async fn delete(&self, key: &SessionKey) -> Result<(), String> {
        let service = self.end_children(key)?;
        service.delete_session(key.session_id.clone()).await?;
        self.forget_tree(key).await;
        Ok(())
    }

    fn end_children(&self, key: &SessionKey) -> Result<AgentService, String> {
        let (service, children) = {
            let state = self.state();
            let service = state
                .service(&key.connection_id)
                .ok_or("Unknown or disconnected connection")?;
            let tree = state.tree(std::slice::from_ref(key));
            (service, tree.into_iter().skip(1).collect::<Vec<_>>())
        };
        for child in children.iter().rev() {
            let _ = self.cancel(child);
        }
        Ok(service)
    }

    async fn forget_tree(&self, key: &SessionKey) {
        let (turns, stops, touched) = {
            let mut state = self.state();
            let tree = state.tree(std::slice::from_ref(key));
            let (turns, mut stops) = state.detach(&tree);
            // The root itself was closed by the caller.
            stops.retain(|(child, _)| child != key);
            (turns, stops, connections_of(&tree))
        };
        self.run_end_hooks();
        self.publish_all(&touched);
        refuse(turns, "The session was closed before the turn started");
        for (child, service) in stops {
            let _ = service.cancel(child.session_id.clone());
            // Best effort: agents without session/close keep the idle session.
            let _ = service.close_session(child.session_id).await;
        }
    }

    /// The user's answer to a permission request. The session key must match
    /// the request, which rules out answering across connections.
    pub fn respond_permission(
        &self,
        key: &SessionKey,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), String> {
        let (service, rejected) = {
            let state = self.state();
            let pending = state
                .pending
                .get(&(key.connection_id.clone(), request_id.clone()))
                .ok_or("Permission request is no longer pending")?;
            if pending.session_id.as_deref() != Some(key.session_id.as_str()) {
                return Err("Permission belongs to a different session".into());
            }
            let kind = option_id.as_ref().and_then(|option| {
                state
                    .permission_kinds
                    .get(&(key.connection_id.clone(), request_id.clone()))
                    .and_then(|kinds| kinds.get(option).cloned())
            });
            let rejected = kind.is_none_or(|kind| kind.starts_with("reject"));
            let service = state
                .service(&key.connection_id)
                .ok_or("Unknown or disconnected connection")?;
            (service, rejected)
        };
        // Recorded before the agent can react, so its stop reason sees it.
        if rejected {
            self.state().rejected.insert(key.clone());
        }
        let result = service.respond_permission(key.session_id.clone(), request_id, option_id);
        if result.is_err() && rejected {
            self.state().rejected.remove(key);
        }
        result
    }

    /// The user's answer to an elicitation on one connection.
    pub fn respond_elicitation(
        &self,
        connection_id: &str,
        request_id: String,
        action: String,
        content_json: Option<String>,
    ) -> Result<(), String> {
        self.service(connection_id)
            .ok_or("Unknown or disconnected connection")?
            .respond_elicitation(request_id, action, content_json)
    }

    /// The user's answer to an elicitation, addressed by session. The
    /// request must be pending on that connection and, when the agent tied it
    /// to a session, on that session, so an answer meant for one thread can
    /// never reach another.
    pub fn respond_elicitation_for(
        &self,
        key: &SessionKey,
        request_id: String,
        action: String,
        content_json: Option<String>,
    ) -> Result<(), String> {
        let service = {
            let state = self.state();
            let pending = state
                .pending
                .get(&(key.connection_id.clone(), request_id.clone()))
                .filter(|p| p.kind == PendingKind::Elicitation)
                .ok_or("Elicitation request is no longer pending")?;
            if pending
                .session_id
                .as_deref()
                .is_some_and(|session| session != key.session_id)
            {
                return Err("Elicitation belongs to a different session".into());
            }
            state
                .service(&key.connection_id)
                .ok_or("Unknown or disconnected connection")?
        };
        service.respond_elicitation(request_id, action, content_json)
    }

    /// The handle an agent session gets for delegation. It can only reach
    /// sessions below `caller`.
    pub fn agent_control(&self, caller: SessionKey) -> Result<AgentControl, String> {
        if !self.state().sessions.contains_key(&caller) {
            return Err("Unknown session".into());
        }
        Ok(AgentControl {
            manager: self.clone(),
            caller,
        })
    }
}

/// What an agent may do with other sessions: start children, message them,
/// read their state and cancel them. By construction it has no method that
/// answers a permission, an elicitation or an edit review; those always go
/// to the user through [`SessionManager`]. This is the only handle the
/// delegation tool server (#52) is meant to receive.
#[derive(Clone)]
pub struct AgentControl {
    manager: SessionManager,
    caller: SessionKey,
}

impl AgentControl {
    pub fn caller(&self) -> &SessionKey {
        &self.caller
    }

    /// The manager, for the tool server ending its own recorded children
    /// after the lead is gone. Not public: agents never get it.
    pub(crate) fn manager(&self) -> &SessionManager {
        &self.manager
    }

    fn below(&self, target: &SessionKey) -> Result<(), String> {
        if self.manager.state().is_descendant(target, &self.caller) {
            Ok(())
        } else {
            Err("Agents can only reach sessions they delegated".into())
        }
    }

    /// Start a child session on a connection.
    pub async fn delegate(&self, connection_id: &str) -> Result<SessionKey, String> {
        self.manager
            .open_session(
                connection_id,
                Some(self.caller.clone()),
                SessionOrigin::Delegated,
            )
            .await
    }

    /// Send a prompt to a child. It queues if the child is busy.
    pub async fn message(&self, target: &SessionKey, text: String) -> Result<(), String> {
        self.below(target)?;
        self.manager.prompt(target, text, Vec::new()).await
    }

    pub fn cancel(&self, target: &SessionKey) -> Result<(), String> {
        self.below(target)?;
        self.manager.cancel(target)
    }

    /// Start a child only if it stays within `max_depth` (a root is depth 0,
    /// so `max_depth` 1 lets a root delegate and stops its children).
    pub async fn delegate_limited(
        &self,
        connection_id: &str,
        max_depth: u32,
    ) -> Result<SessionKey, String> {
        let depth = self.depth().ok_or("Unknown session")?;
        if depth + 1 > max_depth {
            return Err(format!(
                "{DEPTH_EXCEEDED}: this session is at depth {depth} and the limit is {max_depth}"
            ));
        }
        self.delegate(connection_id).await
    }

    /// Send a prompt with attachments to a child. It queues if the child is
    /// busy and resolves when its own turn finishes.
    pub async fn prompt(
        &self,
        target: &SessionKey,
        text: String,
        attachments: Vec<PromptAttachment>,
    ) -> Result<(), String> {
        self.below(target)?;
        self.manager.prompt(target, text, attachments).await
    }

    /// Start or queue a prompt for a child without waiting for it. Calls
    /// made in order run in order. The receiver resolves when the turn
    /// finishes, or errors if the session ends first.
    pub fn enqueue(
        &self,
        target: &SessionKey,
        text: String,
        attachments: Vec<PromptAttachment>,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        self.below(target)?;
        self.manager.enqueue(target, text, attachments)
    }

    /// Run `hook` once when a session below the caller ends.
    pub fn on_session_end(&self, target: &SessionKey, hook: SessionEndHook) -> Result<(), String> {
        self.below(target)?;
        self.manager.on_session_end(target, hook)
    }

    /// The caller's depth, `None` once it left the manager.
    pub fn depth(&self) -> Option<u32> {
        self.manager.session(&self.caller).map(|s| s.depth)
    }

    /// A session below the caller.
    pub fn session(&self, target: &SessionKey) -> Option<SessionInfo> {
        self.below(target).ok()?;
        self.manager.session(target)
    }

    /// Connections a child could be started on, with reported features.
    pub fn agents(&self) -> Vec<ConnectionInfo> {
        self.manager.connections()
    }

    /// Whether the user rejected a permission of `target` during its current
    /// or last turn. Read only: nothing here can answer a request.
    pub fn permission_rejected(&self, target: &SessionKey) -> bool {
        self.below(target).is_ok() && self.manager.state().rejected.contains(target)
    }

    /// Run `hook` once when the caller session ends.
    pub fn on_caller_end(&self, hook: SessionEndHook) -> Result<(), String> {
        self.manager.on_session_end(&self.caller, hook)
    }

    /// Every session below the caller.
    pub fn children(&self) -> Vec<SessionInfo> {
        let state = self.manager.state();
        state
            .tree(std::slice::from_ref(&self.caller))
            .iter()
            .skip(1)
            .filter_map(|key| state.sessions.get(key).map(|s| state.info(key, s)))
            .collect()
    }
}

/// Stops a [`SessionManager::subscribe`] subscription when dropped.
pub struct Subscription {
    id: u64,
    state: Weak<Mutex<State>>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .subscribers
                .remove(&self.id);
            state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .state_watchers
                .remove(&self.id);
        }
    }
}
