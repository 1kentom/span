use crate::{AgentCommand, InstalledAgent};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

static SEQUENCE: AtomicU64 = AtomicU64::new(1);
static ACTIVE: OnceLock<std::sync::Mutex<std::collections::HashMap<u64, AgentCommand>>> =
    OnceLock::new();
static MUTATIONS: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
pub(crate) async fn mutation_guard() -> tokio::sync::MutexGuard<'static, ()> {
    MUTATIONS
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}
pub(crate) fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('.')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}
pub(crate) struct ActiveLaunch(u64);
pub(crate) fn register_launch(command: &AgentCommand) -> Result<ActiveLaunch, String> {
    let id = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    ACTIVE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .map_err(|_| "Active agent state is unavailable")?
        .insert(id, command.clone());
    Ok(ActiveLaunch(id))
}
impl Drop for ActiveLaunch {
    fn drop(&mut self) {
        if let Some(active) = ACTIVE.get() {
            if let Ok(mut active) = active.lock() {
                active.remove(&self.0);
            }
        }
    }
}
fn require_disconnected(directory: &Path) -> Result<(), String> {
    let active = ACTIVE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .map_err(|_| "Active agent state is unavailable")?;
    for command in active.values() {
        for value in std::iter::once(&command.command).chain(command.args.iter()) {
            let path = Path::new(value);
            if path.is_absolute()
                && (path.starts_with(directory)
                    || path
                        .canonicalize()
                        .is_ok_and(|path| path.starts_with(directory)))
            {
                return Err("Disconnect this agent and wait for it to finish closing before removing its managed files".into());
            }
        }
    }
    Ok(())
}
fn token() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|time| time.as_nanos())
            .unwrap_or_default(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn root(cache: &Path, create: bool) -> Result<PathBuf, String> {
    if create {
        std::fs::create_dir_all(cache)
            .map_err(|error| format!("Create managed agent cache: {error}"))?;
    }
    let metadata = std::fs::symlink_metadata(cache)
        .map_err(|error| format!("Open managed agent cache: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Managed agent cache must be a regular directory".into());
    }
    cache.canonicalize().map_err(|error| error.to_string())
}
fn child_directory(parent: &Path, name: &str, create: bool) -> Result<PathBuf, String> {
    if !valid_component(name) {
        return Err("Invalid managed agent identifier".into());
    }
    let directory = parent.join(name);
    if create && !directory.exists() {
        std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
    }
    let metadata = std::fs::symlink_metadata(&directory)
        .map_err(|error| format!("Open managed agent directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Managed agent directory must not be a symlink".into());
    }
    let canonical = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if canonical.parent() != Some(parent) {
        return Err("Managed agent directory escapes the cache".into());
    }
    Ok(canonical)
}
fn manifests(directory: &Path, id: &str) -> Result<Vec<PathBuf>, String> {
    let mut manifests = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let Some(version) = entry.file_name().to_str().map(str::to_owned) else {
            return Err("Invalid managed version directory".into());
        };
        if version.starts_with('.') {
            continue;
        }
        let version_directory = child_directory(directory, &version, false)?;
        let path = version_directory.join("span-agent.json");
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 131_072 {
            return Err("Unsafe managed agent manifest".into());
        }
        let installed: InstalledAgent =
            serde_json::from_slice(&std::fs::read(&path).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Invalid managed agent manifest: {error}"))?;
        if installed.id != id || installed.version != version {
            return Err("Managed agent manifest does not match its cache directory".into());
        }
        manifests.push(path);
    }
    Ok(manifests)
}

/// Remove only Span-owned registration or cached adapter files. Global CLIs and credentials are untouched.
pub async fn remove_installed_agent(cache: &Path, id: &str, uninstall: bool) -> Result<(), String> {
    let _mutation = mutation_guard().await;
    let cache = cache.to_owned();
    let id = id.to_owned();
    tokio::task::spawn_blocking(move || remove(&cache, &id, uninstall))
        .await
        .map_err(|error| format!("Remove managed agent task: {error}"))?
}
fn remove(cache: &Path, id: &str, uninstall: bool) -> Result<(), String> {
    let root = root(cache, false)?;
    let directory = child_directory(&root, id, false)?;
    require_disconnected(&directory)?;
    let registered = manifests(&directory, id)?;
    if registered.is_empty() {
        return Err("This agent has no managed registration to remove".into());
    }
    let quarantine = root.join(format!(".span-remove-{id}-{}", token()));
    std::fs::rename(&directory, &quarantine).map_err(|error| {
        format!("Close the connected agent before removing its managed cache: {error}")
    })?;
    if uninstall {
        return std::fs::remove_dir_all(&quarantine).map_err(|error| format!("Agent was unregistered, but cached files remain in Span's quarantine. Close any running adapter before retrying cleanup: {error}"));
    }
    let mut moved = Vec::new();
    for path in registered {
        let relative = path
            .strip_prefix(&directory)
            .map_err(|error| error.to_string())?;
        let from = quarantine.join(relative);
        let to = from.with_file_name(format!("span-agent.unregistered-{}.json", token()));
        if let Err(error) = std::fs::rename(&from, &to) {
            for (from, to) in moved.iter().rev() {
                let _ = std::fs::rename(to, from);
            }
            let _ = std::fs::rename(&quarantine, &directory);
            return Err(format!("Could not unregister managed agent: {error}"));
        }
        moved.push((from, to));
    }
    std::fs::rename(&quarantine, &directory).map_err(|error| {
        format!("Agent was unregistered, but its cache remains quarantined: {error}")
    })
}

pub(crate) struct StagedInstall {
    root: PathBuf,
    pub directory: PathBuf,
    final_directory: PathBuf,
    committed: bool,
}
impl StagedInstall {
    pub fn new(cache: &Path, id: &str, version: &str) -> Result<Self, String> {
        let root = root(cache, true)?;
        let agent = child_directory(&root, id, true)?;
        if !valid_component(version) {
            return Err("Invalid managed agent version".into());
        }
        let final_directory = agent.join(version);
        if final_directory.symlink_metadata().is_ok() {
            let _ = child_directory(&agent, version, false)?;
        }
        let directory = root.join(format!(".span-install-{id}-{}", token()));
        std::fs::create_dir(&directory).map_err(|error| error.to_string())?;
        Ok(Self {
            root,
            directory,
            final_directory,
            committed: false,
        })
    }
    pub fn publish(mut self, mut installed: InstalledAgent) -> Result<InstalledAgent, String> {
        use std::io::Write;
        relocate(
            &mut installed.launch,
            &self.directory,
            &self.final_directory,
        );
        let temporary = self.directory.join(".span-agent-new.json");
        let mut manifest = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        manifest
            .write_all(&serde_json::to_vec_pretty(&installed).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        manifest.sync_all().map_err(|error| error.to_string())?;
        drop(manifest);
        std::fs::rename(&temporary, self.directory.join("span-agent.json"))
            .map_err(|error| error.to_string())?;
        let backup = self
            .root
            .join(format!(".span-replaced-{}-{}", installed.id, token()));
        let replacing = self.final_directory.exists();
        if replacing {
            require_disconnected(&self.final_directory)?;
        }
        if replacing {
            std::fs::rename(&self.final_directory, &backup)
                .map_err(|error| format!("Disconnect this adapter before updating it: {error}"))?;
        }
        if let Err(error) = std::fs::rename(&self.directory, &self.final_directory) {
            if replacing {
                let _ = std::fs::rename(&backup, &self.final_directory);
            }
            return Err(format!("Publish installed agent: {error}"));
        }
        self.committed = true;
        if replacing {
            if let Err(error) = std::fs::remove_dir_all(backup) {
                eprintln!("Agent update installed; cleanup of its replaced managed cache is pending: {error}");
            }
        }
        Ok(installed)
    }
}
impl Drop for StagedInstall {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
}
fn relocate(launch: &mut AgentCommand, from: &Path, to: &Path) {
    fn path(value: &mut String, from: &Path, to: &Path) {
        if let Ok(relative) = Path::new(value.as_str()).strip_prefix(from) {
            *value = to.join(relative).to_string_lossy().into_owned();
        }
    }
    path(&mut launch.command, from, to);
    for argument in &mut launch.args {
        path(argument, from, to);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    fn install(cache: &Path, id: &str, version: &str) -> InstalledAgent {
        let stage = StagedInstall::new(cache, id, version).unwrap();
        let binary = stage.directory.join("agent");
        std::fs::write(&binary, "fixture").unwrap();
        stage
            .publish(InstalledAgent {
                id: id.into(),
                version: version.into(),
                launch: AgentCommand {
                    command: binary.to_string_lossy().into_owned(),
                    args: vec![],
                    env: BTreeMap::new(),
                },
            })
            .unwrap()
    }
    #[test]
    fn unregister_keeps_cached_files_and_reinstall_is_atomic() {
        let cache = tempfile::tempdir().unwrap();
        let installed = install(cache.path(), "codex-acp", "1.0.0");
        assert!(Path::new(&installed.launch.command).exists());
        assert_eq!(crate::list_installed_agents(cache.path()).unwrap().len(), 1);
        remove(cache.path(), "codex-acp", false).unwrap();
        assert!(crate::list_installed_agents(cache.path())
            .unwrap()
            .is_empty());
        assert!(Path::new(&installed.launch.command).exists());
        assert!(!cache
            .path()
            .join("codex-acp/1.0.0/span-agent.json")
            .exists());
        install(cache.path(), "codex-acp", "1.0.0");
        assert!(cache
            .path()
            .join("codex-acp/1.0.0/span-agent.json")
            .exists());
        remove(cache.path(), "codex-acp", true).unwrap();
        assert!(!cache.path().join("codex-acp").exists());
    }
    #[test]
    fn removal_rejects_unmanaged_and_traversal_ids() {
        let cache = tempfile::tempdir().unwrap();
        for id in ["..", "../outside", "/tmp", ".span-remove-hidden"] {
            assert!(remove(cache.path(), id, true).is_err());
        }
        std::fs::create_dir(cache.path().join("unmanaged")).unwrap();
        assert!(remove(cache.path(), "unmanaged", true).is_err());
        assert!(cache.path().join("unmanaged").exists());
    }
    #[test]
    fn removal_requires_connected_managed_adapter_to_finish_closing() {
        let cache = tempfile::tempdir().unwrap();
        let installed = install(cache.path(), "codex-acp", "1.0.0");
        let active = register_launch(&installed.launch).unwrap();
        assert!(remove(cache.path(), "codex-acp", true)
            .unwrap_err()
            .contains("Disconnect"));
        assert!(Path::new(&installed.launch.command).exists());
        drop(active);
        remove(cache.path(), "codex-acp", true).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn uninstall_never_follows_external_symlinks() {
        let cache = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), "user credentials").unwrap();
        install(cache.path(), "codex-acp", "1.0.0");
        std::os::unix::fs::symlink(
            outside.path(),
            cache.path().join("codex-acp/1.0.0/external"),
        )
        .unwrap();
        remove(cache.path(), "codex-acp", true).unwrap();
        assert_eq!(
            std::fs::read_to_string(outside.path().join("keep")).unwrap(),
            "user credentials"
        );
        std::os::unix::fs::symlink(outside.path(), cache.path().join("codex-acp")).unwrap();
        assert!(remove(cache.path(), "codex-acp", true).is_err());
        assert!(outside.path().join("keep").exists());
    }
}
