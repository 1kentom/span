use crate::{BufferSnapshot, CoreError, CoreWorkspace, Result, TextEdit};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::OnceLock;
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
    run_formatter_cancellable(request, crate::CancellationToken::default()).await
}

pub async fn run_formatter_cancellable(
    request: FormatRequest,
    cancellation: crate::CancellationToken,
) -> Result<FormatResult> {
    if cancellation.is_cancelled() {
        return Err(CoreError::Formatter(
            "Formatting request was cancelled".into(),
        ));
    }
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
    }
    if request.argv.is_none()
        && native_language(&request)
        && formatter_config(&request).is_none()
        && workspace_prettier_script(&request).is_none()
        && resolve_program("prettier").is_none()
    {
        let permit = acquire_native_permit(&cancellation).await?;
        let formatter = native_formatter_label(&request);
        let path = Path::new(&request.path).to_owned();
        let text = request.text;
        let language = request.language;
        let tab_size = request.tab_size;
        let task_cancel = cancellation.clone();
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let result = crate::format_native::format(&path, &text, &language, tab_size);
            if task_cancel.is_cancelled() {
                return Err(CoreError::Formatter(
                    "Formatting request was cancelled".into(),
                ));
            }
            result
        });
        let formatted = tokio::select! {
            result = task => result.map_err(|error| CoreError::Formatter(format!("Native formatter task failed: {error}")))??,
            _ = wait_cancelled(&cancellation) => return Err(CoreError::Formatter("Formatting request was cancelled".into())),
            _ = tokio::time::sleep(Duration::from_secs(10)) => {
                cancellation.cancel();
                return Err(CoreError::Formatter("Native formatter timed out after 10 seconds; its bounded worker will finish in the background".into()));
            }
        };
        if formatted.len() > MAX_FORMAT_BYTES {
            return Err(CoreError::Formatter(
                "Formatted document exceeds 16 MiB".into(),
            ));
        }
        return Ok(FormatResult {
            path: request.path,
            revision: request.revision,
            text: formatted,
            formatter,
        });
    }
    let (program, arguments, label) = formatter_command(&request)?;
    let text = run_process(
        &program,
        &arguments,
        &request.workspace_root,
        request.text,
        Duration::from_secs(10),
        cancellation,
    )
    .await?;
    Ok(FormatResult {
        path: request.path,
        revision: request.revision,
        text,
        formatter: label,
    })
}

fn native_language(request: &FormatRequest) -> bool {
    let extension = Path::new(&request.path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match request.language.as_str() {
        "javascript" => matches!(extension.as_str(), "js" | "jsx" | "mjs" | "cjs"),
        "typescript" => matches!(extension.as_str(), "ts" | "tsx" | "mts" | "cts"),
        "json" => matches!(extension.as_str(), "json" | "jsonc"),
        "markdown" => matches!(extension.as_str(), "md" | "markdown"),
        _ => false,
    }
}

fn native_formatter_label(request: &FormatRequest) -> String {
    match request.language.as_str() {
        "javascript" | "typescript" => "dprint TypeScript".into(),
        "json" => "dprint JSON".into(),
        "markdown" => "dprint Markdown".into(),
        _ => "dprint".into(),
    }
}

fn formatter_config(request: &FormatRequest) -> Option<String> {
    let root = Path::new(&request.workspace_root);
    let path = root.join(&request.path);
    let parent = path.parent().unwrap_or(root);
    let mut directories = Vec::new();
    let mut current = parent;
    loop {
        directories.push(current.to_owned());
        if current == root || !current.starts_with(root) {
            break;
        }
        let Some(next) = current.parent() else { break };
        current = next;
    }
    let names = [
        ".prettierrc",
        ".prettierrc.json",
        ".prettierrc.jsonc",
        ".prettierrc.yaml",
        ".prettierrc.yml",
        ".prettierrc.js",
        ".prettierrc.cjs",
        ".prettierrc.mjs",
        ".prettierrc.toml",
        "prettier.config.js",
        "prettier.config.cjs",
        "prettier.config.mjs",
        "prettier.config.ts",
        "biome.json",
        "biome.jsonc",
        "dprint.json",
        "dprint.jsonc",
        ".dprint.json",
        ".dprint.jsonc",
        "deno.json",
        "deno.jsonc",
    ];
    for directory in directories {
        for name in names {
            if directory.join(name).is_file() {
                return Some(directory.join(name).display().to_string());
            }
        }
        let package_json = directory.join("package.json");
        if let Ok(contents) = std::fs::read_to_string(&package_json) {
            if serde_json::from_str::<serde_json::Value>(&contents)
                .ok()
                .and_then(|value| value.get("prettier").cloned())
                .is_some()
            {
                return Some(package_json.display().to_string());
            }
        }
        if directory == root {
            break;
        }
    }
    None
}

fn is_prettier_config(path: &str) -> bool {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name.contains("prettier") {
        return true;
    }
    if file_name == "package.json" {
        return std::fs::read_to_string(path)
            .ok()
            .and_then(|contents| serde_json::from_str::<serde_json::Value>(&contents).ok())
            .is_some_and(|value| value.get("prettier").is_some());
    }
    false
}

fn project_formatter_kind(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "dprint.json" | "dprint.jsonc" | ".dprint.json" | ".dprint.jsonc" => Some("dprint"),
        "biome.json" | "biome.jsonc" => Some("biome"),
        _ => None,
    }
}

fn workspace_prettier_script(request: &FormatRequest) -> Option<PathBuf> {
    let root = Path::new(&request.workspace_root);
    let path = root.join(&request.path);
    let directory = path.parent().unwrap_or(root);
    [
        "node_modules/prettier/bin/prettier.cjs",
        "node_modules/prettier/bin-prettier.js",
    ]
    .iter()
    .find_map(|script| {
        let mut current = directory;
        loop {
            let candidate = current.join(script);
            if candidate.is_file() {
                return Some(candidate);
            }
            if current == root || !current.starts_with(root) {
                return None;
            }
            current = current.parent()?;
        }
    })
}

static NATIVE_FORMATTERS: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
static EXTERNAL_FORMATTERS: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();

async fn acquire_native_permit(
    cancellation: &crate::CancellationToken,
) -> Result<tokio::sync::OwnedSemaphorePermit> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let semaphore =
        NATIVE_FORMATTERS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));
    loop {
        if cancellation.is_cancelled() {
            return Err(CoreError::Formatter(
                "Formatting request was cancelled".into(),
            ));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(CoreError::Formatter(
                "Timed out waiting for a native formatter worker".into(),
            ));
        }
        match tokio::time::timeout(
            remaining.min(Duration::from_millis(50)),
            semaphore.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => return Ok(permit),
            Ok(Err(_)) => {
                return Err(CoreError::Formatter(
                    "Native formatter is unavailable".into(),
                ))
            }
            Err(_) => continue,
        }
    }
}

async fn acquire_external_permit(
    cancellation: &crate::CancellationToken,
) -> Result<tokio::sync::OwnedSemaphorePermit> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let semaphore =
        EXTERNAL_FORMATTERS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)));
    loop {
        if cancellation.is_cancelled() {
            return Err(CoreError::Formatter(
                "Formatting request was cancelled".into(),
            ));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(CoreError::Formatter(
                "Timed out waiting for an external formatter worker".into(),
            ));
        }
        match tokio::time::timeout(
            remaining.min(Duration::from_millis(50)),
            semaphore.clone().acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => return Ok(permit),
            Ok(Err(_)) => {
                return Err(CoreError::Formatter(
                    "External formatter is unavailable".into(),
                ))
            }
            Err(_) => continue,
        }
    }
}

async fn wait_cancelled(cancellation: &crate::CancellationToken) {
    while !cancellation.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
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
        if let Some(config) = formatter_config(request) {
            if project_formatter_kind(&config) == Some("dprint") {
                let program = resolve_program("dprint").ok_or_else(|| {
                    CoreError::Formatter(format!(
                        "Project formatter configuration found at {config}, but dprint is unavailable"
                    ))
                })?;
                return Ok((
                    program,
                    vec![
                        "fmt".into(),
                        "--config".into(),
                        config,
                        "--stdin".into(),
                        absolute_path,
                    ],
                    "Workspace dprint".into(),
                ));
            }
            if project_formatter_kind(&config) == Some("biome") {
                let program = resolve_program("biome").ok_or_else(|| {
                    CoreError::Formatter(format!(
                        "Project formatter configuration found at {config}, but Biome is unavailable"
                    ))
                })?;
                return Ok((
                    program,
                    vec![
                        "format".into(),
                        format!("--stdin-file-path={absolute_path}"),
                    ],
                    "Workspace Biome".into(),
                ));
            }
            if !is_prettier_config(&config) {
                return Err(CoreError::Formatter(format!(
                    "Project formatter configuration found at {config}. Configure its executable in Span settings to preserve the project style."
                )));
            }
        }
        if let Some(script) = workspace_prettier_script(request) {
            let node = resolve_program("node").ok_or_else(|| {
                CoreError::Formatter("Workspace Prettier found, but Node.js is unavailable".into())
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
        if let Some(program) = resolve_program("prettier") {
            if let Some(config) = formatter_config(request) {
                return Err(CoreError::Formatter(format!(
                    "Project formatter configuration found at {config}, but its pinned formatter is unavailable. Configure its executable in Span settings to preserve the project style."
                )));
            }
            return Ok((
                program,
                vec!["--stdin-filepath".into(), absolute_path],
                "Prettier".into(),
            ));
        }
        if let Some(config) = formatter_config(request) {
            return Err(CoreError::Formatter(format!(
                "Project formatter configuration found at {config}, but its formatter is unavailable. Configure its executable in Span settings to preserve the project style."
            )));
        }
        if native_language(request) {
            return Err(CoreError::Formatter(
                "Native formatting was not selected".into(),
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
    cancellation: crate::CancellationToken,
) -> Result<String> {
    let _permit = acquire_external_permit(&cancellation).await?;
    let mut command = Command::new(program);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
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
    #[cfg(unix)]
    let process_group = child
        .id()
        .ok_or_else(|| CoreError::Formatter("Formatter process ID is unavailable".into()))?
        as i32;
    #[cfg(windows)]
    let process_group = match WindowsProcessGroup::attach(&child) {
        Ok(group) => group,
        Err(error) => {
            let _ = child.kill().await;
            return Err(CoreError::Formatter(format!(
                "Could not contain formatter process tree: {error}"
            )));
        }
    };
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
    let (status, output, errors, input_result) = tokio::select! {
        result = tokio::time::timeout(timeout, operation) => match result {
            Ok(result) => result?,
            Err(_) => {
                stop_formatter_process(&mut child, &process_group).await;
                input_abort.abort();
                output_abort.abort();
                error_abort.abort();
                return Err(CoreError::Formatter(format!(
                    "Formatter timed out and was stopped after {} seconds",
                    timeout.as_secs_f64()
                )));
            }
        },
        _ = wait_cancelled(&cancellation) => {
            stop_formatter_process(&mut child, &process_group).await;
            input_abort.abort();
            output_abort.abort();
            error_abort.abort();
            return Err(CoreError::Formatter("Formatting request was cancelled".into()));
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

#[cfg(unix)]
async fn stop_formatter_process(child: &mut tokio::process::Child, process_group: &i32) {
    // Keep the group ID captured at spawn time. Child::id() becomes None after
    // wait() reaps a formatter whose descendant still holds an output pipe.
    // Each formatter gets its own process group so wrappers and descendants
    // are stopped together when cancellation or timeout wins.
    unsafe {
        libc::kill(-*process_group, libc::SIGKILL);
    }
    let _ = child.kill().await;
}

#[cfg(windows)]
async fn stop_formatter_process(child: &mut tokio::process::Child, group: &WindowsProcessGroup) {
    group.terminate();
    let _ = child.kill().await;
}

#[cfg(windows)]
struct WindowsProcessGroup(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl WindowsProcessGroup {
    fn attach(child: &tokio::process::Child) -> std::io::Result<Self> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::{
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
            },
        };

        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if configured == 0 {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE,
                0,
                child
                    .id()
                    .ok_or_else(|| std::io::Error::other("Formatter process ID is unavailable"))?,
            );
            if process.is_null() {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process as HANDLE);
            if assigned == 0 {
                let error = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self(job))
        }
    }

    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsProcessGroup {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn project_formatter_configs_are_detected_before_native_fallback() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("package.json"),
            r#"{"name":"fixture","prettier":{"singleQuote":true}}"#,
        )
        .unwrap();
        let request = FormatRequest {
            path: "src/main.ts".into(),
            revision: 3,
            text: "const x=1".into(),
            language: "typescript".into(),
            workspace_root: directory.path().to_string_lossy().into_owned(),
            tab_size: 2,
            argv: None,
        };
        assert!(formatter_config(&request)
            .unwrap()
            .ends_with("package.json"));
        assert!(native_language(&request));
    }

    #[test]
    fn project_formatter_selection_uses_config_basename_not_workspace_path() {
        let directory = tempfile::tempdir().unwrap();
        let nested = directory.path().join("dprint");
        std::fs::create_dir(&nested).unwrap();
        let config = nested.join(".prettierrc");
        std::fs::write(&config, "{}").unwrap();
        let request = FormatRequest {
            path: "dprint/main.ts".into(),
            revision: 1,
            text: "const x=1".into(),
            language: "typescript".into(),
            workspace_root: directory.path().to_string_lossy().into_owned(),
            tab_size: 2,
            argv: None,
        };
        let detected = formatter_config(&request).unwrap();
        assert_eq!(Path::new(&detected).file_name().unwrap(), ".prettierrc");
        assert_eq!(project_formatter_kind(&detected), None);
        assert!(is_prettier_config(&detected));
    }

    #[test]
    fn formatted_result_cannot_replace_a_newer_rope_revision() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("draft.ts"), "const original = 1;\n").unwrap();
        let mut workspace = CoreWorkspace::open(directory.path()).unwrap();
        workspace.open_buffer("draft.ts").unwrap();
        let request = workspace.take_format_request("draft.ts", 0).unwrap();
        let newer = workspace
            .edit_buffer_delta(
                "draft.ts",
                0,
                vec![TextEdit {
                    from: 0,
                    to: 0,
                    insert: "// newer draft\n".into(),
                }],
            )
            .unwrap();
        assert!(matches!(
            workspace.apply_format_result(FormatResult {
                path: request.path,
                revision: request.revision,
                text: "const formatted = 1;\n".into(),
                formatter: "test".into(),
            }),
            Err(CoreError::StaleRevision { .. })
        ));
        let current = workspace.buffer_snapshot("draft.ts").unwrap();
        assert_eq!(current.revision, newer.revision);
        assert!(current.text.starts_with("// newer draft"));
    }

    #[tokio::test]
    async fn already_cancelled_request_does_not_start_a_formatter() {
        let request = FormatRequest {
            path: "draft.ts".into(),
            revision: 1,
            text: "const x=1".into(),
            language: "typescript".into(),
            workspace_root: "/unused".into(),
            tab_size: 2,
            argv: None,
        };
        let cancellation = crate::CancellationToken::default();
        cancellation.cancel();
        assert!(run_formatter_cancellable(request, cancellation)
            .await
            .unwrap_err()
            .to_string()
            .contains("cancelled"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_formatter_process() {
        let error = run_process(
            Path::new("/bin/sleep"),
            &["2".into()],
            "/",
            String::new(),
            Duration::from_millis(25),
            crate::CancellationToken::default(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_also_bounds_inherited_output_pipe_after_parent_exits() {
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("formatter-descendant.pid");
        let script = format!("sleep 30 & echo $! > '{}' ; exit 0", pid_file.display());
        let started = std::time::Instant::now();
        let error = run_process(
            Path::new("/bin/sh"),
            &["-c".into(), script, "sh".into()],
            "/",
            String::new(),
            Duration::from_millis(25),
            crate::CancellationToken::default(),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));

        let descendant: i32 = std::fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let reaped = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let alive = unsafe { libc::kill(descendant, 0) == 0 };
                if !alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            reaped.is_ok(),
            "formatter descendant {descendant} survived timeout"
        );
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
