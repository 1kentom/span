//! User-owned interactive terminal sessions. ACP terminal capabilities remain separate.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tokio::sync::mpsc;

const EVENT_CAPACITY: usize = 64;
const CHUNK_BYTES: usize = 8192;
const SCROLLBACK_BYTES: usize = 256 * 1024;
const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_SESSIONS: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("Terminal directory must be an existing directory inside the workspace")]
    InvalidDirectory,
    #[error("Terminal dimensions must be between 2 and 1000")]
    InvalidSize,
    #[error("Terminal session is unavailable")]
    Unavailable,
    #[error("Too many terminal sessions")]
    SessionLimit,
    #[error("Terminal input exceeds one MiB")]
    InputTooLarge,
    #[error("Terminal operation failed: {0}")]
    Operation(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub cwd: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
    pub process_id: Option<u32>,
    pub exit_code: Option<u32>,
    pub exited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { id: String, data: Vec<u8> },
    Exit { id: String, code: Option<u32> },
    Error { id: String, message: String },
}

struct Resources {
    master: Box<dyn MasterPty + Send>,
}
struct Session {
    info: Mutex<TerminalInfo>,
    resources: Mutex<Option<Resources>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    stopped: AtomicBool,
    scrollback: Mutex<VecDeque<u8>>,
}

impl Session {
    fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut child = self.child.lock().unwrap();
        let running = matches!(child.try_wait(), Ok(None));
        // Kill the current foreground job as well as the shell's process group.
        // Interactive shells give each foreground pipeline its own group.
        #[cfg(unix)]
        if let Some(resources) = self.resources.lock().unwrap().as_ref() {
            if let Some(fd) = resources.master.as_raw_fd() {
                unsafe {
                    let foreground = libc::tcgetpgrp(fd);
                    if foreground > 0 {
                        libc::kill(-foreground, libc::SIGKILL);
                    }
                    // Never signal a reaped child PID, which may have been reused.
                    if running {
                        if let Some(pid) = child.process_id() {
                            libc::kill(-(pid as i32), libc::SIGKILL);
                            libc::kill(pid as i32, libc::SIGKILL);
                        }
                    }
                }
            }
        }
        if running {
            let _ = child.kill();
        }
        self.resources.lock().unwrap().take();
        self.writer.lock().unwrap().take();
        let _ = child.wait();
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Construct one manager for the currently open, canonical workspace root.
/// Replacing or dropping it terminates all terminals it owns.
pub struct TerminalManager {
    workspace: PathBuf,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_id: AtomicU64,
}
impl TerminalManager {
    pub fn new(workspace: impl AsRef<Path>) -> Result<Self, TerminalError> {
        let workspace = workspace
            .as_ref()
            .canonicalize()
            .map_err(|_| TerminalError::InvalidDirectory)?;
        if !workspace.is_dir() {
            return Err(TerminalError::InvalidDirectory);
        }
        Ok(Self {
            workspace,
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        })
    }

    /// The receiver must be drained by the desktop event bridge. Its bounded queue
    /// applies backpressure to the PTY reader, without unbounded allocation.
    pub async fn create(
        &self,
        cwd: impl AsRef<Path>,
        cols: u16,
        rows: u16,
    ) -> Result<(TerminalInfo, mpsc::Receiver<TerminalEvent>), TerminalError> {
        let cwd = self.resolve_cwd(cwd.as_ref())?;
        size(cols, rows)?;
        if self.sessions.lock().unwrap().len() >= MAX_SESSIONS {
            return Err(TerminalError::SessionLimit);
        }
        let id = format!("terminal-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        // PTY allocation and process spawning happen on Tokio's blocking pool.
        let (session, rx) =
            tokio::task::spawn_blocking(move || spawn(id, cwd, cols, rows, shell_program()))
                .await
                .map_err(operation)??;
        let info = session.info.lock().unwrap().clone();
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.len() >= MAX_SESSIONS {
            session.stop();
            return Err(TerminalError::SessionLimit);
        }
        sessions.insert(info.id.clone(), session);
        Ok((info, rx))
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| s.info.lock().unwrap().clone())
            .collect()
    }
    pub fn scrollback(&self, id: &str) -> Result<Vec<u8>, TerminalError> {
        Ok(self
            .session(id)?
            .scrollback
            .lock()
            .unwrap()
            .iter()
            .copied()
            .collect())
    }
    pub async fn write(&self, id: &str, data: Vec<u8>) -> Result<(), TerminalError> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(TerminalError::InputTooLarge);
        }
        let session = self.session(id)?;
        tokio::task::spawn_blocking(move || {
            if session.stopped.load(Ordering::Acquire) || session.info.lock().unwrap().exited {
                return Err(TerminalError::Unavailable);
            }
            let mut guard = session.writer.lock().unwrap();
            let writer = guard.as_mut().ok_or(TerminalError::Unavailable)?;
            writer.write_all(&data).map_err(operation)?;
            writer.flush().map_err(operation)
        })
        .await
        .map_err(operation)?
    }
    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let dimensions = size(cols, rows)?;
        let session = self.session(id)?;
        tokio::task::spawn_blocking(move || {
            session
                .resources
                .lock()
                .unwrap()
                .as_ref()
                .ok_or(TerminalError::Unavailable)?
                .master
                .resize(dimensions)
                .map_err(operation)?;
            let mut info = session.info.lock().unwrap();
            info.cols = cols;
            info.rows = rows;
            Ok(())
        })
        .await
        .map_err(operation)?
    }
    /// Send the terminal's interrupt character, respecting terminal line discipline.
    pub async fn interrupt(&self, id: &str) -> Result<(), TerminalError> {
        self.write(id, vec![3]).await
    }
    /// Explicit close terminates the shell and its current foreground job.
    pub async fn close(&self, id: &str) -> Result<(), TerminalError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(id)
            .ok_or(TerminalError::Unavailable)?;
        tokio::task::spawn_blocking(move || session.stop())
            .await
            .map_err(operation)
    }
    pub async fn close_all(&self) -> Result<(), TerminalError> {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        tokio::task::spawn_blocking(move || {
            for session in sessions.values() {
                session.stop();
            }
        })
        .await
        .map_err(operation)
    }
    fn session(&self, id: &str) -> Result<Arc<Session>, TerminalError> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or(TerminalError::Unavailable)
    }
    fn resolve_cwd(&self, cwd: &Path) -> Result<PathBuf, TerminalError> {
        let path = if cwd.is_absolute() {
            cwd.to_owned()
        } else {
            self.workspace.join(cwd)
        };
        let path = path
            .canonicalize()
            .map_err(|_| TerminalError::InvalidDirectory)?;
        if !path.starts_with(&self.workspace) || !path.is_dir() {
            return Err(TerminalError::InvalidDirectory);
        }
        Ok(path)
    }
}
impl Drop for TerminalManager {
    fn drop(&mut self) {
        for session in self.sessions.get_mut().unwrap().values() {
            session.stop();
        }
    }
}
fn size(cols: u16, rows: u16) -> Result<PtySize, TerminalError> {
    if !(2..=1000).contains(&cols) || !(2..=1000).contains(&rows) {
        return Err(TerminalError::InvalidSize);
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}
fn operation(error: impl std::fmt::Display) -> TerminalError {
    TerminalError::Operation(error.to_string())
}

fn shell_program() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_file())
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"))
    }
    #[cfg(unix)]
    {
        std::env::var_os("SHELL")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_file())
            .or_else(|| {
                ["/bin/zsh", "/bin/bash", "/bin/sh"]
                    .into_iter()
                    .map(PathBuf::from)
                    .find(|p| p.is_file())
            })
            .unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
}
fn child_path() -> std::ffi::OsString {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(PathBuf::from(&home).join(".cargo/bin"));
            paths.push(PathBuf::from(home).join(".local/bin"));
        }
        for path in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            paths.push(PathBuf::from(path));
        }
    }
    paths.dedup();
    std::env::join_paths(paths).unwrap_or_default()
}
fn spawn(
    id: String,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    shell: PathBuf,
) -> Result<(Arc<Session>, mpsc::Receiver<TerminalEvent>), TerminalError> {
    let pair = native_pty_system()
        .openpty(size(cols, rows)?)
        .map_err(operation)?;
    let mut command = CommandBuilder::new(&shell);
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("PATH", child_path());
    #[cfg(unix)]
    command.arg("-i");
    // No shell command string or cwd interpolation is involved in starting a PTY.
    let mut reader = pair.master.try_clone_reader().map_err(operation)?;
    let writer = pair.master.take_writer().map_err(operation)?;
    let child = pair.slave.spawn_command(command).map_err(operation)?;
    drop(pair.slave);
    let info = TerminalInfo {
        id: id.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        shell: shell.to_string_lossy().into_owned(),
        cols,
        rows,
        process_id: child.process_id(),
        exit_code: None,
        exited: false,
    };
    let session = Arc::new(Session {
        info: Mutex::new(info),
        resources: Mutex::new(Some(Resources {
            master: pair.master,
        })),
        child: Mutex::new(child),
        writer: Mutex::new(Some(writer)),
        stopped: AtomicBool::new(false),
        scrollback: Mutex::new(VecDeque::with_capacity(SCROLLBACK_BYTES)),
    });
    let (tx, rx) = mpsc::channel(EVENT_CAPACITY);
    let output_session = Arc::clone(&session);
    let output_id = id.clone();
    let output_tx = tx.clone();
    thread::spawn(move || {
        let mut chunk = [0u8; CHUNK_BYTES];
        loop {
            if output_session.stopped.load(Ordering::Acquire) {
                break;
            }
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    let data = chunk[..count].to_vec();
                    {
                        let mut scrollback = output_session.scrollback.lock().unwrap();
                        scrollback.extend(data.iter().copied());
                        let excess = scrollback.len().saturating_sub(SCROLLBACK_BYTES);
                        scrollback.drain(..excess);
                    }
                    if !send_event(
                        &output_tx,
                        TerminalEvent::Output {
                            id: output_id.clone(),
                            data,
                        },
                        &output_session,
                    ) {
                        break;
                    }
                }
                Err(error) => {
                    // Unix PTYs commonly return EIO when the last slave closes.
                    if !output_session.stopped.load(Ordering::Acquire)
                        && error.raw_os_error() != Some(5)
                    {
                        send_event(
                            &output_tx,
                            TerminalEvent::Error {
                                id: output_id.clone(),
                                message: error.to_string(),
                            },
                            &output_session,
                        );
                    }
                    break;
                }
            }
        }
    });
    let status_session = Arc::clone(&session);
    thread::spawn(move || loop {
        let result = status_session.child.lock().unwrap().try_wait();
        match result {
            Ok(Some(status)) => {
                {
                    let mut info = status_session.info.lock().unwrap();
                    info.exited = true;
                    info.exit_code = Some(status.exit_code());
                }
                send_event(
                    &tx,
                    TerminalEvent::Exit {
                        id,
                        code: Some(status.exit_code()),
                    },
                    &status_session,
                );
                break;
            }
            Err(error) => {
                send_event(
                    &tx,
                    TerminalEvent::Error {
                        id,
                        message: error.to_string(),
                    },
                    &status_session,
                );
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
        }
    });
    Ok((session, rx))
}
fn send_event(
    tx: &mpsc::Sender<TerminalEvent>,
    mut event: TerminalEvent,
    session: &Session,
) -> bool {
    loop {
        match tx.try_send(event) {
            Ok(()) => return true,
            Err(mpsc::error::TrySendError::Closed(_)) => return false,
            Err(mpsc::error::TrySendError::Full(returned)) => {
                if session.stopped.load(Ordering::Acquire) {
                    return false;
                }
                event = returned;
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::time::timeout;
    #[cfg(unix)]
    use tokio::time::Instant;

    async fn output_until(rx: &mut mpsc::Receiver<TerminalEvent>, needle: &str) -> String {
        timeout(Duration::from_secs(10), async {
            let mut output = Vec::new();
            while let Some(event) = rx.recv().await {
                if let TerminalEvent::Output { data, .. } = event {
                    output.extend(data);
                }
                if String::from_utf8_lossy(&output).contains(needle) {
                    return String::from_utf8_lossy(&output).into_owned();
                }
            }
            panic!(
                "PTY ended before expected output: {}",
                String::from_utf8_lossy(&output)
            );
        })
        .await
        .expect("PTY output timed out")
    }

    #[tokio::test]
    async fn real_shell_roundtrips_unicode_and_resizes() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let (info, mut rx) = manager.create(".", 80, 24).await.unwrap();
        #[cfg(unix)]
        let input = "printf 'SPAN_RESULT:%s\\n' '日本語🌱'\r";
        #[cfg(windows)]
        let input = "chcp 65001 >nul\rset SPAN_TEST=日本語🌱\recho SPAN_RESULT:%SPAN_TEST%\r";
        manager
            .write(&info.id, input.as_bytes().to_vec())
            .await
            .unwrap();
        let output = output_until(&mut rx, "SPAN_RESULT:日本語🌱").await;
        assert!(output.contains("SPAN_RESULT:日本語🌱"));
        manager.resize(&info.id, 113, 37).await.unwrap();
        let session = manager.session(&info.id).unwrap();
        let actual = session
            .resources
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .master
            .get_size()
            .unwrap();
        assert_eq!((actual.cols, actual.rows), (113, 37));
        manager.close(&info.id).await.unwrap();
        assert!(manager.list().is_empty());
    }

    #[tokio::test]
    async fn rejects_cwd_escape_invalid_size_and_invalid_executable() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        assert!(matches!(
            manager.create(outside.path(), 80, 24).await,
            Err(TerminalError::InvalidDirectory)
        ));
        assert!(matches!(
            manager.create(".", 0, 24).await,
            Err(TerminalError::InvalidSize)
        ));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
            assert!(matches!(
                manager.create("escape", 80, 24).await,
                Err(TerminalError::InvalidDirectory)
            ));
        }
        let invalid = root.path().join("missing-program");
        assert!(spawn("failure".into(), root.path().to_owned(), 80, 24, invalid).is_err());
        assert!(manager.list().is_empty());
    }

    #[tokio::test]
    async fn reports_nonzero_exit_and_rejects_input_after_exit() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let (info, mut rx) = manager.create(".", 80, 24).await.unwrap();
        #[cfg(unix)]
        let input = b"exit 7\r".to_vec();
        #[cfg(windows)]
        let input = b"exit /b 7\r".to_vec();
        manager.write(&info.id, input).await.unwrap();
        let code = timeout(Duration::from_secs(10), async {
            while let Some(event) = rx.recv().await {
                if let TerminalEvent::Exit { code, .. } = event {
                    return code;
                }
            }
            panic!("Exit event missing");
        })
        .await
        .unwrap();
        assert_eq!(code, Some(7));
        assert!(matches!(
            manager.write(&info.id, b"x".to_vec()).await,
            Err(TerminalError::Unavailable)
        ));
        manager.close_all().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn interrupt_reaches_foreground_job_and_shell_stays_usable() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let (info, mut rx) = manager.create(".", 80, 24).await.unwrap();
        manager
            .write(&info.id, b"sleep 30\r".to_vec())
            .await
            .unwrap();
        wait_foreground(&manager, &info.id).await;
        manager.interrupt(&info.id).await.unwrap();
        manager
            .write(&info.id, b"printf 'AFTER_%s\\n' 'INTERRUPT'\r".to_vec())
            .await
            .unwrap();
        output_until(&mut rx, "AFTER_INTERRUPT").await;
        assert!(!manager.list()[0].exited);
        manager.close_all().await.unwrap();
    }

    #[cfg(unix)]
    async fn wait_foreground(manager: &TerminalManager, id: &str) -> i32 {
        timeout(Duration::from_secs(5), async {
            loop {
                let session = manager.session(id).unwrap();
                let foreground = {
                    let resources = session.resources.lock().unwrap();
                    let master = &resources.as_ref().unwrap().master;
                    unsafe { libc::tcgetpgrp(master.as_raw_fd().unwrap()) }
                };
                if foreground > 0
                    && Some(foreground as u32) != session.info.lock().unwrap().process_id
                {
                    return foreground;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Foreground job failed to start")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn close_and_manager_drop_terminate_owned_foreground_jobs() {
        for explicit in [true, false] {
            let root = TempDir::new().unwrap();
            let manager = TerminalManager::new(root.path()).unwrap();
            let (info, _rx) = manager.create(".", 80, 24).await.unwrap();
            manager
                .write(&info.id, b"sleep 30\r".to_vec())
                .await
                .unwrap();
            let foreground = wait_foreground(&manager, &info.id).await;
            if explicit {
                manager.close(&info.id).await.unwrap();
            }
            drop(manager);
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let alive = unsafe { libc::kill(-foreground, 0) == 0 };
                if !alive {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "Owned foreground process group leaked"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bounds_scrollback_and_closes_under_output_backpressure() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let (info, mut rx) = manager.create(".", 80, 24).await.unwrap();
        manager
            .write(
                &info.id,
                b"head -c 400000 /dev/zero | tr '\\000' x; printf 'DONE_%s\\n' 'OUTPUT'\r".to_vec(),
            )
            .await
            .unwrap();
        output_until(&mut rx, "DONE_OUTPUT").await;
        assert_eq!(
            manager.scrollback(&info.id).unwrap().len(),
            SCROLLBACK_BYTES
        );
        manager.write(&info.id, b"yes\r".to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        timeout(Duration::from_secs(5), manager.close(&info.id))
            .await
            .unwrap()
            .unwrap();
    }
}
