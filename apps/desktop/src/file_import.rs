//! Copies items from a native drop or the OS clipboard into an Explorer folder. The copy itself is
//! `CoreWorkspace::import_paths`; this module only checks that every source belongs to the latest drop or
//! clipboard read, tracks progress for polling, and updates the file index afterwards.
use crate::{startup, with_workspace, DesktopState};
use span_core::{CancellationToken, ImportItem, ImportLimits, ImportProgress, ImportReport};
use std::path::PathBuf;
use tauri::State;

/// Progress and cancellation of the running import, read without the workspace lock.
#[derive(Clone, Default)]
pub struct ImportJob {
    pub progress: std::sync::Arc<std::sync::Mutex<Option<ImportProgress>>>,
    pub cancellation: std::sync::Arc<std::sync::Mutex<Option<CancellationToken>>>,
}

/// Copies `items` into the workspace folder `target` ("" is the root). Each source must come from the latest
/// native drop or the latest `clipboard_files` read; any other path is refused before anything is copied.
#[tauri::command]
#[specta::specta]
pub async fn import_paths(
    state: State<'_, DesktopState>,
    target: String,
    items: Vec<ImportItem>,
) -> Result<ImportReport, String> {
    let state = state.inner().clone();
    if items.is_empty() {
        return Ok(ImportReport::default());
    }
    let mut checked = Vec::with_capacity(items.len());
    for item in items {
        let canonical = startup::allowed_import_source(&state, &item.source)?;
        checked.push(ImportItem {
            source: canonical
                .to_str()
                .ok_or("The copied path is not valid Unicode")?
                .to_owned(),
            policy: item.policy,
        });
    }
    let cancellation = CancellationToken::default();
    {
        let mut running = state
            .import_job
            .cancellation
            .lock()
            .map_err(|_| "Import state is unavailable".to_owned())?;
        if running.is_some() {
            return Err("Another copy is still running".to_owned());
        }
        *running = Some(cancellation.clone());
    }
    let job = state.import_job.clone();
    let report = with_workspace(state.clone(), move |workspace| {
        let progress = job.progress.clone();
        workspace.import_paths(
            &target,
            &checked,
            ImportLimits::default(),
            &cancellation,
            &mut |update| {
                if let Ok(mut current) = progress.lock() {
                    *current = Some(update);
                }
            },
        )
    })
    .await;
    if let Ok(mut running) = state.import_job.cancellation.lock() {
        *running = None;
    }
    if let Ok(mut progress) = state.import_job.progress.lock() {
        *progress = None;
    }
    let report = report?;
    refresh_index(&state, &report.created);
    Ok(report)
}

/// Progress of the running import, or nothing when no import runs.
#[tauri::command]
#[specta::specta]
pub fn import_progress(state: State<'_, DesktopState>) -> Option<ImportProgress> {
    state
        .import_job
        .progress
        .lock()
        .ok()
        .and_then(|progress| progress.clone())
}

/// Asks the running import to stop. Items already copied stay and are listed in its report.
#[tauri::command]
#[specta::specta]
pub fn cancel_import(state: State<'_, DesktopState>) {
    if let Ok(running) = state.import_job.cancellation.lock() {
        if let Some(token) = running.as_ref() {
            token.cancel();
        }
    }
}

/// New items reach the file index: folders through a reconcile, files one by one.
pub(crate) fn refresh_index(state: &DesktopState, created: &[String]) {
    let Some(root) = state
        .file_index_root
        .lock()
        .ok()
        .and_then(|root| root.clone())
    else {
        return;
    };
    if created.iter().any(|path| root.join(path).is_dir()) {
        if let Err(error) = state.file_index.reconcile(&root) {
            eprintln!("Could not update file index after copy: {error}");
        }
        return;
    }
    for path in created {
        if let Err(error) = state.file_index.apply_for_root(
            &root,
            span_file_index::FileEvent::Upsert(PathBuf::from(path)),
        ) {
            eprintln!("Could not update file index after copy: {error}");
        }
    }
}
