//! Installed shell discovery never executes a shell or accepts a command string.
use crate::TerminalError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

pub fn terminal_profiles() -> Vec<TerminalProfile> {
    let default = shell_program();
    let mut candidates = vec![default.clone()];
    #[cfg(unix)]
    {
        // Only absolute directories are considered. Never search the workspace
        // through an empty or relative PATH entry.
        for directory in ["/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"] {
            for name in ["zsh", "bash", "sh", "fish", "ksh", "tcsh", "csh", "nu"] {
                candidates.push(Path::new(directory).join(name));
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&path).filter(|path| path.is_absolute()) {
                for name in ["zsh", "bash", "sh", "fish", "ksh", "tcsh", "csh", "nu"] {
                    candidates.push(directory.join(name));
                }
            }
        }
        if let Ok(shells) = std::fs::read_to_string("/etc/shells") {
            candidates.extend(
                shells
                    .lines()
                    .map(str::trim)
                    .filter(|line| line.starts_with('/'))
                    .map(PathBuf::from),
            );
        }
    }
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let root = PathBuf::from(root);
            candidates.push(root.join(r"System32\cmd.exe"));
            candidates.push(root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
        }
        if let Some(root) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(root).join(r"PowerShell\7\pwsh.exe"));
        }
        if let Some(path) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&path).filter(|path| path.is_absolute()) {
                for name in [
                    "cmd.exe",
                    "powershell.exe",
                    "pwsh.exe",
                    "bash.exe",
                    "sh.exe",
                    "zsh.exe",
                    "nu.exe",
                ] {
                    candidates.push(directory.join(name));
                }
            }
        }
    }
    profiles_from_candidates(&default, candidates)
}

fn profiles_from_candidates(default: &Path, candidates: Vec<PathBuf>) -> Vec<TerminalProfile> {
    let mut profiles: Vec<TerminalProfile> = Vec::new();
    let mut identities = std::collections::HashSet::new();
    for candidate in candidates {
        if !is_executable(&candidate) {
            continue;
        }
        let Some(path) = candidate.to_str() else {
            continue;
        };
        if profiles.iter().any(|profile| profile.path == path) {
            continue;
        }
        let Some(name) = candidate.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        // Keep distinct shell names (sh can link to bash), but collapse aliases
        // of the same named executable in /bin and /usr/bin.
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !identities.insert((canonical, name.to_owned())) {
            continue;
        }
        profiles.push(TerminalProfile {
            id: format!("shell:{path}"),
            name: name.to_owned(),
            path: path.to_owned(),
            is_default: candidate == default,
        });
    }
    profiles
}

pub(crate) fn profile_program(id: &str) -> Result<PathBuf, TerminalError> {
    terminal_profiles()
        .into_iter()
        .find(|profile| profile.id == id)
        .map(|profile| PathBuf::from(profile.path))
        .ok_or_else(|| {
            TerminalError::Operation(
                "The selected shell is no longer available. Choose an installed terminal profile."
                    .to_owned(),
            )
        })
}

pub(crate) fn shell_program() -> PathBuf {
    #[cfg(unix)]
    let configured = std::env::var_os("SHELL");
    #[cfg(windows)]
    let configured = std::env::var_os("COMSPEC");
    if let Some(shell) = configured
        .map(PathBuf::from)
        .filter(|path| is_executable(path))
    {
        return shell;
    }
    #[cfg(unix)]
    let candidates = ["/bin/zsh", "/bin/bash", "/bin/sh"];
    #[cfg(windows)]
    let candidates = [r"C:\Windows\System32\cmd.exe"];
    candidates
        .into_iter()
        .map(PathBuf::from)
        .find(|path| is_executable(path))
        .unwrap_or_else(|| PathBuf::from(candidates[candidates.len() - 1]))
}

fn is_executable(path: &Path) -> bool {
    if !path.is_absolute() || !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        unsafe { libc::access(path.as_ptr(), libc::X_OK) == 0 }
    }
    #[cfg(windows)]
    {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    #[test]
    fn discovery_rejects_relative_directories_and_non_executable_files_and_preserves_default() {
        use std::os::unix::fs::PermissionsExt;
        let root = TempDir::new().unwrap();
        let executable = root.path().join("custom-zsh");
        let plain = root.path().join("bash");
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(&plain, "not executable").unwrap();
        let profiles = profiles_from_candidates(
            &executable,
            vec![
                plain,
                root.path().to_owned(),
                "relative/zsh".into(),
                executable.clone(),
                executable.clone(),
            ],
        );
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "custom-zsh");
        assert!(profiles[0].is_default);
        assert_eq!(profiles[0].path, executable.to_str().unwrap());
    }

    #[test]
    fn profile_ids_must_match_a_discovered_executable() {
        assert!(profile_program("/bin/sh -c arbitrary").is_err());
        assert!(profile_program("shell:./bash").is_err());
        assert!(profile_program("shell:/missing-shell").is_err());
        let profiles = terminal_profiles();
        assert!(profiles
            .iter()
            .all(|profile| is_executable(Path::new(&profile.path))));
        if let Some(profile) = profiles.first() {
            assert_eq!(
                profile_program(&profile.id).unwrap(),
                PathBuf::from(&profile.path)
            );
        }
    }
}
