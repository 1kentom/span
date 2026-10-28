//! Archive viewer commands. Business rules live in `span_core::archive`; this file only
//! resolves the source, moves work off the UI thread and streams progress.
use crate::DesktopState;
use serde::{Deserialize, Serialize};
use span_core::{
    ArchiveError, ArchiveErrorKind, ArchiveLimits, ArchiveListing, ArchiveSource,
    CancellationToken, ExtractContext, ExtractOptions, ExtractPlan, ExtractProgress, ExtractReport,
};
use specta::Type;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{ipc::Channel, State};

/// Where the archive comes from. The UI never passes an absolute path: a workspace file
/// is named relative to the workspace root, and anything else arrives as bytes.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArchiveSourceInput {
    /// Workspace-relative path.
    Workspace { path: String },
    /// Archive bytes held by the UI, base64 encoded. `name` drives format detection.
    Inline {
        name: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
    /// An upload held by the uploads store. See [`upload_source`].
    Upload { id: String },
}

/// A slice of one entry's bytes for previews.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntryChunk {
    pub data_base64: String,
    pub offset: u64,
    pub entry_size: u64,
    pub eof: bool,
}

static EXTRACTIONS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(Default::default);

fn unavailable(message: &str) -> ArchiveError {
    ArchiveError::new(ArchiveErrorKind::Unavailable, message)
}

fn task_failed(error: impl std::fmt::Display) -> ArchiveError {
    ArchiveError::new(
        ArchiveErrorKind::Io,
        format!("Archive task failed: {error}"),
    )
}

fn workspace(
    state: &DesktopState,
) -> Result<std::sync::Arc<Mutex<span_core::CoreWorkspace>>, ArchiveError> {
    state
        .workspace
        .lock()
        .map_err(|_| unavailable("Workspace state is unavailable"))?
        .clone()
        .ok_or_else(|| unavailable("Open a folder to use archives from the workspace"))
}

/// ADAPTER POINT for upload ids. The uploads store is built separately and is not a
/// dependency of this module. When it lands, resolve `id` here to the upload's bytes
/// (`ArchiveSource::from_bytes(name, bytes)`) or to its workspace file
/// (`CoreWorkspace::archive_source`). Until then upload sources are refused.
fn upload_source(_state: &DesktopState, _id: &str) -> Result<ArchiveSource, ArchiveError> {
    Err(unavailable(
        "Opening archives by upload id is not available yet. Pass the workspace path or the bytes.",
    ))
}

/// Resolve a source on a blocking worker. Inline bytes are size checked before decoding.
fn resolve(state: &DesktopState, input: ArchiveSourceInput) -> Result<ArchiveSource, ArchiveError> {
    match input {
        ArchiveSourceInput::Workspace { path } => {
            let workspace = workspace(state)?;
            let workspace = workspace
                .lock()
                .map_err(|_| unavailable("Workspace state is unavailable"))?;
            workspace.archive_source(&path)
        }
        ArchiveSourceInput::Inline { name, data_base64 } => {
            use base64::Engine;
            if data_base64.len() / 4 * 3 > span_core::MAX_INLINE_ARCHIVE_BYTES + 3 {
                return Err(ArchiveError::new(
                    ArchiveErrorKind::TooLarge,
                    "The archive is too large to send inline. Open it from the workspace.",
                ));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data_base64.as_bytes())
                .map_err(|_| {
                    ArchiveError::new(
                        ArchiveErrorKind::InvalidPath,
                        "Archive data is not valid base64",
                    )
                })?;
            Ok(ArchiveSource::from_bytes(name, bytes))
        }
        ArchiveSourceInput::Upload { id } => upload_source(state, &id),
    }
}

fn context(state: &DesktopState) -> Result<ExtractContext, ArchiveError> {
    let workspace = workspace(state)?;
    let workspace = workspace
        .lock()
        .map_err(|_| unavailable("Workspace state is unavailable"))?;
    Ok(workspace.extract_context())
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, ArchiveError> + Send + 'static,
) -> Result<T, ArchiveError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(task_failed)?
}

/// List entries with the safety verdict for each.
#[tauri::command]
#[specta::specta]
pub async fn archive_list(
    state: State<'_, DesktopState>,
    source: ArchiveSourceInput,
) -> Result<ArchiveListing, ArchiveError> {
    let state = state.inner().clone();
    blocking(move || {
        let source = resolve(&state, source)?;
        span_core::list_archive(&source, &ArchiveLimits::default())
    })
    .await
}

/// Read at most 4 MiB of one entry, starting at `offset`.
#[tauri::command]
#[specta::specta]
pub async fn archive_read_entry(
    state: State<'_, DesktopState>,
    source: ArchiveSourceInput,
    path: String,
    offset: u64,
    len: u64,
) -> Result<ArchiveEntryChunk, ArchiveError> {
    let state = state.inner().clone();
    blocking(move || {
        use base64::Engine;
        let source = resolve(&state, source)?;
        let chunk =
            span_core::read_archive_entry(&source, &path, offset, len, &ArchiveLimits::default())?;
        Ok(ArchiveEntryChunk {
            data_base64: base64::engine::general_purpose::STANDARD.encode(&chunk.data),
            offset,
            entry_size: chunk.entry_size,
            eof: chunk.eof,
        })
    })
    .await
}

/// Decide what extraction would do, without writing. With `ask`, conflicts come back here.
#[tauri::command]
#[specta::specta]
pub async fn archive_plan_extract(
    state: State<'_, DesktopState>,
    source: ArchiveSourceInput,
    options: ExtractOptions,
) -> Result<ExtractPlan, ArchiveError> {
    let state = state.inner().clone();
    blocking(move || {
        let ctx = context(&state)?;
        let source = resolve(&state, source)?;
        span_core::plan_extract(&source, &options, &ctx, &ArchiveLimits::default())
    })
    .await
}

/// Extract into the workspace. The plan is recomputed here from `options`; progress is
/// streamed on `on_progress` and `archive_cancel(id)` stops between chunks.
#[tauri::command]
#[specta::specta]
pub async fn archive_extract(
    state: State<'_, DesktopState>,
    id: String,
    source: ArchiveSourceInput,
    options: ExtractOptions,
    on_progress: Channel<ExtractProgress>,
) -> Result<ExtractReport, ArchiveError> {
    let state = state.inner().clone();
    let cancel = CancellationToken::default();
    {
        let mut jobs = EXTRACTIONS
            .lock()
            .map_err(|_| unavailable("Extraction state is unavailable"))?;
        if jobs.contains_key(&id) {
            return Err(ArchiveError::new(
                ArchiveErrorKind::Busy,
                "An extraction with this id is already running",
            ));
        }
        jobs.insert(id.clone(), cancel.clone());
    }
    let result = blocking(move || {
        let ctx = context(&state)?;
        let source = resolve(&state, source)?;
        span_core::extract(
            &source,
            &options,
            &ctx,
            &ArchiveLimits::default(),
            &cancel,
            &mut |progress| {
                let _ = on_progress.send(progress.clone());
            },
        )
    })
    .await;
    if let Ok(mut jobs) = EXTRACTIONS.lock() {
        jobs.remove(&id);
    }
    result
}

/// Ask a running extraction to stop. Unknown ids are ignored.
#[tauri::command]
#[specta::specta]
pub async fn archive_cancel(id: String) -> Result<(), ArchiveError> {
    if let Some(cancel) = EXTRACTIONS
        .lock()
        .map_err(|_| unavailable("Extraction state is unavailable"))?
        .get(&id)
    {
        cancel.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn state_with_workspace() -> (tempfile::TempDir, DesktopState) {
        let dir = tempfile::tempdir().unwrap();
        let state = DesktopState::default();
        let workspace = span_core::CoreWorkspace::open(dir.path()).unwrap();
        *state.workspace.lock().unwrap() = Some(std::sync::Arc::new(Mutex::new(workspace)));
        (dir, state)
    }

    fn tar_bytes() -> Vec<u8> {
        tar_from(vec![("a.txt", b"hello".to_vec())])
    }

    /// A minimal ustar writer so the desktop crate needs no archive dev-dependency.
    fn tar_from(items: Vec<(&'static str, Vec<u8>)>) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, data) in items {
            let mut header = [0u8; 512];
            header[..name.len()].copy_from_slice(name.as_bytes());
            header[100..107].copy_from_slice(b"0000644");
            header[108..115].copy_from_slice(b"0000000");
            header[116..123].copy_from_slice(b"0000000");
            header[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
            header[136..147].copy_from_slice(b"00000000000");
            header[156] = b'0';
            header[257..263].copy_from_slice(b"ustar\0");
            header[263..265].copy_from_slice(b"00");
            header[148..156].copy_from_slice(b"        ");
            let sum: u32 = header.iter().map(|&b| u32::from(b)).sum();
            header[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
            out.extend_from_slice(&header);
            out.extend_from_slice(&data);
            out.resize(out.len().div_ceil(512) * 512, 0);
        }
        out.resize(out.len() + 1024, 0);
        out
    }

    #[test]
    fn inline_source_is_size_checked_before_decoding() {
        let state = DesktopState::default();
        let huge = "A".repeat((span_core::MAX_INLINE_ARCHIVE_BYTES / 3 + 2) * 4);
        let error = resolve(
            &state,
            ArchiveSourceInput::Inline {
                name: "a.zip".into(),
                data_base64: huge,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, ArchiveErrorKind::TooLarge);
        let error = resolve(
            &state,
            ArchiveSourceInput::Inline {
                name: "a.zip".into(),
                data_base64: "not base64!".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, ArchiveErrorKind::InvalidPath);
    }

    #[test]
    fn inline_tar_lists_without_a_workspace() {
        let state = DesktopState::default();
        let data = base64::engine::general_purpose::STANDARD.encode(tar_bytes());
        let source = resolve(
            &state,
            ArchiveSourceInput::Inline {
                name: "a.tar".into(),
                data_base64: data,
            },
        )
        .unwrap();
        let listing = span_core::open_archive(&source).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].path, "a.txt");
    }

    #[test]
    fn workspace_source_refuses_absolute_and_parent_paths() {
        let (dir, state) = state_with_workspace();
        std::fs::write(dir.path().join("a.tar"), tar_bytes()).unwrap();
        assert!(resolve(
            &state,
            ArchiveSourceInput::Workspace {
                path: "a.tar".into()
            }
        )
        .is_ok());
        let absolute = dir.path().join("a.tar").display().to_string();
        for bad in [absolute.as_str(), "../a.tar", "/etc/hosts"] {
            let error =
                resolve(&state, ArchiveSourceInput::Workspace { path: bad.into() }).unwrap_err();
            assert_eq!(error.kind, ArchiveErrorKind::InvalidPath, "{bad}");
        }
    }

    #[test]
    fn upload_ids_wait_for_the_adapter_and_no_workspace_is_reported() {
        let state = DesktopState::default();
        let error = resolve(&state, ArchiveSourceInput::Upload { id: "u1".into() }).unwrap_err();
        assert_eq!(error.kind, ArchiveErrorKind::Unavailable);
        let error = resolve(
            &state,
            ArchiveSourceInput::Workspace {
                path: "a.tar".into(),
            },
        )
        .unwrap_err();
        assert_eq!(error.kind, ArchiveErrorKind::Unavailable);
    }

    #[tokio::test]
    async fn cancel_of_an_unknown_id_is_a_no_op() {
        archive_cancel("missing".into()).await.unwrap();
    }
}
