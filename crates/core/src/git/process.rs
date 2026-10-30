use crate::{CancellationToken, CoreError, Result};
use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::mpsc,
    time::{sleep, timeout_at, Instant},
};

pub(super) struct GitCommand {
    pub program: PathBuf,
    pub cwd: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub input: Option<Vec<u8>>,
    pub timeout: Duration,
    pub max_output: usize,
}

#[derive(Debug)]
pub(super) struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub success: bool,
    pub code: Option<i32>,
}

pub(super) async fn run(
    request: GitCommand,
    cancellation: &CancellationToken,
    scope_cancel: &CancellationToken,
) -> Result<GitOutput> {
    let label = request.program.display().to_string();
    if cancellation.is_cancelled() || scope_cancel.is_cancelled() {
        return Err(git_error(format!("{label} cancelled")));
    }
    let mut command = Command::new(&request.program);
    command
        .current_dir(&request.cwd)
        .args(&request.args)
        .stdin(if request.input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for key in ROUTING_ENV {
        command.env_remove(key);
    }
    for (key, _) in std::env::vars_os() {
        if let Some(name) = key.to_str() {
            if name.starts_with("GIT_TRACE")
                || (name.starts_with("GIT_CONFIG_KEY_") || name.starts_with("GIT_CONFIG_VALUE_"))
                    && name.rsplit('_').next().is_some_and(|suffix| {
                        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                    })
            {
                command.env_remove(key);
            }
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat");
    if let Some(path) = crate::native_program_path() {
        command.env("PATH", path);
    }
    command.envs(request.env.iter().map(|(key, value)| (key, value)));

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command
            .as_std_mut()
            .creation_flags(0x0000_0004 | 0x0800_0000); // CREATE_SUSPENDED | CREATE_NO_WINDOW
    }

    let mut child = command
        .spawn()
        .map_err(|error| git_error(format!("could not start {label}: {error}")))?;
    #[cfg(unix)]
    let tree = ProcessTree::new(&child)
        .map_err(|error| git_error(format!("could not track {label}: {error}")))?;
    #[cfg(windows)]
    let tree = ProcessTree::new(&child)
        .map_err(|error| git_error(format!("could not track {label}: {error}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| git_error(format!("{label} stdout unavailable")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| git_error(format!("{label} stderr unavailable")))?;
    let (tx, mut rx) = mpsc::channel::<(bool, Vec<u8>)>(8);
    let out_task = tokio::spawn(pump(stdout, true, tx.clone()));
    let err_task = tokio::spawn(pump(stderr, false, tx.clone()));
    drop(tx);
    let input_task = if let (Some(input), Some(mut stdin)) = (request.input, child.stdin.take()) {
        Some(tokio::spawn(async move {
            let result = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
            result
        }))
    } else {
        None
    };

    let deadline = Instant::now() + request.timeout;
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut received = 0usize;
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut status = None;
    let mut out_task = out_task;
    let mut err_task = err_task;
    let mut child_wait = Box::pin(child.wait());
    let mut failure = None;
    loop {
        if cancellation.is_cancelled() || scope_cancel.is_cancelled() {
            failure = Some(format!("{label} cancelled"));
            break;
        }
        if status.is_some() && stdout_done && stderr_done {
            break;
        }
        tokio::select! {
            _ = sleep(Duration::from_millis(20)) => {},
            result = &mut child_wait, if status.is_none() => match result {
                Ok(value) => status = Some(value),
                Err(error) => { failure = Some(format!("{label} wait failed: {error}")); break; }
            },
            message = rx.recv(), if !stdout_done || !stderr_done => match message {
                Some((is_stdout, bytes)) => {
                    received = received.saturating_add(bytes.len());
                    if received > request.max_output {
                        failure = Some(format!("{label} output exceeded {} bytes", request.max_output));
                        break;
                    }
                    if is_stdout { stdout_bytes.extend_from_slice(&bytes); }
                    else { stderr_bytes.extend_from_slice(&bytes); }
                }
                None => { stdout_done = true; stderr_done = true; }
            },
            _ = timeout_at(deadline, async { std::future::pending::<()>().await }) => {
                failure = Some(format!("{label} timed out after {} ms", request.timeout.as_millis()));
                break;
            }
        }
    }
    if let Some(error) = failure {
        tree.kill();
        if status.is_none() {
            let _ = timeout_at(Instant::now() + Duration::from_millis(200), &mut child_wait).await;
        }
        out_task.abort();
        err_task.abort();
        if let Some(task) = input_task {
            task.abort();
        }
        return Err(git_error(error));
    }
    for (name, task) in [("stdout", &mut out_task), ("stderr", &mut err_task)] {
        match timeout_at(deadline, &mut *task).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => {
                return Err(git_error(format!("{label} {name} read failed: {error}")))
            }
            Ok(Err(error)) => {
                return Err(git_error(format!("{label} {name} reader failed: {error}")))
            }
            Err(_) => {
                tree.kill();
                task.abort();
                return Err(git_error(format!(
                    "{label} timed out while collecting output"
                )));
            }
        }
    }
    let mut input_error = None;
    if let Some(mut task) = input_task {
        match timeout_at(deadline, &mut task).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => input_error = Some(format!("{label} stdin failed: {error}")),
            Ok(Err(error)) => input_error = Some(format!("{label} stdin task failed: {error}")),
            Err(_) => {
                tree.kill();
                task.abort();
                out_task.abort();
                err_task.abort();
                return Err(git_error(format!("{label} timed out while writing stdin")));
            }
        }
    }
    let status = status.ok_or_else(|| git_error(format!("{label} exited without status")))?;
    if status.success() {
        if let Some(error) = input_error {
            return Err(git_error(error));
        }
    }
    Ok(GitOutput {
        stdout: stdout_bytes,
        stderr: stderr_bytes,
        success: status.success(),
        code: status.code(),
    })
}

async fn pump<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    stdout: bool,
    sender: mpsc::Sender<(bool, Vec<u8>)>,
) -> std::io::Result<()> {
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Err(error) => return Err(error),
            Ok(size) => {
                if sender
                    .send((stdout, buffer[..size].to_vec()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    Ok(())
}

const ROUTING_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_EXEC_PATH",
    "GIT_TEMPLATE_DIR",
    "GIT_PROXY_COMMAND",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_KEY_1",
    "GIT_CONFIG_VALUE_1",
    "GIT_CONFIG_KEY_2",
    "GIT_CONFIG_VALUE_2",
    "GIT_CONFIG_KEY_3",
    "GIT_CONFIG_VALUE_3",
    "GIT_CONFIG_KEY_4",
    "GIT_CONFIG_VALUE_4",
    "GIT_CONFIG_KEY_5",
    "GIT_CONFIG_VALUE_5",
    "GIT_CONFIG_KEY_6",
    "GIT_CONFIG_VALUE_6",
    "GIT_CONFIG_KEY_7",
    "GIT_CONFIG_VALUE_7",
    "GIT_CONFIG_KEY_8",
    "GIT_CONFIG_VALUE_8",
    "GIT_CONFIG_KEY_9",
    "GIT_CONFIG_VALUE_9",
];

fn git_error(message: String) -> CoreError {
    CoreError::Git(message)
}

#[cfg(unix)]
struct ProcessTree {
    pid: i32,
    killed: std::sync::atomic::AtomicBool,
}
#[cfg(unix)]
impl ProcessTree {
    fn new(child: &Child) -> std::result::Result<Self, String> {
        use std::sync::atomic::AtomicBool;
        let pid = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .ok_or_else(|| "process ID unavailable".to_owned())?;
        Ok(Self {
            pid,
            killed: AtomicBool::new(false),
        })
    }
    fn kill(&self) {
        use std::sync::atomic::Ordering;
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
    fn new(child: &Child) -> std::result::Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                    THREADENTRY32,
                },
                JobObjects::*,
                Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
            },
        };
        let process = child
            .raw_handle()
            .ok_or_else(|| "process handle unavailable".to_owned())?;
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err("could not create cleanup job".into());
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
            return Err("could not attach cleanup job".into());
        }
        let pid = child
            .id()
            .ok_or_else(|| "process ID unavailable".to_owned())?;
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(job);
            }
            return Err("could not inspect suspended process".into());
        }
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut found = unsafe { Thread32First(snapshot, &mut entry) };
        let mut resumed = false;
        while found != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if !thread.is_null() {
                    resumed = unsafe { ResumeThread(thread) } != u32::MAX;
                    unsafe {
                        CloseHandle(thread);
                    }
                }
                break;
            }
            found = unsafe { Thread32Next(snapshot, &mut entry) };
        }
        unsafe {
            CloseHandle(snapshot);
        }
        if !resumed {
            unsafe {
                CloseHandle(job);
            }
            return Err("could not resume tracked process".into());
        }
        Ok(Self { job })
    }
    fn kill(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn command(
        script: &str,
        timeout: Duration,
        max_output: usize,
        input: Option<&[u8]>,
    ) -> GitCommand {
        GitCommand {
            program: PathBuf::from("/bin/sh"),
            cwd: std::env::temp_dir(),
            args: vec![OsString::from("-c"), OsString::from(script)],
            env: vec![],
            input: input.map(ToOwned::to_owned),
            timeout,
            max_output,
        }
    }
    #[tokio::test]
    async fn captures_input_and_both_streams() {
        let request = command(
            "read x; printf '%s' \"$x\"; printf err >&2",
            Duration::from_secs(2),
            100,
            Some(b"hello\n"),
        );
        let result = run(
            request,
            &CancellationToken::default(),
            &CancellationToken::default(),
        )
        .await
        .unwrap();
        assert_eq!(result.stdout, b"hello");
        assert_eq!(result.stderr, b"err");
        assert!(result.success);
    }
    #[tokio::test]
    async fn rejects_combined_output_over_budget() {
        let error = run(
            command("printf 1234567890", Duration::from_secs(2), 5, None),
            &CancellationToken::default(),
            &CancellationToken::default(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("exceeded 5 bytes"));
    }
    #[tokio::test]
    async fn timeout_covers_inherited_pipe_holders_after_parent_exit() {
        let start = Instant::now();
        let error = run(
            command("(sleep 5) & exit 0", Duration::from_millis(100), 100, None),
            &CancellationToken::default(),
            &CancellationToken::default(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[tokio::test]
    async fn cancellation_stops_process() {
        let token = CancellationToken::default();
        let child_token = token.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(50)).await;
            child_token.cancel();
        });
        let error = run(
            command("sleep 5", Duration::from_secs(5), 100, None),
            &token,
            &CancellationToken::default(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
    }

    #[tokio::test]
    async fn pre_cancelled_request_does_not_spawn() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("spawned");
        let mut request = command("printf x > marker", Duration::from_secs(2), 100, None);
        request.cwd = directory.path().to_path_buf();
        let token = CancellationToken::default();
        token.cancel();
        let error = run(request, &token, &CancellationToken::default())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        assert!(!marker.exists());
    }
}
