use crate::DesktopState;
use span_acp::{AgentCommand, AgentEvent, AgentService, InstalledAgent, RegistryAgent};
use span_core::BufferSnapshot;
use tauri::{ipc::Channel, Manager, State};

#[derive(Clone)]
pub struct ActiveAgent {
    service: AgentService,
    session: Option<String>,
}
struct ActiveAgentSession {
    service: AgentService,
    session: String,
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
    active.session = Some(session.to_owned());
    Ok(())
}

fn active(state: &DesktopState) -> Result<ActiveAgentSession, String> {
    let active = state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Connect an agent first".to_owned())?;
    if active.session.is_none() || active.service.auth_required()? {
        return Err("Choose an advertised authentication method before starting a session".into());
    }
    let session = active.session.ok_or_else(|| {
        "Choose an advertised authentication method before starting a session".to_owned()
    })?;
    Ok(ActiveAgentSession {
        service: active.service,
        session,
    })
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

pub async fn disconnect_and_wait(state: &DesktopState) -> Result<(), String> {
    let active = state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .take();
    if let Some(active) = active {
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
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    let gate = state.connection_gate.lock().await;
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a folder before connecting an agent".to_owned())?;
    disconnect_and_wait(&state).await?;
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
    *state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())? = Some(ActiveAgent {
        service: service.clone(),
        session: None,
    });
    drop(gate);
    match tokio::time::timeout(std::time::Duration::from_secs(45), service.new_session()).await {
        Ok(Ok(session)) => {
            switch_session(&state, &service, &session)?;
            Ok(Some(session))
        }
        Ok(Err(_)) if service.auth_required()? => Ok(None),
        result => {
            let _ = service.shutdown();
            if let Ok(mut active) = state.agent.lock() {
                if active
                    .as_ref()
                    .is_some_and(|agent| agent.service.same_connection(&service))
                {
                    active.take();
                }
            }
            Err(match result {
                Ok(Err(error)) => error,
                Err(_) => "Agent session creation timed out after 45 seconds".to_owned(),
                Ok(Ok(_)) => "Agent session creation failed".to_owned(),
            })
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn agent_authenticate(
    state: State<'_, DesktopState>,
    method_id: String,
) -> Result<String, String> {
    let state = state.inner();
    let agent = state
        .agent
        .lock()
        .map_err(|_| "Agent state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Connect an agent first".to_owned())?;
    if agent.session.is_some() && !agent.service.auth_required()? {
        return Err("This agent connection already has a session".into());
    }
    let session = agent.service.authenticate(method_id).await?;
    switch_session(state, &agent.service, &session)?;
    Ok(session)
}

/// Start a fresh conversation on the connected agent process.
#[tauri::command]
#[specta::specta]
pub async fn agent_new_session(state: State<'_, DesktopState>) -> Result<String, String> {
    let agent = active(state.inner())?;
    let session = agent.service.new_session().await?;
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
    state: State<'_, DesktopState>,
    session_id: String,
) -> Result<String, String> {
    let agent = active(state.inner())?;
    agent.service.load_session(session_id.clone()).await?;
    switch_session(state.inner(), &agent.service, &session_id)?;
    Ok(session_id)
}

#[tauri::command]
#[specta::specta]
pub async fn agent_prompt(state: State<'_, DesktopState>, text: String) -> Result<(), String> {
    let agent = active(state.inner())?;
    agent.service.prompt(agent.session, text).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_set_config(
    state: State<'_, DesktopState>,
    config_id: String,
    value: String,
) -> Result<(), String> {
    let agent = active(state.inner())?;
    agent
        .service
        .set_config(agent.session, config_id, value)
        .await
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
    disconnect_and_wait(state).await
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
            session: Some("current".into()),
        });
        assert!(switch_session(&state, &old, "old-result").is_err());
        assert_eq!(active(&state).unwrap().session, "current");
        switch_session(&state, &current, "valid-result").unwrap();
        assert_eq!(active(&state).unwrap().session, "valid-result");
        old.shutdown_and_wait().await.unwrap();
        current.shutdown_and_wait().await.unwrap();
    }
}
