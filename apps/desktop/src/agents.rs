use crate::DesktopState;
use serde::Serialize;
use span_acp::tools::{
    DelegationEvent, DelegationEventSink, DelegationStatus, DelegationTranscript, ToolPolicy,
    ToolServerConfig,
};
use span_acp::{
    AgentCommand, AgentEvent, AgentHealth, AgentPreset, AgentService, AuthCredential,
    BackgroundAgents, BackgroundState, EventSink, HealthMonitor, HealthPolicy, InstalledAgent,
    LiveSession, PromptAttachment, PromptError, RegistryAgent, SessionActivity, SessionEvent,
    SessionKey, SessionManager, SessionOrigin, SessionStates, PROMPT_ALREADY_RUNNING,
};
use span_core::{BufferSnapshot, CoreWorkspace};
use specta::Type;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{ipc::Channel, Manager, State};
use tauri_specta::Event;

/// The session states of one agent connection changed: a turn started or
/// ended, a request for the user was raised or answered, or a session was
/// added or removed. The UI shows these as they are and never infers them.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionStatesChanged {
    pub states: SessionStates,
}

/// Forward every session state change of the session manager to the UI for
/// the life of the app.
pub fn watch_session_states(app: &tauri::AppHandle) {
    let state = app.state::<DesktopState>();
    let handle = app.clone();
    let subscription = state.sessions.watch_states(Arc::new(move |states| {
        // Goes through the mounted guard like every other event, so a state change can
        // never panic for lack of the event registry.
        crate::events::emit(&handle, &AgentSessionStatesChanged { states });
    }));
    // The watch lasts as long as the app: the manager lives in the app state.
    std::mem::forget(subscription);
}

/// One agent event with the session it belongs to (ADR 0001 section 3,
/// ADR 0011 phase 1). Sent for every event of every connection the session
/// manager holds, beside the sidebar's own channel, which keeps receiving the
/// plain `AgentEvent`s of the focused connection unchanged. `key` is `None`
/// for connection level events (`Ready`, `Status`, `Log`, `Capabilities`,
/// `AuthRequired`, `ElicitationComplete`, and `Delegation` `unavailable`).
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentKeyedEvent {
    pub connection_id: String,
    pub agent_name: String,
    pub key: Option<SessionKey>,
    pub event: AgentEvent,
}

impl From<SessionEvent> for AgentKeyedEvent {
    fn from(tagged: SessionEvent) -> Self {
        let key = tagged
            .session_id
            .map(|session| SessionKey::new(tagged.connection_id.clone(), session));
        Self {
            connection_id: tagged.connection_id,
            agent_name: tagged.agent_name,
            key,
            event: tagged.event,
        }
    }
}

/// A span-agents event as a keyed event: the key is the lead session.
fn keyed_delegation(sessions: &SessionManager, event: DelegationEvent) -> AgentKeyedEvent {
    let key = event.lead().cloned();
    let (connection_id, agent_name) = match (&key, &event) {
        (Some(lead), _) => (
            lead.connection_id.clone(),
            sessions
                .connection(&lead.connection_id)
                .map(|c| c.agent_name)
                .unwrap_or_default(),
        ),
        (
            None,
            DelegationEvent::Unavailable {
                connection_id,
                agent_name,
                ..
            },
        ) => (connection_id.clone(), agent_name.clone()),
        (None, _) => (String::new(), String::new()),
    };
    AgentKeyedEvent {
        connection_id,
        agent_name,
        key,
        event: AgentEvent::Delegation { event },
    }
}

/// Forward every event of every managed connection to the UI as an
/// `AgentKeyedEvent` for the life of the app.
pub fn watch_keyed_events(app: &tauri::AppHandle) {
    let state = app.state::<DesktopState>();
    let handle = app.clone();
    let subscription = state.sessions.subscribe(Arc::new(move |event| {
        crate::events::emit(&handle, &AgentKeyedEvent::from(event));
    }));
    // The subscription lasts as long as the app: the manager lives in the app state.
    std::mem::forget(subscription);
}

/// The span-agents event sink of a lead: the sidebar's channel while
/// `channel`'s gate is open, and the keyed event stream when `app` is given.
fn delegation_sink(
    app: Option<tauri::AppHandle>,
    sessions: SessionManager,
    channel: Option<(Channel<AgentEvent>, Arc<AtomicBool>)>,
) -> DelegationEventSink {
    Arc::new(move |event: DelegationEvent| {
        if let Some((channel, forward)) = &channel {
            if forward.load(Ordering::SeqCst) {
                let _ = channel.send(AgentEvent::Delegation {
                    event: event.clone(),
                });
            }
        }
        if let Some(app) = &app {
            crate::events::emit(app, &keyed_delegation(&sessions, event));
        }
    })
}

/// The latest health check result of every checked agent (ADR 0010), sent
/// whole whenever one changes.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealthChanged {
    pub agents: Vec<AgentHealth>,
}

/// The agent health check, created on first use. It checks the installed
/// agents running in the background map (warm, on demand, or the chat's
/// own when it is installed); it never starts one.
pub fn health(app: &tauri::AppHandle, state: &DesktopState) -> HealthMonitor {
    let mut guard = state.health.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .get_or_insert_with(|| {
            let folder = state.workspace.clone();
            // `agents.healthCheck` is user-only in core settings, so the open
            // folder's merged settings carry the user's value. No folder, no
            // running agents, nothing to check.
            let enabled = Arc::new(move || {
                folder
                    .lock()
                    .ok()
                    .and_then(|open| open.clone())
                    .and_then(|workspace| workspace.lock().ok()?.get_settings().ok())
                    .is_some_and(|settings| settings.agents.health_check)
            });
            let monitor = HealthMonitor::for_background(
                state.sessions.clone(),
                background(state),
                HealthPolicy::default(),
                enabled,
            );
            // Health session ids are remembered across runs, so listings
            // keep hiding them and the cleanup can delete them later.
            if let Ok(directory) = app.path().app_data_dir() {
                monitor.set_ledger(directory.join("agent-health-sessions.json"));
            }
            let handle = app.clone();
            monitor.set_sink(Some(Arc::new(move |agents| {
                crate::events::emit(&handle, &AgentHealthChanged { agents });
            })));
            monitor
        })
        .clone()
}

/// App exit: stop checking and delete (else close) the hidden check
/// sessions where the agent supports it, bounded to a few seconds.
pub fn stop_health(state: &DesktopState) {
    let monitor = state
        .health
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(monitor) = monitor {
        tauri::async_runtime::block_on(async move {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(3), monitor.shutdown()).await;
        });
    }
}

/// The focused session: the sidebar's agent connection and its open chat.
/// The unkeyed commands (`agent_prompt`, `agent_cancel`, ...) resolve to it.
#[derive(Clone)]
pub struct ActiveAgent {
    service: AgentService,
    connection: String,
    session: String,
    /// Forwards span-agents events to the UI channel as `AgentEvent::Delegation`.
    delegation_events: DelegationEventSink,
    /// Open while this connection is the sidebar's: its events reach the
    /// sidebar channel. Closed when the sidebar switches agents, so a
    /// connection kept alive for other live sessions stops feeding the old
    /// channel (its events still arrive keyed).
    forward: Arc<AtomicBool>,
}

/// The live agent sessions the desktop holds for the user (ADR 0011 phase 1).
/// Sessions, their trees and their runtime state live in the session manager;
/// this adds the focused session and which leads were opened by key.
#[derive(Default)]
pub struct LiveAgents {
    /// The sidebar's agent and chat. `None` without a connected agent.
    focused: Option<ActiveAgent>,
    /// Lead sessions opened with `agent_open_session`. A connection that still
    /// holds one is kept when the sidebar switches agents.
    opened: HashSet<SessionKey>,
    /// Connections kept or started for keyed sessions, ended with the folder.
    kept: HashSet<String>,
}

impl LiveAgents {
    /// Whether `connection` still holds a live lead opened by key.
    fn holds_opened(&mut self, sessions: &SessionManager, connection: &str) -> bool {
        self.opened.retain(|key| sessions.session(key).is_some());
        self.opened
            .iter()
            .any(|key| key.connection_id == connection)
    }
}

fn live(state: &DesktopState) -> Result<MutexGuard<'_, LiveAgents>, String> {
    state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())
}

impl ActiveAgent {
    fn key(&self, session: &str) -> SessionKey {
        SessionKey::new(self.connection.clone(), session)
    }
}

fn switch_session(
    state: &DesktopState,
    expected: &AgentService,
    session: &str,
) -> Result<(), String> {
    let mut guard = live(state)?;
    let active = guard
        .focused
        .as_mut()
        .ok_or_else(|| "Connect an agent first".to_owned())?;
    if !active.service.same_connection(expected) {
        return Err("The agent connection changed while switching conversations".into());
    }
    active.session = session.to_owned();
    Ok(())
}

/// A session left the manager: it is no longer focused or opened.
fn forget_session(state: &DesktopState, key: &SessionKey) -> Result<(), String> {
    let mut guard = live(state)?;
    guard.opened.remove(key);
    if let Some(agent) = guard
        .focused
        .as_mut()
        .filter(|agent| agent.connection == key.connection_id && agent.session == key.session_id)
    {
        agent.session.clear();
    }
    Ok(())
}

fn active(state: &DesktopState) -> Result<ActiveAgent, String> {
    live(state)?
        .focused
        .clone()
        .ok_or_else(|| "Connect an agent first".to_owned())
}

/// The focused session's key, the target of every unkeyed command.
fn focused_key(state: &DesktopState) -> Result<SessionKey, String> {
    let agent = active_session(state)?;
    Ok(agent.key(&agent.session))
}

/// Like `active`, but refuses while the agent still needs authentication.
fn active_session(state: &DesktopState) -> Result<ActiveAgent, String> {
    let agent = active(state)?;
    if agent.session.is_empty() {
        return Err("Sign in to the agent first".into());
    }
    Ok(agent)
}

fn workspace(state: &DesktopState) -> Result<Arc<Mutex<CoreWorkspace>>, String> {
    state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a folder before connecting an agent".to_owned())
}

/// `agents.delegation.enabled`. Core settings honour it only from the user's
/// own settings file, never from a workspace `.span/settings.jsonc`, so a
/// cloned repository cannot change it. It is on by default. Unreadable
/// settings count as off.
async fn delegation_enabled(workspace: Arc<Mutex<CoreWorkspace>>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        workspace
            .lock()
            .ok()
            .and_then(|workspace| workspace.get_settings().ok())
            .is_some_and(|settings| settings.agents.delegation.enabled)
    })
    .await
    .unwrap_or(false)
}

/// MCP tool config for a new or restored lead session, or `None` when both
/// delegation and workspace run tools are off.
async fn delegation_config(
    app: &tauri::AppHandle,
    state: &DesktopState,
    events: DelegationEventSink,
) -> Result<Option<ToolServerConfig>, String> {
    let workspace = workspace(state)?;
    let delegation_enabled = delegation_enabled(workspace.clone()).await;
    let run_tools_enabled = crate::run_tools::enabled(workspace.clone()).await;
    if !delegation_enabled && !run_tools_enabled {
        return Ok(None);
    }
    // With delegation on, an installed agent the lead delegates to is
    // started in the background; the UI shows the start on the delegation
    // card (ADR 0003 section 8).
    let installed = if delegation_enabled {
        installed_agents(app).await
    } else {
        Vec::new()
    };
    let background_agents = delegation_enabled.then(|| background(state));
    let run_tools = run_tools_enabled
        .then(|| crate::run_tools::backend(app.clone(), state.clone(), workspace.clone()));
    Ok(Some(ToolServerConfig {
        workspace,
        policy: ToolPolicy::default(),
        delegation_enabled,
        run_tools,
        installed,
        background: background_agents,
        events: Some(events),
    }))
}

async fn installed_agents(app: &tauri::AppHandle) -> Vec<InstalledAgent> {
    match app.path().app_cache_dir() {
        Ok(directory) => {
            let directory = directory.join("agents");
            tauri::async_runtime::spawn_blocking(move || {
                span_acp::list_installed_agents(&directory).unwrap_or_default()
            })
            .await
            .unwrap_or_default()
        }
        Err(_) => Vec::new(),
    }
}

/// The installed agents Span runs in the background, started through the
/// session manager in the open folder. Created on first use.
pub fn background(state: &DesktopState) -> BackgroundAgents {
    let mut guard = state.background.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .get_or_insert_with(|| {
            let folder = state.workspace.clone();
            let sessions = state.sessions.clone();
            BackgroundAgents::new(
                state.sessions.clone(),
                Arc::new(move |agent: InstalledAgent, sink: EventSink| {
                    let (folder, sessions) = (folder.clone(), sessions.clone());
                    Box::pin(async move {
                        let workspace = folder
                            .lock()
                            .map_err(|_| "Workspace state is unavailable".to_owned())?
                            .clone()
                            .ok_or_else(|| "Open a folder before starting an agent".to_owned())?;
                        let cwd = workspace
                            .lock()
                            .map_err(|_| "Workspace lock poisoned".to_owned())?
                            .workspace()
                            .root;
                        // Same launch path as a user connect (PATH resolution in
                        // span_acp::launch), off the async runtime's workers.
                        tauri::async_runtime::spawn_blocking(move || {
                            tauri::async_runtime::block_on(sessions.connect(
                                agent.launch,
                                cwd,
                                workspace,
                                Some(sink),
                            ))
                        })
                        .await
                        .map_err(|error| format!("Agent start task failed: {error}"))?
                    })
                }),
            )
        })
        .clone()
}

fn same_command(a: &AgentCommand, b: &AgentCommand) -> bool {
    a.command == b.command && a.args == b.args && a.env == b.env
}

/// Open a user session on the active connection. Enabled Span tools are
/// offered in this `session/new` only.
async fn open_lead(
    app: &tauri::AppHandle,
    state: &DesktopState,
    agent: &ActiveAgent,
) -> Result<String, String> {
    let config = delegation_config(app, state, agent.delegation_events.clone()).await?;
    let (key, _) = state
        .leads
        .open_lead(&state.sessions, &agent.connection, config)
        .await?;
    Ok(key.session_id)
}

/// Take the focused agent and every connection kept for keyed sessions.
/// Returns the focused agent and the other connections.
fn take_all(state: &DesktopState) -> Result<(Option<ActiveAgent>, Vec<String>), String> {
    let mut guard = live(state)?;
    let focused = guard.focused.take();
    let mut others: Vec<String> = guard.kept.drain().collect();
    others.extend(guard.opened.drain().map(|key| key.connection_id));
    others.sort();
    others.dedup();
    if let Some(focused) = &focused {
        others.retain(|c| *c != focused.connection);
    }
    Ok((focused, others))
}

/// App exit: end the focused agent and every connection held for keyed
/// sessions, without waiting.
pub fn disconnect(state: &DesktopState) -> Result<(), String> {
    let (focused, others) = take_all(state)?;
    for connection in others {
        state.run_approvals.cancel_connection(&connection);
        let _ = state.sessions.disconnect(&connection);
    }
    if let Some(active) = focused {
        state.run_approvals.cancel_connection(&active.connection);
        state.sessions.disconnect(&active.connection)?;
    }
    Ok(())
}

/// The folder closes: end the focused agent and every connection held for
/// keyed sessions, and wait for their processes.
pub async fn disconnect_and_wait(state: &DesktopState) -> Result<(), String> {
    let (focused, others) = take_all(state)?;
    for connection in others {
        let _ = end_connection(state, &connection).await;
    }
    match focused {
        Some(active) => end_connection(state, &active.connection).await,
        None => Ok(()),
    }
}

/// The sidebar disconnects its agent: end the focused connection only.
/// Sessions opened by key on other connections keep running.
async fn disconnect_focused_and_wait(state: &DesktopState) -> Result<(), String> {
    let focused = {
        let mut guard = live(state)?;
        let focused = guard.focused.take();
        if let Some(focused) = &focused {
            guard.kept.remove(&focused.connection);
        }
        focused
    };
    match focused {
        Some(active) => end_connection(state, &active.connection).await,
        None => Ok(()),
    }
}

/// End the connection's sessions and delegated children in the session
/// manager, then wait for the process and its callbacks.
async fn end_connection(state: &DesktopState, connection: &str) -> Result<(), String> {
    state.run_approvals.cancel_connection(connection);
    let service = state.sessions.service(connection);
    let _ = state.sessions.disconnect(connection);
    match service {
        Some(service) => service.shutdown_and_wait().await,
        None => Ok(()),
    }
}

/// Switch the active agent to the one `connect` opens (issue #87). The new
/// agent connects first while the old one stays active; only once it is
/// connected does it become the active agent and the old connection close.
/// A failed connect leaves the old connection and the active agent as they
/// were, so the UI can go back to the chat it left. `connect` cleans up its
/// own connection when it fails. Returns the new session id, empty while the
/// new agent waits for sign-in.
async fn connect_then_replace<F>(state: &DesktopState, connect: F) -> Result<String, String>
where
    F: std::future::Future<Output = Result<ActiveAgent, String>>,
{
    let agent = connect.await?;
    let session = agent.session.clone();
    let connection = agent.connection.clone();
    let (previous, keep) = {
        let mut guard = live(state)?;
        let previous = guard.focused.replace(agent);
        let keep = match &previous {
            Some(previous) if previous.connection != connection => {
                guard.holds_opened(&state.sessions, &previous.connection)
            }
            _ => false,
        };
        if keep {
            if let Some(previous) = &previous {
                guard.kept.insert(previous.connection.clone());
            }
        }
        guard.kept.remove(&connection);
        (previous, keep)
    };
    if let Some(previous) = previous.filter(|previous| previous.connection != connection) {
        // The old connection no longer feeds the sidebar channel.
        previous.forward.store(false, Ordering::SeqCst);
        // Sessions opened by key on it keep it alive (ADR 0011): starting a
        // sidebar agent never closes another live thread.
        if !keep {
            // The switch is done: a slow or failed shutdown of the old process
            // must not fail it.
            let _ = end_connection(state, &previous.connection).await;
        }
    }
    Ok(session)
}

/// True when connecting `installed` would reuse the active agent's own
/// connection from the background map: a reconnect to the same agent, not a
/// switch. That one still closes the old process first so it starts fresh.
fn reuses_active(
    state: &DesktopState,
    background: &BackgroundAgents,
    installed: &InstalledAgent,
) -> bool {
    let BackgroundState::Connected(connection) = background.state(&installed.id) else {
        return false;
    };
    active(state).is_ok_and(|agent| agent.connection == connection)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_remove(
    app: tauri::AppHandle,
    id: String,
    uninstall: bool,
) -> Result<(), String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("agents");
    span_acp::remove_installed_agent(&directory, &id, uninstall).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_registry() -> Result<Vec<RegistryAgent>, String> {
    span_acp::fetch_registry().await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_installed(app: tauri::AppHandle) -> Result<Vec<InstalledAgent>, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("agents");
    tauri::async_runtime::spawn_blocking(move || span_acp::list_installed_agents(&directory))
        .await
        .map_err(|error| format!("Installed agent task failed: {error}"))?
}

/// Check-only: compares installed agents with the ACP registry and reads
/// local versions through the tool probe. Nothing is installed or run to
/// update (ADR 0004).
#[tauri::command]
#[specta::specta]
pub async fn agent_update_status(
    app: tauri::AppHandle,
) -> Result<Vec<span_acp::update::AgentUpdate>, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("agents");
    span_acp::update::agent_update_status(&directory).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_install(app: tauri::AppHandle, id: String) -> Result<InstalledAgent, String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("agents");
    span_acp::install_registry_agent(&id, &directory).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_connect(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    command: AgentCommand,
    cwd: String,
    on_event: Channel<AgentEvent>,
) -> Result<String, String> {
    let state = state.inner().clone();
    let _gate = state.connection_gate.lock().await;
    let workspace = workspace(&state)?;
    let background = background(&state);
    let installed = installed_agents(&app)
        .await
        .into_iter()
        .find(|agent| same_command(&agent.launch, &command));
    if installed
        .as_ref()
        .is_some_and(|installed| reuses_active(&state, &background, installed))
    {
        disconnect_focused_and_wait(&state).await?;
    }
    let forward = Arc::new(AtomicBool::new(true));
    let ui: EventSink = {
        let channel = on_event.clone();
        let forward = forward.clone();
        Arc::new(move |event| {
            if forward.load(Ordering::SeqCst) {
                let _ = channel.send(event);
            }
        })
    };
    let opening = open_agent(
        &app,
        &state,
        &background,
        installed,
        command,
        cwd,
        workspace,
        on_event,
        forward,
        ui.clone(),
    );
    let session = connect_then_replace(&state, opening).await?;
    // Requests of delegated children on background agents reach this chat.
    // Set only once the switch is done, so a failed one leaves them with the
    // chat that is still active.
    background.set_child_sink(Some(ui));
    Ok(session)
}

/// Connect `command` and open its lead session, without touching the active
/// agent. On failure the new connection is closed again.
#[allow(clippy::too_many_arguments)]
async fn open_agent(
    app: &tauri::AppHandle,
    state: &DesktopState,
    background: &BackgroundAgents,
    installed: Option<InstalledAgent>,
    command: AgentCommand,
    cwd: String,
    workspace: Arc<Mutex<CoreWorkspace>>,
    on_event: Channel<AgentEvent>,
    forward: Arc<AtomicBool>,
    ui: EventSink,
) -> Result<ActiveAgent, String> {
    let delegation_events = delegation_sink(
        Some(app.clone()),
        state.sessions.clone(),
        Some((on_event, forward.clone())),
    );
    let connection = match installed {
        // An installed agent runs through the background map, so a warm or
        // delegated process is reused and never started twice.
        Some(installed) => {
            background
                .ensure(&installed, std::time::Duration::from_secs(60))
                .await?;
            background.promote(&installed.id, ui)?
        }
        None => {
            let sessions = state.sessions.clone();
            tauri::async_runtime::spawn_blocking(move || {
                tauri::async_runtime::block_on(sessions.connect(command, cwd, workspace, Some(ui)))
            })
            .await
            .map_err(|error| format!("Agent connection task failed: {error}"))??
        }
    };
    let service: AgentService = state
        .sessions
        .service(&connection)
        .ok_or_else(|| "Agent disconnected".to_owned())?;
    let mut agent = ActiveAgent {
        service: service.clone(),
        connection: connection.clone(),
        session: String::new(),
        delegation_events,
        forward,
    };
    let session = match tokio::time::timeout(
        std::time::Duration::from_secs(45),
        open_lead(app, state, &agent),
    )
    .await
    {
        Ok(Ok(session)) => session,
        Ok(Err(_)) if service.auth_required() => {
            // Keep the process alive. The UI gets an AuthRequired event and
            // calls agent_authenticate, which creates the session.
            return Ok(agent);
        }
        result => {
            let _ = state.sessions.disconnect(&connection);
            return Err(match result {
                Ok(Err(error)) => error,
                Err(_) => "Agent session creation timed out after 45 seconds".to_owned(),
                Ok(Ok(_)) => "Agent session creation failed".to_owned(),
            });
        }
    };
    agent.session = session;
    Ok(agent)
}

/// Warm start (ADR 0009): start installed agents in the background so a
/// delegation or an agent switch does not wait for the process. Process and
/// ACP `initialize` only, no session. `recent` lists agent ids most recently
/// used first (the UI keeps that list); the rest follow by id. At most four,
/// one at a time and 300 ms apart, off the UI thread; returns at once. A
/// failed start is recorded quietly and retried only on demand. Does nothing
/// when `agents.warmStart` (user settings only) is off. Returns how many
/// agents it queued.
#[tauri::command]
#[specta::specta]
pub async fn agent_warm_start(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    recent: Vec<String>,
) -> Result<u32, String> {
    let state = state.inner();
    let workspace = workspace(state)?;
    let enabled = tauri::async_runtime::spawn_blocking(move || {
        workspace
            .lock()
            .ok()
            .and_then(|workspace| workspace.get_settings().ok())
            .is_some_and(|settings| settings.agents.warm_start)
    })
    .await
    .unwrap_or(false);
    if !enabled {
        return Ok(0);
    }
    let agents = warm_order(installed_agents(&app).await, &recent);
    let count = agents.len().min(WARM_CAP) as u32;
    background(state).warm(
        agents,
        std::time::Duration::from_millis(300),
        WARM_CAP,
        std::time::Duration::from_secs(45),
    );
    Ok(count)
}

const WARM_CAP: usize = 4;

/// The latest health check result per agent (ADR 0010); empty while
/// `agents.healthCheck` (user settings only) is off. The first call starts
/// the periodic checks, so the UI calls it once the window is shown; changes
/// arrive as `AgentHealthChanged`. Each check is one tiny prompt to a running
/// agent that has not chatted for five minutes, over a hidden session that
/// never shows in History.
#[tauri::command]
#[specta::specta]
pub async fn agent_health(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Vec<AgentHealth>, String> {
    let monitor = health(&app, state.inner());
    monitor.start();
    tauri::async_runtime::spawn_blocking(move || monitor.results())
        .await
        .map_err(|error| format!("Agent health task failed: {error}"))
}

/// Installed agents ordered for a warm start: `recent` ids first in that
/// order, then the others by id. One entry per id (the newest version).
fn warm_order(mut installed: Vec<InstalledAgent>, recent: &[String]) -> Vec<InstalledAgent> {
    installed.sort_by(|a, b| a.id.cmp(&b.id).then(b.version.cmp(&a.version)));
    installed.dedup_by(|a, b| a.id == b.id);
    let rank = |id: &str| {
        recent
            .iter()
            .position(|r| r.eq_ignore_ascii_case(id))
            .unwrap_or(usize::MAX)
    };
    installed.sort_by_key(|agent| rank(&agent.id));
    installed
}

/// Start a fresh conversation on the connected agent process.
#[tauri::command]
#[specta::specta]
pub async fn agent_new_session(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    let agent = active(state.inner())?;
    let session = open_lead(&app, state.inner(), &agent).await?;
    switch_session(state.inner(), &agent.service, &session)?;
    Ok(session)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_list_sessions(
    state: State<'_, DesktopState>,
) -> Result<Vec<span_acp::SessionSummary>, String> {
    active(state.inner())?.service.list_sessions().await
}

/// Every session the connected agent lists, from any folder (the History
/// "All folders" scope). Each summary carries the session's `cwd`.
#[tauri::command]
#[specta::specta]
pub async fn agent_list_all_sessions(
    state: State<'_, DesktopState>,
) -> Result<Vec<span_acp::SessionSummary>, String> {
    active(state.inner())?.service.list_sessions_in(true).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_resume_session(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<String, String> {
    let agent = active(state.inner())?;
    // A session Span holds that is still working (a turn in flight, queued
    // follow-ups or a request waiting for the user) is shown as it is: a
    // session/load would replay it over the live turn.
    let live = state
        .sessions
        .session_state(&agent.key(&session_id))
        .is_some_and(|s| s.state != SessionActivity::Idle || s.queued > 0);
    if !live {
        // ACP does not keep MCP servers across session/load, so with delegation
        // on a fresh span-agents entry is offered in this load (ADR 0003).
        let config =
            delegation_config(&app, state.inner(), agent.delegation_events.clone()).await?;
        state
            .leads
            .load_lead(&state.sessions, &agent.connection, &session_id, config)
            .await?;
    }
    switch_session(state.inner(), &agent.service, &session_id)?;
    Ok(session_id)
}

/// Close a session the agent holds. Closing the active session leaves the
/// connection without one; the UI starts or resumes another.
#[tauri::command]
#[specta::specta]
pub async fn agent_close_session(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<(), String> {
    let agent = active(state.inner())?;
    close_key(state.inner(), &agent.key(&session_id)).await
}

/// Delete a session from the agent's history. Any running turn in it is
/// cancelled first by the service.
#[tauri::command]
#[specta::specta]
pub async fn agent_delete_session(
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<(), String> {
    let agent = active(state.inner())?;
    let key = agent.key(&session_id);
    state.run_approvals.cancel_lead(&key);
    state.sessions.delete(&key).await?;
    forget_session(state.inner(), &key)
}

/// Run a prompt in the active session and resolve when its turn ends. A
/// session that already runs a turn refuses it with the typed
/// `PromptError::Busy` (nothing is sent or queued), so the UI can offer
/// steer or queue instead of showing an error.
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt(
    state: State<'_, DesktopState>,
    text: String,
    attachments: Option<Vec<PromptAttachment>>,
) -> Result<(), PromptError> {
    let key = focused_key(state.inner()).map_err(|message| PromptError::Failed { message })?;
    prompt_key(state.inner(), &key, text, attachments.unwrap_or_default()).await
}

/// Run a prompt in the session `key` (ADR 0011 phase 1). Same refusal as
/// `agent_prompt`: a busy session answers `PromptError::Busy`.
async fn prompt_key(
    state: &DesktopState,
    key: &SessionKey,
    text: String,
    attachments: Vec<PromptAttachment>,
) -> Result<(), PromptError> {
    let done = state.sessions.start_turn(key, text, attachments)?;
    match done.await {
        Ok(Ok(())) => Ok(()),
        // The agent itself still had a turn in flight (it started between
        // the manager's check and the prompt reaching it).
        Ok(Err(message)) if message == PROMPT_ALREADY_RUNNING => Err(PromptError::Busy {
            message,
            state: state.sessions.session_state(key),
        }),
        Ok(Err(message)) => Err(PromptError::Failed { message }),
        Err(_) => Err(PromptError::Failed {
            message: "The session ended before the turn finished".into(),
        }),
    }
}

/// Runtime state of every session on the active connection: idle, running,
/// waiting for an approval or an answer, queued follow-ups, when the current
/// turn started and its current tool. `connectionId` is null without a
/// connection. Changes arrive as `AgentSessionStatesChanged`.
#[tauri::command]
#[specta::specta]
pub async fn agent_session_states(state: State<'_, DesktopState>) -> Result<SessionStates, String> {
    Ok(match active(state.inner()) {
        Ok(agent) => state.sessions.session_states(&agent.connection),
        Err(_) => SessionStates {
            connection_id: None,
            sessions: Vec::new(),
        },
    })
}

/// Sign in with an advertised method, then create the session that was blocked.
/// Returns the new session id, or the current one when a session already exists.
#[tauri::command]
#[specta::specta]
pub async fn agent_authenticate(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    method_id: String,
) -> Result<String, String> {
    let agent = active(state.inner())?;
    agent.service.authenticate(method_id).await?;
    if !agent.session.is_empty() {
        return Ok(agent.session);
    }
    let session = open_lead(&app, state.inner(), &agent).await?;
    switch_session(state.inner(), &agent.service, &session)?;
    Ok(session)
}

/// Sign in with a method that needs an API key or a gateway the user typed,
/// then create the session that was blocked. The secret is passed to the agent
/// only; it is not logged or stored.
#[tauri::command]
#[specta::specta]
pub async fn agent_authenticate_with(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    method_id: String,
    credential: AuthCredential,
) -> Result<String, String> {
    let agent = active(state.inner())?;
    agent
        .service
        .authenticate_with(method_id, credential)
        .await?;
    if !agent.session.is_empty() {
        return Ok(agent.session);
    }
    let session = open_lead(&app, state.inner(), &agent).await?;
    switch_session(state.inner(), &agent.service, &session)?;
    Ok(session)
}

/// Agents launched by a known custom command rather than a registry install.
#[tauri::command]
#[specta::specta]
pub fn agent_presets() -> Vec<AgentPreset> {
    span_acp::agent_presets()
}

/// Answer an agent input request. `action` is accept, decline or cancel.
#[tauri::command]
#[specta::specta]
pub async fn agent_elicitation(
    state: State<'_, DesktopState>,
    request_id: String,
    action: String,
    content_json: Option<String>,
) -> Result<(), String> {
    let agent = active(state.inner())?;
    match agent.service.respond_elicitation(
        request_id.clone(),
        action.clone(),
        content_json.clone(),
    ) {
        // A delegated child on a background agent asked it.
        Err(error) if error.contains("no longer pending") => {
            for service in other_services(state.inner(), &agent) {
                if service
                    .respond_elicitation(request_id.clone(), action.clone(), content_json.clone())
                    .is_ok()
                {
                    return Ok(());
                }
            }
            Err(error)
        }
        result => result,
    }
}

/// The services of every other open connection (background agents running
/// delegated children). Proposal ids come from the shared workspace, so
/// they are unique across connections.
fn other_services(state: &DesktopState, agent: &ActiveAgent) -> Vec<AgentService> {
    state
        .sessions
        .connections()
        .into_iter()
        .filter(|c| c.open && c.connection_id != agent.connection)
        .filter_map(|c| state.sessions.service(&c.connection_id))
        .collect()
}

/// Review a proposal on the active agent, else on the background agent
/// whose delegated child proposed it.
fn review_anywhere(
    state: &DesktopState,
    agent: &ActiveAgent,
    review: impl Fn(&AgentService) -> Result<BufferSnapshot, String>,
) -> Result<BufferSnapshot, String> {
    match review(&agent.service) {
        Err(error) if error.contains("no longer pending") => {
            for service in other_services(state, agent) {
                match review(&service) {
                    Err(other) if other.contains("no longer pending") => continue,
                    result => return result,
                }
            }
            Err(error)
        }
        result => result,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn agent_set_config(
    state: State<'_, DesktopState>,
    config_id: String,
    value: String,
) -> Result<(), String> {
    let key = focused_key(state.inner())?;
    set_config_key(state.inner(), &key, config_id, value).await
}

async fn set_config_key(
    state: &DesktopState,
    key: &SessionKey,
    config_id: String,
    value: String,
) -> Result<(), String> {
    state
        .sessions
        .service(&key.connection_id)
        .ok_or("Unknown or disconnected connection")?
        .set_config(key.session_id.clone(), config_id, value)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_cancel(state: State<'_, DesktopState>) -> Result<(), String> {
    state.sessions.cancel(&focused_key(state.inner())?)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_disconnect(state: State<'_, DesktopState>) -> Result<(), String> {
    let state = state.inner();
    let _gate = state.connection_gate.lock().await;
    disconnect_focused_and_wait(state).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_permission(
    state: State<'_, DesktopState>,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let key = focused_key(state.inner())?;
    state
        .sessions
        .respond_permission(&key, request_id, option_id)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_review(
    state: State<'_, DesktopState>,
    lsp: State<'_, crate::language_servers::LspService>,
    proposal_id: String,
    accept: bool,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    let agent = active(state.inner())?;
    let desktop = state.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        review_anywhere(&desktop, &agent, |service| {
            service.review_proposal(proposal_id.clone(), accept, expected_revision)
        })
    })
    .await
    .map_err(|error| format!("Review task failed: {error}"))??;
    lsp.on_snapshot(&snapshot);
    Ok(snapshot)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_review_hunks(
    state: State<'_, DesktopState>,
    lsp: State<'_, crate::language_servers::LspService>,
    proposal_id: String,
    accepted_hunk_ids: Vec<String>,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    let agent = active(state.inner())?;
    let desktop = state.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        review_anywhere(&desktop, &agent, |service| {
            service.review_proposal_hunks(
                proposal_id.clone(),
                accepted_hunk_ids.clone(),
                expected_revision,
            )
        })
    })
    .await
    .map_err(|error| format!("Review task failed: {error}"))??;
    lsp.on_snapshot(&snapshot);
    Ok(snapshot)
}

/// Delegation state of the active connection and its current lead session:
/// whether `agents.delegation.enabled` is on (user settings only), whether
/// the agent can use the span-agents server and why not, and the lead's
/// tasks and decisions.
#[tauri::command]
#[specta::specta]
pub async fn agent_delegation_status(
    state: State<'_, DesktopState>,
) -> Result<DelegationStatus, String> {
    let state = state.inner();
    let agent = active(state)?;
    let enabled = delegation_enabled(workspace(state)?).await;
    let lead = (!agent.session.is_empty()).then(|| agent.key(&agent.session));
    Ok(state
        .leads
        .status(&state.sessions, &agent.connection, lead.as_ref(), enabled))
}

/// The user stops one delegated task: its child session and everything
/// below it are cancelled and the task ends as cancelled. User only: the
/// span-agents `cancel` tool is the lead's separate way to do the same, and
/// no tool can reach this command. Task ids repeat across leads, so the
/// active chat's lead is searched first.
#[tauri::command]
#[specta::specta]
pub async fn agent_cancel_task(
    state: State<'_, DesktopState>,
    task_id: String,
) -> Result<(), String> {
    let state = state.inner();
    let lead = active(state)
        .ok()
        .filter(|agent| !agent.session.is_empty())
        .map(|agent| agent.key(&agent.session));
    state.leads.cancel_task(lead.as_ref(), &task_id)
}

/// One delegated task and what its child session wrote so far, for the
/// user opening the child session from its card. Read only. Searched like
/// `agent_cancel_task`.
#[tauri::command]
#[specta::specta]
pub async fn agent_task_transcript(
    state: State<'_, DesktopState>,
    task_id: String,
) -> Result<DelegationTranscript, String> {
    let state = state.inner();
    let lead = active(state)
        .ok()
        .filter(|agent| !agent.session.is_empty())
        .map(|agent| agent.key(&agent.session));
    state.leads.transcript(lead.as_ref(), &task_id)
}

/// The user's answer to a permission request from a delegated child
/// session, keyed by its connection and session. Only the UI calls this:
/// the span-agents tools hold an `AgentControl`, which has no permission
/// path, so no agent can answer for the user. User sessions keep using
/// `agent_permission`.
#[tauri::command]
#[specta::specta]
pub async fn agent_child_permission(
    state: State<'_, DesktopState>,
    connection_id: String,
    session_id: String,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let key = SessionKey::new(connection_id, session_id);
    let session = state
        .sessions
        .session(&key)
        .ok_or_else(|| "Unknown or ended session".to_owned())?;
    if session.origin != SessionOrigin::Delegated {
        return Err("Not a delegated session".into());
    }
    state
        .sessions
        .respond_permission(&key, request_id, option_id)
}

/// Open a user lead session on `connection` without touching the focused
/// session. Each lead gets its own span-agents server and token when tools
/// are enabled (ADR 0003). A failure leaves every existing session as it was.
async fn open_on(
    state: &DesktopState,
    connection: &str,
    config: Option<ToolServerConfig>,
) -> Result<SessionKey, String> {
    let (key, _) = state
        .leads
        .open_lead(&state.sessions, connection, config)
        .await?;
    live(state)?.opened.insert(key.clone());
    Ok(key)
}

/// Start a custom agent command for keyed sessions. Its events reach the UI
/// only as `AgentKeyedEvent`s; the sidebar channel is not involved.
async fn connect_command(
    state: &DesktopState,
    command: AgentCommand,
    cwd: String,
    workspace: Arc<Mutex<CoreWorkspace>>,
) -> Result<String, String> {
    let sessions = state.sessions.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(sessions.connect(command, cwd, workspace, None))
    })
    .await
    .map_err(|error| format!("Agent connection task failed: {error}"))??;
    live(state)?.kept.insert(connection.clone());
    Ok(connection)
}

/// The connection a new keyed session runs on: the given one, the focused
/// one, or a new one for `command`. The bool is true when this call started
/// a process it must end again if the session fails to open.
async fn connection_for_open(
    app: &tauri::AppHandle,
    state: &DesktopState,
    connection_id: Option<String>,
    command: Option<AgentCommand>,
) -> Result<(String, bool), String> {
    match (connection_id, command) {
        (Some(_), Some(_)) => Err("Pass a connection or a command, not both".into()),
        (Some(connection), None) => Ok((connection, false)),
        (None, None) => Ok((active(state)?.connection, false)),
        (None, Some(command)) => {
            let workspace = workspace(state)?;
            let installed = installed_agents(app)
                .await
                .into_iter()
                .find(|agent| same_command(&agent.launch, &command));
            match installed {
                // Installed agents run through the background map, so a warm
                // or delegated process is reused and never started twice.
                Some(installed) => {
                    let ensured = background(state)
                        .ensure(&installed, std::time::Duration::from_secs(60))
                        .await?;
                    live(state)?.kept.insert(ensured.connection_id.clone());
                    Ok((ensured.connection_id, false))
                }
                None => {
                    let cwd = workspace
                        .lock()
                        .map_err(|_| "Workspace lock poisoned".to_owned())?
                        .workspace()
                        .root;
                    let connection = connect_command(state, command, cwd, workspace).await?;
                    Ok((connection, true))
                }
            }
        }
    }
}

/// Open a new user session and return its key (ADR 0011 phase 1). Unlike
/// `agent_connect` it never closes another session. Runs on `connection_id`
/// when given, on a new or running process for `command` when given, else
/// on the focused connection. With `focus` the new session becomes the
/// sidebar's chat; only a session on the sidebar's own connection can be
/// focused, and that is checked before anything is opened. A failure leaves
/// every existing session and the focus as they were.
#[tauri::command]
#[specta::specta]
pub async fn agent_open_session(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    connection_id: Option<String>,
    command: Option<AgentCommand>,
    focus: bool,
) -> Result<SessionKey, String> {
    let state = state.inner().clone();
    let focused = active(&state).ok();
    if focus {
        let on_focused = match (&connection_id, &command, &focused) {
            (_, Some(_), _) | (_, _, None) => false,
            (Some(connection), None, Some(agent)) => *connection == agent.connection,
            (None, None, Some(_)) => true,
        };
        if !on_focused {
            return Err("Only a session on the sidebar's agent connection can be focused".into());
        }
    }
    let _gate = state.connection_gate.lock().await;
    let (connection, started) = connection_for_open(&app, &state, connection_id, command).await?;
    let events = delegation_sink(Some(app.clone()), state.sessions.clone(), None);
    let opened = async {
        let config = delegation_config(&app, &state, events).await?;
        open_on(&state, &connection, config).await
    };
    let key = match tokio::time::timeout(std::time::Duration::from_secs(45), opened).await {
        Ok(Ok(key)) => key,
        result => {
            if started {
                if let Ok(mut guard) = live(&state) {
                    guard.kept.remove(&connection);
                }
                let _ = state.sessions.disconnect(&connection);
            }
            return Err(match result {
                Ok(Err(error)) => error,
                _ => "Agent session creation timed out after 45 seconds".to_owned(),
            });
        }
    };
    if let (true, Some(agent)) = (focus, focused) {
        switch_session(&state, &agent.service, &key.session_id)?;
    }
    Ok(key)
}

/// Every live session Span holds: user leads, their delegated children
/// (with the parent key) and resumed sessions, with runtime state (idle,
/// running, waiting for approval or an answer, queued follow-ups), agent,
/// title, model, mode and health. Hidden health check sessions never appear.
/// Changes arrive as `AgentSessionStatesChanged` and `AgentKeyedEvent`.
#[tauri::command]
#[specta::specta]
pub async fn agent_live_sessions(
    state: State<'_, DesktopState>,
) -> Result<Vec<LiveSession>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live_sessions(&state))
        .await
        .map_err(|error| format!("Live session task failed: {error}"))
}

fn live_sessions(state: &DesktopState) -> Vec<LiveSession> {
    let mut sessions = state.sessions.live_sessions();
    // Neither is created here: no background map means no installed agents
    // run, and no monitor means no health results yet.
    let background = state
        .background
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let health = state
        .health
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .map(|monitor| monitor.results())
        .unwrap_or_default();
    for session in &mut sessions {
        session.agent_id = background
            .as_ref()
            .and_then(|b| b.agent_for(&session.key.connection_id));
        session.health = session.agent_id.as_ref().and_then(|id| {
            health
                .iter()
                .find(|h| h.agent_id.eq_ignore_ascii_case(id))
                .map(|h| h.state)
        });
    }
    sessions
}

/// The focused session (the sidebar's chat), `None` without one.
#[tauri::command]
#[specta::specta]
pub async fn agent_focused_session(
    state: State<'_, DesktopState>,
) -> Result<Option<SessionKey>, String> {
    Ok(focused_key(state.inner()).ok())
}

/// Run a prompt in the session `key`. Like `agent_prompt`, a busy session
/// refuses it with `PromptError::Busy`.
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt_keyed(
    state: State<'_, DesktopState>,
    key: SessionKey,
    text: String,
    attachments: Option<Vec<PromptAttachment>>,
) -> Result<(), PromptError> {
    prompt_key(state.inner(), &key, text, attachments.unwrap_or_default()).await
}

/// Stop the turn in `key` and every session below it.
#[tauri::command]
#[specta::specta]
pub async fn agent_cancel_keyed(
    state: State<'_, DesktopState>,
    key: SessionKey,
) -> Result<(), String> {
    state.sessions.cancel(&key)
}

/// The user's answer to a permission request of `key`. The request must
/// belong to that session on that connection. User only: agents hold an
/// `AgentControl`, which has no answering path (ADR 0003).
#[tauri::command]
#[specta::specta]
pub async fn agent_permission_keyed(
    state: State<'_, DesktopState>,
    key: SessionKey,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    state
        .sessions
        .respond_permission(&key, request_id, option_id)
}

/// The user's answer to an input request of `key`. `action` is accept,
/// decline or cancel. User only, like `agent_permission_keyed`.
#[tauri::command]
#[specta::specta]
pub async fn agent_elicitation_keyed(
    state: State<'_, DesktopState>,
    key: SessionKey,
    request_id: String,
    action: String,
    content_json: Option<String>,
) -> Result<(), String> {
    state
        .sessions
        .respond_elicitation_for(&key, request_id, action, content_json)
}

/// Change a config option of the session `key`.
#[tauri::command]
#[specta::specta]
pub async fn agent_set_config_keyed(
    state: State<'_, DesktopState>,
    key: SessionKey,
    config_id: String,
    value: String,
) -> Result<(), String> {
    set_config_key(state.inner(), &key, config_id, value).await
}

/// The service a keyed review runs on: only the connection of `key`.
fn review_service(state: &DesktopState, key: &SessionKey) -> Result<AgentService, String> {
    state
        .sessions
        .service(&key.connection_id)
        .ok_or_else(|| "Unknown or disconnected connection".to_owned())
}

/// Accept or reject a proposal of the session `key`, on its connection
/// only. User only.
#[tauri::command]
#[specta::specta]
pub async fn agent_review_keyed(
    state: State<'_, DesktopState>,
    lsp: State<'_, crate::language_servers::LspService>,
    key: SessionKey,
    proposal_id: String,
    accept: bool,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    let service = review_service(state.inner(), &key)?;
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        service.review_proposal(proposal_id, accept, expected_revision)
    })
    .await
    .map_err(|error| format!("Review task failed: {error}"))??;
    lsp.on_snapshot(&snapshot);
    Ok(snapshot)
}

/// Accept some hunks of a proposal of the session `key`. User only.
#[tauri::command]
#[specta::specta]
pub async fn agent_review_hunks_keyed(
    state: State<'_, DesktopState>,
    lsp: State<'_, crate::language_servers::LspService>,
    key: SessionKey,
    proposal_id: String,
    accepted_hunk_ids: Vec<String>,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    let service = review_service(state.inner(), &key)?;
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        service.review_proposal_hunks(proposal_id, accepted_hunk_ids, expected_revision)
    })
    .await
    .map_err(|error| format!("Review task failed: {error}"))??;
    lsp.on_snapshot(&snapshot);
    Ok(snapshot)
}

/// Close the session `key`. Its delegated children are cancelled and
/// closed with it, and its span-agents server stops (ADR 0001 section 5,
/// ADR 0003). Closing the focused session leaves the sidebar without a chat.
#[tauri::command]
#[specta::specta]
pub async fn agent_close_keyed(
    state: State<'_, DesktopState>,
    key: SessionKey,
) -> Result<(), String> {
    close_key(state.inner(), &key).await
}

async fn close_key(state: &DesktopState, key: &SessionKey) -> Result<(), String> {
    state.run_approvals.cancel_lead(key);
    state.sessions.close(key).await?;
    forget_session(state, key)
}

/// Check-only: reads the public GitHub release list for this build's channel.
/// Opening the release page is a separate, user-initiated `open_external`.
#[tauri::command]
#[specta::specta]
pub async fn app_update_check(app: tauri::AppHandle) -> span_acp::update::AppUpdate {
    let version = app.package_info().version.to_string();
    span_acp::update::check_app_update(&version, cfg!(debug_assertions)).await
}

#[cfg(test)]
mod warm_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn agent(id: &str, version: &str) -> InstalledAgent {
        InstalledAgent {
            id: id.into(),
            version: version.into(),
            launch: AgentCommand {
                command: id.into(),
                args: Vec::new(),
                env: BTreeMap::new(),
            },
        }
    }

    #[test]
    fn warm_order_puts_recent_agents_first_once_each() {
        let installed = vec![
            agent("gemini", "1"),
            agent("claude-acp", "1"),
            agent("codex-acp", "2"),
            agent("codex-acp", "1"),
            agent("opencode", "1"),
        ];
        let ids: Vec<String> = warm_order(installed, &["codex-acp".into(), "opencode".into()])
            .into_iter()
            .map(|a| format!("{}@{}", a.id, a.version))
            .collect();
        assert_eq!(
            ids,
            ["codex-acp@2", "opencode@1", "claude-acp@1", "gemini@1"]
        );
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        sync::{Arc, Mutex},
    };
    #[tokio::test]
    async fn old_connection_cannot_change_new_connections_active_session() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = Arc::new(Mutex::new(
            span_core::CoreWorkspace::open(directory.path())
                .unwrap()
                .with_user_settings(None),
        ));
        let command = AgentCommand {
            command: "node".into(),
            args: vec![format!(
                "{}/../../crates/acp/tests/fixtures/agent.mjs",
                env!("CARGO_MANIFEST_DIR")
            )],
            env: BTreeMap::new(),
        };
        let old = AgentService::start(
            command.clone(),
            directory.path().to_string_lossy().into_owned(),
            workspace.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let current = AgentService::start(
            command,
            directory.path().to_string_lossy().into_owned(),
            workspace,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let state = DesktopState::default();
        state.agent.lock().unwrap().focused = Some(ActiveAgent {
            service: current.clone(),
            connection: String::new(),
            session: "current".into(),
            delegation_events: Arc::new(|_| {}),
            forward: Arc::new(AtomicBool::new(true)),
        });
        assert!(switch_session(&state, &old, "old-result").is_err());
        assert_eq!(active(&state).unwrap().session, "current");
        switch_session(&state, &current, "valid-result").unwrap();
        assert_eq!(active(&state).unwrap().session, "valid-result");
        old.shutdown_and_wait().await.unwrap();
        current.shutdown_and_wait().await.unwrap();
    }

    /// Connect the fixture agent through the state's session manager and
    /// describe it as an active agent with `session`.
    async fn fixture_agent(
        state: &DesktopState,
        directory: &std::path::Path,
        session: &str,
    ) -> ActiveAgent {
        let workspace = Arc::new(Mutex::new(
            span_core::CoreWorkspace::open(directory)
                .unwrap()
                .with_user_settings(None),
        ));
        let command = AgentCommand {
            command: "node".into(),
            args: vec![format!(
                "{}/../../crates/acp/tests/fixtures/agent.mjs",
                env!("CARGO_MANIFEST_DIR")
            )],
            env: BTreeMap::new(),
        };
        let connection = state
            .sessions
            .connect(
                command,
                directory.to_string_lossy().into_owned(),
                workspace,
                Some(Arc::new(|_| {})),
            )
            .await
            .unwrap();
        ActiveAgent {
            service: state.sessions.service(&connection).unwrap(),
            connection,
            session: session.into(),
            delegation_events: Arc::new(|_| {}),
            forward: Arc::new(AtomicBool::new(true)),
        }
    }

    #[tokio::test]
    async fn agent_switch_connects_first_and_keeps_the_old_connection_when_it_fails() {
        let directory = tempfile::tempdir().unwrap();
        let state = DesktopState::default();
        let old = fixture_agent(&state, directory.path(), "old-session").await;
        let old_connection = old.connection.clone();
        state.agent.lock().unwrap().focused = Some(old);

        // A failed switch: the old agent stays active and its process alive.
        let failed = connect_then_replace(&state, async {
            assert!(state.sessions.service(&old_connection).is_some());
            Err::<ActiveAgent, String>("new agent: command not found".into())
        })
        .await;
        assert_eq!(failed.unwrap_err(), "new agent: command not found");
        let still = active(&state).unwrap();
        assert_eq!(still.connection, old_connection);
        assert_eq!(still.session, "old-session");
        assert!(state.sessions.service(&old_connection).is_some());

        // A successful switch: the old connection is still open while the new
        // agent connects, and closed once the new one is active.
        let switched = connect_then_replace(&state, async {
            assert!(state.sessions.service(&old_connection).is_some());
            Ok(fixture_agent(&state, directory.path(), "new-session").await)
        })
        .await
        .unwrap();
        assert_eq!(switched, "new-session");
        let current = active(&state).unwrap();
        assert_ne!(current.connection, old_connection);
        assert_eq!(current.session, "new-session");
        assert!(state.sessions.service(&old_connection).is_none());
        assert!(state.sessions.service(&current.connection).is_some());

        disconnect_and_wait(&state).await.unwrap();
        assert!(state.sessions.service(&current.connection).is_none());
    }

    fn fixture_command(flags: &[&str]) -> AgentCommand {
        let mut args = vec![format!(
            "{}/../../crates/acp/tests/fixtures/agent.mjs",
            env!("CARGO_MANIFEST_DIR")
        )];
        args.extend(flags.iter().map(|flag| flag.to_string()));
        AgentCommand {
            command: "node".into(),
            args,
            env: BTreeMap::new(),
        }
    }

    fn fixture_workspace(directory: &std::path::Path) -> Arc<Mutex<CoreWorkspace>> {
        std::fs::write(directory.join("sample.txt"), "disk text\n").unwrap();
        Arc::new(Mutex::new(
            span_core::CoreWorkspace::open(directory)
                .unwrap()
                .with_user_settings(None),
        ))
    }

    /// Start a fixture agent for keyed sessions, the way `agent_open_session`
    /// starts a custom command.
    async fn keyed_connection(
        state: &DesktopState,
        directory: &std::path::Path,
        flags: &[&str],
    ) -> String {
        connect_command(
            state,
            fixture_command(flags),
            directory.to_string_lossy().into_owned(),
            fixture_workspace(directory),
        )
        .await
        .unwrap()
    }

    /// Make `key` the focused session, as `agent_connect` does for the sidebar.
    fn focus(state: &DesktopState, key: &SessionKey) {
        state.agent.lock().unwrap().focused = Some(ActiveAgent {
            service: state.sessions.service(&key.connection_id).unwrap(),
            connection: key.connection_id.clone(),
            session: key.session_id.clone(),
            delegation_events: Arc::new(|_| {}),
            forward: Arc::new(AtomicBool::new(true)),
        });
    }

    async fn activity_becomes(state: &DesktopState, key: &SessionKey, wanted: SessionActivity) {
        let waited = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                if state.sessions.session_state(key).map(|s| s.state) == Some(wanted) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            waited.is_ok(),
            "{key:?} never became {wanted:?}, it is {:?}",
            state.sessions.session_state(key)
        );
    }

    fn activity(state: &DesktopState, key: &SessionKey) -> Option<SessionActivity> {
        state.sessions.session_state(key).map(|s| s.state)
    }

    fn spawn_prompt(
        state: &DesktopState,
        key: &SessionKey,
        text: &str,
    ) -> tokio::task::JoinHandle<Result<(), PromptError>> {
        let (state, key, text) = (state.clone(), key.clone(), text.to_owned());
        tokio::spawn(async move { prompt_key(&state, &key, text, Vec::new()).await })
    }

    async fn finished(
        turn: tokio::task::JoinHandle<Result<(), PromptError>>,
    ) -> Result<(), PromptError> {
        tokio::time::timeout(std::time::Duration::from_secs(15), turn)
            .await
            .expect("turn did not finish")
            .unwrap()
    }

    #[tokio::test]
    async fn two_live_sessions_route_prompt_cancel_and_permission_by_key() {
        let directory = tempfile::tempdir().unwrap();
        let state = DesktopState::default();
        let alpha = keyed_connection(&state, directory.path(), &["--name=alpha"]).await;
        let beta = keyed_connection(&state, directory.path(), &["--name=beta"]).await;
        let a = open_on(&state, &alpha, None).await.unwrap();
        let b = open_on(&state, &beta, None).await.unwrap();
        // Same agent session id on two processes: only the key tells them apart.
        assert_eq!(a.session_id, b.session_id);
        assert_ne!(a, b);
        let listed: Vec<SessionKey> = live_sessions(&state).into_iter().map(|s| s.key).collect();
        assert_eq!(listed, vec![a.clone(), b.clone()]);

        // Both ask for a permission with the same request id.
        let turn_a = spawn_prompt(&state, &a, "edit please");
        let turn_b = spawn_prompt(&state, &b, "edit please");
        activity_becomes(&state, &a, SessionActivity::WaitingForApproval).await;
        activity_becomes(&state, &b, SessionActivity::WaitingForApproval).await;
        let request = |connection: &str| {
            state
                .sessions
                .pending_requests()
                .into_iter()
                .find(|r| r.connection_id == connection)
                .unwrap()
                .request_id
        };
        let (request_a, request_b) = (request(&alpha), request(&beta));
        assert_eq!(request_a, request_b);

        // A key that does not own the request cannot answer it.
        let stranger = SessionKey::new(alpha.clone(), "fixture-99");
        assert!(state
            .sessions
            .respond_permission(&stranger, request_b.clone(), Some("yes".into()))
            .is_err());
        assert_eq!(
            activity(&state, &b),
            Some(SessionActivity::WaitingForApproval)
        );

        // The answer by key reaches only that session.
        state
            .sessions
            .respond_permission(&a, request_a, Some("no".into()))
            .unwrap();
        finished(turn_a).await.unwrap();
        assert_eq!(activity(&state, &a), Some(SessionActivity::Idle));
        assert_eq!(
            activity(&state, &b),
            Some(SessionActivity::WaitingForApproval)
        );

        // Cancel by key stops only that session.
        let wait_a = spawn_prompt(&state, &a, "wait");
        activity_becomes(&state, &a, SessionActivity::Running).await;
        state.sessions.cancel(&a).unwrap();
        finished(wait_a).await.unwrap();
        assert_eq!(activity(&state, &a), Some(SessionActivity::Idle));
        assert_eq!(
            activity(&state, &b),
            Some(SessionActivity::WaitingForApproval)
        );
        state.sessions.cancel(&b).unwrap();
        finished(turn_b).await.unwrap();

        disconnect_and_wait(&state).await.unwrap();
        assert!(state.sessions.service(&alpha).is_none());
        assert!(state.sessions.service(&beta).is_none());
    }

    #[tokio::test]
    async fn an_unkeyed_command_resolves_to_the_focused_session() {
        let directory = tempfile::tempdir().unwrap();
        let state = DesktopState::default();
        let alpha = keyed_connection(&state, directory.path(), &["--name=alpha", "--close"]).await;
        let beta = keyed_connection(&state, directory.path(), &["--name=beta"]).await;
        let a = open_on(&state, &alpha, None).await.unwrap();
        let b = open_on(&state, &beta, None).await.unwrap();
        focus(&state, &a);
        // Opening another session without focus leaves the focus alone.
        let a2 = open_on(&state, &alpha, None).await.unwrap();
        assert_ne!(a2, a);
        assert_eq!(focused_key(&state).unwrap(), a);

        let turn = spawn_prompt(&state, &focused_key(&state).unwrap(), "wait");
        activity_becomes(&state, &a, SessionActivity::Running).await;
        assert_eq!(activity(&state, &b), Some(SessionActivity::Idle));
        assert_eq!(activity(&state, &a2), Some(SessionActivity::Idle));
        state
            .sessions
            .cancel(&focused_key(&state).unwrap())
            .unwrap();
        finished(turn).await.unwrap();
        assert_eq!(activity(&state, &a), Some(SessionActivity::Idle));

        // Closing the focused session by key leaves the sidebar without a chat.
        close_key(&state, &a).await.unwrap();
        assert!(focused_key(&state).is_err());
        assert!(state.sessions.session(&b).is_some());
        disconnect_and_wait(&state).await.unwrap();
    }

    #[tokio::test]
    async fn closing_a_lead_by_key_cascades_to_its_children() {
        let directory = tempfile::tempdir().unwrap();
        let state = DesktopState::default();
        let lead_connection = keyed_connection(&state, directory.path(), &["--close"]).await;
        let worker = keyed_connection(&state, directory.path(), &["--close"]).await;
        let lead = open_on(&state, &lead_connection, None).await.unwrap();
        let other = open_on(&state, &worker, None).await.unwrap();
        let child = state
            .sessions
            .open_session(&worker, Some(lead.clone()), SessionOrigin::Delegated)
            .await
            .unwrap();
        let listed = live_sessions(&state);
        let row = listed.iter().find(|s| s.key == child).unwrap();
        assert_eq!(row.parent.as_ref(), Some(&lead));
        assert_eq!(row.origin, SessionOrigin::Delegated);

        let busy = spawn_prompt(&state, &child, "wait");
        activity_becomes(&state, &child, SessionActivity::Running).await;
        close_key(&state, &lead).await.unwrap();
        let _ = finished(busy).await;
        assert!(state.sessions.session(&lead).is_none());
        assert!(state.sessions.session(&child).is_none());
        // A session that is not below the lead stays.
        assert!(state.sessions.session(&other).is_some());
        assert!(!state.agent.lock().unwrap().opened.contains(&lead));
        disconnect_and_wait(&state).await.unwrap();
    }

    #[tokio::test]
    async fn a_failed_open_leaves_existing_sessions_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let state = DesktopState::default();
        let alpha = keyed_connection(&state, directory.path(), &[]).await;
        let a = open_on(&state, &alpha, None).await.unwrap();
        focus(&state, &a);
        let before = live_sessions(&state);

        assert!(open_on(&state, "connection-404", None).await.is_err());
        let missing = connect_command(
            &state,
            AgentCommand {
                command: "span-no-such-agent-command".into(),
                args: Vec::new(),
                env: BTreeMap::new(),
            },
            directory.path().to_string_lossy().into_owned(),
            fixture_workspace(directory.path()),
        )
        .await;
        assert!(missing.is_err());
        let refusing = keyed_connection(&state, directory.path(), &["--missing-session"]).await;
        assert!(open_on(&state, &refusing, None).await.is_err());

        assert_eq!(live_sessions(&state), before);
        assert_eq!(focused_key(&state).unwrap(), a);
        let turn = spawn_prompt(&state, &a, "stop:end_turn");
        finished(turn).await.unwrap();
        disconnect_and_wait(&state).await.unwrap();
    }

    #[tokio::test]
    async fn an_event_for_one_session_never_updates_another() {
        let directory = tempfile::tempdir().unwrap();
        let state = DesktopState::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentKeyedEvent>();
        let _subscription = state.sessions.subscribe(Arc::new(move |event| {
            let _ = tx.send(AgentKeyedEvent::from(event));
        }));
        let alpha = keyed_connection(&state, directory.path(), &["--name=alpha", "--config"]).await;
        let beta = keyed_connection(&state, directory.path(), &["--name=beta", "--config"]).await;
        let a = open_on(&state, &alpha, None).await.unwrap();
        let a2 = open_on(&state, &alpha, None).await.unwrap();
        let b = open_on(&state, &beta, None).await.unwrap();

        // A config change of one session updates only that session's model.
        set_config_key(&state, &a, "model".into(), "deep".into())
            .await
            .unwrap();
        let model = |key: &SessionKey| state.sessions.live_session(key).unwrap().model;
        assert_eq!(model(&a).as_deref(), Some("deep"));
        assert_eq!(model(&a2).as_deref(), Some("fast"));
        assert_eq!(model(&b).as_deref(), Some("fast"));

        // Interleaved streams: every text chunk carries the key of the session
        // that wrote it.
        let turns = [
            spawn_prompt(&state, &a, "stream:5"),
            spawn_prompt(&state, &a2, "stream:5"),
            spawn_prompt(&state, &b, "stream:5"),
        ];
        for turn in turns {
            finished(turn).await.unwrap();
        }
        let mut chunks = 0;
        while let Ok(event) = rx.try_recv() {
            if let AgentEvent::Text { text, .. } = &event.event {
                let key = event.key.as_ref().expect("text is session level");
                let name = if key.connection_id == alpha {
                    "alpha"
                } else {
                    "beta"
                };
                assert_eq!(
                    *text,
                    format!("{name}:{}:{}", key.session_id, &text[text.len() - 1..])
                );
                chunks += 1;
            }
        }
        assert_eq!(chunks, 15);
        disconnect_and_wait(&state).await.unwrap();
    }
}
