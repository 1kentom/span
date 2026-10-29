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
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};
use tokio::sync::mpsc;

mod profiles;
use profiles::{selected_profile, shell_program};
#[cfg(unix)]
mod shell_integration;
pub use profiles::{terminal_profiles, TerminalProfile, TerminalProfileKind};

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

/// Explicit Markdown execution languages. Source is passed as one argv value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TerminalCommandLanguage {
    Bash,
    Sh,
    Zsh,
    Shell,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { id: String, data: Vec<u8> },
    Exit { id: String, code: Option<u32> },
    Error { id: String, message: String },
}

enum TerminalLaunch {
    Interactive(TerminalProfileKind),
    Command(TerminalCommandLanguage, String),
}

struct Resources {
    _integration: Option<tempfile::TempDir>,
    master: Box<dyn MasterPty + Send>,
    #[cfg(windows)]
    _job: WindowsJob,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    unix_session_id: Option<libc::pid_t>,
}

#[cfg(windows)]
struct WindowsJob(usize);

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE terminates the shell and every
        // descendant still assigned to this session when the handle closes.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
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
        let mut child = recover_lock(&self.child);
        let running = matches!(child.try_wait(), Ok(None));
        // Kill the current foreground job as well as the shell's process group.
        // Interactive shells give each foreground pipeline its own group.
        #[cfg(unix)]
        if let Some(resources) = recover_lock(&self.resources).as_ref() {
            if let Some(fd) = resources.master.as_raw_fd() {
                // portable-pty's writer destructor sends EOF. A full echo buffer
                // must not turn that final write into a blocking shutdown.
                if let Err(error) = prepare_unix_close(fd) {
                    eprintln!("Could not prepare closing PTY: {error}");
                }
                unsafe {
                    #[cfg(any(target_os = "linux", target_os = "macos"))]
                    if let Some(session_id) = resources.unix_session_id {
                        // The still-owned PTY must identify the recorded session.
                        // An exited shell's numeric PID alone is not an identity.
                        if libc::tcgetsid(fd) == session_id {
                            terminate_unix_session(session_id);
                        }
                    }
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
        recover_lock(&self.resources).take();
        recover_lock(&self.writer).take();
        let _ = child.wait();
    }
}

#[cfg(unix)]
fn prepare_unix_close(fd: std::os::fd::RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn recover_lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn checked_lock<'a, T>(
    mutex: &'a Mutex<T>,
    name: &str,
) -> Result<MutexGuard<'a, T>, TerminalError> {
    mutex
        .lock()
        .map_err(|_| operation(format!("{name} lock is poisoned")))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn record_unix_session_id(child_pid: Option<u32>) -> Option<libc::pid_t> {
    let child_pid = libc::pid_t::try_from(child_pid?).ok()?;
    let session_id = unsafe { libc::getsid(child_pid) };
    let current_session_id = unsafe { libc::getsid(0) };
    if session_id == child_pid
        && session_id > 0
        && current_session_id > 0
        && session_id != current_session_id
    {
        Some(session_id)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn process_ids() -> Vec<libc::pid_t> {
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<libc::pid_t>().ok())
        .filter(|pid| *pid > 0)
        .collect()
}

#[cfg(target_os = "macos")]
fn process_ids() -> Vec<libc::pid_t> {
    use std::{ffi::c_void, mem::size_of, ptr};

    let count = unsafe { libc::proc_listallpids(ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let capacity = (count as usize).saturating_add(128).min(131_072);
    let mut pids = vec![0; capacity];
    let buffer_bytes = capacity.saturating_mul(size_of::<libc::pid_t>());
    let buffer_bytes = buffer_bytes.min(libc::c_int::MAX as usize) as libc::c_int;
    let listed =
        unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), buffer_bytes) };
    if listed <= 0 {
        return Vec::new();
    }
    pids.truncate((listed as usize).min(capacity));
    pids.into_iter().filter(|pid| *pid > 0).collect()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn terminate_unix_session(session_id: libc::pid_t) {
    let current_session_id = unsafe { libc::getsid(0) };
    if session_id <= 0 || session_id == current_session_id {
        return;
    }

    // Kill every process in the PTY's private session, repeating the scan
    // briefly to catch children forked while an earlier pass was in progress.
    for _ in 0..8 {
        let mut found_member = false;
        for pid in process_ids() {
            if pid <= 0 || unsafe { libc::getsid(pid) } != session_id {
                continue;
            }
            found_member = true;
            // Recheck immediately before signaling so a recycled PID cannot
            // redirect cleanup into an unrelated process session.
            if unsafe { libc::getsid(pid) } == session_id {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
        if !found_member {
            break;
        }
        thread::sleep(Duration::from_millis(5));
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
        self.create_with_profile(cwd, cols, rows, None).await
    }

    pub async fn create_with_profile(
        &self,
        cwd: impl AsRef<Path>,
        cols: u16,
        rows: u16,
        profile_id: Option<&str>,
    ) -> Result<(TerminalInfo, mpsc::Receiver<TerminalEvent>), TerminalError> {
        let (shell, kind) = match profile_id {
            Some(id) => {
                let profile = selected_profile(id)?;
                (PathBuf::from(profile.path), profile.kind)
            }
            None => (shell_program(), TerminalProfileKind::Shell),
        };
        self.create_process(
            cwd.as_ref(),
            cols,
            rows,
            shell,
            TerminalLaunch::Interactive(kind),
        )
        .await
    }

    /// Execute one explicitly requested snippet in a fresh PTY. Non-interactive
    /// parsing keeps multiline source atomic and avoids prompt/paste behavior.
    pub async fn create_command(
        &self,
        language: TerminalCommandLanguage,
        code: String,
        expected_workspace_root: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<(TerminalInfo, mpsc::Receiver<TerminalEvent>), TerminalError> {
        if code.len() > 64 * 1024 || code.contains('\0') {
            return Err(operation(
                "Terminal command must be at most 64 KiB and contain no NUL bytes",
            ));
        }
        if !expected_workspace_root.is_absolute()
            || expected_workspace_root.canonicalize().ok().as_ref() != Some(&self.workspace)
        {
            return Err(operation(
                "The workspace changed before the command could start",
            ));
        }
        let shell = match language {
            TerminalCommandLanguage::Shell => shell_program(),
            explicit => {
                let name = match explicit {
                    TerminalCommandLanguage::Bash => "bash",
                    TerminalCommandLanguage::Sh => "sh",
                    TerminalCommandLanguage::Zsh => "zsh",
                    TerminalCommandLanguage::Shell => unreachable!(),
                };
                terminal_profiles().into_iter().find(|profile| profile.name == name)
                    .map(|profile| PathBuf::from(profile.path))
                    .ok_or_else(|| operation(format!("The {name} interpreter is not installed. Choose Send to review this snippet in your terminal.")))?
            }
        };
        self.create_process(
            &self.workspace,
            cols,
            rows,
            shell,
            TerminalLaunch::Command(language, code),
        )
        .await
    }

    async fn create_process(
        &self,
        cwd: &Path,
        cols: u16,
        rows: u16,
        shell: PathBuf,
        command: TerminalLaunch,
    ) -> Result<(TerminalInfo, mpsc::Receiver<TerminalEvent>), TerminalError> {
        let cwd = self.resolve_cwd(cwd)?;
        size(cols, rows)?;
        if checked_lock(&self.sessions, "terminal sessions")?.len() >= MAX_SESSIONS {
            return Err(TerminalError::SessionLimit);
        }
        let id = format!("terminal-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        // PTY allocation and process spawning happen on Tokio's blocking pool.
        let (session, rx) =
            tokio::task::spawn_blocking(move || spawn_process(id, cwd, cols, rows, shell, command))
                .await
                .map_err(operation)??;
        let info = match checked_lock(&session.info, "terminal session info") {
            Ok(info) => info.clone(),
            Err(error) => {
                session.stop();
                return Err(error);
            }
        };
        let mut sessions = match checked_lock(&self.sessions, "terminal sessions") {
            Ok(sessions) => sessions,
            Err(error) => {
                session.stop();
                return Err(error);
            }
        };
        if sessions.len() >= MAX_SESSIONS {
            session.stop();
            return Err(TerminalError::SessionLimit);
        }
        sessions.insert(info.id.clone(), session);
        Ok((info, rx))
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        recover_lock(&self.sessions)
            .values()
            .map(|s| recover_lock(&s.info).clone())
            .collect()
    }
    pub fn scrollback(&self, id: &str) -> Result<Vec<u8>, TerminalError> {
        let session = self.session(id)?;
        let bytes = checked_lock(&session.scrollback, "terminal scrollback")?
            .iter()
            .copied()
            .collect();
        Ok(bytes)
    }
    pub async fn write(&self, id: &str, data: Vec<u8>) -> Result<(), TerminalError> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(TerminalError::InputTooLarge);
        }
        let session = self.session(id)?;
        tokio::task::spawn_blocking(move || {
            if session.stopped.load(Ordering::Acquire)
                || checked_lock(&session.info, "terminal session info")?.exited
            {
                return Err(TerminalError::Unavailable);
            }
            let mut guard = checked_lock(&session.writer, "terminal writer")?;
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
            let resources = checked_lock(&session.resources, "terminal resources")?;
            let resources = resources.as_ref().ok_or(TerminalError::Unavailable)?;
            let mut info = checked_lock(&session.info, "terminal session info")?;
            // Repeated layout/appearance observers must not send duplicate
            // SIGWINCH notifications and redraw an unchanged shell prompt.
            if info.cols == cols && info.rows == rows {
                return Ok(());
            }
            resources.master.resize(dimensions).map_err(operation)?;
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
        self.close_with_notify(id, || {}).await
    }
    /// Notify the event bridge after accepting close, before waiting for cleanup.
    /// A rejected close leaves output delivery active; an accepted close can
    /// release a consumer acknowledgement that would otherwise block PTY EOF.
    pub async fn close_with_notify(
        &self,
        id: &str,
        accepted: impl FnOnce() + Send,
    ) -> Result<(), TerminalError> {
        let session = checked_lock(&self.sessions, "terminal sessions")?
            .remove(id)
            .ok_or(TerminalError::Unavailable)?;
        accepted();
        tokio::task::spawn_blocking(move || session.stop())
            .await
            .map_err(operation)
    }
    pub async fn close_all(&self) -> Result<(), TerminalError> {
        let sessions = std::mem::take(&mut *checked_lock(&self.sessions, "terminal sessions")?);
        tokio::task::spawn_blocking(move || {
            for session in sessions.values() {
                session.stop();
            }
        })
        .await
        .map_err(operation)
    }
    fn session(&self, id: &str) -> Result<Arc<Session>, TerminalError> {
        checked_lock(&self.sessions, "terminal sessions")?
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
        let sessions = match self.sessions.get_mut() {
            Ok(sessions) => sessions,
            Err(poisoned) => poisoned.into_inner(),
        };
        for session in sessions.values() {
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

#[cfg(windows)]
fn create_windows_job(child: &dyn Child) -> Result<WindowsJob, TerminalError> {
    use std::{ffi::c_void, mem::size_of, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    unsafe {
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return Err(operation(std::io::Error::from_raw_os_error(
                GetLastError() as i32
            )));
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            let error = std::io::Error::from_raw_os_error(GetLastError() as i32);
            CloseHandle(job);
            return Err(operation(error));
        }

        let Some(process) = child.as_raw_handle() else {
            CloseHandle(job);
            return Err(operation("PTY child did not expose a process handle"));
        };
        if AssignProcessToJobObject(job, process as _) == 0 {
            let error = std::io::Error::from_raw_os_error(GetLastError() as i32);
            CloseHandle(job);
            return Err(operation(error));
        }
        Ok(WindowsJob(job as usize))
    }
}

fn child_path() -> std::ffi::OsString {
    let mut paths: Vec<PathBuf> = match std::env::var_os("PATH") {
        Some(path) => std::env::split_paths(&path).collect(),
        None => Vec::new(),
    };
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
    match std::env::join_paths(paths) {
        Ok(paths) => paths,
        Err(_) => std::ffi::OsString::new(),
    }
}
#[cfg(test)]
fn spawn(
    id: String,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    shell: PathBuf,
) -> Result<(Arc<Session>, mpsc::Receiver<TerminalEvent>), TerminalError> {
    spawn_process(
        id,
        cwd,
        cols,
        rows,
        shell,
        TerminalLaunch::Interactive(TerminalProfileKind::Shell),
    )
}

fn spawn_process(
    id: String,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    shell: PathBuf,
    source: TerminalLaunch,
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
    let mut integration = None;
    #[cfg(windows)]
    let integration = None;
    if let TerminalLaunch::Command(language, code) = source {
        #[cfg(windows)]
        let is_cmd = shell
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("cmd"));
        #[cfg(windows)]
        if is_cmd {
            command.args(["/D", "/S", "/C"]);
            command.arg(code);
        } else {
            if language == TerminalCommandLanguage::Bash {
                command.args(["--noprofile", "--norc"]);
            }
            command.arg("-c");
            command.arg(code);
        }
        #[cfg(unix)]
        {
            if language == TerminalCommandLanguage::Bash {
                command.args(["--noprofile", "--norc"]);
            }
            command.arg("-c");
            command.arg(code);
        }
    } else if let TerminalLaunch::Interactive(kind) = source {
        match kind {
            TerminalProfileKind::Node => {
                command.arg("--interactive");
            }
            TerminalProfileKind::Python => {
                command.arg("-i");
            }
            TerminalProfileKind::Shell => {
                #[cfg(unix)]
                {
                    integration = shell_integration::configure(&mut command, &shell)?;
                }
            }
        }
    }
    // The executable, cwd, and optional source argv are passed separately.
    let mut reader = pair.master.try_clone_reader().map_err(operation)?;
    let writer = pair.master.take_writer().map_err(operation)?;
    let child = pair.slave.spawn_command(command).map_err(operation)?;
    #[cfg(windows)]
    let mut child = child;
    drop(pair.slave);
    #[cfg(windows)]
    let job = match create_windows_job(child.as_ref()) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let process_id = child.process_id();
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let unix_session_id = record_unix_session_id(process_id);
    let info = TerminalInfo {
        id: id.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        shell: shell.to_string_lossy().into_owned(),
        cols,
        rows,
        process_id,
        exit_code: None,
        exited: false,
    };
    let session = Arc::new(Session {
        info: Mutex::new(info),
        resources: Mutex::new(Some(Resources {
            _integration: integration,
            master: pair.master,
            #[cfg(windows)]
            _job: job,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            unix_session_id,
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
    let output_done = Arc::new(AtomicBool::new(false));
    let output_done_thread = Arc::clone(&output_done);
    thread::Builder::new()
        .name(format!("span-terminal-output-{output_id}"))
        .spawn(move || {
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
                            let mut scrollback = recover_lock(&output_session.scrollback);
                            let excess = scrollback
                                .len()
                                .saturating_add(data.len())
                                .saturating_sub(SCROLLBACK_BYTES);
                            let existing_excess = excess.min(scrollback.len());
                            scrollback.drain(..existing_excess);
                            let incoming_skip = excess.saturating_sub(existing_excess);
                            scrollback.extend(data.iter().skip(incoming_skip).copied());
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
            output_done_thread.store(true, Ordering::Release);
        })
        .map_err(operation)?;
    let status_session = Arc::clone(&session);
    let status_thread = thread::Builder::new()
        .name(format!("span-terminal-status-{id}"))
        .spawn(move || {
            loop {
                let result = recover_lock(&status_session.child).try_wait();
                match result {
                    Ok(Some(status)) => {
                        #[cfg(windows)]
                        {
                            {
                                let mut info = recover_lock(&status_session.info);
                                info.exited = true;
                                info.exit_code = Some(status.exit_code());
                            }
                            // ConPTY owns its output pipe until the master closes.
                            // Close it on this thread while the reader drains the
                            // final output. Waiting for EOF first is a circular wait.
                            let resources = {
                                let mut resources = recover_lock(&status_session.resources);
                                resources.take()
                            };
                            drop(resources);
                        }
                        // EOF from the PTY reader is the ordering barrier: it means all
                        // final output chunks have already entered the bounded queue.
                        while !output_done.load(Ordering::Acquire) {
                            thread::sleep(Duration::from_millis(5));
                        }
                        {
                            let mut info = recover_lock(&status_session.info);
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
            }
        });
    if let Err(error) = status_thread {
        session.stop();
        return Err(operation(error));
    }
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

    #[cfg(unix)]
    #[test]
    fn closing_writer_does_not_block_on_a_full_terminal_output_buffer() {
        use std::os::unix::fs::OpenOptionsExt;
        let pair = native_pty_system().openpty(size(80, 24).unwrap()).unwrap();
        let fd = pair.master.as_raw_fd().unwrap();
        let mut slave_output = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(pair.master.tty_name().unwrap())
            .unwrap();
        let mut written = 0;
        loop {
            match slave_output.write(&[b'x'; 8192]) {
                Ok(0) => break,
                Ok(count) => {
                    written += count;
                    assert!(written <= 1024 * 1024, "PTY output must be bounded");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("Fill terminal output: {error}"),
            }
        }
        assert!(written > 0);
        let writer = pair.master.take_writer().unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        prepare_unix_close(fd).unwrap();
        let (done, finished) = std::sync::mpsc::channel();
        let thread = thread::spawn(move || {
            drop(writer);
            let _ = done.send(());
        });
        let prompt_close = finished.recv_timeout(Duration::from_secs(1)).is_ok();
        // Release the owned native fixture even if the assertion would fail.
        let mut bytes = [0; 8192];
        while reader.read(&mut bytes).is_ok_and(|count| count > 0) {}
        drop(slave_output);
        drop(pair.slave);
        drop(reader);
        drop(pair.master);
        thread.join().unwrap();
        assert!(
            prompt_close,
            "Writer destructor blocked behind terminal output"
        );
    }

    async fn output_until(rx: &mut mpsc::Receiver<TerminalEvent>, needle: &str) -> String {
        let mut output = Vec::new();
        let result = timeout(Duration::from_secs(10), async {
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
        .await;
        match result {
            Ok(output) => output,
            Err(_) => panic!(
                "PTY output timed out waiting for {needle:?}; last output: {:?}",
                String::from_utf8_lossy(&output[output.len().saturating_sub(4096)..])
            ),
        }
    }

    async fn create_test_terminal(
        manager: &TerminalManager,
    ) -> (TerminalInfo, mpsc::Receiver<TerminalEvent>) {
        let (info, receiver) = manager.create(".", 80, 24).await.unwrap();
        #[cfg(windows)]
        let mut receiver = receiver;
        #[cfg(windows)]
        {
            // ConPTY cursor inheritance requires a renderer reply before input.
            output_until(&mut receiver, "\x1b[6n").await;
            manager
                .write(&info.id, b"\x1b[1;1R".to_vec())
                .await
                .unwrap();
            manager
                .write(
                    &info.id,
                    b"chcp 65001 >nul & echo SPAN_UTF8_R^E^A^D^Y\r".to_vec(),
                )
                .await
                .unwrap();
            output_until(&mut receiver, "SPAN_UTF8_READY").await;
        }
        (info, receiver)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_runs_multiline_bash_atomically_and_delivers_output_before_exit() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let code = "values=(first '日本語🌱')\nfor value in \"${values[@]}\"; do\n  printf 'SPAN_ATOMIC:%s\\n' \"$value\"\ndone\ncat <<'SPAN_LITERAL'\n$(this is literal); 'quotes' \"double\"\nSPAN_LITERAL\nprintf 'CWD:%s\\n' \"$PWD\"\nexit 7";
        let (info, mut rx) = manager
            .create_command(
                TerminalCommandLanguage::Bash,
                code.to_owned(),
                root.path(),
                80,
                24,
            )
            .await
            .unwrap();
        assert_eq!(Path::new(&info.shell).file_stem().unwrap(), "bash");
        let (output, exit) = timeout(Duration::from_secs(10), async {
            let mut output = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    TerminalEvent::Output { data, .. } => output.extend(data),
                    TerminalEvent::Exit { code, .. } => {
                        return (String::from_utf8(output).unwrap(), code)
                    }
                    TerminalEvent::Error { message, .. } => panic!("{message}"),
                }
            }
            panic!("Missing command exit");
        })
        .await
        .unwrap();
        assert_eq!(exit, Some(7));
        assert!(output.contains("SPAN_ATOMIC:first"));
        assert!(output.contains("SPAN_ATOMIC:日本語🌱"));
        assert!(output.contains("$(this is literal); 'quotes' \"double\""));
        assert!(output.contains(&format!(
            "CWD:{}",
            root.path().canonicalize().unwrap().display()
        )));
        assert!(
            !output.contains("for value"),
            "Source must not be echoed as terminal input"
        );
        manager.close(&info.id).await.unwrap();
    }

    #[tokio::test]
    async fn command_validation_rejects_stale_roots_oversized_source_and_nul_without_spawning() {
        let root = TempDir::new().unwrap();
        let other = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        for (code, expected_root) in [
            ("echo stale".to_owned(), other.path()),
            ("echo relative".to_owned(), Path::new(".")),
            ("x".repeat(64 * 1024 + 1), root.path()),
            ("echo\0nul".to_owned(), root.path()),
        ] {
            assert!(manager
                .create_command(TerminalCommandLanguage::Shell, code, expected_root, 80, 24)
                .await
                .is_err());
            assert!(manager.list().is_empty());
        }
        assert!(manager
            .create_with_profile(".", 80, 24, Some("shell:/not-installed"))
            .await
            .is_err());
        assert!(manager.list().is_empty());
    }

    #[tokio::test]
    async fn selected_profile_launches_the_reported_shell() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let profiles = terminal_profiles();
        let profile = profiles
            .iter()
            .find(|profile| profile.is_default)
            .expect("A default executable shell is installed");
        let (info, _receiver) = manager
            .create_with_profile(".", 80, 24, Some(&profile.id))
            .await
            .unwrap();
        assert_eq!(info.shell, profile.path);
        manager.close(&info.id).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn compact_real_zsh_prompt_has_one_redraw_per_enter_and_changed_size() {
        let Some(profile) = terminal_profiles()
            .into_iter()
            .find(|profile| profile.name == "zsh")
        else {
            return;
        };
        let root = TempDir::new().unwrap();
        let workspace = root.path().join("span-prompt-fixture");
        std::fs::create_dir(&workspace).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q", "--initial-branch", "span-main"])
            .arg(&workspace)
            .status()
            .unwrap()
            .success());
        let manager = TerminalManager::new(&workspace).unwrap();
        let (info, mut rx) = manager
            .create_with_profile(".", 80, 24, Some(&profile.id))
            .await
            .unwrap();
        let initial = output_until(&mut rx, "git:(span-main)").await;
        assert!(initial.contains("span-prompt-fixture"), "{initial}");
        manager.write(&info.id, b"\r".to_vec()).await.unwrap();
        let next = output_until(&mut rx, "git:(span-main)").await;
        assert_eq!(
            next.matches('→').count(),
            1,
            "Enter printed repeated managed prompts: {next}"
        );
        assert!(
            !next.contains(&workspace.to_string_lossy().to_string()),
            "Prompt printed full workspace path: {next}"
        );
        for _ in 0..20 {
            manager.resize(&info.id, 80, 24).await.unwrap();
        }
        let mut redundant_output = Vec::new();
        while let Ok(Some(event)) = timeout(Duration::from_millis(150), rx.recv()).await {
            if let TerminalEvent::Output { data, .. } = event {
                redundant_output.extend(data);
            }
        }
        let redundant_output = String::from_utf8_lossy(&redundant_output);
        assert!(
            !redundant_output.contains('→'),
            "Unchanged size redrew the prompt: {redundant_output}"
        );
        manager.resize(&info.id, 90, 30).await.unwrap();
        let resized = output_until(&mut rx, "git:(span-main)").await;
        assert_eq!(
            resized.matches('→').count(),
            1,
            "Changed size printed repeated prompts: {resized}"
        );
        manager.close(&info.id).await.unwrap();
    }

    #[tokio::test]
    async fn real_shell_roundtrips_unicode_and_resizes() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let (info, mut rx) = create_test_terminal(&manager).await;
        #[cfg(unix)]
        let input = "printf 'SPAN_RESULT:%s\\n' '日本語🌱'\r";
        #[cfg(windows)]
        let input = "set SPAN_TEST=日本語🌱\recho SPAN_RESULT:%SPAN_TEST%\r";
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
        let (info, mut rx) = create_test_terminal(&manager).await;
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

    #[tokio::test]
    async fn final_output_is_delivered_before_exit_event() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let (info, mut rx) = create_test_terminal(&manager).await;
        #[cfg(unix)]
        let input = b"printf 'FINAL_OUTPUT_SENTINEL\\n'; exit 0\r".to_vec();
        #[cfg(windows)]
        let input = b"echo FINAL_OUTPUT_SENTINEL & exit /b 0\r".to_vec();
        manager.write(&info.id, input).await.unwrap();

        let saw_final_output_before_exit = timeout(Duration::from_secs(10), async {
            let mut output = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    TerminalEvent::Output { data, .. } => output.extend(data),
                    TerminalEvent::Exit { .. } => {
                        return String::from_utf8_lossy(&output).contains("FINAL_OUTPUT_SENTINEL");
                    }
                    TerminalEvent::Error { .. } => {}
                }
            }
            false
        })
        .await
        .expect("PTY exit event timed out");
        assert!(saw_final_output_before_exit);
    }

    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    async fn start_background_sleep(
        manager: &TerminalManager,
    ) -> (TerminalInfo, BackgroundProcessGuard) {
        let (info, mut rx) = manager.create(".", 80, 24).await.unwrap();
        let shell_pid = info.process_id.unwrap() as libc::pid_t;
        let session_id = unsafe { libc::getsid(shell_pid) };
        assert!(session_id > 0);
        assert_ne!(session_id, unsafe { libc::getsid(0) });
        let pid_file = manager
            .workspace
            .join(format!("{}-background.pid", info.id));
        let pid_file_name = pid_file.file_name().unwrap().to_string_lossy().into_owned();
        let mut guard = BackgroundProcessGuard {
            pid: None,
            session_id,
            pid_file,
        };
        manager
            .write(
                &info.id,
                format!("sleep 60 & echo $! > {pid_file_name}; echo BG_PID:$!\r").into_bytes(),
            )
            .await
            .unwrap();

        let background_pid = timeout(Duration::from_secs(10), async {
            let mut output = Vec::new();
            while let Some(event) = rx.recv().await {
                if let TerminalEvent::Output { data, .. } = event {
                    output.extend(data);
                    let mut remaining = output.as_slice();
                    while let Some(start) = remaining
                        .windows(b"BG_PID:".len())
                        .position(|window| window == b"BG_PID:")
                    {
                        let after_marker = &remaining[start + b"BG_PID:".len()..];
                        let digits = after_marker
                            .iter()
                            .take_while(|byte| byte.is_ascii_digit())
                            .copied()
                            .collect::<Vec<_>>();
                        if !digits.is_empty() {
                            if let Ok(pid) =
                                std::str::from_utf8(&digits).unwrap().parse::<libc::pid_t>()
                            {
                                return pid;
                            }
                        }
                        remaining = after_marker;
                    }
                }
            }
            panic!("PTY ended before reporting the background child PID");
        })
        .await
        .expect("background child PID timed out");
        assert!(unsafe { libc::getsid(background_pid) } > 0);
        guard.pid = Some(background_pid);
        (info, guard)
    }

    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    async fn wait_for_process_to_leave_session(pid: libc::pid_t, session_id: libc::pid_t) {
        timeout(Duration::from_secs(5), async {
            loop {
                if unsafe { libc::getsid(pid) } != session_id {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("background child remained in the terminal session");
    }

    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    struct BackgroundProcessGuard {
        pid: Option<libc::pid_t>,
        session_id: libc::pid_t,
        pid_file: PathBuf,
    }

    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    impl Drop for BackgroundProcessGuard {
        fn drop(&mut self) {
            let pid = self.pid.or_else(|| {
                std::fs::read_to_string(&self.pid_file)
                    .ok()?
                    .trim()
                    .parse::<libc::pid_t>()
                    .ok()
            });
            if let Some(pid) = pid {
                if unsafe { libc::getsid(pid) } == self.session_id {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
            let _ = std::fs::remove_file(&self.pid_file);
        }
    }

    #[cfg(all(unix, any(target_os = "linux", target_os = "macos")))]
    #[tokio::test]
    async fn close_and_manager_drop_kill_background_jobs() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let (info, first_guard) = start_background_sleep(&manager).await;
        manager.close(&info.id).await.unwrap();
        wait_for_process_to_leave_session(first_guard.pid.unwrap(), first_guard.session_id).await;

        let (info, second_guard) = start_background_sleep(&manager).await;
        drop(manager);
        wait_for_process_to_leave_session(second_guard.pid.unwrap(), second_guard.session_id).await;
        drop(info);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn interrupt_reaches_foreground_job_and_shell_stays_usable() {
        let root = TempDir::new().unwrap();
        let manager = TerminalManager::new(root.path()).unwrap();
        let (info, mut rx) = manager.create(".", 80, 24).await.unwrap();
        manager
            .write(&info.id, b"printf 'SHELL_%s\\n' 'READY'\r".to_vec())
            .await
            .unwrap();
        output_until(&mut rx, "SHELL_READY").await;
        wait_shell_foreground(&manager, &info.id).await;
        manager
            .write(&info.id, b"sleep 30\r".to_vec())
            .await
            .unwrap();
        wait_foreground(&manager, &info.id).await;
        manager.interrupt(&info.id).await.unwrap();
        // Queuing ETX does not mean the shell has completed signal handling.
        // Wait for foreground ownership before writing input that ISIG may flush.
        wait_shell_foreground(&manager, &info.id).await;
        manager
            .write(&info.id, b"printf 'AFTER_%s\\n' 'INTERRUPT'\r".to_vec())
            .await
            .unwrap();
        output_until(&mut rx, "AFTER_INTERRUPT").await;
        assert!(!manager.list()[0].exited);
        manager.close_all().await.unwrap();
    }

    #[cfg(unix)]
    async fn wait_shell_foreground(manager: &TerminalManager, id: &str) {
        timeout(Duration::from_secs(5), async {
            loop {
                let session = manager.session(id).unwrap();
                let shell_pid = session.info.lock().unwrap().process_id.unwrap();
                let foreground = {
                    let resources = session.resources.lock().unwrap();
                    let master = &resources.as_ref().unwrap().master;
                    unsafe { libc::tcgetpgrp(master.as_raw_fd().unwrap()) }
                };
                if foreground > 0 && foreground as u32 == shell_pid {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Shell failed to regain terminal foreground ownership");
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
        let session = manager.session(&info.id).unwrap();
        assert!(recover_lock(&session.scrollback).capacity() <= SCROLLBACK_BYTES);
        manager.write(&info.id, b"yes\r".to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        timeout(Duration::from_secs(5), manager.close(&info.id))
            .await
            .unwrap()
            .unwrap();
    }
}
