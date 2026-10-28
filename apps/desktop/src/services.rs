use crate::DesktopState;
use serde::{Deserialize, Serialize};
use span_core::{BufferSnapshot, SessionState, SessionStore};
use specta::Type;
use std::sync::{Arc, Mutex};
use tauri::State;
use tauri_specta::Event;

fn current_workspace(state: &DesktopState) -> Result<Arc<Mutex<span_core::CoreWorkspace>>, String> {
    state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a folder first".to_owned())
}

enum FormatPreparation {
    Saved(BufferSnapshot),
    Format(span_core::FormatRequest),
    Unformatted(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct FormatWarning {
    pub path: String,
    pub message: String,
}

pub type FormatWarningSink = Arc<dyn Fn(FormatWarning) + Send + Sync>;

pub async fn format_or_save(
    state: DesktopState,
    path: String,
    expected_revision: u64,
    save: bool,
) -> Result<BufferSnapshot, String> {
    format_or_save_with_warning(state, path, expected_revision, save, None).await
}

async fn save_unformatted(
    state: DesktopState,
    workspace: Arc<Mutex<span_core::CoreWorkspace>>,
    path: String,
    expected_revision: u64,
    message: String,
    warning: Option<FormatWarningSink>,
) -> Result<BufferSnapshot, String> {
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let current = current_workspace(&state)?;
        if !Arc::ptr_eq(&current, &workspace) {
            return Err("Workspace changed while formatting. Run Save again.".to_owned());
        }
        // Saving the authoritative buffer checks the original revision and disk state.
        // A draft edited during formatter execution is never replaced or saved here.
        workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .save_buffer(&path, expected_revision)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Save task failed: {error}"))??;
    if let Some(warning) = warning {
        warning(FormatWarning {
            path: snapshot.path.clone(),
            message,
        });
    }
    Ok(snapshot)
}

pub async fn format_or_save_with_warning(
    state: DesktopState,
    path: String,
    expected_revision: u64,
    save: bool,
    warning: Option<FormatWarningSink>,
) -> Result<BufferSnapshot, String> {
    let workspace = current_workspace(&state)?;
    let worker_workspace = workspace.clone();
    let worker_path = path.clone();
    let preparation = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = worker_workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        if save {
            // Settings files preserve JSONC comments and use core schema validation on save.
            if std::path::Path::new(&worker_path).ends_with(".span/settings.jsonc") {
                return guard
                    .save_buffer(&worker_path, expected_revision)
                    .map(FormatPreparation::Saved)
                    .map_err(|error| error.to_string());
            }
            match guard.get_settings() {
                Ok(settings) if !settings.format_on_save => {
                    return guard
                        .save_buffer(&worker_path, expected_revision)
                        .map(FormatPreparation::Saved)
                        .map_err(|error| error.to_string())
                }
                Err(error) => return Ok(FormatPreparation::Unformatted(error.to_string())),
                _ => {}
            }
        }
        match guard.take_format_request(&worker_path, expected_revision) {
            Ok(request) => Ok(FormatPreparation::Format(request)),
            Err(error) if save => Ok(FormatPreparation::Unformatted(error.to_string())),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|error| format!("Prepare format task failed: {error}"))??;
    let request = match preparation {
        FormatPreparation::Saved(snapshot) => return Ok(snapshot),
        FormatPreparation::Unformatted(message) => {
            return save_unformatted(state, workspace, path, expected_revision, message, warning)
                .await
        }
        FormatPreparation::Format(request) => request,
    };
    let attempt = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(span_core::run_formatter(request))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Formatter task failed: {error}"))
    .and_then(|result| result);
    let formatted = match attempt {
        Ok(formatted) => formatted,
        Err(message) if save => {
            return save_unformatted(state, workspace, path, expected_revision, message, warning)
                .await
        }
        Err(message) => return Err(message),
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let current = current_workspace(&state)?;
        if !Arc::ptr_eq(&current, &workspace) {
            return Err("Workspace changed while formatting. Run the command again.".to_owned());
        }
        let mut guard = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        let snapshot = match guard.apply_format_result(formatted) {
            Ok(snapshot) => snapshot,
            Err(error) if save => {
                let saved = guard
                    .save_buffer(&path, expected_revision)
                    .map_err(|error| error.to_string())?;
                return Ok((saved, Some(error.to_string())));
            }
            Err(error) => return Err(error.to_string()),
        };
        if save {
            guard
                .save_buffer(&snapshot.path, snapshot.revision)
                .map(|saved| (saved, None))
                .map_err(|error| error.to_string())
        } else {
            Ok((snapshot, None))
        }
    })
    .await
    .map_err(|error| format!("Apply format task failed: {error}"))??;
    if let (Some(message), Some(warning)) = (result.1, warning) {
        warning(FormatWarning {
            path: result.0.path.clone(),
            message,
        });
    }
    Ok(result.0)
}

#[tauri::command]
#[specta::specta]
pub async fn format_buffer(
    state: State<'_, DesktopState>,
    path: String,
    expected_revision: u64,
) -> Result<BufferSnapshot, String> {
    format_or_save(state.inner().clone(), path, expected_revision, false).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_session(state: State<'_, DesktopState>) -> Result<Option<SessionState>, String> {
    let _gate = state.session_gate.lock().await;
    tauri::async_runtime::spawn_blocking(|| {
        SessionStore::for_current_user()
            .and_then(|store| store.load())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Load session task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn save_session(
    state: State<'_, DesktopState>,
    session: SessionState,
) -> Result<(), String> {
    let _gate = state.session_gate.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        SessionStore::for_current_user()
            .and_then(|store| store.save(session))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Save session task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn list_tools() -> Result<Vec<span_core::ToolInfo>, String> {
    tauri::async_runtime::spawn_blocking(span_core::list_tools)
        .await
        .map_err(|error| format!("Tool detection task failed: {error}"))
}

#[tauri::command]
#[specta::specta]
pub async fn recent_projects() -> Result<Vec<span_core::RecentProject>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        span_core::RecentProjectStore::for_current_user()
            .and_then(|store| store.load())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Load recent projects task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn remove_recent_project(root: String) -> Result<Vec<span_core::RecentProject>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        span_core::RecentProjectStore::for_current_user()
            .and_then(|store| store.remove(&root))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Remove recent project task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn clear_recent_projects() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        span_core::RecentProjectStore::for_current_user()
            .and_then(|store| store.clear())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Clear recent projects task failed: {error}"))?
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NativeWindowState {
    pub fullscreen: bool,
    pub maximized: bool,
    pub has_native_traffic_lights: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn native_window_state(
    window: tauri::WebviewWindow,
) -> Result<NativeWindowState, String> {
    let fullscreen = window.is_fullscreen().map_err(|error| error.to_string())?;
    Ok(NativeWindowState {
        fullscreen,
        maximized: window.is_maximized().map_err(|error| error.to_string())?,
        has_native_traffic_lights: cfg!(target_os = "macos")
            && !fullscreen
            && window.is_decorated().map_err(|error| error.to_string())?,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn read_clipboard(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn write_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|error| error.to_string())
}

fn external_url(value: &str) -> Result<String, String> {
    if value.len() > 16_384 || value.chars().any(char::is_control) {
        return Err(
            "External link contains invalid characters or exceeds the size limit".to_owned(),
        );
    }
    let url =
        tauri::Url::parse(value).map_err(|_| "External link is not a valid URL".to_owned())?;
    if !matches!(url.scheme(), "https" | "http" | "mailto") {
        return Err("Only http, https and mailto links can open externally".to_owned());
    }
    if matches!(url.scheme(), "https" | "http") && url.host_str().is_none() {
        return Err("External web link requires a host".to_owned());
    }
    Ok(url.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn open_external(url: String) -> Result<(), String> {
    let url = external_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = std::process::Command::new("/usr/bin/open");
            command.arg("--");
            command
        };
        #[cfg(target_os = "windows")]
        let mut command = {
            let system = std::env::var_os("SystemRoot")
                .ok_or_else(|| "Windows system directory is unavailable".to_owned())?;
            let mut command = std::process::Command::new(
                std::path::PathBuf::from(system).join("System32/rundll32.exe"),
            );
            command.arg("url.dll,FileProtocolHandler");
            command
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let mut command = std::process::Command::new(
            span_core::resolve_program("xdg-open")
                .ok_or_else(|| "No external URL opener is installed".to_owned())?,
        );
        let status = command
            .arg(url)
            .status()
            .map_err(|error| format!("Open external link: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("External URL opener exited with {status}"))
        }
    })
    .await
    .map_err(|error| format!("Open external link task failed: {error}"))?
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageSource {
    pub mime: String,
    pub data_url: String,
}

#[tauri::command]
#[specta::specta]
pub async fn read_image(
    state: State<'_, DesktopState>,
    path: String,
) -> Result<ImageSource, String> {
    let workspace = current_workspace(state.inner())?;
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let image = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .read_image(&path, 8 * 1024 * 1024)
            .map_err(|error| error.to_string())?;
        Ok(ImageSource {
            data_url: format!(
                "data:{};base64,{}",
                image.mime,
                base64::engine::general_purpose::STANDARD.encode(image.data)
            ),
            mime: image.mime,
        })
    })
    .await
    .map_err(|error| format!("Read image task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    fn dirty_workspace(formatter: Vec<String>) -> (tempfile::TempDir, crate::DesktopState, u64) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("draft.ts"),
            "const original = true;\n",
        )
        .unwrap();
        let mut workspace = span_core::CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(None);
        let mut settings = span_core::Settings {
            format_on_save: true,
            ..Default::default()
        };
        settings.formatters.insert("typescript".into(), formatter);
        workspace.update_settings(settings).unwrap();
        workspace.open_buffer("draft.ts").unwrap();
        let edited = workspace
            .edit_buffer_delta(
                "draft.ts",
                0,
                vec![span_core::TextEdit {
                    from: 0,
                    to: 0,
                    insert: "// unsaved draft\n".into(),
                }],
            )
            .unwrap();
        let state = crate::DesktopState::default();
        *state.workspace.lock().unwrap() =
            Some(std::sync::Arc::new(std::sync::Mutex::new(workspace)));
        (directory, state, edited.revision)
    }

    #[tokio::test]
    async fn settings_jsonc_save_preserves_comments_without_invoking_a_formatter() {
        let (directory, state, _) =
            dirty_workspace(vec!["span-nonexistent-formatter-fixture".into()]);
        let revision = {
            let workspace = super::current_workspace(&state).unwrap();
            let mut workspace = workspace.lock().unwrap();
            let snapshot = workspace.open_buffer(".span/settings.jsonc").unwrap();
            workspace
                .edit_buffer_delta(
                    ".span/settings.jsonc",
                    snapshot.revision,
                    vec![span_core::TextEdit {
                        from: 0,
                        to: 0,
                        insert: "// retained settings comment\n".into(),
                    }],
                )
                .unwrap()
                .revision
        };
        let notices = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let captured = notices.clone();
        let saved = super::format_or_save_with_warning(
            state,
            ".span/settings.jsonc".into(),
            revision,
            true,
            Some(std::sync::Arc::new(move |_| {
                captured.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            })),
        )
        .await
        .unwrap();
        assert!(saved.text.starts_with("// retained settings comment\n"));
        assert_eq!(notices.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            std::fs::read_to_string(directory.path().join(".span/settings.jsonc")).unwrap(),
            saved.text
        );
    }

    #[tokio::test]
    async fn format_on_save_missing_formatter_still_saves_original_draft() {
        let (directory, state, revision) =
            dirty_workspace(vec!["span-nonexistent-formatter-fixture".into()]);
        let saved = super::format_or_save(state, "draft.ts".into(), revision, true)
            .await
            .unwrap();
        assert_eq!(saved.saved_revision, revision);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("draft.ts")).unwrap(),
            "// unsaved draft\nconst original = true;\n"
        );
    }

    fn hanging_formatter() -> Vec<String> {
        vec![
            std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            "--exact".into(),
            "services::tests::formatter_timeout_fixture".into(),
            "--nocapture".into(),
        ]
    }

    #[test]
    fn formatter_timeout_fixture() {
        // Only the separately spawned formatter process selects this exact fixture.
        let arguments: Vec<_> = std::env::args().collect();
        if arguments.windows(2).any(|pair| {
            pair[0] == "--exact" && pair[1] == "services::tests::formatter_timeout_fixture"
        }) {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }

    #[tokio::test]
    async fn format_on_save_timeout_falls_back_to_original_draft() {
        let (directory, state, revision) = dirty_workspace(hanging_formatter());
        let saved = super::format_or_save(state, "draft.ts".into(), revision, true)
            .await
            .unwrap();
        assert_eq!(saved.saved_revision, revision);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("draft.ts")).unwrap(),
            saved.text
        );
        assert_eq!(saved.text, "// unsaved draft\nconst original = true;\n");
    }

    #[tokio::test]
    async fn edits_during_formatter_wait_are_never_saved_by_fallback() {
        let (directory, state, revision) = dirty_workspace(hanging_formatter());
        let task = tokio::spawn(super::format_or_save(
            state.clone(),
            "draft.ts".into(),
            revision,
            true,
        ));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let workspace = super::current_workspace(&state).unwrap();
        workspace
            .lock()
            .unwrap()
            .edit_buffer_delta(
                "draft.ts",
                revision,
                vec![span_core::TextEdit {
                    from: 0,
                    to: 0,
                    insert: "// newer edit\n".into(),
                }],
            )
            .unwrap();
        let error = task.await.unwrap().unwrap_err();
        assert!(error.contains("Expected revision"), "{error}");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("draft.ts")).unwrap(),
            "const original = true;\n"
        );
        let current = workspace
            .lock()
            .unwrap()
            .buffer_snapshot("draft.ts")
            .unwrap();
        assert_eq!(current.saved_revision, 0);
        assert!(current.text.starts_with("// newer edit"));
    }

    #[tokio::test]
    async fn formatter_failure_never_hides_real_disk_conflict_or_clears_dirty_state() {
        let (directory, state, revision) =
            dirty_workspace(vec!["span-nonexistent-formatter-fixture".into()]);
        std::fs::write(directory.path().join("draft.ts"), "external change\n").unwrap();
        let error = super::format_or_save(state.clone(), "draft.ts".into(), revision, true)
            .await
            .unwrap_err();
        assert!(error.contains("File changed on disk"), "{error}");
        let current = super::current_workspace(&state)
            .unwrap()
            .lock()
            .unwrap()
            .buffer_snapshot("draft.ts")
            .unwrap();
        assert_eq!(current.saved_revision, 0);
        assert_eq!(current.revision, revision);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("draft.ts")).unwrap(),
            "external change\n"
        );
    }

    #[tokio::test]
    async fn manual_format_still_errors_and_never_saves() {
        let (directory, state, revision) =
            dirty_workspace(vec!["span-nonexistent-formatter-fixture".into()]);
        assert!(
            super::format_or_save(state, "draft.ts".into(), revision, false)
                .await
                .unwrap_err()
                .contains("formatter executable is unavailable")
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("draft.ts")).unwrap(),
            "const original = true;\n"
        );
    }

    #[tokio::test]
    async fn advisory_is_emitted_only_after_successful_fallback_save() {
        let (directory, state, revision) =
            dirty_workspace(vec!["span-nonexistent-formatter-fixture".into()]);
        let warnings = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = warnings.clone();
        let sink: super::FormatWarningSink =
            std::sync::Arc::new(move |warning| captured.lock().unwrap().push(warning));
        let saved = super::format_or_save_with_warning(
            state.clone(),
            "draft.ts".into(),
            revision,
            true,
            Some(sink.clone()),
        )
        .await
        .unwrap();
        assert_eq!(warnings.lock().unwrap().len(), 1);
        assert_eq!(warnings.lock().unwrap()[0].path, "draft.ts");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("draft.ts")).unwrap(),
            saved.text
        );
        std::fs::write(directory.path().join("draft.ts"), "external\n").unwrap();
        assert!(super::format_or_save_with_warning(
            state,
            "draft.ts".into(),
            revision,
            true,
            Some(sink)
        )
        .await
        .is_err());
        assert_eq!(warnings.lock().unwrap().len(), 1);
    }

    #[test]
    fn external_links_are_limited_to_web_and_mail() {
        for value in [
            "https://example.com/docs",
            "http://localhost:3000/",
            "mailto:hello@example.com",
        ] {
            assert!(super::external_url(value).is_ok());
        }
        for value in [
            "javascript:alert(1)",
            "file:///tmp/x",
            "data:text/html,hello",
            "https://example.com/\nfile",
        ] {
            assert!(super::external_url(value).is_err());
        }
    }
}
