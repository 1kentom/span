use crate::DesktopState;
use span_acp::{AgentCommand, AgentEvent, AgentService, InstalledAgent, RegistryAgent};
use span_core::BufferSnapshot;
use tauri::{ipc::Channel, Manager, State};

#[derive(Clone)]
pub struct ActiveAgent {
    service: AgentService,
    session: String,
}

fn active(state: &DesktopState) -> Result<ActiveAgent, String> {
    state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Connect an agent first".to_owned())
}

pub fn disconnect(state: &DesktopState) -> Result<(), String> {
    if let Some(active) = state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .take()
    {
        active.service.shutdown()?;
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
    let service = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(AgentService::start(
            command,
            cwd,
            workspace,
            std::sync::Arc::new(move |event| {
                let _ = on_event.send(event);
            }),
        ))
    })
    .await
    .map_err(|error| format!("Agent connection task failed: {error}"))??;
    let session =
        match tokio::time::timeout(std::time::Duration::from_secs(45), service.new_session()).await
        {
            Ok(Ok(session)) => session,
            result => {
                let _ = service.shutdown();
                return Err(match result {
                    Ok(Err(error)) => error,
                    Err(_) => "Agent session creation timed out after 45 seconds".to_owned(),
                    Ok(Ok(_)) => "Agent session creation failed".to_owned(),
                });
            }
        };
    *state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())? = Some(ActiveAgent {
        service,
        session: session.clone(),
    });
    Ok(session)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_prompt(state: State<'_, DesktopState>, text: String) -> Result<(), String> {
    let agent = active(state.inner())?;
    agent.service.prompt(agent.session, text).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_cancel(state: State<'_, DesktopState>) -> Result<(), String> {
    let agent = active(state.inner())?;
    agent.service.cancel(agent.session)
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
    let agent = active(state.inner())?;
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
