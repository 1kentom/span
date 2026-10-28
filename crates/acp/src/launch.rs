use crate::AgentCommand;
use span_core::resolve_program;
use std::path::{Path, PathBuf};

/// Per-user folders where agent CLIs install themselves. A native GUI process does not inherit
/// the PATH exported from interactive shell files such as `.zshrc`, so these are searched after
/// the inherited PATH and the folders `resolve_program` already knows. The list is fixed and
/// relative to the home directory; nothing is read from a shell or from the workspace.
const USER_PROGRAM_DIRECTORIES: &[&str] = &[
    ".opencode/bin",
    ".bun/bin",
    ".volta/bin",
    ".npm-global/bin",
    ".deno/bin",
    ".claude/local",
    ".local/share/mise/shims",
    ".asdf/shims",
    "Library/pnpm",
    ".yarn/bin",
    "AppData/Roaming/npm",
];

fn user_program_directories(home: &Path) -> Vec<PathBuf> {
    USER_PROGRAM_DIRECTORIES
        .iter()
        .map(|relative| home.join(relative))
        .collect()
}

fn resolve_agent_program(command: &str, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(found) = resolve_program(command) {
        return Some(found);
    }
    let path = Path::new(command);
    if path.is_absolute() || path.components().count() > 1 {
        return None;
    }
    for directory in user_program_directories(home?) {
        let candidate = directory.join(command);
        let candidates = [candidate.clone(), candidate.with_extension("exe")];
        for candidate in candidates {
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

fn not_found_message(command: &str) -> String {
    format!(
        "Executable was not found: {command}. Span looked in the PATH it inherited, Homebrew, ~/.cargo/bin, ~/.local/bin and the usual per-user tool folders (for example ~/.opencode/bin and ~/.bun/bin). Start Span from a terminal that can run `{command}`, or enter its full path as the agent command."
    )
}

/// Resolve GUI-launched executables without invoking a login shell or changing process state.
pub(crate) fn prepare_command(mut config: AgentCommand) -> Result<AgentCommand, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let program = resolve_agent_program(&config.command, home.as_deref())
        .ok_or_else(|| not_found_message(&config.command))?;
    let inherited = config
        .env
        .get("PATH")
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"));
    let node = resolve_program("node");
    config.env.insert(
        "PATH".into(),
        child_path(&program, node.as_deref(), inherited.as_deref())?,
    );
    config.command = program.to_string_lossy().into_owned();
    Ok(config)
}

fn child_path(
    program: &Path,
    node: Option<&Path>,
    inherited: Option<&std::ffi::OsStr>,
) -> Result<String, String> {
    let mut directories = Vec::new();
    for program in Some(program).into_iter().chain(node) {
        if let Some(parent) = program.parent() {
            if !parent.as_os_str().is_empty()
                && !directories.iter().any(|directory| directory == parent)
            {
                directories.push(parent.to_owned());
            }
        }
    }
    if let Some(inherited) = inherited {
        directories.extend(std::env::split_paths(inherited));
    }
    std::env::join_paths(directories)
        .map_err(|error| format!("Prepare agent PATH: {error}"))?
        .into_string()
        .map_err(|_| "Agent PATH contains unsupported non-UTF-8 characters".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn child_path_keeps_resolved_programs_and_inherited_directories() {
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent-bin/agent");
        let node = root.path().join("node-bin/node");
        let inherited = std::env::join_paths([root.path().join("system-bin")]).unwrap();
        let path = child_path(&agent, Some(&node), Some(&inherited)).unwrap();
        let directories: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(
            directories,
            vec![
                root.path().join("agent-bin"),
                root.path().join("node-bin"),
                root.path().join("system-bin")
            ]
        );
        let path = child_path(&node, Some(&node), None).unwrap();
        assert_eq!(std::env::split_paths(&path).count(), 1);
    }

    fn install(home: &Path, relative: &str, name: &str) -> PathBuf {
        let directory = home.join(relative);
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_owned()
        });
        std::fs::write(&file, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        file
    }

    #[test]
    fn finds_agents_installed_in_per_user_tool_folders() {
        let home = tempfile::tempdir().unwrap();
        for (relative, name) in [
            (".opencode/bin", "span-test-opencode-agent"),
            (".bun/bin", "span-test-bun-agent"),
            (".npm-global/bin", "span-test-npm-agent"),
        ] {
            let installed = install(home.path(), relative, name);
            assert_eq!(
                resolve_agent_program(name, Some(home.path())),
                Some(installed),
                "{relative}"
            );
        }
    }

    #[test]
    fn user_folders_never_resolve_what_is_not_there_or_not_executable() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_agent_program("span-test-missing-agent", Some(home.path())),
            None
        );
        assert_eq!(resolve_agent_program("span-test-missing-agent", None), None);
        let directory = home.path().join(".opencode/bin");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("span-test-plain-file"), b"data").unwrap();
        #[cfg(unix)]
        assert_eq!(
            resolve_agent_program("span-test-plain-file", Some(home.path())),
            None,
            "a file without the executable bit must not resolve"
        );
        std::fs::create_dir_all(directory.join("span-test-a-directory")).unwrap();
        assert_eq!(
            resolve_agent_program("span-test-a-directory", Some(home.path())),
            None
        );
    }

    #[test]
    fn explicit_paths_are_never_searched_in_user_folders() {
        let home = tempfile::tempdir().unwrap();
        install(home.path(), ".opencode/bin", "span-test-opencode-agent");
        assert_eq!(
            resolve_agent_program(
                "../.opencode/bin/span-test-opencode-agent",
                Some(home.path())
            ),
            None
        );
    }

    #[test]
    fn the_not_found_message_names_the_program_and_where_it_looked() {
        let message = not_found_message("opencode");
        assert!(message.starts_with("Executable was not found: opencode"));
        assert!(message.contains("~/.opencode/bin"));
        assert!(message.contains("full path"));
        assert!(!message.contains('\u{2014}'));
    }
}
