//! Versioned, explicit workspace run commands. Loading and discovery never execute commands.
use crate::{io_error, CoreError, CoreWorkspace, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::hash::BuildHasher;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
static NEXT_CONFIG: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunConfiguration {
    pub id: String,
    pub name: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    /// Only user supplied overrides. Prefer ${env:NAME} to saving literal credentials.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}
fn default_cwd() -> String {
    ".".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRunTask {
    pub configuration: RunConfiguration,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunCatalog {
    pub workspace_root: String,
    pub configurations: Vec<RunConfiguration>,
    pub detected: Vec<DetectedRunTask>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunFile {
    version: u32,
    configurations: Vec<RunConfiguration>,
}
/// Launch preparation contains expanded environment values and intentionally has no Debug/IPC impl.
pub struct PreparedRun {
    pub configuration: RunConfiguration,
    pub workspace_root: PathBuf,
    pub cwd: PathBuf,
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}
fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::RunConfiguration(message.into())
}

impl CoreWorkspace {
    fn run_file_path(&self, create: bool) -> Result<Option<PathBuf>> {
        let directory = self.resolve(".span")?;
        if !directory.exists() {
            if !create {
                return Ok(None);
            }
            fs::create_dir(&directory).map_err(|error| {
                io_error("Create run configuration directory", &directory, error)
            })?;
        }
        if !self.resolve(".span")?.is_dir() {
            return Err(invalid(".span must be a directory"));
        }
        Ok(Some(self.resolve(".span/run.json")?))
    }
    fn load_run_file(&self) -> Result<RunFile> {
        let empty = || RunFile {
            version: 1,
            configurations: Vec::new(),
        };
        let Some(path) = self.run_file_path(false)? else {
            return Ok(empty());
        };
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
            Err(error) => return Err(io_error("Read run configurations", &path, error)),
        };
        let mut bytes = Vec::new();
        file.take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| io_error("Read run configurations", &path, error))?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(invalid(".span/run.json exceeds 1 MiB"));
        }
        let file: RunFile = serde_json::from_slice(&bytes)
            .map_err(|error| invalid(format!(".span/run.json is invalid JSON: {error}")))?;
        if file.version != 1 {
            return Err(invalid("Unsupported .span/run.json version, expected 1"));
        }
        if file.configurations.len() > 128 {
            return Err(invalid("At most 128 run configurations are supported"));
        }
        let mut ids = std::collections::HashSet::new();
        for configuration in &file.configurations {
            validate(configuration)?;
            if configuration.id.is_empty()
                || configuration.id.starts_with("detected:")
                || !ids.insert(&configuration.id)
            {
                return Err(invalid(
                    "Saved run configuration IDs must be unique and nonempty",
                ));
            }
        }
        Ok(file)
    }
    fn write_run_file(&mut self, file: &RunFile) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(file)
            .map_err(|error| invalid(format!("Encode run configurations: {error}")))?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(invalid(".span/run.json exceeds 1 MiB"));
        }
        if self
            .buffers
            .get(".span/run.json")
            .is_some_and(|buffer| buffer.revision != buffer.saved_revision)
            || self
                .proposals
                .values()
                .any(|proposal| proposal.path == ".span/run.json")
        {
            return Err(invalid("Resolve unsaved edits and pending proposals in .span/run.json before changing run configurations"));
        }
        let path = self
            .run_file_path(true)?
            .ok_or_else(|| invalid("Run configuration path is unavailable"))?;
        crate::workspace::atomic_write(&path, &bytes)?;
        if self.buffers.contains_key(".span/run.json") {
            self.discard_buffer(".span/run.json")?;
        }
        Ok(())
    }
    /// Exact persisted configuration snapshot for approval staleness checks, never logged.
    pub fn run_configuration_snapshot(&self) -> Result<String> {
        let file = self.load_run_file()?;
        let mut manifests = BTreeMap::new();
        for path in [
            "package.json",
            "Cargo.toml",
            "pyproject.toml",
            "setup.py",
            "pom.xml",
            "build.gradle",
            "build.gradle.kts",
            "Makefile",
        ] {
            manifests.insert(path, crate::run_detection::read_manifest(&self.root, path)?);
        }
        serde_json::to_string(&(file, manifests))
            .map_err(|error| invalid(format!("Encode run snapshot: {error}")))
    }
    pub fn run_configuration_revision(&self) -> Result<String> {
        static KEY: std::sync::OnceLock<std::collections::hash_map::RandomState> =
            std::sync::OnceLock::new();
        // Randomly keyed and process-local: public revision tokens expose no stable secret digest.
        Ok(format!(
            "{:016x}",
            KEY.get_or_init(std::collections::hash_map::RandomState::new)
                .hash_one(self.run_configuration_snapshot()?)
        ))
    }
    pub fn run_configurations(&self) -> Result<RunCatalog> {
        let mut detected = crate::run_detection::detect_tasks(&self.root)?;
        detected.extend(self.java_run_tasks());
        Ok(RunCatalog {
            workspace_root: self.workspace().root,
            configurations: self.load_run_file()?.configurations,
            detected,
        })
    }
    pub fn save_run_configuration(
        &mut self,
        mut configuration: RunConfiguration,
    ) -> Result<RunConfiguration> {
        validate(&configuration)?;
        if configuration.id.starts_with("detected:") {
            return Err(invalid(
                "Detected tasks are read only. Duplicate the task to edit it.",
            ));
        }
        let mut file = self.load_run_file()?;
        if configuration.id.is_empty() {
            configuration.id = format!(
                "run-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |time| time.as_nanos()),
                NEXT_CONFIG.fetch_add(1, Ordering::Relaxed)
            );
        }
        if let Some(previous) = file
            .configurations
            .iter_mut()
            .find(|entry| entry.id == configuration.id)
        {
            *previous = configuration.clone();
        } else {
            if file.configurations.len() >= 128 {
                return Err(invalid("At most 128 run configurations are supported"));
            }
            file.configurations.push(configuration.clone());
        }
        self.write_run_file(&file)?;
        Ok(configuration)
    }
    pub fn delete_run_configuration(&mut self, id: &str) -> Result<()> {
        let mut file = self.load_run_file()?;
        let before = file.configurations.len();
        file.configurations.retain(|entry| entry.id != id);
        if before == file.configurations.len() {
            return Err(invalid("Saved run configuration was not found"));
        }
        self.write_run_file(&file)
    }
    pub fn duplicate_run_configuration(&mut self, id: &str) -> Result<RunConfiguration> {
        let catalog = self.run_configurations()?;
        let mut configuration = catalog
            .configurations
            .into_iter()
            .chain(catalog.detected.into_iter().map(|task| task.configuration))
            .find(|entry| entry.id == id)
            .ok_or_else(|| invalid("Run configuration was not found"))?;
        configuration.id.clear();
        configuration.name = format!("{} copy", configuration.name);
        // A maximal name still needs to be editable as a copy.
        if configuration.name.chars().count() > 160 {
            configuration.name = configuration.name.chars().take(160).collect();
        }
        self.save_run_configuration(configuration)
    }
    /// Snapshot under the workspace mutex. The caller releases it before spawning or waiting.
    pub fn prepare_run(&self, configuration: RunConfiguration) -> Result<PreparedRun> {
        self.prepare_run_with_env(configuration, |name| std::env::var(name).ok())
    }
    fn prepare_run_with_env(
        &self,
        configuration: RunConfiguration,
        environment: impl Fn(&str) -> Option<String>,
    ) -> Result<PreparedRun> {
        validate(&configuration)?;
        self.validate_java_run(&configuration)?;
        let variables = std::cell::RefCell::new(BTreeMap::<String, Option<String>>::new());
        let lookup = |name: &str| {
            variables
                .borrow_mut()
                .entry(name.to_owned())
                .or_insert_with(|| environment(name))
                .clone()
        };
        let expand = |value: &str| expand(value, &self.workspace().root, &lookup);
        let cwd_text = expand(&configuration.cwd)?;
        let cwd = self.resolve(&cwd_text)?;
        if !cwd.is_dir() {
            return Err(invalid(
                "Run working directory must be an existing directory inside the workspace",
            ));
        }
        let env = configuration
            .env
            .iter()
            .map(|(name, value)| Ok((name.clone(), expand(value)?)))
            .collect::<Result<BTreeMap<_, _>>>()?;
        let executable_name = expand(&configuration.executable)?;
        let path = std::path::Path::new(&executable_name);
        let executable = if path.is_absolute() {
            crate::resolve_program(&executable_name)
        } else if path.components().count() > 1 {
            let resolved = self.resolve(&executable_name)?;
            crate::resolve_program(&resolved.to_string_lossy())
        } else if let Some(path) = env.get("PATH") {
            std::env::split_paths(path).find_map(|directory| {
                let directory = if directory.is_absolute() { directory } else { cwd.join(directory) };
                let candidate = directory.join(&executable_name);
                #[cfg(windows)]
                if let Some(program) = crate::resolve_program(&candidate.with_extension("exe").to_string_lossy()) { return Some(program); }
                crate::resolve_program(&candidate.to_string_lossy())
            })
        } else {
            crate::resolve_program(&executable_name)
        }.ok_or_else(|| invalid("Run executable was not found or is not executable. Configure its full path or install it explicitly."))?;
        let args = configuration
            .args
            .iter()
            .map(|value| expand(value))
            .collect::<Result<Vec<_>>>()?;
        Ok(PreparedRun {
            configuration,
            workspace_root: self.root.clone(),
            cwd,
            executable,
            args,
            env,
        })
    }
}

fn validate(configuration: &RunConfiguration) -> Result<()> {
    if configuration.name.trim().is_empty() || configuration.name.chars().count() > 160 {
        return Err(invalid("Run name must contain 1 to 160 characters"));
    }
    if configuration.id.len() > 256 || configuration.id.contains(['\0', '\r', '\n']) {
        return Err(invalid("Run ID is invalid"));
    }
    if configuration.executable.trim().is_empty() || configuration.executable.len() > 4096 {
        return Err(invalid(
            "Run executable is required and must be shorter than 4096 bytes",
        ));
    }
    if configuration.args.len() > 256 || configuration.env.len() > 128 {
        return Err(invalid(
            "Run configuration exceeds the argument or environment count limit",
        ));
    }
    let values = std::iter::once(&configuration.executable)
        .chain(std::iter::once(&configuration.cwd))
        .chain(configuration.args.iter())
        .chain(configuration.env.values());
    let mut total = 0;
    for value in values {
        total += value.len();
        if value.contains('\0') || value.len() > 32768 {
            return Err(invalid(
                "Run values must not contain NUL or exceed 32768 bytes",
            ));
        }
    }
    if total > 128 * 1024 {
        return Err(invalid("Run configuration exceeds 128 KiB"));
    }
    for name in configuration.env.keys() {
        if name.is_empty()
            || name.len() > 256
            || !name.bytes().enumerate().all(|(index, byte)| {
                byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
            })
        {
            return Err(invalid("Environment names must use letters, digits and underscores, starting with a letter or underscore"));
        }
    }
    Ok(())
}
fn expand(
    value: &str,
    root: &str,
    environment: &impl Fn(&str) -> Option<String>,
) -> Result<String> {
    let mut output = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        output.push_str(&remaining[..start]);
        let expression = &remaining[start + 2..];
        let end = expression
            .find('}')
            .ok_or_else(|| invalid("Unclosed run variable reference"))?;
        let key = &expression[..end];
        if key == "workspaceFolder" {
            output.push_str(root);
        } else if let Some(name) = key.strip_prefix("env:") {
            if name.is_empty() {
                return Err(invalid("Environment reference name is empty"));
            }
            output.push_str(&environment(name).ok_or_else(|| {
                invalid(format!(
                    "Required environment variable {name} is unavailable"
                ))
            })?);
        } else {
            return Err(invalid(
                "Supported run variables are ${workspaceFolder} and ${env:NAME}",
            ));
        }
        if output.len() > 128 * 1024 {
            return Err(invalid("Expanded run value exceeds 128 KiB"));
        }
        remaining = &expression[end + 1..];
    }
    output.push_str(remaining);
    if output.contains('\0') || output.len() > 128 * 1024 {
        return Err(invalid(
            "Expanded run value contains NUL or exceeds 128 KiB",
        ));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> RunConfiguration {
        RunConfiguration {
            id: String::new(),
            name: "Test".into(),
            executable: std::env::current_exe().unwrap().display().to_string(),
            args: vec!["literal space ; $(no-shell)".into()],
            cwd: ".".into(),
            env: BTreeMap::from([("TOKEN".into(), "${env:TEST_SECRET}".into())]),
        }
    }
    #[test]
    fn crud_persists_only_explicit_config_not_resolved_environment() {
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = CoreWorkspace::open(dir.path()).unwrap();
        let saved = workspace.save_run_configuration(config()).unwrap();
        assert!(!saved.id.is_empty());
        let prepared = workspace
            .prepare_run_with_env(saved.clone(), |name| {
                (name == "TEST_SECRET").then(|| "secret-value-not-on-disk".into())
            })
            .unwrap();
        assert_eq!(prepared.env["TOKEN"], "secret-value-not-on-disk");
        assert_eq!(prepared.args, saved.args);
        let disk = fs::read_to_string(dir.path().join(".span/run.json")).unwrap();
        assert!(!disk.contains("secret-value-not-on-disk"));
        assert!(disk.contains("${env:TEST_SECRET}"));
        let copy = workspace.duplicate_run_configuration(&saved.id).unwrap();
        assert_ne!(copy.id, saved.id);
        workspace.delete_run_configuration(&saved.id).unwrap();
        assert_eq!(
            workspace.run_configurations().unwrap().configurations,
            vec![copy]
        );
    }
    #[test]
    fn run_validation_rejects_escapes_invalid_env_and_bad_versions() {
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = CoreWorkspace::open(dir.path()).unwrap();
        let mut value = config();
        value.cwd = "../".into();
        assert!(workspace.prepare_run(value).is_err());
        let mut value = config();
        value.env.insert("BAD=NAME".into(), "x".into());
        assert!(workspace.save_run_configuration(value).is_err());
        let mut value = config();
        value.cwd = "settings://user".into();
        assert!(workspace.prepare_run(value).is_err());
        fs::create_dir(dir.path().join(".span")).unwrap();
        fs::write(
            dir.path().join(".span/run.json"),
            r#"{"version":2,"configurations":[]}"#,
        )
        .unwrap();
        assert!(workspace.run_configurations().is_err());
    }
    #[test]
    fn undefined_reference_does_not_leak_other_values_and_substitution_is_single_pass() {
        assert!(expand("${env:MISSING}", "root", &|_| None)
            .unwrap_err()
            .to_string()
            .contains("MISSING"));
        assert_eq!(
            expand("${env:TOKEN}", "root", &|_| Some("${env:OTHER}".into())).unwrap(),
            "${env:OTHER}"
        );
        assert_eq!(
            expand("${workspaceFolder}/a b", "/workspace", &|_| None).unwrap(),
            "/workspace/a b"
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_configuration_and_cwd_cannot_escape_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut workspace = CoreWorkspace::open(dir.path()).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(".span")).unwrap();
        assert!(workspace.save_run_configuration(config()).is_err());
        std::os::unix::fs::symlink(outside.path(), dir.path().join("outside")).unwrap();
        let mut value = config();
        value.cwd = "outside".into();
        assert!(workspace.prepare_run(value).is_err());
        assert!(!outside.path().join("run.json").exists());
    }
    #[test]
    fn dirty_run_file_and_pending_proposals_prevent_crud_overwriting_editor_data() {
        let dir = tempfile::tempdir().unwrap();
        let mut workspace = CoreWorkspace::open(dir.path()).unwrap();
        workspace.save_run_configuration(config()).unwrap();
        let snapshot = workspace.open_buffer(".span/run.json").unwrap();
        workspace
            .edit_buffer_delta(
                ".span/run.json",
                snapshot.revision,
                vec![crate::TextEdit {
                    from: 0,
                    to: 0,
                    insert: " ".into(),
                }],
            )
            .unwrap();
        let disk = fs::read(dir.path().join(".span/run.json")).unwrap();
        assert!(workspace.save_run_configuration(config()).is_err());
        assert_eq!(fs::read(dir.path().join(".span/run.json")).unwrap(), disk);
        let clean = workspace.discard_buffer(".span/run.json").unwrap();
        let proposal = workspace
            .stage_edit_proposal(
                ".span/run.json",
                clean.revision,
                vec![crate::TextEdit {
                    from: 0,
                    to: 0,
                    insert: " ".into(),
                }],
            )
            .unwrap();
        assert!(workspace.save_run_configuration(config()).is_err());
        workspace
            .resolve_proposal(&proposal.id, false, clean.revision)
            .unwrap();
        assert!(workspace.save_run_configuration(config()).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn configured_path_is_used_for_executable_discovery_with_exact_argument_boundaries() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("bin")).unwrap();
        let executable = dir.path().join("bin/fixture-tool");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = CoreWorkspace::open(dir.path()).unwrap();
        let mut value = config();
        value.executable = "fixture-tool".into();
        value.env = BTreeMap::from([("PATH".into(), "${workspaceFolder}/bin".into())]);
        let request = workspace.prepare_run(value.clone()).unwrap();
        assert_eq!(request.executable, executable.canonicalize().unwrap());
        assert_eq!(request.args, value.args);
    }
    #[test]
    fn variable_references_are_snapshotted_once_into_the_prepared_plan() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = CoreWorkspace::open(dir.path()).unwrap();
        let mut value = config();
        value.args = vec!["${env:TEST_SECRET}".into(), "${env:TEST_SECRET}".into()];
        let calls = std::cell::Cell::new(0);
        let request = workspace
            .prepare_run_with_env(value, |_| {
                calls.set(calls.get() + 1);
                Some(format!("value-{}", calls.get()))
            })
            .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(request.args, vec!["value-1", "value-1"]);
        assert_eq!(request.env["TOKEN"], "value-1");
    }
}
