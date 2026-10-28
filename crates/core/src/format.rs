use crate::{BufferSnapshot, CoreError, CoreWorkspace, Result, TextEdit};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const MAX_FORMAT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatRequest {
    pub path: String,
    pub revision: u64,
    pub text: String,
    pub language: String,
    pub workspace_root: String,
    pub tab_size: u32,
    pub argv: Option<Vec<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    pub path: String,
    pub revision: u64,
    pub text: String,
    pub formatter: String,
}

impl CoreWorkspace {
    /// Take under the workspace mutex, then release it before running the formatter.
    pub fn take_format_request(&self, path: &str, expected_revision: u64) -> Result<FormatRequest> {
        let snapshot = self.buffer_snapshot_bounded(path, MAX_FORMAT_BYTES)?;
        if snapshot.revision != expected_revision {
            return Err(CoreError::StaleRevision {
                expected: expected_revision,
                actual: snapshot.revision,
            });
        }
        let settings = self.get_settings()?;
        let argv = settings.formatters.get(&snapshot.language).cloned();
        Ok(FormatRequest {
            path: snapshot.path,
            revision: snapshot.revision,
            text: snapshot.text,
            language: snapshot.language,
            workspace_root: self.workspace().root,
            tab_size: settings.tab_size,
            argv,
        })
    }
    pub fn apply_format_result(&mut self, formatted: FormatResult) -> Result<BufferSnapshot> {
        if formatted.text.len() > MAX_FORMAT_BYTES {
            return Err(CoreError::Formatter(
                "Formatted document exceeds 16 MiB".into(),
            ));
        }
        let current = self.buffer_snapshot_bounded(&formatted.path, MAX_FORMAT_BYTES)?;
        if current.revision != formatted.revision {
            return Err(CoreError::StaleRevision {
                expected: formatted.revision,
                actual: current.revision,
            });
        }
        if current.text == formatted.text {
            return Ok(current);
        }
        let to = u32::try_from(current.text.encode_utf16().count())
            .map_err(|_| CoreError::Formatter("Document exceeds UTF-16 offset range".into()))?;
        self.edit_buffer(
            &formatted.path,
            formatted.revision,
            vec![TextEdit {
                from: 0,
                to,
                insert: formatted.text,
            }],
        )
    }
}

/// Safe executable discovery for native GUI processes that inherit a limited PATH.
pub fn resolve_program(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.is_absolute() || path.components().count() > 1 {
        return executable(path).then(|| path.to_owned());
    }
    resolve_in_directories(name, program_directories())
}

/// PATH for subprocess dependencies launched from a native GUI without a login shell.
pub fn native_program_path() -> Option<std::ffi::OsString> {
    std::env::join_paths(program_directories()).ok()
}

fn program_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    #[cfg(unix)]
    {
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        directories.push(PathBuf::from(&home).join(".cargo/bin"));
        directories.push(PathBuf::from(home).join(".local/bin"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&paths));
    }
    #[cfg(unix)]
    {
        directories.extend([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
    }
    directories
}
fn resolve_in_directories(
    name: &str,
    directories: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    for directory in directories {
        let candidate = directory.join(name);
        if executable(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let candidate = directory.join(format!("{name}.exe"));
            if executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}
fn executable(path: &Path) -> bool {
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

pub async fn run_formatter(request: FormatRequest) -> Result<FormatResult> {
    if request.text.len() > MAX_FORMAT_BYTES {
        return Err(CoreError::Formatter(
            "Document exceeds formatter limit of 16 MiB".into(),
        ));
    }
    if !(1..=8).contains(&request.tab_size) {
        return Err(CoreError::Formatter("Invalid indentation size".into()));
    }
    if request.argv.is_none()
        && request.language == "json"
        && Path::new(&request.path)
            .extension()
            .is_some_and(|extension| extension == "json")
    {
        reject_duplicate_json_keys(&request.text)?;
        let value: serde_json::Value = serde_json::from_str(&request.text)
            .map_err(|error| CoreError::Formatter(format!("JSON is invalid: {error}")))?;
        let indent = vec![b' '; request.tab_size as usize];
        let mut output = Vec::new();
        let mut serializer = serde_json::Serializer::with_formatter(
            &mut output,
            serde_json::ser::PrettyFormatter::with_indent(&indent),
        );
        value
            .serialize(&mut serializer)
            .map_err(|error| CoreError::Formatter(error.to_string()))?;
        output.push(b'\n');
        let text =
            String::from_utf8(output).map_err(|error| CoreError::Formatter(error.to_string()))?;
        return Ok(FormatResult {
            path: request.path,
            revision: request.revision,
            text,
            formatter: "Built-in JSON".into(),
        });
    }
    let (program, arguments, label) = formatter_command(&request)?;
    let text = run_process(
        &program,
        &arguments,
        &request.workspace_root,
        request.text,
        Duration::from_secs(10),
    )
    .await?;
    Ok(FormatResult {
        path: request.path,
        revision: request.revision,
        text,
        formatter: label,
    })
}

fn formatter_command(request: &FormatRequest) -> Result<(PathBuf, Vec<String>, String)> {
    let absolute_path = Path::new(&request.workspace_root)
        .join(&request.path)
        .to_string_lossy()
        .into_owned();
    if let Some(argv) = &request.argv {
        let name = argv
            .first()
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| {
                CoreError::Formatter("Configured formatter requires an executable".into())
            })?;
        if argv.len() > 64 || argv.iter().any(|argument| argument.contains('\0')) {
            return Err(CoreError::Formatter(
                "Invalid configured formatter arguments".into(),
            ));
        }
        let configured_path = Path::new(name);
        let configured_name =
            if configured_path.is_relative() && configured_path.components().count() > 1 {
                Path::new(&request.workspace_root)
                    .join(configured_path)
                    .to_string_lossy()
                    .into_owned()
            } else {
                name.clone()
            };
        let program = resolve_program(&configured_name).ok_or_else(|| {
            CoreError::Formatter(format!(
                "Configured formatter executable is unavailable: {name}"
            ))
        })?;
        return Ok((
            program,
            argv.iter()
                .skip(1)
                .map(|argument| argument.replace("{path}", &absolute_path))
                .collect(),
            "Configured formatter".into(),
        ));
    }
    if request.language == "rust" {
        let program = resolve_program("rustfmt").ok_or_else(|| {
            CoreError::Formatter(
                "rustfmt is unavailable. Install rustfmt or configure formatters.rust".into(),
            )
        })?;
        return Ok((
            program,
            vec![
                "--edition".into(),
                "2021".into(),
                "--emit".into(),
                "stdout".into(),
            ],
            "rustfmt".into(),
        ));
    }
    if request.language == "python" {
        let program = resolve_program("ruff").ok_or_else(|| {
            CoreError::Formatter(
                "Ruff is unavailable. Install Ruff or configure formatters.python".into(),
            )
        })?;
        return Ok((
            program,
            vec![
                "format".into(),
                "--stdin-filename".into(),
                absolute_path,
                "-".into(),
            ],
            "Ruff".into(),
        ));
    }
    if matches!(
        request.language.as_str(),
        "javascript"
            | "typescript"
            | "markdown"
            | "json"
            | "yaml"
            | "css"
            | "scss"
            | "less"
            | "html"
            | "vue"
            | "svelte"
    ) {
        for script in [
            "node_modules/prettier/bin/prettier.cjs",
            "node_modules/prettier/bin-prettier.js",
        ] {
            let script = Path::new(&request.workspace_root).join(script);
            if script.is_file() {
                let node = resolve_program("node").ok_or_else(|| {
                    CoreError::Formatter(
                        "Workspace Prettier found, but Node.js is unavailable".into(),
                    )
                })?;
                return Ok((
                    node,
                    vec![
                        script.to_string_lossy().into_owned(),
                        "--stdin-filepath".into(),
                        absolute_path,
                    ],
                    "Workspace Prettier".into(),
                ));
            }
        }
        if let Some(program) = resolve_program("prettier") {
            return Ok((
                program,
                vec!["--stdin-filepath".into(), absolute_path],
                "Prettier".into(),
            ));
        }
        return Err(CoreError::Formatter("Prettier is unavailable. Install it in this workspace or configure a language formatter".into()));
    }
    Err(CoreError::Formatter(format!(
        "No formatter is configured for {}",
        request.language
    )))
}

fn reject_duplicate_json_keys(text: &str) -> Result<()> {
    struct UniqueJson;
    impl<'de> serde::Deserialize<'de> for UniqueJson {
        fn deserialize<D: serde::Deserializer<'de>>(
            deserializer: D,
        ) -> std::result::Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = UniqueJson;
                fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                    formatter.write_str("JSON with unique object keys")
                }
                fn visit_bool<E: serde::de::Error>(
                    self,
                    _: bool,
                ) -> std::result::Result<UniqueJson, E> {
                    Ok(UniqueJson)
                }
                fn visit_i64<E: serde::de::Error>(
                    self,
                    _: i64,
                ) -> std::result::Result<UniqueJson, E> {
                    Ok(UniqueJson)
                }
                fn visit_u64<E: serde::de::Error>(
                    self,
                    _: u64,
                ) -> std::result::Result<UniqueJson, E> {
                    Ok(UniqueJson)
                }
                fn visit_f64<E: serde::de::Error>(
                    self,
                    _: f64,
                ) -> std::result::Result<UniqueJson, E> {
                    Ok(UniqueJson)
                }
                fn visit_str<E: serde::de::Error>(
                    self,
                    _: &str,
                ) -> std::result::Result<UniqueJson, E> {
                    Ok(UniqueJson)
                }
                fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<UniqueJson, E> {
                    Ok(UniqueJson)
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut sequence: A,
                ) -> std::result::Result<UniqueJson, A::Error> {
                    while sequence.next_element::<UniqueJson>()?.is_some() {}
                    Ok(UniqueJson)
                }
                fn visit_map<A: serde::de::MapAccess<'de>>(
                    self,
                    mut object: A,
                ) -> std::result::Result<UniqueJson, A::Error> {
                    let mut keys = std::collections::HashSet::new();
                    while let Some(key) = object.next_key::<String>()? {
                        if !keys.insert(key.clone()) {
                            return Err(serde::de::Error::custom(format!(
                                "Duplicate JSON key: {key}"
                            )));
                        }
                        object.next_value::<UniqueJson>()?;
                    }
                    Ok(UniqueJson)
                }
            }
            deserializer.deserialize_any(Visitor)
        }
    }
    let mut deserializer = serde_json::Deserializer::from_str(text);
    UniqueJson::deserialize(&mut deserializer)
        .map_err(|error| CoreError::Formatter(error.to_string()))?;
    deserializer
        .end()
        .map_err(|error| CoreError::Formatter(error.to_string()))
}

async fn read_limited(reader: impl AsyncRead + Unpin, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut output)
        .await?;
    Ok(output)
}
async fn run_process(
    program: &Path,
    arguments: &[String],
    cwd: &str,
    text: String,
    timeout: Duration,
) -> Result<String> {
    let mut command = Command::new(program);
    if let Some(paths) = native_program_path() {
        command.env("PATH", paths);
    }
    let mut child = command
        .args(arguments)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| CoreError::Formatter(format!("Start {}: {error}", program.display())))?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| CoreError::Formatter("Formatter stdin is unavailable".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::Formatter("Formatter stdout is unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CoreError::Formatter("Formatter stderr is unavailable".into()))?;
    let input_task = tokio::spawn(async move {
        input.write_all(text.as_bytes()).await?;
        input.shutdown().await
    });
    let output_task = tokio::spawn(read_limited(stdout, MAX_FORMAT_BYTES));
    let error_task = tokio::spawn(read_limited(stderr, 64 * 1024));
    let input_abort = input_task.abort_handle();
    let output_abort = output_task.abort_handle();
    let error_abort = error_task.abort_handle();
    let operation = async {
        let status = child
            .wait()
            .await
            .map_err(|error| CoreError::Formatter(format!("Wait for formatter: {error}")))?;
        let (output, errors, input_result) = tokio::join!(output_task, error_task, input_task);
        let output = output
            .map_err(|error| CoreError::Formatter(error.to_string()))?
            .map_err(|error| CoreError::Formatter(format!("Read formatter output: {error}")))?;
        let errors = errors
            .map_err(|error| CoreError::Formatter(error.to_string()))?
            .map_err(|error| {
                CoreError::Formatter(format!("Read formatter diagnostics: {error}"))
            })?;
        let input_result = input_result.map_err(|error| CoreError::Formatter(error.to_string()))?;
        Ok::<_, CoreError>((status, output, errors, input_result))
    };
    let (status, output, errors, input_result) =
        match tokio::time::timeout(timeout, operation).await {
            Ok(result) => result?,
            Err(_) => {
                let _ = child.kill().await;
                input_abort.abort();
                output_abort.abort();
                error_abort.abort();
                return Err(CoreError::Formatter(format!(
                    "Formatter timed out and was stopped after {} seconds",
                    timeout.as_secs_f64()
                )));
            }
        };
    if !status.success() {
        return Err(CoreError::Formatter(format!(
            "{} exited with {status}: {}",
            program.display(),
            String::from_utf8_lossy(&errors).trim()
        )));
    }
    input_result
        .map_err(|error| CoreError::Formatter(format!("Write document to formatter: {error}")))?;
    if output.len() > MAX_FORMAT_BYTES {
        return Err(CoreError::Formatter(
            "Formatter output exceeds 16 MiB".into(),
        ));
    }
    String::from_utf8(output)
        .map_err(|error| CoreError::Formatter(format!("Formatter returned invalid UTF-8: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_formatter_process() {
        let error = run_process(
            Path::new("/bin/sleep"),
            &["2".into()],
            "/",
            String::new(),
            Duration::from_millis(25),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_also_bounds_inherited_output_pipe_after_parent_exits() {
        let started = std::time::Instant::now();
        let error = run_process(
            Path::new("/bin/sh"),
            &["-c".into(), "sleep 2 & exit 0".into()],
            "/",
            String::new(),
            Duration::from_millis(25),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    #[cfg(unix)]
    #[test]
    fn executable_resolver_checks_custom_directories_without_shell() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let program = directory.path().join("fake-formatter");
        std::fs::write(&program, "#!/bin/sh\ncat\n").unwrap();
        assert!(resolve_in_directories("fake-formatter", [directory.path().to_owned()]).is_none());
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            resolve_in_directories("fake-formatter", [directory.path().to_owned()]),
            Some(program.clone())
        );
        assert_eq!(resolve_program(&program.to_string_lossy()), Some(program));
    }
}
