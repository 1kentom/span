use crate::DesktopState;
use serde::Serialize;
use span_acp::tools::{DelegationEventSink, DelegationStatus, ToolPolicy, ToolServerConfig};
use span_acp::{
    AgentCommand, AgentEvent, AgentPreset, AgentService, AuthCredential, BackgroundAgents,
    EventSink, InstalledAgent, PromptAttachment, PromptError, RegistryAgent, SessionActivity,
    SessionKey, SessionOrigin, SessionStates, PROMPT_ALREADY_RUNNING,
};
use span_core::{BufferSnapshot, CoreWorkspace};
use specta::Type;
use std::sync::{Arc, Mutex};
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

#[derive(Clone)]
pub struct ActiveAgent {
    service: AgentService,
    connection: String,
    session: String,
    /// Forwards span-agents events to the UI channel as `AgentEvent::Delegation`.
    delegation_events: DelegationEventSink,
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
    let mut guard = state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?;
    let active = guard
        .as_mut()
        .ok_or_else(|| "Connect an agent first".to_owned())?;
    if !active.service.same_connection(expected) {
        return Err("The agent connection changed while switching conversations".into());
    }
    active.session = session.to_owned();
    Ok(())
}

fn clear_if_active(state: &DesktopState, session: &str) -> Result<(), String> {
    let mut guard = state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?;
    if let Some(agent) = guard.as_mut().filter(|agent| agent.session == session) {
        agent.session.clear();
    }
    Ok(())
}

fn active(state: &DesktopState) -> Result<ActiveAgent, String> {
    state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Connect an agent first".to_owned())
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

/// The span-agents config for a new or restored lead session, or `None`
/// when delegation is off.
async fn delegation_config(
    app: &tauri::AppHandle,
    state: &DesktopState,
    agent: &ActiveAgent,
) -> Result<Option<ToolServerConfig>, String> {
    let workspace = workspace(state)?;
    if !delegation_enabled(workspace.clone()).await {
        return Ok(None);
    }
    // The user turned delegation on, so an installed agent the lead
    // delegates to is started in the background; the UI shows the start on
    // the delegation card (ADR 0003 section 8).
    let installed = installed_agents(app).await;
    Ok(Some(ToolServerConfig {
        workspace,
        policy: ToolPolicy::default(),
        installed,
        background: Some(background(state)),
        events: Some(agent.delegation_events.clone()),
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

/// Open a user session on the active connection. With delegation on, the
/// span-agents entry is offered in this `session/new` only.
async fn open_lead(
    app: &tauri::AppHandle,
    state: &DesktopState,
    agent: &ActiveAgent,
) -> Result<String, String> {
    let config = delegation_config(app, state, agent).await?;
    let (key, _) = state
        .leads
        .open_lead(&state.sessions, &agent.connection, config)
        .await?;
    Ok(key.session_id)
}

pub fn disconnect(state: &DesktopState) -> Result<(), String> {
    if let Some(active) = state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .take()
    {
        state.sessions.disconnect(&active.connection)?;
    }
    Ok(())
}

pub async fn disconnect_and_wait(state: &DesktopState) -> Result<(), String> {
    let active = state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .take();
    if let Some(active) = active {
        // End the connection's sessions and delegated children in the
        // session manager, then wait for the process and its callbacks.
        let _ = state.sessions.disconnect(&active.connection);
        active.service.shutdown_and_wait().await?;
    }
    Ok(())
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
    disconnect_and_wait(&state).await?;
    let delegation_events: DelegationEventSink = {
        let channel = on_event.clone();
        Arc::new(move |event| {
            let _ = channel.send(AgentEvent::Delegation { event });
        })
    };
    let ui: EventSink = {
        let channel = on_event.clone();
        Arc::new(move |event| {
            let _ = channel.send(event);
        })
    };
    let background = background(&state);
    // Requests of delegated children on background agents reach this chat.
    background.set_child_sink(Some(ui.clone()));
    let installed = installed_agents(&app)
        .await
        .into_iter()
        .find(|agent| same_command(&agent.launch, &command));
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
                tauri::async_runtime::block_on(sessions.connect(
                    command,
                    cwd,
                    workspace,
                    Some(ui),
                ))
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
    };
    let session = match tokio::time::timeout(
        std::time::Duration::from_secs(45),
        open_lead(&app, &state, &agent),
    )
    .await
    {
        Ok(Ok(session)) => session,
        Ok(Err(_)) if service.auth_required() => {
            // Keep the process alive. The UI gets an AuthRequired event and
            // calls agent_authenticate, which creates the session.
            *state
                .agent
                .lock()
                .map_err(|_| "Agent state is unavailable".to_owned())? = Some(agent);
            return Ok(String::new());
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
    agent.session = session.clone();
    *state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())? = Some(agent);
    Ok(session)
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
        let config = delegation_config(&app, state.inner(), &agent).await?;
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
    state.sessions.close(&agent.key(&session_id)).await?;
    clear_if_active(state.inner(), &session_id)
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
    state.sessions.delete(&agent.key(&session_id)).await?;
    clear_if_active(state.inner(), &session_id)
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
    let agent = active_session(state.inner()).map_err(|message| PromptError::Failed { message })?;
    let key = agent.key(&agent.session);
    let done = state
        .sessions
        .start_turn(&key, text, attachments.unwrap_or_default())?;
    match done.await {
        Ok(Ok(())) => Ok(()),
        // The agent itself still had a turn in flight (it started between
        // the manager's check and the prompt reaching it).
        Ok(Err(message)) if message == PROMPT_ALREADY_RUNNING => Err(PromptError::Busy {
            message,
            state: state.sessions.session_state(&key),
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
    match agent
        .service
        .respond_elicitation(request_id.clone(), action.clone(), content_json.clone())
    {
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
    let agent = active_session(state.inner())?;
    agent
        .service
        .set_config(agent.session, config_id, value)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_cancel(state: State<'_, DesktopState>) -> Result<(), String> {
    let agent = active_session(state.inner())?;
    state.sessions.cancel(&agent.key(&agent.session))
}

#[tauri::command]
#[specta::specta]
pub async fn agent_disconnect(state: State<'_, DesktopState>) -> Result<(), String> {
    let state = state.inner();
    let _gate = state.connection_gate.lock().await;
    disconnect_and_wait(state).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_permission(
    state: State<'_, DesktopState>,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let agent = active_session(state.inner())?;
    agent
        .service
        .respond_permission(agent.session, request_id, option_id)
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

/// Check-only: reads the public GitHub release list for this build's channel.
/// Opening the release page is a separate, user-initiated `open_external`.
#[tauri::command]
#[specta::specta]
pub async fn app_update_check(app: tauri::AppHandle) -> span_acp::update::AppUpdate {
    let version = app.package_info().version.to_string();
    span_acp::update::check_app_update(&version, cfg!(debug_assertions)).await
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
        *state.agent.lock().unwrap() = Some(ActiveAgent {
            service: current.clone(),
            connection: String::new(),
            session: "current".into(),
            delegation_events: Arc::new(|_| {}),
        });
        assert!(switch_session(&state, &old, "old-result").is_err());
        assert_eq!(active(&state).unwrap().session, "current");
        switch_session(&state, &current, "valid-result").unwrap();
        assert_eq!(active(&state).unwrap().session, "valid-result");
        old.shutdown_and_wait().await.unwrap();
        current.shutdown_and_wait().await.unwrap();
    }
}
