//! Archive viewer commands (ADR 0016). Only the renderer calls these; they are
//! not agent tools or MCP methods. An archive comes from the open workspace
//! (contained by `existing_path`) or from one of the user's own uploads, the
//! only outside source the viewer opens. Extraction always lands inside the
//! workspace, checked with the Explorer import rules.
use crate::DesktopState;
use base64::Engine;
use serde::{Deserialize, Serialize};
use span_core::{
    ArchiveExtractOptions, ArchiveExtractProgress, ArchiveExtractReport, ArchiveLimits,
    ArchiveListing, ArchivePlan, ArchivePreviewKind, ArchiveSource, CancellationToken,
    ConflictPolicy, CoreWorkspace, UploadStore,
};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State};

/// Most extractions running at once.
const MAX_JOBS: usize = 2;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Running extractions by the job ID the renderer chose.
pub(crate) type ArchiveJobs = Arc<Mutex<HashMap<String, CancellationToken>>>;

/// Where an archive comes from.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArchiveRef {
    /// A file in the open workspace (workspace relative or absolute inside it).
    Workspace { path: String },
    /// An upload the user opened in the Uploads view.
    Upload { id: String },
    /// A file from the latest native drop (listed for a chat attachment outline).
    Dropped { path: String },
}

/// A dropped path must be one recorded from the latest native drop.
fn checked_drop(state: &DesktopState, source: &ArchiveRef) -> Result<Option<PathBuf>, String> {
    match source {
        ArchiveRef::Dropped { path } => crate::startup::allowed_drop(state, path).map(Some),
        _ => Ok(None),
    }
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntryData {
    pub kind: ArchivePreviewKind,
    pub data_base64: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveExtractRequest {
    /// Existing workspace folder that receives the new folder ("" is the root).
    pub target_dir: String,
    /// Name of the new folder. Defaults to the archive name without its extension.
    pub folder_name: Option<String>,
    pub policy: ConflictPolicy,
    pub options: ArchiveExtractOptions,
}

fn current(state: &DesktopState) -> Result<Arc<Mutex<CoreWorkspace>>, String> {
    state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a folder to use archives".to_owned())
}

fn text<T>(result: span_core::Result<T>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}

/// Opens the archive and reads the extraction cap from the user's settings.
fn open_source(
    workspace: &CoreWorkspace,
    source: &ArchiveRef,
    dropped: Option<&Path>,
) -> Result<(ArchiveSource, ArchiveLimits), String> {
    let limit_mb = workspace
        .get_settings()
        .map(|settings| settings.archive_extract_limit_mb)
        .unwrap_or(1024);
    let limits = ArchiveLimits::with_total_bytes(u64::from(limit_mb) * 1024 * 1024);
    let archive = match source {
        ArchiveRef::Workspace { path } => {
            let resolved = text(workspace.existing_path(path))?;
            text(ArchiveSource::open(&resolved))?
        }
        ArchiveRef::Upload { id } => {
            let root = workspace.workspace().root;
            let store = text(UploadStore::for_current_user(Path::new(&root)))?;
            let (path, name) = text(store.archive_blob(id))?;
            text(ArchiveSource::open_named(&path, &name))?
        }
        ArchiveRef::Dropped { .. } => {
            let path =
                dropped.ok_or_else(|| "Only items from the latest drop can be read".to_owned())?;
            text(ArchiveSource::open(path))?
        }
    };
    Ok((archive, limits))
}

fn with_source<T: Send + 'static>(
    state: &DesktopState,
    source: ArchiveRef,
    run: impl FnOnce(&ArchiveSource, &ArchiveLimits) -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    let workspace = current(state);
    let dropped = checked_drop(state, &source);
    async move {
        let workspace = workspace?;
        let dropped = dropped?;
        tauri::async_runtime::spawn_blocking(move || {
            // The lock covers path checks and the open only; reading runs unlocked.
            let (archive, limits) = {
                let guard = workspace
                    .lock()
                    .map_err(|_| "Workspace state is unavailable".to_owned())?;
                open_source(&guard, &source, dropped.as_deref())?
            };
            run(&archive, &limits)
        })
        .await
        .map_err(|error| format!("Archive task failed: {error}"))?
    }
}

#[tauri::command]
#[specta::specta]
pub async fn archive_list(
    state: State<'_, DesktopState>,
    source: ArchiveRef,
) -> Result<ArchiveListing, String> {
    with_source(&state, source, |archive, limits| text(archive.list(limits))).await
}

#[tauri::command]
#[specta::specta]
pub async fn archive_read_entry(
    state: State<'_, DesktopState>,
    source: ArchiveRef,
    path: String,
) -> Result<ArchiveEntryData, String> {
    with_source(&state, source, move |archive, limits| {
        let preview = text(archive.read_entry(&path, limits))?;
        Ok(ArchiveEntryData {
            kind: preview.kind,
            data_base64: base64::engine::general_purpose::STANDARD.encode(preview.bytes),
            truncated: preview.truncated,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn archive_plan_extract(
    state: State<'_, DesktopState>,
    source: ArchiveRef,
    request: ArchiveExtractRequest,
) -> Result<ArchivePlan, String> {
    let workspace = current(&state)?;
    let dropped = checked_drop(&state, &source)?;
    tauri::async_runtime::spawn_blocking(move || {
        let guard = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        let (archive, limits) = open_source(&guard, &source, dropped.as_deref())?;
        let folder = request
            .folder_name
            .clone()
            .unwrap_or_else(|| archive.folder_name());
        let target = text(guard.archive_extract_target(&request.target_dir, &folder))?;
        drop(guard);
        text(archive.plan(&target, &request.options, &limits))
    })
    .await
    .map_err(|error| format!("Archive task failed: {error}"))?
}

fn register(jobs: &ArchiveJobs, id: &str) -> Result<CancellationToken, String> {
    let mut jobs = jobs
        .lock()
        .map_err(|_| "Archive jobs are unavailable".to_owned())?;
    if jobs.contains_key(id) {
        return Err("This extraction is already running".into());
    }
    if jobs.len() >= MAX_JOBS {
        return Err("Wait for a running extraction to finish first".into());
    }
    let token = CancellationToken::default();
    jobs.insert(id.to_owned(), token.clone());
    Ok(token)
}

fn unregister(jobs: &ArchiveJobs, id: &str) {
    if let Ok(mut jobs) = jobs.lock() {
        jobs.remove(id);
    }
}

/// Cancels every running extraction, when the workspace closes or changes.
pub(crate) fn cancel_all(state: &DesktopState) {
    if let Ok(jobs) = state.archive_jobs.lock() {
        for token in jobs.values() {
            token.cancel();
        }
    }
}

/// Runs the three phases: check the destination (locked), write the staging
/// folder (unlocked, cancellable), publish with the clash policy (locked).
fn run_extract(
    workspace: &Mutex<CoreWorkspace>,
    source: &ArchiveRef,
    dropped: Option<&Path>,
    request: &ArchiveExtractRequest,
    token: &CancellationToken,
    progress: &mut dyn FnMut(ArchiveExtractProgress),
) -> Result<ArchiveExtractReport, String> {
    let (archive, limits, target) = {
        let guard = workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        let (archive, limits) = open_source(&guard, source, dropped)?;
        let folder = request
            .folder_name
            .clone()
            .unwrap_or_else(|| archive.folder_name());
        let target = text(guard.archive_extract_target(&request.target_dir, &folder))?;
        (archive, limits, target)
    };
    let staged =
        text(archive.extract_to_staging(&target, &request.options, &limits, token, progress))?;
    let mut guard = workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?;
    text(guard.publish_archive_extract(&target, staged, request.policy))
}

#[tauri::command]
#[specta::specta]
pub async fn archive_extract(
    state: State<'_, DesktopState>,
    job_id: String,
    source: ArchiveRef,
    request: ArchiveExtractRequest,
    on_progress: Channel<ArchiveExtractProgress>,
) -> Result<ArchiveExtractReport, String> {
    let workspace = current(&state)?;
    let dropped = checked_drop(&state, &source)?;
    let jobs = state.archive_jobs.clone();
    let token = register(&jobs, &job_id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut last = Instant::now() - PROGRESS_INTERVAL;
        run_extract(
            &workspace,
            &source,
            dropped.as_deref(),
            &request,
            &token,
            &mut |progress| {
                if progress.entries == progress.total_entries || last.elapsed() >= PROGRESS_INTERVAL
                {
                    last = Instant::now();
                    let _ = on_progress.send(progress);
                }
            },
        )
    })
    .await
    .map_err(|error| format!("Archive task failed: {error}"));
    unregister(&jobs, &job_id);
    result?
}

#[tauri::command]
#[specta::specta]
pub async fn archive_cancel(state: State<'_, DesktopState>, job_id: String) -> Result<(), String> {
    if let Some(token) = state
        .archive_jobs
        .lock()
        .map_err(|_| "Archive jobs are unavailable".to_owned())?
        .get(&job_id)
    {
        token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn workspace_with_zip() -> (tempfile::TempDir, CoreWorkspace) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("w");
        std::fs::create_dir(&root).unwrap();
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("docs/a.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"alpha").unwrap();
        std::fs::write(root.join("pkg.zip"), writer.finish().unwrap().into_inner()).unwrap();
        let workspace = CoreWorkspace::open(&root).unwrap();
        (dir, workspace)
    }

    #[test]
    fn archive_sources_outside_the_workspace_are_refused() {
        let (dir, workspace) = workspace_with_zip();
        std::fs::copy(dir.path().join("w/pkg.zip"), dir.path().join("outside.zip")).unwrap();
        let outside = dir
            .path()
            .join("outside.zip")
            .to_string_lossy()
            .into_owned();
        for path in ["../outside.zip", outside.as_str(), "missing.zip"] {
            let source = ArchiveRef::Workspace { path: path.into() };
            assert!(open_source(&workspace, &source, None).is_err(), "{path}");
        }
        let unknown = ArchiveRef::Upload {
            id: "../../etc".into(),
        };
        assert!(open_source(&workspace, &unknown, None).is_err());
        // A dropped path is honoured only after the latest drop check passed.
        let dropped = ArchiveRef::Dropped {
            path: outside.clone(),
        };
        assert!(open_source(&workspace, &dropped, None).is_err());
        let state = DesktopState::default();
        assert!(checked_drop(&state, &dropped).is_err());
        *state.dropped_paths.lock().unwrap() = vec![std::fs::canonicalize(&outside).unwrap()];
        let allowed = checked_drop(&state, &dropped).unwrap();
        assert!(open_source(&workspace, &dropped, allowed.as_deref()).is_ok());
        let (archive, limits) = open_source(
            &workspace,
            &ArchiveRef::Workspace {
                path: "pkg.zip".into(),
            },
            None,
        )
        .unwrap();
        assert_eq!(limits.max_total_bytes, 1024 * 1024 * 1024);
        assert_eq!(archive.list(&limits).unwrap().entries.len(), 1);
    }

    #[test]
    fn archive_extract_runs_the_phases_and_lands_inside_the_workspace() {
        let (dir, workspace) = workspace_with_zip();
        let workspace = Mutex::new(workspace);
        let request = ArchiveExtractRequest {
            target_dir: String::new(),
            folder_name: None,
            policy: ConflictPolicy::KeepBoth,
            options: ArchiveExtractOptions::default(),
        };
        let source = ArchiveRef::Workspace {
            path: "pkg.zip".into(),
        };
        let mut events = Vec::new();
        let report = run_extract(
            &workspace,
            &source,
            None,
            &request,
            &CancellationToken::default(),
            &mut |p| events.push(p),
        )
        .unwrap();
        assert_eq!(report.created.as_deref(), Some("pkg"));
        assert_eq!(
            std::fs::read(dir.path().join("w/pkg/docs/a.txt")).unwrap(),
            b"alpha"
        );
        assert_eq!(events.last().unwrap().entries, 1);
        let again = run_extract(
            &workspace,
            &source,
            None,
            &request,
            &CancellationToken::default(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(again.created.as_deref(), Some("pkg copy"));
        let escape = ArchiveExtractRequest {
            target_dir: "../".into(),
            ..request
        };
        assert!(run_extract(
            &workspace,
            &source,
            None,
            &escape,
            &CancellationToken::default(),
            &mut |_| {}
        )
        .is_err());
    }

    #[test]
    fn archive_jobs_are_bounded_and_cancel_reaches_the_token() {
        let state = DesktopState::default();
        let first = register(&state.archive_jobs, "a").unwrap();
        assert!(register(&state.archive_jobs, "a").is_err());
        let _second = register(&state.archive_jobs, "b").unwrap();
        assert!(register(&state.archive_jobs, "c").is_err());
        cancel_all(&state);
        assert!(first.is_cancelled());
        unregister(&state.archive_jobs, "a");
        assert!(register(&state.archive_jobs, "c").is_ok());
    }

    #[test]
    fn archive_commands_are_not_agent_tools() {
        let tools = span_acp::tools::tool_definitions().to_string();
        assert!(
            !tools.contains("archive"),
            "no agent tool may reach the archive commands"
        );
    }
}
