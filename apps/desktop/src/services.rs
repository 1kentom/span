use crate::DesktopState;
use serde::Serialize;
use span_core::{BufferSnapshot, SessionState, SessionStore};
use specta::Type;
use std::sync::{Arc, Mutex};
use tauri::State;

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
}

pub async fn format_or_save(
    state: DesktopState,
    path: String,
    expected_revision: u64,
    save: bool,
) -> Result<BufferSnapshot, String> {
    let workspace = current_workspace(&state)?;
    let worker_workspace = workspace.clone();
    let preparation = tauri::async_runtime::spawn_blocking(move || {
        let mut guard = worker_workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        if save
            && !guard
                .get_settings()
                .map_err(|error| error.to_string())?
                .format_on_save
        {
            return guard
                .save_buffer(&path, expected_revision)
                .map(FormatPreparation::Saved)
                .map_err(|error| error.to_string());
        }
        guard
            .take_format_request(&path, expected_revision)
            .map(FormatPreparation::Format)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Prepare format task failed: {error}"))??;
    let request = match preparation {
        FormatPreparation::Saved(snapshot) => return Ok(snapshot),
        FormatPreparation::Format(request) => request,
    };
    // Both built-in formatting and subprocess setup run away from the renderer thread.
    let formatted = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(span_core::run_formatter(request))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Formatter task failed: {error}"))??;
    tauri::async_runtime::spawn_blocking(move || {
        let current = current_workspace(&state)?;
        if !Arc::ptr_eq(&current, &workspace) {
            return Err("Workspace changed while formatting. Run the command again.".to_owned());
        }
        let mut guard = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        let snapshot = guard
            .apply_format_result(formatted)
            .map_err(|error| error.to_string())?;
        if save {
            guard
                .save_buffer(&snapshot.path, snapshot.revision)
                .map_err(|error| error.to_string())
        } else {
            Ok(snapshot)
        }
    })
    .await
    .map_err(|error| format!("Apply format task failed: {error}"))?
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
