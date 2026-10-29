//! Interactive user terminals. Output is acknowledged after xterm consumes it.
use crate::DesktopState;
use serde::{Deserialize, Serialize};
use span_terminal::{
    terminal_profiles as discover_terminal_profiles, TerminalCommandLanguage,
    TerminalEvent as PtyEvent, TerminalInfo, TerminalManager, TerminalProfile,
};
use specta::Type;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::State;
use tokio::sync::{mpsc, oneshot, watch};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output {
        id: String,
        data: Vec<u8>,
        sequence: u64,
    },
    Exit {
        id: String,
        code: Option<u32>,
    },
    Error {
        id: String,
        message: String,
    },
}

type EventSink = Arc<dyn Fn(TerminalEvent) -> Result<(), String> + Send + Sync>;

struct OutputFlow {
    pending: Mutex<Option<(u64, oneshot::Sender<()>)>>,
    cancelled: watch::Sender<bool>,
}

impl OutputFlow {
    fn new() -> Self {
        let (cancelled, _) = watch::channel(false);
        Self {
            pending: Mutex::new(None),
            cancelled,
        }
    }

    fn cancel(&self) {
        self.cancelled.send_replace(true);
        // Cleanup must still release a waiting forwarder after a poisoned lock.
        match self.pending.lock() {
            Ok(mut pending) => {
                pending.take();
            }
            Err(poisoned) => {
                poisoned.into_inner().take();
            }
        }
    }

    fn acknowledge(&self, sequence: u64) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Terminal output state is unavailable".to_owned())?;
        if pending.as_ref().map(|(expected, _)| *expected) != Some(sequence) {
            return Err("Terminal output acknowledgement is stale".to_owned());
        }
        let (_, sender) = pending
            .take()
            .ok_or_else(|| "Terminal output acknowledgement is unavailable".to_owned())?;
        sender
            .send(())
            .map_err(|_| "Terminal output stream has closed".to_owned())
    }
}

struct WorkspaceTerminals {
    epoch: u64,
    manager: Arc<TerminalManager>,
    flows: Mutex<HashMap<String, Arc<OutputFlow>>>,
}

impl WorkspaceTerminals {
    fn external_id(&self, internal_id: &str) -> String {
        format!("{}:{internal_id}", self.epoch)
    }

    fn internal_id<'a>(&self, id: &'a str) -> Result<&'a str, String> {
        let (epoch, internal_id) = id
            .split_once(':')
            .ok_or_else(|| "Terminal session is unavailable".to_owned())?;
        if epoch.parse::<u64>().ok() != Some(self.epoch) || internal_id.is_empty() {
            return Err("Terminal belongs to a previous workspace".to_owned());
        }
        Ok(internal_id)
    }

    fn flow(&self, id: &str) -> Result<Arc<OutputFlow>, String> {
        self.internal_id(id)?;
        self.flows
            .lock()
            .map_err(|_| "Terminal output state is unavailable".to_owned())?
            .get(id)
            .cloned()
            .ok_or_else(|| "Terminal session is unavailable".to_owned())
    }

    fn cancel_flows(&self) {
        let flows = match self.flows.lock() {
            Ok(flows) => flows,
            Err(poisoned) => poisoned.into_inner(),
        };
        for flow in flows.values() {
            flow.cancel();
        }
    }
}

/// One terminal manager per workspace. The gate serializes spawn and replacement.
#[derive(Clone, Default)]
pub struct TerminalState {
    current: Arc<Mutex<Option<Arc<WorkspaceTerminals>>>>,
    next_epoch: Arc<AtomicU64>,
    gate: Arc<tokio::sync::Mutex<()>>,
}

impl TerminalState {
    fn current(&self) -> Result<Arc<WorkspaceTerminals>, String> {
        self.current
            .lock()
            .map_err(|_| "Terminal workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Open a folder to start a terminal".to_owned())
    }

    pub async fn replace_workspace(&self, root: &Path) -> Result<(), String> {
        let _gate = self.gate.lock().await;
        let replacement = Arc::new(WorkspaceTerminals {
            epoch: self.next_epoch.fetch_add(1, Ordering::Relaxed) + 1,
            manager: Arc::new(TerminalManager::new(root).map_err(|error| error.to_string())?),
            flows: Mutex::new(HashMap::new()),
        });
        self.close_current().await?;
        *self
            .current
            .lock()
            .map_err(|_| "Terminal workspace state is unavailable".to_owned())? = Some(replacement);
        Ok(())
    }

    async fn close_current(&self) -> Result<(), String> {
        let current = self
            .current
            .lock()
            .map_err(|_| "Terminal workspace state is unavailable".to_owned())?
            .take();
        if let Some(current) = current {
            current.cancel_flows();
            current
                .manager
                .close_all()
                .await
                .map_err(|error| format!("Close workspace terminals: {error}"))?;
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        let _gate = self.gate.lock().await;
        self.close_current().await
    }

    async fn create(
        &self,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<TerminalInfo, String> {
        self.create_profile(cwd, cols, rows, sink, None).await
    }

    async fn create_profile(
        &self,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        sink: EventSink,
        profile_id: Option<String>,
    ) -> Result<TerminalInfo, String> {
        let _gate = self.gate.lock().await;
        let current = self.current()?;
        let cwd = cwd.as_deref().unwrap_or(".");
        if cwd.contains("://") {
            return Err("Terminal directory must be a workspace folder".to_owned());
        }
        let (info, receiver) = current
            .manager
            .create_with_profile(cwd, cols, rows, profile_id.as_deref())
            .await
            .map_err(|error| error.to_string())?;
        Self::attach(current, info, receiver, sink).await
    }

    async fn create_command(
        &self,
        language: TerminalCommandLanguage,
        code: String,
        expected_workspace_root: String,
        cols: u16,
        rows: u16,
        sink: EventSink,
    ) -> Result<TerminalInfo, String> {
        let _gate = self.gate.lock().await;
        let current = self.current()?;
        let (info, receiver) = current
            .manager
            .create_command(
                language,
                code,
                Path::new(&expected_workspace_root),
                cols,
                rows,
            )
            .await
            .map_err(|error| error.to_string())?;
        Self::attach(current, info, receiver, sink).await
    }

    async fn attach(
        current: Arc<WorkspaceTerminals>,
        mut info: TerminalInfo,
        receiver: mpsc::Receiver<PtyEvent>,
        sink: EventSink,
    ) -> Result<TerminalInfo, String> {
        let internal_id = info.id.clone();
        info.id = current.external_id(&internal_id);
        let flow = Arc::new(OutputFlow::new());
        let inserted = match current.flows.lock() {
            Ok(mut flows) => {
                flows.insert(info.id.clone(), flow.clone());
                true
            }
            Err(_) => false,
        };
        if !inserted {
            let _ = current.manager.close(&internal_id).await;
            return Err("Terminal output state is unavailable".to_owned());
        }
        // The channel is supplied on create, before any PTY output can be forwarded.
        tokio::spawn(forward_output(
            current.clone(),
            internal_id,
            info.id.clone(),
            receiver,
            flow,
            sink,
        ));
        Ok(info)
    }

    fn list(&self) -> Result<Vec<TerminalInfo>, String> {
        let current = self.current()?;
        Ok(current
            .manager
            .list()
            .into_iter()
            .map(|mut info| {
                info.id = current.external_id(&info.id);
                info
            })
            .collect())
    }

    async fn write(&self, id: &str, data: Vec<u8>) -> Result<(), String> {
        let current = self.current()?;
        let internal_id = current.internal_id(id)?;
        current
            .manager
            .write(internal_id, data)
            .await
            .map_err(|error| error.to_string())
    }

    async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let current = self.current()?;
        let internal_id = current.internal_id(id)?;
        current
            .manager
            .resize(internal_id, cols, rows)
            .await
            .map_err(|error| error.to_string())
    }

    async fn interrupt(&self, id: &str) -> Result<(), String> {
        let current = self.current()?;
        let internal_id = current.internal_id(id)?;
        current
            .manager
            .interrupt(internal_id)
            .await
            .map_err(|error| error.to_string())
    }

    async fn close(&self, id: &str) -> Result<(), String> {
        let current = self.current()?;
        let internal_id = current.internal_id(id)?;
        let flow = current
            .flows
            .lock()
            .map_err(|_| "Terminal output state is unavailable".to_owned())?
            .get(id)
            .cloned();
        current
            .manager
            .close_with_notify(internal_id, move || {
                if let Some(flow) = flow {
                    flow.cancel();
                }
            })
            .await
            .map_err(|error| error.to_string())?;
        current
            .flows
            .lock()
            .map_err(|_| "Terminal output state is unavailable".to_owned())?
            .remove(id);
        Ok(())
    }

    fn scrollback(&self, id: &str) -> Result<Vec<u8>, String> {
        let current = self.current()?;
        current
            .manager
            .scrollback(current.internal_id(id)?)
            .map_err(|error| error.to_string())
    }

    fn acknowledge(&self, id: &str, sequence: u64) -> Result<(), String> {
        self.current()?.flow(id)?.acknowledge(sequence)
    }
}

async fn forward_output(
    current: Arc<WorkspaceTerminals>,
    internal_id: String,
    external_id: String,
    mut receiver: mpsc::Receiver<PtyEvent>,
    flow: Arc<OutputFlow>,
    sink: EventSink,
) {
    let mut cancellation = flow.cancelled.subscribe();
    let mut sequence = 0;
    let mut normal_exit = false;
    loop {
        if *cancellation.borrow() {
            break;
        }
        let event = tokio::select! {
            event = receiver.recv() => match event { Some(event) => event, None => break },
            _ = cancellation.changed() => break,
        };
        if *cancellation.borrow() {
            break;
        }
        match event {
            PtyEvent::Output { data, .. } => {
                sequence += 1;
                let (sender, acknowledgement) = oneshot::channel();
                match flow.pending.lock() {
                    Ok(mut pending) => *pending = Some((sequence, sender)),
                    Err(_) => break,
                }
                if sink(TerminalEvent::Output {
                    id: external_id.clone(),
                    data,
                    sequence,
                })
                .is_err()
                {
                    break;
                }
                let acknowledged = tokio::select! {
                    result = acknowledgement => result.is_ok(),
                    _ = cancellation.changed() => false,
                };
                if !acknowledged {
                    break;
                }
            }
            PtyEvent::Exit { code, .. } => {
                normal_exit = sink(TerminalEvent::Exit {
                    id: external_id.clone(),
                    code,
                })
                .is_ok();
                break;
            }
            PtyEvent::Error { message, .. } => {
                if sink(TerminalEvent::Error {
                    id: external_id.clone(),
                    message,
                })
                .is_err()
                {
                    break;
                }
            }
        }
    }
    let externally_cancelled = *cancellation.borrow();
    flow.cancel();
    if !normal_exit && !externally_cancelled {
        // A disconnected consumer must not leave a shell running without its UI.
        let _ = current.manager.close(&internal_id).await;
    }
    if let Ok(mut flows) = current.flows.lock() {
        if flows
            .get(&external_id)
            .is_some_and(|registered| Arc::ptr_eq(registered, &flow))
        {
            flows.remove(&external_id);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_create(
    state: State<'_, DesktopState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<TerminalEvent>,
    profile_id: Option<String>,
) -> Result<TerminalInfo, String> {
    // Workspace replacement holds this gate through the core-state assignment.
    // A shell cannot start between terminal-manager and core-workspace updates.
    let _workspace_gate = state.connection_gate.lock().await;
    let sink: EventSink =
        Arc::new(move |event| on_event.send(event).map_err(|error| error.to_string()));
    match profile_id {
        None => state.terminals.create(cwd, cols, rows, sink).await,
        profile => {
            state
                .terminals
                .create_profile(cwd, cols, rows, sink, profile)
                .await
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_profiles() -> Result<Vec<TerminalProfile>, String> {
    tokio::task::spawn_blocking(discover_terminal_profiles)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_create_command(
    state: State<'_, DesktopState>,
    language: TerminalCommandLanguage,
    code: String,
    expected_workspace_root: String,
    cols: u16,
    rows: u16,
    on_event: tauri::ipc::Channel<TerminalEvent>,
) -> Result<TerminalInfo, String> {
    let _workspace_gate = state.connection_gate.lock().await;
    state
        .terminals
        .create_command(
            language,
            code,
            expected_workspace_root,
            cols,
            rows,
            Arc::new(move |event| on_event.send(event).map_err(|error| error.to_string())),
        )
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_write(
    state: State<'_, DesktopState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    state.terminals.write(&id, data).await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_resize(
    state: State<'_, DesktopState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminals.resize(&id, cols, rows).await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_interrupt(state: State<'_, DesktopState>, id: String) -> Result<(), String> {
    state.terminals.interrupt(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_close(state: State<'_, DesktopState>, id: String) -> Result<(), String> {
    state.terminals.close(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_list(state: State<'_, DesktopState>) -> Result<Vec<TerminalInfo>, String> {
    state.terminals.list()
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_scrollback(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<Vec<u8>, String> {
    state.terminals.scrollback(&id)
}

#[tauri::command]
#[specta::specta]
pub async fn terminal_acknowledge(
    state: State<'_, DesktopState>,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    state.terminals.acknowledge(&id, sequence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::time::timeout;

    fn collecting_sink() -> (EventSink, mpsc::UnboundedReceiver<TerminalEvent>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (
            Arc::new(move |event| sender.send(event).map_err(|error| error.to_string())),
            receiver,
        )
    }

    async fn output_until(
        state: &TerminalState,
        receiver: &mut mpsc::UnboundedReceiver<TerminalEvent>,
        needle: &str,
    ) -> String {
        let mut output = Vec::new();
        let result = timeout(Duration::from_secs(10), async {
            while let Some(event) = receiver.recv().await {
                match event {
                    TerminalEvent::Output { id, data, sequence } => {
                        assert!(data.len() <= 8192);
                        output.extend(data);
                        state.acknowledge(&id, sequence).unwrap();
                    }
                    TerminalEvent::Error { message, .. } => panic!("PTY error: {message}"),
                    TerminalEvent::Exit { .. } => break,
                }
                if String::from_utf8_lossy(&output).contains(needle) {
                    return String::from_utf8_lossy(&output).into_owned();
                }
            }
            panic!("Expected terminal output not received: {needle}");
        })
        .await;
        match result {
            Ok(output) => output,
            Err(_) => panic!(
                "Native bridge output timed out waiting for {needle:?}; last output: {:?}",
                String::from_utf8_lossy(&output[output.len().saturating_sub(4096)..])
            ),
        }
    }

    #[cfg(windows)]
    async fn prepare_windows_renderer(
        state: &TerminalState,
        id: &str,
        receiver: &mut mpsc::UnboundedReceiver<TerminalEvent>,
    ) {
        // portable-pty requests ConPTY cursor inheritance. A fresh xterm answers
        // this query; the headless fixture must implement the same protocol.
        output_until(state, receiver, "\x1b[6n").await;
        state.write(id, b"\x1b[1;1R".to_vec()).await.unwrap();
        state
            .write(id, b"chcp 65001 >nul & echo SPAN_UTF8_R^E^A^D^Y\r".to_vec())
            .await
            .unwrap();
        // Carets keep the echoed input from satisfying the executed sentinel.
        output_until(state, receiver, "SPAN_UTF8_READY").await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_bridge_streams_complete_source_and_exit_with_output_acknowledgements() {
        let root = TempDir::new().unwrap();
        let state = TerminalState::default();
        state.replace_workspace(root.path()).await.unwrap();
        let (sink, mut receiver) = collecting_sink();
        let info = state.create_command(TerminalCommandLanguage::Bash,
            "items=(one two)\nfor item in \"${items[@]}\"; do printf 'COMMAND:%s\\n' \"$item\"; done\nexit 9".to_owned(),
            root.path().to_string_lossy().into_owned(), 80, 24, sink).await.unwrap();
        let output = output_until(&state, &mut receiver, "COMMAND:two").await;
        assert!(output.contains("COMMAND:one"));
        assert!(!output.contains("items="));
        timeout(Duration::from_secs(10), async {
            while let Some(event) = receiver.recv().await {
                match event {
                    TerminalEvent::Output { id, sequence, .. } => {
                        state.acknowledge(&id, sequence).unwrap()
                    }
                    TerminalEvent::Exit { id, code } => {
                        assert_eq!(id, info.id);
                        assert_eq!(code, Some(9));
                        return;
                    }
                    TerminalEvent::Error { message, .. } => panic!("{message}"),
                }
            }
            panic!("Command bridge lost exit event");
        })
        .await
        .unwrap();
        state.close(&info.id).await.unwrap();
        assert!(state.list().unwrap().is_empty());
    }

    #[tokio::test]
    async fn command_bridge_rejects_old_workspace_and_invalid_profile_without_starting_a_session() {
        let root = TempDir::new().unwrap();
        let next = TempDir::new().unwrap();
        let state = TerminalState::default();
        state.replace_workspace(root.path()).await.unwrap();
        state.replace_workspace(next.path()).await.unwrap();
        let (sink, _receiver) = collecting_sink();
        assert!(state
            .create_command(
                TerminalCommandLanguage::Shell,
                "echo old".to_owned(),
                root.path().to_string_lossy().into_owned(),
                80,
                24,
                sink
            )
            .await
            .unwrap_err()
            .contains("workspace changed"));
        let (sink, _receiver) = collecting_sink();
        assert!(state
            .create_profile(None, 80, 24, sink, Some("shell:relative/bash".to_owned()))
            .await
            .is_err());
        assert!(state.list().unwrap().is_empty());
    }

    #[tokio::test]
    async fn native_bridge_real_pty_write_resize_interrupt_and_scrollback() {
        let root = TempDir::new().unwrap();
        let state = TerminalState::default();
        assert!(state.list().is_err());
        state.replace_workspace(root.path()).await.unwrap();
        let (sink, mut receiver) = collecting_sink();
        let info = state.create(None, 80, 24, sink).await.unwrap();
        #[cfg(windows)]
        prepare_windows_renderer(&state, &info.id, &mut receiver).await;
        #[cfg(unix)]
        let command = "printf 'SPAN_%s\\n' 'BRIDGE_日本語🌱'\r";
        #[cfg(windows)]
        let command = "set SPAN_NATIVE=BRIDGE_日本語🌱\recho SPAN_%SPAN_NATIVE%\r";
        state
            .write(&info.id, command.as_bytes().to_vec())
            .await
            .unwrap();
        let output = output_until(&state, &mut receiver, "SPAN_BRIDGE_日本語🌱").await;
        assert!(output.contains("SPAN_BRIDGE_日本語🌱"));
        state.resize(&info.id, 101, 35).await.unwrap();
        let resized = state.list().unwrap().remove(0);
        assert_eq!((resized.cols, resized.rows), (101, 35));
        state.interrupt(&info.id).await.unwrap();
        assert!(
            String::from_utf8_lossy(&state.scrollback(&info.id).unwrap())
                .contains("SPAN_BRIDGE_日本語🌱")
        );
        state.close(&info.id).await.unwrap();
        assert!(state.list().unwrap().is_empty());
        state.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn native_output_has_one_unacknowledged_chunk_and_close_cancels_backpressure() {
        let root = TempDir::new().unwrap();
        let state = TerminalState::default();
        state.replace_workspace(root.path()).await.unwrap();
        let (sink, mut receiver) = collecting_sink();
        let info = state.create(None, 80, 24, sink).await.unwrap();
        #[cfg(windows)]
        {
            prepare_windows_renderer(&state, &info.id, &mut receiver).await;
            state
                .write(&info.id, b"echo SPAN_FLOW_START\r".to_vec())
                .await
                .unwrap();
        }
        let first = timeout(Duration::from_secs(10), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        let TerminalEvent::Output { sequence, data, .. } = first else {
            panic!("Expected initial shell output");
        };
        #[cfg(unix)]
        assert_eq!(sequence, 1);
        #[cfg(windows)]
        assert!(
            sequence > 1,
            "Renderer setup already acknowledged initial output"
        );
        assert!(data.len() <= 8192);
        assert!(state.acknowledge(&info.id, sequence + 1).is_err());
        #[cfg(unix)]
        let command = b"yes SPAN_FLOW\r".to_vec();
        #[cfg(windows)]
        let command = b"for /L %i in (1,1,100000) do @echo SPAN_FLOW\r".to_vec();
        state.write(&info.id, command).await.unwrap();
        assert!(timeout(Duration::from_millis(100), receiver.recv())
            .await
            .is_err());
        timeout(Duration::from_secs(5), state.close(&info.id))
            .await
            .expect("Close must not wait for the UI acknowledgement")
            .unwrap();
        assert!(state.list().unwrap().is_empty());
        assert!(state.acknowledge(&info.id, sequence).is_err());
        state.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn workspace_replacement_closes_old_sessions_and_rejects_stale_ids() {
        let root = TempDir::new().unwrap();
        let next = TempDir::new().unwrap();
        let state = TerminalState::default();
        state.replace_workspace(root.path()).await.unwrap();
        let old_workspace = state.current().unwrap();
        let (sink, _receiver) = collecting_sink();
        let old = state.create(None, 80, 24, sink).await.unwrap();
        timeout(Duration::from_secs(5), state.replace_workspace(next.path()))
            .await
            .unwrap()
            .unwrap();
        assert!(old_workspace.manager.list().is_empty());
        assert!(state.write(&old.id, b"x".to_vec()).await.is_err());
        assert!(state.acknowledge(&old.id, 1).is_err());
        let (sink, _receiver) = collecting_sink();
        let new = state.create(None, 80, 24, sink).await.unwrap();
        assert_ne!(old.id, new.id);
        assert_eq!(state.list().unwrap().len(), 1);
        state.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn rejected_directory_and_disconnected_consumer_leave_no_session() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let state = TerminalState::default();
        state.replace_workspace(root.path()).await.unwrap();
        for cwd in [
            "settings://user".to_owned(),
            outside.path().to_string_lossy().into_owned(),
        ] {
            let (sink, _receiver) = collecting_sink();
            assert!(state.create(Some(cwd), 80, 24, sink).await.is_err());
        }
        assert!(state.list().unwrap().is_empty());
        state
            .create(
                None,
                80,
                24,
                Arc::new(|_| Err("Webview channel closed".to_owned())),
            )
            .await
            .unwrap();
        timeout(Duration::from_secs(5), async {
            while !state.list().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Disconnected channel must terminate its shell");
        state.shutdown().await.unwrap();
    }
}
