//! Lazy, read-only discovery for the Tools settings page.
use crate::{native_program_path, resolve_program};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub name: String,
    pub program: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub available: bool,
    pub kind: String,
}

struct KnownTool {
    id: &'static str,
    name: &'static str,
    program: &'static str,
    kind: &'static str,
    argument: &'static str,
}

const TOOLS: &[KnownTool] = &[
    KnownTool {
        id: "java",
        name: "Java",
        program: "java",
        kind: "Runtime",
        argument: "-version",
    },
    KnownTool {
        id: "javac",
        name: "Java compiler",
        program: "javac",
        kind: "Compiler",
        argument: "-version",
    },
    KnownTool {
        id: "git",
        name: "Git",
        program: "git",
        kind: "Version control",
        argument: "--version",
    },
    KnownTool {
        id: "node",
        name: "Node.js",
        program: "node",
        kind: "Runtime",
        argument: "--version",
    },
    KnownTool {
        id: "npm",
        name: "npm",
        program: "npm",
        kind: "Package manager",
        argument: "--version",
    },
    KnownTool {
        id: "pnpm",
        name: "pnpm",
        program: "pnpm",
        kind: "Package manager",
        argument: "--version",
    },
    KnownTool {
        id: "bun",
        name: "Bun",
        program: "bun",
        kind: "Runtime",
        argument: "--version",
    },
    KnownTool {
        id: "deno",
        name: "Deno",
        program: "deno",
        kind: "Runtime",
        argument: "--version",
    },
    KnownTool {
        id: "python",
        name: "Python",
        program: "python3",
        kind: "Runtime",
        argument: "--version",
    },
    KnownTool {
        id: "go",
        name: "Go",
        program: "go",
        kind: "Compiler",
        argument: "version",
    },
    KnownTool {
        id: "rust",
        name: "Rust",
        program: "rustc",
        kind: "Compiler",
        argument: "--version",
    },
    KnownTool {
        id: "cargo",
        name: "Cargo",
        program: "cargo",
        kind: "Package manager",
        argument: "--version",
    },
    KnownTool {
        id: "rustfmt",
        name: "rustfmt",
        program: "rustfmt",
        kind: "Formatter",
        argument: "--version",
    },
    KnownTool {
        id: "ruff",
        name: "Ruff",
        program: "ruff",
        kind: "Formatter",
        argument: "--version",
    },
    KnownTool {
        id: "prettier",
        name: "Prettier",
        program: "prettier",
        kind: "Formatter",
        argument: "--version",
    },
    KnownTool {
        id: "claude",
        name: "Claude Code",
        program: "claude",
        kind: "Agent CLI",
        argument: "--version",
    },
    KnownTool {
        id: "codex",
        name: "Codex",
        program: "codex",
        kind: "Agent CLI",
        argument: "--version",
    },
    KnownTool {
        id: "gemini",
        name: "Gemini CLI",
        program: "gemini",
        kind: "Agent CLI",
        argument: "--version",
    },
    KnownTool {
        id: "opencode",
        name: "OpenCode",
        program: "opencode",
        kind: "Agent CLI",
        argument: "--version",
    },
];

/// Requested by Tools refresh or the Java gutter capability check. At most four probes run at once.
pub fn list_tools() -> Vec<ToolInfo> {
    thread::scope(|scope| {
        let workers: Vec<_> = (0..4)
            .map(|worker| {
                scope.spawn(move || {
                    TOOLS
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| index % 4 == worker)
                        .map(|(index, tool)| {
                            (
                                index,
                                inspect(
                                    tool,
                                    resolve_program(tool.program).as_deref(),
                                    Duration::from_millis(1500),
                                ),
                            )
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut results: Vec<_> = workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap_or_default())
            .collect();
        results.sort_by_key(|(index, _)| *index);
        results.into_iter().map(|(_, tool)| tool).collect()
    })
}

fn inspect(tool: &KnownTool, resolved: Option<&Path>, timeout: Duration) -> ToolInfo {
    ToolInfo {
        id: tool.id.into(),
        name: tool.name.into(),
        program: tool.program.into(),
        path: resolved.map(|path| path.to_string_lossy().into_owned()),
        version: resolved.and_then(|path| probe_version(path, tool.argument, timeout)),
        available: resolved.is_some(),
        kind: tool.kind.into(),
    }
}

fn probe_version(path: &Path, argument: &str, timeout: Duration) -> Option<String> {
    let mut command = Command::new(path);
    command
        .arg(argument)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("RUSTUP_AUTO_INSTALL", "0")
        .env("COREPACK_ENABLE_NETWORK", "0")
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0");
    if let Some(path) = native_program_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let stderr = child.stderr.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    for stream in [Box::new(stdout) as Box<dyn Read + Send>, Box::new(stderr)] {
        let sender = sender.clone();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.take(4096).read_to_end(&mut bytes);
            let _ = sender.send(bytes);
        });
    }
    drop(sender);
    let start = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !success {
        return None;
    }
    // The deadline also bounds inherited output handles from a misbehaving CLI.
    for _ in 0..2 {
        let bytes = receiver
            .recv_timeout(timeout.saturating_sub(start.elapsed()))
            .ok()?;
        if let Some(line) = String::from_utf8_lossy(&bytes)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
        {
            let clean: String = line
                .chars()
                .filter(|character| !character.is_control())
                .take(200)
                .collect();
            if !clean.is_empty() {
                return Some(clean);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_program_has_no_installed_claim() {
        let tool = inspect(&TOOLS[0], None, Duration::from_millis(30));
        assert!(!tool.available);
        assert!(tool.path.is_none() && tool.version.is_none());
    }
    #[cfg(unix)]
    #[test]
    fn probe_is_bounded_and_failed_versions_do_not_hide_available_programs() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let program = temp.path().join("probe");
        std::fs::write(&program, "#!/bin/sh\nexec sleep 2\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let start = Instant::now();
        let tool = inspect(&TOOLS[0], Some(&program), Duration::from_millis(40));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(tool.available);
        assert!(tool.version.is_none());
    }
    #[cfg(unix)]
    #[test]
    fn version_command_uses_a_single_argument_and_limits_output() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let program = temp.path().join("probe");
        std::fs::write(&program, "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 1\nprintf 'example 1.2.3\\n'\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            probe_version(&program, "--version", Duration::from_secs(1)).as_deref(),
            Some("example 1.2.3")
        );
    }
}
