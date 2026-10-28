use crate::DesktopState;
use span_acp::{
    AgentCommand, AgentEvent, AgentService, InstalledAgent, PromptAttachment, RegistryAgent,
    SessionKey, SessionOrigin,
};
use span_core::BufferSnapshot;
use tauri::{ipc::Channel, Manager, State};

#[derive(Clone)]
pub struct ActiveAgent {
    service: AgentService,
    connection: String,
    session: String,
}

impl ActiveAgent {
    fn key(&self, session: &str) -> SessionKey {
        SessionKey::new(self.connection.clone(), session)
    }
}

/// Track a session created on the primary connection so that cascades
/// (cancel, close, disconnect) reach any children delegated from it.
fn adopt(state: &DesktopState, agent: &ActiveAgent, session: &str) -> Result<(), String> {
    state
        .sessions
        .adopt(agent.key(session), SessionOrigin::User)
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
    state: State<'_, DesktopState>,
    command: AgentCommand,
    cwd: String,
    on_event: Channel<AgentEvent>,
) -> Result<String, String> {
    let state = state.inner().clone();
    let _gate = state.connection_gate.lock().await;
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a folder before connecting an agent".to_owned())?;
    disconnect(&state)?;
    let sessions = state.sessions.clone();
    let connection = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(sessions.connect(
            command,
            cwd,
            workspace,
            Some(std::sync::Arc::new(move |event| {
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
    let session =
        match tokio::time::timeout(std::time::Duration::from_secs(45), service.new_session()).await
        {
            Ok(Ok(session)) => session,
            Ok(Err(_)) if service.auth_required() => {
                // Keep the process alive. The UI gets an AuthRequired event and
                // calls agent_authenticate, which creates the session.
                *state
                    .agent
                    .lock()
                    .map_err(|_| "Agent state is unavailable".to_owned())? = Some(ActiveAgent {
                    service,
                    connection,
                    session: String::new(),
                });
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
    let agent = ActiveAgent {
        service,
        connection,
        session: session.clone(),
    };
    adopt(&state, &agent, &session)?;
    *state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())? = Some(agent);
    Ok(session)
}

/// Start a fresh conversation on the connected agent process.
#[tauri::command]
#[specta::specta]
pub async fn agent_new_session(state: State<'_, DesktopState>) -> Result<String, String> {
    let agent = active(state.inner())?;
    let session = agent.service.new_session().await?;
    adopt(state.inner(), &agent, &session)?;
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
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<String, String> {
    let agent = active(state.inner())?;
    agent.service.load_session(session_id.clone()).await?;
    adopt(state.inner(), &agent, &session_id)?;
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
    state: State<'_, DesktopState>,
    method_id: String,
) -> Result<String, String> {
    let agent = active(state.inner())?;
    agent.service.authenticate(method_id).await?;
    if !agent.session.is_empty() {
        return Ok(agent.session);
    }
    let session = agent.service.new_session().await?;
    adopt(state.inner(), &agent, &session)?;
    switch_session(state.inner(), &session)?;
    Ok(session)
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
