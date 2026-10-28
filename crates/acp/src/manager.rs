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
}

struct Session {
    parent: Option<SessionKey>,
    depth: u32,
    origin: SessionOrigin,
    busy: bool,
    queue: VecDeque<Turn>,
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
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new(Arc::new(|_| {}))
    }
}

fn refuse(turns: Vec<Turn>, message: &str) {
    for turn in turns {
        let _ = turn.reply.send(Err(message.to_owned()));
    }
}

fn event_session(event: &AgentEvent) -> Option<String> {
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
        Elicitation { session_id, .. } => session_id.clone(),
        Status { .. }
        | Capabilities { .. }
        | Ready { .. }
        | AuthRequired { .. }
        | ElicitationResolved { .. }
        | ElicitationComplete { .. }
        | Log { .. }
        | Error { .. } => None,
    }
}

impl SessionManager {
    pub fn new(emit: SessionEventSink) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            emit,
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
            };
            let (agent_name, session_id) = manager.observe(&id, &event);
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
        (agent_name, session_id)
    }

    /// The process exited: its sessions and every child of them end.
    fn connection_exited(&self, connection_id: &str) {
        let (turns, stops) = {
            let mut state = self.state();
            let Some(connection) = state.connections.get_mut(connection_id) else {
                return;
            };
            connection.open = false;
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
            state.detach(&tree)
        };
        self.run_end_hooks();
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
        let (connection, turns, stops) = {
            let mut state = self.state();
            let roots: Vec<SessionKey> = state
                .sessions
                .keys()
                .filter(|key| key.connection_id == connection_id)
                .cloned()
                .collect();
            let tree = state.tree(&roots);
            let (turns, stops) = state.detach(&tree);
            state.pending.retain(|(id, _), _| id != connection_id);
            state
                .permission_kinds
                .retain(|(id, _), _| id != connection_id);
            (state.connections.remove(connection_id), turns, stops)
        };
        self.run_end_hooks();
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
        let session_id = service.new_session().await?;
        let key = SessionKey::new(connection_id, session_id);
        let registered = {
            let mut state = self.state();
            let alive = state.connections.get(connection_id).is_some_and(|c| c.open)
                && parent
                    .as_ref()
                    .is_none_or(|p| state.sessions.contains_key(p));
            if alive {
                state.sessions.insert(
                    key.clone(),
                    Session {
                        parent,
                        depth,
                        origin,
                        busy: false,
                        queue: VecDeque::new(),
                    },
                );
            }
            alive
        };
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
        let mut state = self.state();
        if !state
            .connections
            .get(&key.connection_id)
            .is_some_and(|c| c.open)
        {
            return Err("Unknown or disconnected connection".into());
        }
        state.sessions.entry(key).or_insert(Session {
            parent: None,
            depth: 0,
            origin,
            busy: false,
            queue: VecDeque::new(),
        });
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
        let turn = Turn {
            text,
            attachments,
            reply,
        };
        let start = {
            let mut state = self.state();
            let session = state.sessions.get_mut(key).ok_or("Unknown session")?;
            if session.busy {
                session.queue.push_back(turn);
                None
            } else {
                session.busy = true;
                Some(turn)
            }
        };
        if let Some(turn) = start {
            self.drive(key.clone(), turn);
        }
        Ok(done)
    }

    /// Run turns for one session until its queue is empty.
    fn drive(&self, key: SessionKey, first: Turn) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut next = Some(first);
            while let Some(turn) = next.take() {
                manager.state().rejected.remove(&key);
                let result = match manager.service(&key.connection_id) {
                    Some(service) => {
                        service
                            .prompt(key.session_id.clone(), turn.text, turn.attachments)
                            .await
                    }
                    None => Err("Agent disconnected".into()),
                };
                let _ = turn.reply.send(result);
                let mut state = manager.state();
                next = match state.sessions.get_mut(&key) {
                    Some(session) => {
                        let queued = session.queue.pop_front();
                        session.busy = queued.is_some();
                        queued
                    }
                    None => None,
                };
            }
        });
    }

    /// Stop the turn in a session and in every session below it, and drop
    /// their queued follow-ups. Each connection applies the existing five
    /// second Stop deadline. Sessions stay open.
    pub fn cancel(&self, key: &SessionKey) -> Result<(), String> {
        let (turns, stops, root) = {
            let mut state = self.state();
            let root = state.service(&key.connection_id);
            let tree = state.tree(std::slice::from_ref(key));
            let mut turns = Vec::new();
            let mut stops = Vec::new();
            for child in tree.iter().skip(1).rev() {
                if let Some(session) = state.sessions.get_mut(child) {
                    turns.extend(session.queue.drain(..));
                }
                if let Some(service) = state.service(&child.connection_id) {
                    stops.push((service, child.session_id.clone()));
                }
            }
            if let Some(session) = state.sessions.get_mut(key) {
                turns.extend(session.queue.drain(..));
            }
            (turns, stops, root)
        };
        refuse(turns, "Cancelled before the turn started");
        for (service, session) in stops {
            let _ = service.cancel(session);
        }
        root.ok_or("Unknown or disconnected connection")?
            .cancel(key.session_id.clone())
    }

    /// Close a session (`session/close`). Children are cancelled first; once
    /// the agent confirms the close, they are closed and forgotten too. If
    /// the close fails the children stay registered, cancelled.
    pub async fn close(&self, key: &SessionKey) -> Result<(), String> {
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
        let (turns, stops) = {
            let mut state = self.state();
            let tree = state.tree(std::slice::from_ref(key));
            let (turns, mut stops) = state.detach(&tree);
            // The root itself was closed by the caller.
            stops.retain(|(child, _)| child != key);
            (turns, stops)
        };
        self.run_end_hooks();
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
        }
    }
}
