//! Binary safe access to workspace files that do not open as text: the editor shows them in the
//! shared file viewer, with "Open with default app" and "Reveal" actions.
use crate::uploads::{launch, open_launch, reveal_launch, Os};
use crate::{with_workspace, DesktopState};
use span_core::FileProbe;
use tauri::State;

/// Name, size and text or binary kind of a workspace file, without opening a buffer.
#[tauri::command]
#[specta::specta]
pub async fn probe_file(state: State<'_, DesktopState>, path: String) -> Result<FileProbe, String> {
    with_workspace(state.inner().clone(), move |workspace| {
        workspace.probe_file(&path)
    })
    .await
}

/// Raw bytes of a workspace file for the file viewer, as base64. A file larger than `max_bytes`
/// (capped by the core viewer limit) is refused rather than truncated.
#[tauri::command]
#[specta::specta]
pub async fn read_file_bytes(
    state: State<'_, DesktopState>,
    path: String,
    max_bytes: u32,
) -> Result<String, String> {
    use base64::Engine;
    let bytes = with_workspace(state.inner().clone(), move |workspace| {
        workspace.read_file_bytes(&path, u64::from(max_bytes))
    })
    .await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Opens a workspace file with the system default app. Programs and scripts are refused, with
/// the same rules as uploads.
#[tauri::command]
#[specta::specta]
pub async fn open_file_with_system(
    state: State<'_, DesktopState>,
    path: String,
) -> Result<(), String> {
    let (resolved, refusal) = with_workspace(state.inner().clone(), move |workspace| {
        workspace.external_open_target(&path)
    })
    .await?;
    if let Some(reason) = refusal {
        return Err(reason);
    }
    tauri::async_runtime::spawn_blocking(move || launch(&open_launch(Os::current(), &resolved)?))
        .await
        .map_err(|error| format!("Open file task failed: {error}"))?
}

/// Shows a workspace file or folder in Finder, Explorer or the Linux file manager.
#[tauri::command]
#[specta::specta]
pub async fn reveal_file(state: State<'_, DesktopState>, path: String) -> Result<(), String> {
    let resolved = with_workspace(state.inner().clone(), move |workspace| {
        workspace.existing_path(&path)
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || launch(&reveal_launch(Os::current(), &resolved)?))
        .await
        .map_err(|error| format!("Reveal file task failed: {error}"))?
}
