//! Host adapter for saved run configuration tools offered over ACP MCP.
//! All execution routes through the desktop's shared RunService.
use crate::{
    run_approval::{self, ApprovalSink, RunApprovalAction},
    runs, DesktopState,
};
use serde_json::{json, Value};
use span_acp::{
    tools::{RunConfigurationEntry, RunToolBackend, RunToolCatalog, RunToolFuture},
    SessionKey,
};
use span_core::{CoreWorkspace, RunConfiguration};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::time::Instant;

// MCP run output is an optional UI observation. Keep the event fan-out finite
// even when a renderer is not listening, and keep execution independent of it.
const MAX_AGENT_OUTPUT_EVENT_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub(crate) struct DesktopRunTools {
    state: DesktopState,
    workspace: Arc<Mutex<CoreWorkspace>>,
    approvals: ApprovalSink,
    run_events: runs::RunSink,
}

impl DesktopRunTools {
    pub(crate) fn new(
        app: AppHandle,
        state: DesktopState,
        workspace: Arc<Mutex<CoreWorkspace>>,
    ) -> Self {
        let approval_app = app.clone();
        let approvals: ApprovalSink = Arc::new(move |event| event.emit(&approval_app).is_ok());
        let run_events: runs::RunSink = Arc::new(move |event| event.emit(&app).is_ok());
        Self::with_sinks(state, workspace, approvals, run_events)
    }

    fn with_sinks(
        state: DesktopState,
        workspace: Arc<Mutex<CoreWorkspace>>,
        approvals: ApprovalSink,
        run_events: runs::RunSink,
    ) -> Self {
        let run_events = Self::bounded_run_sink(state.runs.clone(), run_events);
        Self {
            state,
            workspace,
            approvals,
            run_events,
        }
    }

    fn bounded_run_sink(service: runs::RunService, observer: runs::RunSink) -> runs::RunSink {
        let output_bytes = Arc::new(Mutex::new(std::collections::HashMap::<String, usize>::new()));
        Arc::new(move |event| {
            let output = match &event {
                runs::RunEvent::Output {
                    id, sequence, text, ..
                } => {
                    let emit = output_bytes
                        .lock()
                        .ok()
                        .map(|mut sent| {
                            let current = sent.entry(id.clone()).or_default();
                            let emit =
                                current.saturating_add(text.len()) <= MAX_AGENT_OUTPUT_EVENT_BYTES;
                            if emit {
                                *current = current.saturating_add(text.len());
                            }
                            emit
                        })
                        .unwrap_or(false);
                    Some((id.clone(), *sequence, emit))
                }
                runs::RunEvent::State { run } => {
                    if matches!(
                        run.status,
                        runs::RunStatus::Exited
                            | runs::RunStatus::Stopped
                            | runs::RunStatus::Failed
                    ) {
                        if let Ok(mut sent) = output_bytes.lock() {
                            sent.remove(&run.id);
                        }
                    }
                    None
                }
            };

            // Agent processes write to bounded RunService history first. A
            // global event is only a best-effort live view, so renderer
            // absence, slow ACKs, or a closed event channel must not kill the
            // approved process. Bound serialized output sent to that view;
            // the final state lets the UI refresh the authoritative snapshot.
            if output.as_ref().is_none_or(|(_, _, emit)| *emit) {
                let _ = observer(event);
            }
            if let Some((id, sequence, _)) = output {
                service.acknowledge(&id, sequence).is_ok()
            } else {
                true
            }
        })
    }

    fn ensure_live(&self, lead: &SessionKey) -> Result<(), String> {
        if self.state.sessions.session(lead).is_none() {
            return Err("The agent session ended. Reconnect and request this tool again.".into());
        }
        if !self
            .state
            .sessions
            .connection(&lead.connection_id)
            .is_some_and(|connection| connection.open)
        {
            return Err(
                "The agent connection ended. Reconnect and request this tool again.".into(),
            );
        }
        let current = self
            .state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| {
                "Workspace was closed. Open a workspace and request the tool again.".to_owned()
            })?;
        if !Arc::ptr_eq(&current, &self.workspace) {
            return Err(
                "Workspace changed. Request the tool again in the active workspace.".into(),
            );
        }
        if !self
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .run_tools_enabled()
            .map_err(|error| error.to_string())?
        {
            return Err(
                "Agent run tools are disabled in user settings. Enable them and retry.".into(),
            );
        }
        Ok(())
    }

    fn approval_sink(&self) -> ApprovalSink {
        self.approvals.clone()
    }

    async fn wait_for_approval<T>(
        future: impl std::future::Future<Output = Result<T, String>>,
        progress: Option<span_acp::tools::RunToolProgress>,
    ) -> Result<T, String> {
        tokio::pin!(future);
        let Some(progress) = progress else {
            return future.await;
        };
        progress("Waiting for user approval in Span".into());
        let mut updates = tokio::time::interval_at(
            Instant::now() + Duration::from_secs(15),
            Duration::from_secs(15),
        );
        loop {
            tokio::select! {
                result = &mut future => return result,
                _ = updates.tick() => progress("Waiting for user approval in Span".into()),
            }
        }
    }

    fn run_sink(&self) -> runs::RunSink {
        self.run_events.clone()
    }

    async fn catalog(&self, lead: &SessionKey) -> Result<RunToolCatalog, String> {
        let _gate = self.state.connection_gate.lock().await;
        self.ensure_live(lead)?;
        let workspace = self
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        let revision = workspace
            .run_configuration_revision()
            .map_err(|error| error.to_string())?;
        let catalog = workspace
            .run_configurations()
            .map_err(|error| error.to_string())?;
        let mut configurations = catalog
            .configurations
            .into_iter()
            .map(|configuration| RunConfigurationEntry {
                configuration,
                revision: revision.clone(),
                detected: false,
            })
            .collect::<Vec<_>>();
        configurations.extend(
            catalog
                .detected
                .into_iter()
                .map(|task| RunConfigurationEntry {
                    configuration: task.configuration,
                    revision: revision.clone(),
                    detected: true,
                }),
        );
        Ok(RunToolCatalog {
            configurations,
            revision,
        })
    }

    async fn saved_configuration(
        &self,
        lead: &SessionKey,
        id: &str,
    ) -> Result<(RunConfiguration, String), String> {
        let catalog = self.catalog(lead).await?;
        let entry = catalog
            .configurations
            .into_iter()
            .find(|entry| entry.configuration.id == id)
            .ok_or_else(|| {
                "Saved run configuration was not found. Refresh the run configuration list."
                    .to_owned()
            })?;
        if entry.detected {
            return Err(
                "Detected tasks are read only. Save a copy before running or editing one.".into(),
            );
        }
        Ok((entry.configuration, catalog.revision))
    }

    fn check_revision(&self, expected: &str, actual: &str) -> Result<(), String> {
        if expected != actual {
            Err(
                "Run configurations changed. Refresh the list and retry with its current revision."
                    .into(),
            )
        } else {
            Ok(())
        }
    }

    fn info_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
        serde_json::to_value(value).map_err(|error| format!("Encode run result: {error}"))
    }

    fn current_entry(
        &self,
        configuration: RunConfiguration,
        revision: String,
    ) -> RunConfigurationEntry {
        RunConfigurationEntry {
            configuration,
            revision,
            detected: false,
        }
    }
}

impl RunToolBackend for DesktopRunTools {
    fn list_configurations<'a>(
        &'a self,
        lead: &'a SessionKey,
    ) -> RunToolFuture<'a, RunToolCatalog> {
        Box::pin(async move { self.catalog(lead).await })
    }

    fn read_configuration<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
    ) -> RunToolFuture<'a, Option<RunConfigurationEntry>> {
        Box::pin(async move {
            self.catalog(lead).await.map(|catalog| {
                catalog
                    .configurations
                    .into_iter()
                    .find(|entry| entry.configuration.id == id)
            })
        })
    }

    fn save_configuration<'a>(
        &'a self,
        lead: &'a SessionKey,
        configuration: RunConfiguration,
        expected_revision: String,
        progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, RunConfigurationEntry> {
        Box::pin(async move {
            let before = self.catalog(lead).await?;
            self.check_revision(&expected_revision, &before.revision)?;
            if !configuration.id.is_empty()
                && !before
                    .configurations
                    .iter()
                    .any(|entry| !entry.detected && entry.configuration.id == configuration.id)
            {
                return Err(
                    "Saved configuration was removed or is no longer editable. Refresh the list."
                        .into(),
                );
            }
            let approved = Self::wait_for_approval(
                run_approval::authorize(
                    &self.state,
                    &self.workspace,
                    RunApprovalAction::Save {
                        configuration: configuration.clone(),
                    },
                    lead.clone(),
                    self.approval_sink(),
                ),
                progress,
            )
            .await?;
            let _gate = self.state.connection_gate.lock().await;
            self.ensure_live(lead)?;
            let updated = approved.with_workspace(&self.state, |workspace| {
                workspace
                    .save_run_configuration(configuration)
                    .map_err(|error| error.to_string())
            })?;
            self.ensure_live(lead)?;
            let revision = self
                .workspace
                .lock()
                .map_err(|_| "Workspace state is unavailable".to_owned())?
                .run_configuration_revision()
                .map_err(|error| error.to_string())?;
            Ok(self.current_entry(updated, revision))
        })
    }

    fn delete_configuration<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
        expected_revision: String,
        progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move {
            let (configuration, revision) = self.saved_configuration(lead, id).await?;
            self.check_revision(&expected_revision, &revision)?;
            let approved = Self::wait_for_approval(
                run_approval::authorize(
                    &self.state,
                    &self.workspace,
                    RunApprovalAction::Delete { id: id.to_owned() },
                    lead.clone(),
                    self.approval_sink(),
                ),
                progress,
            )
            .await?;
            let _gate = self.state.connection_gate.lock().await;
            self.ensure_live(lead)?;
            approved.with_workspace(&self.state, |workspace| {
                workspace
                    .delete_run_configuration(&configuration.id)
                    .map_err(|error| error.to_string())
            })?;
            self.ensure_live(lead)?;
            Ok(json!({"deleted": true, "id": id}))
        })
    }

    fn start_run<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
        expected_revision: String,
        progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move {
            let (configuration, revision) = self.saved_configuration(lead, id).await?;
            self.check_revision(&expected_revision, &revision)?;
            let mut approved = Self::wait_for_approval(
                run_approval::authorize(
                    &self.state,
                    &self.workspace,
                    RunApprovalAction::Run {
                        configuration: configuration.clone(),
                    },
                    lead.clone(),
                    self.approval_sink(),
                ),
                progress,
            )
            .await?;
            let _gate = self.state.connection_gate.lock().await;
            self.ensure_live(lead)?;
            approved.with_workspace(&self.state, |_| Ok(()))?;
            let prepared = approved.take_prepared()?;
            let info = self.state.runs.start(prepared, self.run_sink()).await?;
            self.ensure_live(lead)?;
            Self::info_value(info)
        })
    }

    fn stop_run<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
        progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move {
            self.ensure_live(lead)?;
            let approved = Self::wait_for_approval(
                run_approval::authorize(
                    &self.state,
                    &self.workspace,
                    RunApprovalAction::Stop { id: id.to_owned() },
                    lead.clone(),
                    self.approval_sink(),
                ),
                progress,
            )
            .await?;
            let _gate = self.state.connection_gate.lock().await;
            self.ensure_live(lead)?;
            approved.with_workspace(&self.state, |_| Ok(()))?;
            let info = self.state.runs.stop(id).await?;
            self.ensure_live(lead)?;
            Self::info_value(info)
        })
    }

    fn restart_run<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
        progress: Option<span_acp::tools::RunToolProgress>,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move {
            self.ensure_live(lead)?;
            let mut approved = Self::wait_for_approval(
                run_approval::authorize(
                    &self.state,
                    &self.workspace,
                    RunApprovalAction::Restart { id: id.to_owned() },
                    lead.clone(),
                    self.approval_sink(),
                ),
                progress,
            )
            .await?;
            let _gate = self.state.connection_gate.lock().await;
            self.ensure_live(lead)?;
            approved.with_workspace(&self.state, |_| Ok(()))?;
            let prepared = approved.take_prepared()?;
            let info = self
                .state
                .runs
                .restart_prepared(id, prepared, self.run_sink())
                .await?;
            self.ensure_live(lead)?;
            Self::info_value(info)
        })
    }

    fn list_runs<'a>(&'a self, lead: &'a SessionKey) -> RunToolFuture<'a, Value> {
        Box::pin(async move {
            let _gate = self.state.connection_gate.lock().await;
            self.ensure_live(lead)?;
            Self::info_value(self.state.runs.list()?)
        })
    }

    fn read_run_output<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
    ) -> RunToolFuture<'a, Value> {
        Box::pin(async move {
            let _gate = self.state.connection_gate.lock().await;
            self.ensure_live(lead)?;
            Self::info_value(self.state.runs.output(id)?)
        })
    }
}

pub(crate) async fn enabled(workspace: Arc<Mutex<CoreWorkspace>>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        workspace
            .lock()
            .ok()
            .and_then(|workspace| workspace.run_tools_enabled().ok())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

pub(crate) fn backend(
    app: AppHandle,
    state: DesktopState,
    workspace: Arc<Mutex<CoreWorkspace>>,
) -> Arc<dyn RunToolBackend> {
    Arc::new(DesktopRunTools::new(app, state, workspace))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn run_tools_enabled(
    state: tauri::State<'_, DesktopState>,
) -> Result<bool, String> {
    crate::with_settings(
        state.inner().clone(),
        span_core::SettingsScope::User,
        |context| context.run_tools_enabled(),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn run_tools_set_enabled(
    state: tauri::State<'_, DesktopState>,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    let _gate = state.connection_gate.lock().await;
    crate::with_settings(
        state.clone(),
        span_core::SettingsScope::User,
        move |context| context.set_run_tools_enabled(enabled).map(|_| ()),
    )
    .await?;
    if !enabled {
        state.run_approvals.cancel_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_approval::RunApprovalsChanged;
    use crate::runs::RunEvent;
    use serde_json::json;
    use span_acp::{AgentCommand, SessionOrigin};
    use std::{collections::BTreeMap, fs, path::PathBuf};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
    };

    #[test]
    fn optional_agent_output_fanout_is_bounded() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let observer: runs::RunSink = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
            true
        });
        let sink = DesktopRunTools::bounded_run_sink(runs::RunService::default(), observer);

        for sequence in 1..=40 {
            let _ = sink(RunEvent::Output {
                id: "flood-run".into(),
                sequence,
                workspace_epoch: 1,
                stream: runs::RunStream::Stdout,
                text: "x".repeat(8 * 1024),
            });
        }

        let events = events.lock().unwrap();
        let forwarded_bytes = events
            .iter()
            .map(|event| match event {
                RunEvent::Output { text, .. } => text.len(),
                RunEvent::State { .. } => 0,
            })
            .sum::<usize>();
        assert_eq!(forwarded_bytes, MAX_AGENT_OUTPUT_EVENT_BYTES);
        assert_eq!(events.len(), 32);
    }

    async fn exercise_mcp_run_call(disable_before_approval: bool) {
        let temp = tempfile::tempdir().unwrap();
        let user_settings_path = temp.path().join("user-settings.json");
        let workspace = Arc::new(Mutex::new(
            CoreWorkspace::open(temp.path())
                .unwrap()
                .with_user_settings(Some(user_settings_path)),
        ));
        workspace
            .lock()
            .unwrap()
            .set_run_tools_enabled(true)
            .unwrap();
        let config = RunConfiguration {
            id: String::new(),
            name: "Write integration marker".into(),
            executable: "node".into(),
            args: vec![
                "-e".into(),
                "require('node:fs').writeFileSync('run-tool-marker.txt', 'approved-through-mcp'); process.stdout.write('stdout-through-mcp\\n'); process.stderr.write('stderr-through-mcp\\n')".into(),
            ],
            cwd: ".".into(),
            env: Default::default(),
        };
        let (saved, revision) = {
            let mut workspace = workspace.lock().unwrap();
            let saved = workspace.save_run_configuration(config).unwrap();
            let revision = workspace.run_configuration_revision().unwrap();
            (saved, revision)
        };

        let state = DesktopState::default();
        *state.workspace.lock().unwrap() = Some(workspace.clone());
        let approval_state = state.clone();
        let approval_workspace = workspace.clone();
        let approval_requests = Arc::new(Mutex::new(Vec::new()));
        let captured = approval_requests.clone();
        let approvals: ApprovalSink = Arc::new(move |event: RunApprovalsChanged| {
            let mut ids = Vec::new();
            if let Ok(mut requests) = captured.lock() {
                for request in &event.pending {
                    ids.push(request.id.clone());
                    requests.push(request.clone());
                }
            }
            for id in ids {
                if disable_before_approval {
                    let _ = approval_workspace
                        .lock()
                        .map(|workspace| workspace.set_run_tools_enabled(false));
                }
                let _ = approval_state.run_approvals.resolve(&id, true);
            }
            true
        });
        // Model a global event emitter with no frontend listener. Its success
        // means dispatch was accepted, not that a WebView will ACK the output.
        let run_events: runs::RunSink = Arc::new(|_| true);
        let backend: Arc<dyn RunToolBackend> = Arc::new(DesktopRunTools::with_sinks(
            state.clone(),
            workspace.clone(),
            approvals,
            run_events,
        ));

        // Keep this as a regular drive path on Windows. `canonicalize()` may
        // add the `\\?\` prefix, which Node does not accept as a script path.
        let desktop_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repository_root = desktop_manifest
            .parent()
            .and_then(std::path::Path::parent)
            .expect("desktop manifest is two levels below the repository root");
        let fixture = repository_root.join("crates/acp/tests/fixtures/worker.mjs");
        assert!(
            fixture.is_file(),
            "ACP worker fixture is missing: {fixture:?}"
        );
        let connection = state
            .sessions
            .connect(
                AgentCommand {
                    command: "node".into(),
                    args: vec![fixture.to_string_lossy().into_owned(), "--mcp-http".into()],
                    env: BTreeMap::new(),
                },
                temp.path().to_string_lossy().into_owned(),
                workspace.clone(),
                None,
            )
            .await
            .unwrap();

        let server = span_acp::tools::ToolServer::start(
            &state.sessions,
            &connection,
            span_acp::tools::ToolServerConfig {
                workspace: workspace.clone(),
                editor_tools: None,
                policy: span_acp::tools::ToolPolicy::default(),
                delegation_enabled: false,
                run_tools: Some(backend),
                installed: Vec::new(),
                background: None,
                events: None,
            },
        )
        .await
        .unwrap();
        let lead = state
            .sessions
            .open_session_with(
                &connection,
                None,
                SessionOrigin::User,
                vec![server.mcp_server_json()],
            )
            .await
            .unwrap();
        server.bind(&state.sessions, lead).unwrap();

        let address = server
            .url()
            .strip_prefix("http://127.0.0.1:")
            .unwrap()
            .strip_suffix("/mcp")
            .unwrap();
        let port = address.parse::<u16>().unwrap();
        let entry = server.mcp_server_json();
        let bearer = entry["headers"][0]["value"].as_str().unwrap();
        let list_body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 76, "method": "tools/list", "params": {}
        }))
        .unwrap();
        let mut list_stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let list_request = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {bearer}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            list_body.len()
        );
        list_stream
            .write_all(list_request.as_bytes())
            .await
            .unwrap();
        list_stream.write_all(&list_body).await.unwrap();
        let mut list_response = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(10),
            list_stream.read_to_end(&mut list_response),
        )
        .await
        .unwrap()
        .unwrap();
        let list_response = String::from_utf8(list_response).unwrap();
        let list_response_body = list_response.split_once("\r\n\r\n").unwrap().1;
        let listing: Value = serde_json::from_str(list_response_body).unwrap();
        let tool_names = listing["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect::<Vec<_>>();
        assert!(tool_names.contains(&"run_start"));
        assert!(!tool_names.contains(&"delegate"));

        let body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 77, "method": "tools/call",
            "params": {"name": "run_start", "arguments": {"id": saved.id, "expectedRevision": revision}}
        })).unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {bearer}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(response).unwrap();
        let response_body = response.split_once("\r\n\r\n").unwrap().1;
        let reply: Value = serde_json::from_str(response_body).unwrap();
        if disable_before_approval {
            assert_eq!(reply["error"]["code"], -32000);
            assert!(reply["error"]["message"]
                .as_str()
                .unwrap()
                .contains("disabled"));
        } else {
            assert_eq!(reply["result"]["isError"], false);
            assert_eq!(
                reply["result"]["structuredContent"]["configurationId"],
                saved.id
            );
        }

        if disable_before_approval {
            assert!(!temp.path().join("run-tool-marker.txt").exists());
        } else {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if temp.path().join("run-tool-marker.txt").exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the approved process writes its marker");
            assert_eq!(
                fs::read_to_string(temp.path().join("run-tool-marker.txt")).unwrap(),
                "approved-through-mcp"
            );
            let run_id = reply["result"]["structuredContent"]["id"]
                .as_str()
                .expect("run_start returns the shared run ID")
                .to_owned();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if state
                        .runs
                        .list()
                        .unwrap()
                        .iter()
                        .any(|run| run.id == run_id && run.status == runs::RunStatus::Exited)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the process exits without a renderer ACK");
            let output = state.runs.output(&run_id).unwrap();
            assert!(output.text.contains("stdout-through-mcp"));
            assert!(output.text.contains("stderr-through-mcp"));
        }
        let approvals = approval_requests.lock().unwrap();
        assert!(approvals
            .iter()
            .any(|request| request.action == "run" && request.execution_resolved));

        server.shutdown();
        state.sessions.disconnect(&connection).unwrap();
    }

    #[tokio::test]
    async fn mcp_run_call_uses_approval_and_shared_run_service() {
        exercise_mcp_run_call(false).await;
    }

    #[tokio::test]
    async fn disabling_run_tools_during_approval_blocks_execution() {
        exercise_mcp_run_call(true).await;
    }
}
