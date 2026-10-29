//! Scoped external-change checks driven by the existing debounced workspace watcher.
use crate::{language_servers, services, with_workspace, DesktopState};
use serde::{Deserialize, Serialize};
use span_core::{ExternalFileCheck, ExternalFileKind, ExternalFileResolution, ExternalFileState};
use specta::Type;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) async fn abandon_external_file(
    state: State<'_, DesktopState>,
    path: String,
    expected_revision: u64,
    expected_workspace_root: String,
) -> Result<(), String> {
    services::cancel_formatter_jobs_for_path(state.inner(), &path);
    with_workspace(state.inner().clone(), move |workspace| {
        if workspace.workspace().root != expected_workspace_root {
            return Err(span_core::CoreError::InvalidEdit(
                "Workspace changed before discarding the retained buffer".into(),
            ));
        }
        workspace.abandon_external_file(&path, expected_revision)
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFilesUpdate {
    pub workspace_root: String,
    pub revision: u64,
    pub directories_changed: bool,
    pub states: Vec<ExternalFileState>,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn check_external_files(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    checks: Vec<ExternalFileCheck>,
    expected_workspace_root: String,
    since_revision: Option<u64>,
) -> Result<ExternalFilesUpdate, String> {
    let revision = state.file_index.change_revision();
    let changed = since_revision != Some(revision);
    let generation = lsp.generation();
    let lsp = lsp.inner().clone();
    with_workspace(state.inner().clone(), move |workspace| {
        if workspace.workspace().root != expected_workspace_root {
            return Err(span_core::CoreError::InvalidEdit(
                "Workspace changed before external file checks".into(),
            ));
        }
        let states = if changed {
            workspace.check_external_files(&checks)?
        } else {
            vec![]
        };
        if generation == lsp.generation() {
            for change in &states {
                if change.kind == ExternalFileKind::Reloaded {
                    if let Some(snapshot) = &change.snapshot {
                        lsp.on_discard(snapshot);
                    }
                }
            }
        }
        Ok(ExternalFilesUpdate {
            workspace_root: expected_workspace_root,
            revision,
            directories_changed: changed,
            states,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn resolve_external_file(
    state: State<'_, DesktopState>,
    lsp: State<'_, language_servers::LspService>,
    path: String,
    expected_revision: u64,
    reviewed_disk_token: String,
    resolution: ExternalFileResolution,
    expected_workspace_root: String,
) -> Result<span_core::BufferSnapshot, String> {
    services::cancel_formatter_jobs_for_path(state.inner(), &path);
    let generation = lsp.generation();
    let lsp = lsp.inner().clone();
    with_workspace(state.inner().clone(), move |workspace| {
        if workspace.workspace().root != expected_workspace_root {
            return Err(span_core::CoreError::InvalidEdit(
                "Workspace changed before external file resolution".into(),
            ));
        }
        let snapshot = workspace.resolve_external_file(
            &path,
            expected_revision,
            &reviewed_disk_token,
            resolution,
        )?;
        if generation == lsp.generation() {
            lsp.after_save(generation, &snapshot);
        }
        Ok(snapshot)
    })
    .await
}
