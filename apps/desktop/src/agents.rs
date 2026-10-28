use crate::DesktopState;
use span_acp::tools::{DelegationEventSink, DelegationStatus, ToolPolicy, ToolServerConfig};
use span_acp::{
    AgentCommand, AgentEvent, AgentPreset, AgentService, AuthCredential, InstalledAgent,
    PromptAttachment, RegistryAgent, SessionKey, SessionOrigin,
};
use span_core::{BufferSnapshot, CoreWorkspace};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager, State};

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

fn switch_session(state: &DesktopState, session: &str) -> Result<(), String> {
    state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .as_mut()
        .ok_or_else(|| "Connect an agent first".to_owned())?
        .session = session.to_owned();
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
/// cloned repository cannot switch delegation on. Unreadable settings count
/// as off.
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
    // Listed for the lead only; starting another agent stays a user action.
    let installed = match app.path().app_cache_dir() {
        Ok(directory) => {
            let directory = directory.join("agents");
            tauri::async_runtime::spawn_blocking(move || {
                span_acp::list_installed_agents(&directory).unwrap_or_default()
            })
            .await
            .unwrap_or_default()
        }
        Err(_) => Vec::new(),
    };
    Ok(Some(ToolServerConfig {
        workspace,
        policy: ToolPolicy::default(),
        installed,
        events: Some(agent.delegation_events.clone()),
    }))
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
    disconnect(&state)?;
    let delegation_events: DelegationEventSink = {
        let channel = on_event.clone();
        Arc::new(move |event| {
            let _ = channel.send(AgentEvent::Delegation { event });
        })
    };
    let sessions = state.sessions.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(sessions.connect(
            command,
            cwd,
            workspace,
            Some(Arc::new(move |event| {
                let _ = on_event.send(event);
            })),
        ))
    })
    .await
    .map_err(|error| format!("Agent connection task failed: {error}"))??;
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
    switch_session(state.inner(), &session)?;
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
    // ACP does not keep MCP servers across session/load, so with delegation
    // on a fresh span-agents entry is offered in this load (ADR 0003).
    let config = delegation_config(&app, state.inner(), &agent).await?;
    state
        .leads
        .load_lead(&state.sessions, &agent.connection, &session_id, config)
        .await?;
    switch_session(state.inner(), &session_id)?;
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

#[tauri::command]
#[specta::specta]
pub async fn agent_prompt(
    state: State<'_, DesktopState>,
    text: String,
    attachments: Option<Vec<PromptAttachment>>,
) -> Result<(), String> {
    let agent = active_session(state.inner())?;
    agent
        .service
        .prompt(agent.session, text, attachments.unwrap_or_default())
        .await
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
    switch_session(state.inner(), &session)?;
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
    switch_session(state.inner(), &session)?;
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
    agent
        .service
        .respond_elicitation(request_id, action, content_json)
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
    disconnect(state)
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
    proposal_id: String,
    accept: bool,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    let agent = active(state.inner())?;
    tauri::async_runtime::spawn_blocking(move || {
        agent
            .service
            .review_proposal(proposal_id, accept, expected_revision)
    })
    .await
    .map_err(|error| format!("Review task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn agent_review_hunks(
    state: State<'_, DesktopState>,
    proposal_id: String,
    accepted_hunk_ids: Vec<String>,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    let agent = active(state.inner())?;
    tauri::async_runtime::spawn_blocking(move || {
        agent
            .service
            .review_proposal_hunks(proposal_id, accepted_hunk_ids, expected_revision)
    })
    .await
    .map_err(|error| format!("Review task failed: {error}"))?
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
