//! Helpers shared by the LSP integration tests (each `tests/*.rs` is its own crate,
//! so they pull this in with `mod common;`). Process inspection uses explicit
//! argument commands only, never a shell string.
#![allow(dead_code)]

use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// Python interpreter as `(program, leading args)`. Prefers `python3`, then `python`,
/// then the Windows launcher `py -3`; the first one that actually runs wins (on
/// Windows `python3` is often a Store stub that exists but fails).
pub fn python() -> (&'static str, &'static [&'static str]) {
    static PY: OnceLock<(&'static str, &'static [&'static str])> = OnceLock::new();
    *PY.get_or_init(|| {
        let candidates: [(&str, &[&str]); 3] = [("python3", &[]), ("python", &[]), ("py", &["-3"])];
        for (prog, pre) in candidates {
            let ok = Command::new(prog)
                .args(pre)
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                return (prog, pre);
            }
        }
        ("python3", &[])
    })
}

/// Python program plus its leading args followed by `rest`, as owned strings.
pub fn python_args(rest: &[String]) -> (String, Vec<String>) {
    let (prog, pre) = python();
    let mut args: Vec<String> = pre.iter().map(|s| s.to_string()).collect();
    args.extend(rest.iter().cloned());
    (prog.to_string(), args)
}

/// Every process as `(pid, ppid, state)`. Unix state is the `ps` stat column
/// (`Z...` is a zombie). Windows has no zombies, so the state is always `R` and
/// reaping is checked by absence.
#[cfg(unix)]
pub fn process_table() -> Vec<(u32, u32, String)> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,ppid=,stat="])
        .output()
        .expect("run ps");
    parse_table(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(windows)]
pub fn process_table() -> Vec<(u32, u32, String)> {
    let out = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} R' -f $_.ProcessId, $_.ParentProcessId }",
        ])
        .output()
        .expect("run powershell");
    parse_table(&String::from_utf8_lossy(&out.stdout))
}

fn parse_table(text: &str) -> Vec<(u32, u32, String)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((
                it.next()?.parse().ok()?,
                it.next()?.parse().ok()?,
                it.next()?.to_string(),
            ))
        })
        .collect()
}

/// State of a pid, `None` once it no longer exists (fully reaped). On unix a zombie
/// still reports `Z...`; on Windows the state is always `R`.
#[cfg(unix)]
pub fn ps_state(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(windows)]
pub fn ps_state(pid: u32) -> Option<String> {
    process_table()
        .into_iter()
        .find(|(p, _, _)| *p == pid)
        .map(|(_, _, s)| s)
}

/// True while the pid exists. On unix `kill -0` also succeeds on a zombie, so a
/// `false` here means the child was reaped.
#[cfg(unix)]
pub fn process_exists(pid: u64) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn process_exists(pid: u64) -> bool {
    ps_state(pid as u32).is_some()
}

/// Alive means present and not a zombie (zombies exist on unix only).
pub fn is_alive(pid: u32) -> bool {
    process_table()
        .iter()
        .any(|(p, _, stat)| *p == pid && !stat.starts_with('Z'))
}

/// Forcefully kills a pid (unix `kill -9`, Windows `taskkill /F /T`).
#[cfg(unix)]
pub fn kill_force(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

#[cfg(windows)]
pub fn kill_force(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .status();
}
