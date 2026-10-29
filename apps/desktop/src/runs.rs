//! Non-interactive, direct-argv run execution shared by native commands and tool hosts.
use crate::{with_workspace, DesktopState};
use serde::{Deserialize, Serialize};
use span_core::{PreparedRun, RunCatalog, RunConfiguration};
use specta::Type;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::State;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{mpsc, watch, Notify},
};

const MAX_RUNS: usize = 32;
const MAX_ACTIVE: usize = 4;
const OUTPUT_LIMIT: usize = 256 * 1024;
static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Stopping,
    Stopped,
    Exited,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub id: String,
    pub configuration_id: String,
    pub workspace_epoch: u64,
    pub name: String,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RunStream {
    Stdout,
    Stderr,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunEvent {
    Output {
        id: String,
        sequence: u64,
        #[serde(rename = "workspaceEpoch")]
        workspace_epoch: u64,
        stream: RunStream,
        text: String,
    },
    State {
        run: RunInfo,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    pub id: String,
    pub text: String,
    pub truncated: bool,
}

/// Return false when the consumer is gone. A missing consumer stops the owned process tree.
pub(crate) type RunSink = Arc<dyn Fn(RunEvent) -> bool + Send + Sync>;
#[derive(Default)]
struct Output {
    bytes: VecDeque<u8>,
    truncated: bool,
}
struct RunRecord {
    info: Mutex<RunInfo>,
    configuration: RunConfiguration,
    root: std::path::PathBuf,
    output: Mutex<Output>,
    cancel: watch::Sender<bool>,
    completed: watch::Receiver<bool>,
    acknowledged: AtomicU64,
    pending_sequence: AtomicU64,
    ack_notify: Notify,
}
type RunRecords = VecDeque<(String, Arc<RunRecord>)>;
#[derive(Clone, Default)]
pub(crate) struct RunService {
    epoch: Arc<AtomicU64>,
    records: Arc<Mutex<RunRecords>>,
}
fn unavailable() -> String {
    "Run process state is unavailable".into()
}
impl RunService {
    fn record(&self, id: &str) -> Result<Arc<RunRecord>, String> {
        self.records
            .lock()
            .map_err(|_| unavailable())?
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, record)| record.clone())
            .ok_or_else(|| "Run was not found in this workspace".into())
    }
    pub(crate) fn approval_configuration(
        &self,
        id: &str,
    ) -> Result<(RunConfiguration, std::path::PathBuf), String> {
        let record = self.record(id)?;
        Ok((record.configuration.clone(), record.root.clone()))
    }
    pub(crate) fn list(&self) -> Result<Vec<RunInfo>, String> {
        self.records
            .lock()
            .map_err(|_| unavailable())?
            .iter()
            .map(|(_, record)| {
                record
                    .info
                    .lock()
                    .map(|info| info.clone())
                    .map_err(|_| unavailable())
            })
            .collect()
    }
    pub(crate) fn output(&self, id: &str) -> Result<RunOutput, String> {
        let record = self.record(id)?;
        let output = record.output.lock().map_err(|_| unavailable())?;
        Ok(RunOutput {
            id: id.into(),
            text: String::from_utf8_lossy(&output.bytes.iter().copied().collect::<Vec<_>>())
                .into_owned(),
            truncated: output.truncated,
        })
    }
    pub(crate) fn acknowledge(&self, id: &str, sequence: u64) -> Result<(), String> {
        let record = self.record(id)?;
        // Future sequence acknowledgements must not disable flow control.
        if sequence == record.pending_sequence.load(Ordering::Acquire)
            && sequence > record.acknowledged.load(Ordering::Acquire)
        {
            record.acknowledged.store(sequence, Ordering::Release);
            record.ack_notify.notify_one();
        }
        Ok(())
    }
    pub(crate) async fn start(
        &self,
        prepared: PreparedRun,
        sink: RunSink,
    ) -> Result<RunInfo, String> {
        let (mut info, record, cancelled, complete, spawned) = {
            let mut records = self.records.lock().map_err(|_| unavailable())?;
            let active = records
                .iter()
                .filter(|(_, record)| record.completed.borrow().eq(&false))
                .count();
            if active >= MAX_ACTIVE {
                return Err("At most four run processes may be active. Stop a run first.".into());
            }
            // A configuration has one active instance, independent of UI or tool caller.
            if records.iter().any(|(_, record)| {
                !*record.completed.borrow() && record.configuration.id == prepared.configuration.id
            }) {
                return Err(
                    "This configuration is already running. Stop or restart it first.".into(),
                );
            }
            if records.len() >= MAX_RUNS {
                let Some(index) = records
                    .iter()
                    .position(|(_, record)| *record.completed.borrow())
                else {
                    return Err("Run history is full".into());
                };
                records.remove(index);
            }
            let id = format!("run-process-{}", NEXT_RUN.fetch_add(1, Ordering::Relaxed));
            let info = RunInfo {
                id: id.clone(),
                configuration_id: prepared.configuration.id.clone(),
                workspace_epoch: self.epoch.load(Ordering::Acquire),
                name: prepared.configuration.name.clone(),
                status: RunStatus::Running,
                exit_code: None,
                error: None,
            };
            let (cancel, cancelled) = watch::channel(false);
            let (complete, completed) = watch::channel(false);
            let mut command = Command::new(&prepared.executable);
            command
                .args(&prepared.args)
                .current_dir(&prepared.cwd)
                .envs(&prepared.env)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            if !prepared.env.contains_key("PATH") {
                if let Some(path) = span_core::native_program_path() {
                    command.env("PATH", path);
                }
            }
            #[cfg(unix)]
            command.process_group(0);
            #[cfg(windows)]
            command.creation_flags(0x08000004); // CREATE_NO_WINDOW | CREATE_SUSPENDED, assigned to a job before first execution.
            let spawned = command.spawn();
            let record = Arc::new(RunRecord {
                info: Mutex::new(info.clone()),
                configuration: prepared.configuration,
                root: prepared.workspace_root,
                output: Mutex::new(Output::default()),
                cancel,
                completed,
                acknowledged: AtomicU64::new(0),
                pending_sequence: AtomicU64::new(0),
                ack_notify: Notify::new(),
            });
            records.push_back((id, record.clone()));
            (info, record, cancelled, complete, spawned)
        };
        match spawned {
            Ok(mut child) => {
                let tree = match ProcessTree::new(&child) {
                    Ok(tree) => tree,
                    Err(error) => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        info.status = RunStatus::Failed;
                        info.error = Some(error);
                        *record.info.lock().map_err(|_| unavailable())? = info.clone();
                        let _ = sink(RunEvent::State { run: info.clone() });
                        let _ = complete.send(true);
                        return Ok(info);
                    }
                };
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| "Run stdout pipe is unavailable".to_owned())?;
                let stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| "Run stderr pipe is unavailable".to_owned())?;
                let (tx, rx) = mpsc::channel(16);
                let stdout_task = tokio::spawn(read_pipe(stdout, RunStream::Stdout, tx.clone()));
                let stderr_task = tokio::spawn(read_pipe(stderr, RunStream::Stderr, tx));
                if !sink(RunEvent::State { run: info.clone() }) {
                    let _ = record.cancel.send(true);
                }
                tokio::spawn(supervise(
                    child,
                    tree,
                    record,
                    cancelled,
                    complete,
                    RunPipes {
                        output: rx,
                        readers: [stdout_task, stderr_task],
                    },
                    sink,
                ));
            }
            Err(error) => {
                info.status = RunStatus::Failed;
                // Display only OS failure, never argv, expanded environment or command Debug.
                info.error = Some(format!("Could not start executable: {error}"));
                *record.info.lock().map_err(|_| unavailable())? = info.clone();
                let _ = sink(RunEvent::State { run: info.clone() });
                let _ = complete.send(true);
            }
        }
        Ok(info)
    }
    pub(crate) async fn restart_prepared(
        &self,
        id: &str,
        prepared: PreparedRun,
        sink: RunSink,
    ) -> Result<RunInfo, String> {
        let previous = self.record(id)?;
        if previous.root != prepared.workspace_root {
            return Err("Run belongs to a different workspace".into());
        }
        self.stop(id).await?;
        self.start(prepared, sink).await
    }
    pub(crate) async fn stop(&self, id: &str) -> Result<RunInfo, String> {
        let record = self.record(id)?;
        if !*record.completed.borrow() {
            if let Ok(mut info) = record.info.lock() {
                info.status = RunStatus::Stopping;
            }
            let _ = record.cancel.send(true);
            let mut done = record.completed.clone();
            tokio::time::timeout(Duration::from_secs(8), async {
                while !*done.borrow_and_update() {
                    if done.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
            .map_err(|_| "Timed out while stopping run process tree".to_owned())?;
        }
        let info = record.info.lock().map_err(|_| unavailable())?.clone();
        Ok(info)
    }
    pub(crate) async fn shutdown(&self) -> Result<(), String> {
        let records: Vec<_> = self
            .records
            .lock()
            .map_err(|_| unavailable())?
            .iter()
            .map(|(_, record)| record.clone())
            .collect();
        for record in &records {
            let _ = record.cancel.send(true);
        }
        for record in records {
            let mut done = record.completed.clone();
            tokio::time::timeout(Duration::from_secs(8), async {
                while !*done.borrow_and_update() {
                    if done.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
            .map_err(|_| "Timed out while cleaning up run processes".to_owned())?;
        }
        self.epoch.fetch_add(1, Ordering::AcqRel);
        self.records.lock().map_err(|_| unavailable())?.clear();
        Ok(())
    }
}

enum PipeEvent {
    Text(RunStream, String),
    Error,
}
fn decode_utf8(pending: &mut Vec<u8>, eof: bool) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                text.push_str(valid);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                text.push_str(&String::from_utf8_lossy(&pending[..valid]));
                match error.error_len() {
                    Some(length) => {
                        text.push('\u{fffd}');
                        pending.drain(..valid + length);
                    }
                    None => {
                        pending.drain(..valid);
                        break;
                    }
                }
            }
        }
    }
    if eof && !pending.is_empty() {
        text.push_str(&String::from_utf8_lossy(pending));
        pending.clear();
    }
    text
}
async fn read_pipe(
    mut pipe: impl AsyncRead + Unpin,
    stream: RunStream,
    sender: mpsc::Sender<PipeEvent>,
) {
    let mut buffer = [0; 8192];
    let mut pending = Vec::new();
    loop {
        match pipe.read(&mut buffer).await {
            Ok(count) => {
                pending.extend_from_slice(&buffer[..count]);
                let text = decode_utf8(&mut pending, count == 0);
                if !text.is_empty()
                    && sender
                        .send(PipeEvent::Text(stream.clone(), text))
                        .await
                        .is_err()
                {
                    return;
                }
                if count == 0 {
                    return;
                }
            }
            Err(_) => {
                let _ = sender.send(PipeEvent::Error).await;
                return;
            }
        }
    }
}
async fn wait_cancelled(cancelled: &mut watch::Receiver<bool>) {
    while !*cancelled.borrow_and_update() {
        if cancelled.changed().await.is_err() {
            return;
        }
    }
}
async fn deliver(
    record: &RunRecord,
    stream: RunStream,
    text: String,
    sequence: u64,
    sink: &RunSink,
    cancelled: &mut watch::Receiver<bool>,
) -> bool {
    if let Ok(mut output) = record.output.lock() {
        for byte in text.as_bytes() {
            if output.bytes.len() == OUTPUT_LIMIT {
                output.bytes.pop_front();
                output.truncated = true;
            }
            output.bytes.push_back(*byte);
        }
        // Never expose a sliced UTF-8 codepoint at the retained history boundary.
        while output.bytes.front().is_some_and(|byte| byte & 0xc0 == 0x80) {
            output.bytes.pop_front();
        }
    }
    if *cancelled.borrow() {
        return false;
    }
    let id = match record.info.lock() {
        Ok(info) => info.id.clone(),
        Err(_) => return false,
    };
    record.pending_sequence.store(sequence, Ordering::Release);
    if !sink(RunEvent::Output {
        id,
        sequence,
        workspace_epoch: record
            .info
            .lock()
            .map(|info| info.workspace_epoch)
            .unwrap_or(0),
        stream,
        text,
    }) {
        return false;
    }
    let ack = async {
        loop {
            let notified = record.ack_notify.notified();
            if record.acknowledged.load(Ordering::Acquire) >= sequence {
                return;
            }
            notified.await;
        }
    };
    tokio::select! { result = tokio::time::timeout(Duration::from_secs(15), ack) => result.is_ok(), _ = wait_cancelled(cancelled) => false }
}
struct RunPipes {
    output: mpsc::Receiver<PipeEvent>,
    readers: [tokio::task::JoinHandle<()>; 2],
}
async fn supervise(
    mut child: tokio::process::Child,
    tree: ProcessTree,
    record: Arc<RunRecord>,
    mut cancelled: watch::Receiver<bool>,
    complete: watch::Sender<bool>,
    pipes: RunPipes,
    sink: RunSink,
) {
    let RunPipes {
        mut output,
        readers,
    } = pipes;
    let mut result = None;
    let mut error = None;
    let mut sequence = 0;
    let mut stop = false;
    let mut drain_deadline = None;
    let mut output_closed = false;
    loop {
        if output_closed && result.is_some() {
            break;
        }
        tokio::select! {
            biased;
            _ = wait_cancelled(&mut cancelled), if !stop => { stop = true; drain_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(2)); tree.kill(); let _ = child.start_kill(); }
            status = child.wait(), if result.is_none() => { result = Some(status); drain_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(2)); tree.kill(); }
            _ = async { if let Some(deadline) = drain_deadline { tokio::time::sleep_until(deadline).await; } else { std::future::pending::<()>().await; } } => break,
            event = output.recv(), if !output_closed => match event {
                Some(PipeEvent::Text(stream, text)) => {
                    sequence += 1;
                    let delivered = if !stop {
                        let mut delivery = Box::pin(deliver(&record, stream, text, sequence, &sink, &mut cancelled));
                        loop {
                            tokio::select! {
                                done = &mut delivery => break done,
                                status = child.wait(), if result.is_none() => { result = Some(status); tree.kill(); drain_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(2)); }
                                _ = async { if let Some(deadline) = drain_deadline { tokio::time::sleep_until(deadline).await; } else { std::future::pending::<()>().await; } } => break false,
                            }
                        }
                    } else { true };
                    if !delivered {
                        stop = true; drain_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(2)); tree.kill(); let _ = child.start_kill();
                        if !*cancelled.borrow() { error = Some("Output consumer disconnected or did not acknowledge output before the delivery deadline".into()); }
                    }
                }
                Some(PipeEvent::Error) => { error = Some("Could not read run process output".into()); stop = true; drain_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(2)); tree.kill(); let _ = child.start_kill(); }
                None => { output_closed = true; },
            }
        }
    }
    tree.kill();
    if result.is_none() {
        result = Some(child.wait().await);
    }
    for reader in readers {
        reader.abort();
    }
    let final_info = if let Ok(mut info) = record.info.lock() {
        match result {
            Some(Ok(status)) => {
                info.exit_code = status.code();
                info.status = if error.is_some() {
                    RunStatus::Failed
                } else if *cancelled.borrow() {
                    RunStatus::Stopped
                } else {
                    RunStatus::Exited
                };
            }
            Some(Err(_)) | None => {
                info.status = RunStatus::Failed;
                error = Some("Could not collect run process exit status".into());
            }
        }
        info.error = error;
        Some(info.clone())
    } else {
        None
    };
    if let Some(run) = final_info {
        let _ = sink(RunEvent::State { run });
    }
    let _ = complete.send(true);
}

#[cfg(unix)]
struct ProcessTree {
    pid: i32,
    killed: std::sync::atomic::AtomicBool,
}
#[cfg(unix)]
impl ProcessTree {
    fn new(child: &tokio::process::Child) -> Result<Self, String> {
        let pid = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .ok_or_else(|| "Run process ID is unavailable".to_owned())?;
        Ok(Self {
            pid,
            killed: std::sync::atomic::AtomicBool::new(false),
        })
    }
    fn kill(&self) {
        if !self.killed.swap(true, Ordering::AcqRel) && self.pid > 1 {
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
        }
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        self.kill();
    }
}
#[cfg(windows)]
struct ProcessTree {
    job: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
impl ProcessTree {
    fn new(child: &tokio::process::Child) -> Result<Self, String> {
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        let process = child
            .raw_handle()
            .ok_or_else(|| "Run process handle is unavailable".to_owned())?;
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err("Could not create run process cleanup job".into());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let valid = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) != 0
                && AssignProcessToJobObject(job, process as _) != 0
        };
        if !valid {
            unsafe {
                CloseHandle(job);
            }
            return Err("Could not attach run process cleanup job".into());
        }
        let tree = Self { job };
        resume_owned_process(
            child
                .id()
                .ok_or_else(|| "Run process ID is unavailable".to_owned())?,
        )?;
        Ok(tree)
    }
    fn kill(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
    }
}
#[cfg(windows)]
fn resume_owned_process(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    // The child is still CREATE_SUSPENDED. No application thread can create descendants yet.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err("Could not inspect suspended run process".into());
    }
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut found = unsafe { Thread32First(snapshot, &mut entry) };
    let mut resumed = false;
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread.is_null() {
                let result = unsafe { ResumeThread(thread) };
                unsafe {
                    CloseHandle(thread);
                }
                if result != u32::MAX {
                    resumed = true;
                }
            }
            break;
        }
        found = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    if resumed {
        Ok(())
    } else {
        Err("Could not resume the owned run process after job assignment".into())
    }
}
#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunContext {
    pub workspace_root: String,
    pub workspace_epoch: u64,
    pub runs: Vec<RunInfo>,
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn run_context(state: State<'_, DesktopState>) -> Result<RunContext, String> {
    let _gate = state.connection_gate.lock().await;
    let root = state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a workspace first".to_owned())?
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .workspace()
        .root;
    Ok(RunContext {
        workspace_root: root,
        workspace_epoch: state.runs.epoch.load(Ordering::Acquire),
        runs: state.runs.list()?,
    })
}

fn require_root(workspace: &span_core::CoreWorkspace, expected: &str) -> span_core::Result<()> {
    if workspace.workspace().root != expected {
        return Err(span_core::CoreError::RunConfiguration(
            "Workspace changed. Reload run configurations before continuing.".into(),
        ));
    }
    Ok(())
}

// Native wrappers. The shared service above has no renderer dependency.
#[tauri::command]
#[specta::specta]
pub(crate) async fn run_configurations(
    state: State<'_, DesktopState>,
) -> Result<RunCatalog, String> {
    with_workspace(state.inner().clone(), |workspace| {
        workspace.run_configurations()
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn save_run_configuration(
    state: State<'_, DesktopState>,
    configuration: RunConfiguration,
    expected_workspace_root: String,
) -> Result<RunConfiguration, String> {
    let _gate = state.connection_gate.lock().await;
    with_workspace(state.inner().clone(), move |workspace| {
        require_root(workspace, &expected_workspace_root)?;
        workspace.save_run_configuration(configuration)
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn delete_run_configuration(
    state: State<'_, DesktopState>,
    id: String,
    expected_workspace_root: String,
) -> Result<(), String> {
    let _gate = state.connection_gate.lock().await;
    with_workspace(state.inner().clone(), move |workspace| {
        require_root(workspace, &expected_workspace_root)?;
        workspace.delete_run_configuration(&id)
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn duplicate_run_configuration(
    state: State<'_, DesktopState>,
    id: String,
    expected_workspace_root: String,
) -> Result<RunConfiguration, String> {
    let _gate = state.connection_gate.lock().await;
    with_workspace(state.inner().clone(), move |workspace| {
        require_root(workspace, &expected_workspace_root)?;
        workspace.duplicate_run_configuration(&id)
    })
    .await
}

pub(crate) async fn start_shared(
    state: &DesktopState,
    configuration: RunConfiguration,
    expected_workspace_root: String,
    sink: RunSink,
) -> Result<RunInfo, String> {
    let _gate = state.connection_gate.lock().await;
    let prepared = with_workspace(state.clone(), move |workspace| {
        require_root(workspace, &expected_workspace_root)?;
        let catalog = workspace.run_configurations()?;
        if !catalog
            .configurations
            .iter()
            .chain(catalog.detected.iter().map(|task| &task.configuration))
            .any(|current| current == &configuration)
        {
            return Err(span_core::CoreError::RunConfiguration(
                "Run configuration changed or is not saved. Reload it before running.".into(),
            ));
        }
        workspace.prepare_run(configuration)
    })
    .await?;
    state.runs.start(prepared, sink).await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_run(
    state: State<'_, DesktopState>,
    configuration: RunConfiguration,
    expected_workspace_root: String,
    on_event: tauri::ipc::Channel<RunEvent>,
) -> Result<RunInfo, String> {
    start_shared(
        state.inner(),
        configuration,
        expected_workspace_root,
        Arc::new(move |event| on_event.send(event).is_ok()),
    )
    .await
}
/// Start the runner mapped to one workspace file. The command is recomputed
/// in core from the path, so the renderer cannot supply arbitrary commands.
pub(crate) async fn start_current_file_shared(
    state: &DesktopState,
    path: String,
    expected_workspace_root: String,
    sink: RunSink,
) -> Result<RunInfo, String> {
    let _gate = state.connection_gate.lock().await;
    let prepared = with_workspace(state.clone(), move |workspace| {
        require_root(workspace, &expected_workspace_root)?;
        let plan = workspace.current_file_run(&path)?;
        let configuration = plan.configuration.ok_or_else(|| {
            span_core::CoreError::RunConfiguration(
                plan.reason
                    .unwrap_or_else(|| "This file has no runner.".into()),
            )
        })?;
        workspace.prepare_run(configuration)
    })
    .await?;
    state.runs.start(prepared, sink).await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn current_file_run(
    state: State<'_, DesktopState>,
    path: String,
    expected_workspace_root: String,
) -> Result<span_core::CurrentFileRun, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        require_root(workspace, &expected_workspace_root)?;
        workspace.current_file_run(&path)
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn start_current_file_run(
    state: State<'_, DesktopState>,
    path: String,
    expected_workspace_root: String,
    on_event: tauri::ipc::Channel<RunEvent>,
) -> Result<RunInfo, String> {
    start_current_file_shared(
        state.inner(),
        path,
        expected_workspace_root,
        Arc::new(move |event| on_event.send(event).is_ok()),
    )
    .await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn stop_run(
    state: State<'_, DesktopState>,
    id: String,
) -> Result<RunInfo, String> {
    state.runs.stop(&id).await
}
pub(crate) async fn restart_shared(
    state: &DesktopState,
    id: &str,
    sink: RunSink,
) -> Result<RunInfo, String> {
    let _gate = state.connection_gate.lock().await;
    let previous = state.runs.record(id)?;
    let config = previous.configuration.clone();
    let root = previous.root.clone();
    let prepared = with_workspace(state.clone(), move |workspace| {
        if std::path::Path::new(&workspace.workspace().root) != root {
            return Err(span_core::CoreError::RunConfiguration(
                "Workspace changed. Select a configuration from this workspace.".into(),
            ));
        }
        workspace.prepare_run(config)
    })
    .await?;
    state.runs.restart_prepared(id, prepared, sink).await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn restart_run(
    state: State<'_, DesktopState>,
    id: String,
    on_event: tauri::ipc::Channel<RunEvent>,
) -> Result<RunInfo, String> {
    restart_shared(
        state.inner(),
        &id,
        Arc::new(move |event| on_event.send(event).is_ok()),
    )
    .await
}
#[tauri::command]
#[specta::specta]
pub(crate) fn list_runs(state: State<'_, DesktopState>) -> Result<Vec<RunInfo>, String> {
    state.runs.list()
}
#[tauri::command]
#[specta::specta]
pub(crate) fn run_output(state: State<'_, DesktopState>, id: String) -> Result<RunOutput, String> {
    state.runs.output(&id)
}
#[tauri::command]
#[specta::specta]
pub(crate) fn acknowledge_run(
    state: State<'_, DesktopState>,
    id: String,
    sequence: u64,
) -> Result<(), String> {
    state.runs.acknowledge(&id, sequence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, io::Write};

    // The child is this test executable in a separate process, with no user shell profiles.
    #[test]
    fn fixture_child() {
        let Ok(mode) = std::env::var("SPAN_RUN_TEST_MODE") else {
            return;
        };
        match mode.as_str() {
            "output" => {
                for byte in "日本語🌱\n".as_bytes() {
                    std::io::stdout().write_all(&[*byte]).unwrap();
                    std::io::stdout().flush().unwrap();
                    std::thread::sleep(Duration::from_millis(1));
                }
                eprintln!("fixture-stderr");
                let mut input = [0];
                assert_eq!(
                    std::io::Read::read(&mut std::io::stdin(), &mut input).unwrap(),
                    0
                );
                std::process::exit(7);
            }
            "flood" => {
                for _ in 0..128 {
                    std::io::stdout().write_all(&[b'x'; 8192]).unwrap();
                }
            }
            "wait" => {
                println!("fixture-ready");
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_secs(60));
            }
            "quiet" => std::thread::sleep(Duration::from_secs(60)),
            "descendant" => {
                let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "runs::tests::fixture_child", "--nocapture"])
                    .env("SPAN_RUN_TEST_MODE", "quiet")
                    .spawn()
                    .unwrap();
                std::fs::write(
                    std::env::var("SPAN_RUN_PID_FILE").unwrap(),
                    child.id().to_string(),
                )
                .unwrap();
                println!("descendant-ready");
                std::io::stdout().flush().unwrap();
                let _ = child.wait();
            }
            _ => panic!("Unknown fixture mode"),
        }
    }
    fn prepared(root: &std::path::Path, mode: &str) -> PreparedRun {
        let workspace = span_core::CoreWorkspace::open(root).unwrap();
        workspace
            .prepare_run(RunConfiguration {
                id: format!("fixture-{mode}"),
                name: "fixture".into(),
                executable: std::env::current_exe().unwrap().display().to_string(),
                args: vec![
                    "--exact".into(),
                    "runs::tests::fixture_child".into(),
                    "--nocapture".into(),
                ],
                cwd: ".".into(),
                env: BTreeMap::from([("SPAN_RUN_TEST_MODE".into(), mode.into())]),
            })
            .unwrap()
    }
    fn sink(service: RunService, events: Arc<Mutex<Vec<RunEvent>>>) -> RunSink {
        Arc::new(move |event| {
            if let RunEvent::Output { id, sequence, .. } = &event {
                service.acknowledge(id, *sequence).unwrap();
            }
            events.lock().unwrap().push(event);
            true
        })
    }
    async fn completed(service: &RunService, id: &str) -> RunInfo {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let info = service
                    .list()
                    .unwrap()
                    .into_iter()
                    .find(|info| info.id == id)
                    .unwrap();
                if matches!(
                    info.status,
                    RunStatus::Exited | RunStatus::Stopped | RunStatus::Failed
                ) {
                    return info;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("run did not finish")
    }
    #[tokio::test]
    async fn final_unacknowledged_output_cannot_hold_exit_indefinitely() {
        let dir = tempfile::tempdir().unwrap();
        let service = RunService::default();
        let info = service
            .start(prepared(dir.path(), "output"), Arc::new(|_| true))
            .await
            .unwrap();
        let finished = completed(&service, &info.id).await;
        assert_eq!(finished.status, RunStatus::Failed);
        assert!(finished.error.unwrap().contains("Output consumer"));
    }
    #[test]
    fn decoder_preserves_one_byte_unicode_and_invalid_prefixes() {
        let mut pending = Vec::new();
        let mut text = String::new();
        for byte in "日本語🌱".as_bytes() {
            pending.push(*byte);
            text.push_str(&decode_utf8(&mut pending, false));
        }
        assert_eq!(text, "日本語🌱");
        assert!(pending.is_empty());
        pending.extend_from_slice(&[0xff, 0xf0, 0x9f]);
        assert_eq!(decode_utf8(&mut pending, false), "�");
        pending.extend_from_slice(&[0x8c, 0xb1]);
        assert_eq!(decode_utf8(&mut pending, true), "🌱");
    }
    #[tokio::test]
    async fn real_process_streams_unicode_stderr_and_nonzero_exit_without_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let service = RunService::default();
        let events = Arc::new(Mutex::new(Vec::new()));
        let info = service
            .start(
                prepared(dir.path(), "output"),
                sink(service.clone(), events.clone()),
            )
            .await
            .unwrap();
        let finished = completed(&service, &info.id).await;
        assert_eq!(finished.status, RunStatus::Exited);
        assert_eq!(finished.exit_code, Some(7));
        let output = service.output(&info.id).unwrap();
        assert!(output.text.contains("日本語🌱"));
        assert!(output.text.contains("fixture-stderr"));
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| matches!(
            event,
            RunEvent::Output {
                stream: RunStream::Stderr,
                ..
            }
        )));
        assert!(
            matches!(events.last(), Some(RunEvent::State {run}) if run.status == RunStatus::Exited)
        );
    }
    #[tokio::test]
    async fn output_history_is_bounded_and_stop_cancels_unacknowledged_output() {
        let dir = tempfile::tempdir().unwrap();
        let service = RunService::default();
        let events = Arc::new(Mutex::new(Vec::new()));
        let info = service
            .start(prepared(dir.path(), "flood"), sink(service.clone(), events))
            .await
            .unwrap();
        completed(&service, &info.id).await;
        let output = service.output(&info.id).unwrap();
        assert!(output.truncated);
        assert!(output.text.len() <= OUTPUT_LIMIT);
        let received = Arc::new(AtomicU64::new(0));
        let copy = received.clone();
        let info = service
            .start(
                prepared(dir.path(), "wait"),
                Arc::new(move |event| {
                    if matches!(event, RunEvent::Output { .. }) {
                        copy.fetch_add(1, Ordering::Relaxed);
                    }
                    true
                }),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while received.load(Ordering::Relaxed) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(received.load(Ordering::Relaxed), 1);
        let stopped = service.stop(&info.id).await.unwrap();
        assert_eq!(stopped.status, RunStatus::Stopped);
        service.shutdown().await.unwrap();
        assert!(service.list().unwrap().is_empty());
    }
    #[tokio::test]
    async fn disconnected_consumer_stops_even_a_quiet_process_and_spawn_errors_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let service = RunService::default();
        let info = service
            .start(prepared(dir.path(), "quiet"), Arc::new(|_| false))
            .await
            .unwrap();
        assert_eq!(
            completed(&service, &info.id).await.status,
            RunStatus::Stopped
        );
        let mut missing = prepared(dir.path(), "output");
        missing.executable = dir.path().join("missing");
        let info = service.start(missing, Arc::new(|_| true)).await.unwrap();
        assert_eq!(info.status, RunStatus::Failed);
        assert!(info.error.unwrap().contains("Could not start"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stop_kills_owned_descendant_and_workspace_shutdown_rejects_old_ids() {
        let dir = tempfile::tempdir().unwrap();
        let service = RunService::default();
        let pidfile = dir.path().join("child.pid");
        let mut request = prepared(dir.path(), "descendant");
        request
            .env
            .insert("SPAN_RUN_PID_FILE".into(), pidfile.display().to_string());
        let info = service
            .start(
                request,
                sink(service.clone(), Arc::new(Mutex::new(Vec::new()))),
            )
            .await
            .unwrap();
        let pid: i32 = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&pidfile) {
                    if let Ok(pid) = text.parse() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        service.stop(&info.id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if unsafe { libc::kill(pid, 0) } != 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("owned descendant survived stop");
        service.shutdown().await.unwrap();
        assert!(service.stop(&info.id).await.is_err());
        let next = service
            .start(
                prepared(dir.path(), "output"),
                sink(service.clone(), Arc::new(Mutex::new(Vec::new()))),
            )
            .await
            .unwrap();
        assert_ne!(next.workspace_epoch, info.workspace_epoch);
        assert_ne!(next.id, info.id);
        completed(&service, &next.id).await;
    }
}
