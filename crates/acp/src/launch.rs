use crate::AgentCommand;
use span_core::resolve_program;
use std::path::Path;

/// Resolve GUI-launched executables without invoking a login shell or changing process state.
pub(crate) fn prepare_command(mut config: AgentCommand) -> Result<AgentCommand, String> {
    let program = resolve_program(&config.command)
        .ok_or_else(|| format!("Executable was not found: {}", config.command))?;
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
}
