//! ZIP extraction from owned uploads into a fresh folder in the selected workspace.
use crate::DesktopState;
use serde::Serialize;
use span_core::{
    ArchiveExtractOptions, ArchiveListing, ArchivePlan, ArchiveProgress, ArchiveResult,
    CancellationToken, CoreWorkspace, UploadStore, ZipBundle, MAX_UPLOAD_BYTES,
    MAX_UPLOAD_READ_BYTES,
};
use specta::Type;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State};

const MAX_PLANS: usize = 4;
const PLAN_LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_ENTRY_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct ArchiveState {
    plans: Arc<Mutex<HashMap<String, CachedPlan>>>,
    next: Arc<AtomicU64>,
    permits: Arc<tokio::sync::Semaphore>,
}
impl Default for ArchiveState {
    fn default() -> Self {
        Self {
            plans: Arc::default(),
            next: Arc::new(AtomicU64::new(1)),
            permits: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
}
impl ArchiveState {
    fn check_capacity(&self, root: &str) -> Result<(), String> {
        let mut plans = self
            .plans
            .lock()
            .map_err(|_| "Archive plans are unavailable".to_owned())?;
        prune(&mut plans, root);
        if plans.len() >= MAX_PLANS {
            return Err("Close another archive extraction before preparing a new one".into());
        }
        Ok(())
    }

    fn cache(
        &self,
        root: &str,
        bundle: ZipBundle,
        plan: ArchivePlan,
    ) -> Result<NativeArchivePlan, String> {
        let mut plans = self
            .plans
            .lock()
            .map_err(|_| "Archive plans are unavailable".to_owned())?;
        prune(&mut plans, root);
        if plans.len() >= MAX_PLANS {
            return Err("Close another archive extraction before preparing a new one".into());
        }
        let id = format!("archive-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let view = NativeArchivePlan {
            plan_id: id.clone(),
            destination: plan.destination.clone(),
            files: plan.files,
            bytes: plan.bytes,
            skipped_unsafe: plan.skipped_unsafe.clone(),
        };
        plans.insert(
            id,
            CachedPlan {
                root: root.to_owned(),
                bundle,
                plan,
                cancel: CancellationToken::default(),
                created: Instant::now(),
                running: false,
            },
        );
        Ok(view)
    }

    fn start(&self, id: &str, root: &str) -> Result<CachedPlan, String> {
        let mut plans = self
            .plans
            .lock()
            .map_err(|_| "Archive plans are unavailable".to_owned())?;
        prune(&mut plans, root);
        let cached = plans.get_mut(id).ok_or_else(|| {
            "Archive plan expired or was cancelled; prepare extraction again".to_owned()
        })?;
        if cached.running {
            return Err("This archive plan is already extracting".into());
        }
        cached.running = true;
        Ok(cached.clone())
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut plans = self
            .plans
            .lock()
            .map_err(|_| "Archive plans are unavailable".to_owned())?;
        if let Some(cached) = plans.get(id) {
            cached.cancel.cancel();
            if !cached.running {
                plans.remove(id);
            }
        }
        Ok(())
    }

    pub(crate) fn cancel_all(&self) {
        if let Ok(mut plans) = self.plans.lock() {
            for cached in plans.values() {
                cached.cancel.cancel();
            }
            plans.clear();
        }
    }
}

#[derive(Clone)]
struct CachedPlan {
    root: String,
    bundle: ZipBundle,
    plan: ArchivePlan,
    cancel: CancellationToken,
    created: Instant,
    running: bool,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NativeArchivePlan {
    pub plan_id: String,
    pub destination: String,
    pub files: u32,
    pub bytes: u64,
    pub skipped_unsafe: Vec<String>,
}
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntryBytes {
    pub data_base64: String,
}

fn with_workspace<T>(
    state: &DesktopState,
    expected: &str,
    run: impl FnOnce(&CoreWorkspace) -> Result<T, String>,
) -> Result<T, String> {
    let selected = state
        .workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?;
    let workspace = selected
        .as_ref()
        .ok_or_else(|| "Open a folder to use archives".to_owned())?;
    let workspace = workspace
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?;
    if workspace.workspace().root != expected {
        return Err("The workspace changed before the archive operation".into());
    }
    run(&workspace)
}

fn upload_bundle(root: &str, upload_id: &str) -> Result<ZipBundle, String> {
    let store =
        UploadStore::for_current_user(Path::new(root)).map_err(|error| error.to_string())?;
    let metadata = store
        .get_meta(upload_id)
        .map_err(|error| error.to_string())?;
    if metadata.missing || metadata.size > MAX_UPLOAD_BYTES {
        return Err("Archive upload is missing or exceeds the upload limit".into());
    }
    let mut bytes = Vec::with_capacity(metadata.size as usize);
    while (bytes.len() as u64) < metadata.size {
        let chunk = store
            .read(upload_id, bytes.len() as u64, MAX_UPLOAD_READ_BYTES)
            .map_err(|error| error.to_string())?;
        if chunk.size != metadata.size
            || chunk.bytes.is_empty()
            || bytes.len() as u64 + chunk.bytes.len() as u64 > metadata.size
        {
            return Err("Archive upload changed while it was being read".into());
        }
        bytes.extend_from_slice(&chunk.bytes);
    }
    if span_core::content_fingerprint(&bytes) != metadata.fingerprint {
        return Err("Archive upload changed before it could be opened".into());
    }
    ZipBundle::new(Arc::new(bytes)).map_err(|error| error.to_string())
}

fn prune(plans: &mut HashMap<String, CachedPlan>, root: &str) {
    plans.retain(|_, cached| {
        let retain = cached.root == root && cached.created.elapsed() <= PLAN_LIFETIME;
        if !retain {
            cached.cancel.cancel();
        }
        retain
    });
}

#[tauri::command]
#[specta::specta]
pub async fn archive_list_entries(
    state: State<'_, DesktopState>,
    upload_id: String,
    expected_workspace_root: String,
) -> Result<ArchiveListing, String> {
    let state = state.inner().clone();
    let permit = state
        .archives
        .permits
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Archive reader is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        with_workspace(&state, &expected_workspace_root, |_| {
            upload_bundle(&expected_workspace_root, &upload_id)?
                .listing()
                .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| format!("List archive task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn archive_read_entry(
    state: State<'_, DesktopState>,
    upload_id: String,
    expected_workspace_root: String,
    path: String,
) -> Result<ArchiveEntryBytes, String> {
    let state = state.inner().clone();
    let permit = state
        .archives
        .permits
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Archive reader is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        with_workspace(&state, &expected_workspace_root, |_| {
            let bundle = upload_bundle(&expected_workspace_root, &upload_id)?;
            let listing = bundle.listing().map_err(|error| error.to_string())?;
            let entry = listing
                .entries
                .iter()
                .find(|entry| entry.path == path)
                .ok_or_else(|| "Archive entry was not found".to_owned())?;
            if entry.size > MAX_ENTRY_PREVIEW_BYTES {
                return Err("Archive entry preview is limited to 8 MiB".into());
            }
            let bytes = bundle
                .read_entry(&path)
                .map_err(|error| error.to_string())?;
            use base64::Engine;
            Ok(ArchiveEntryBytes {
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            })
        })
    })
    .await
    .map_err(|error| format!("Read archive entry task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn archive_plan_extract(
    state: State<'_, DesktopState>,
    upload_id: String,
    expected_workspace_root: String,
    options: ArchiveExtractOptions,
) -> Result<NativeArchivePlan, String> {
    let state = state.inner().clone();
    let permit = state
        .archives
        .permits
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Archive reader is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        with_workspace(&state, &expected_workspace_root, |workspace| {
            state.archives.check_capacity(&expected_workspace_root)?;
            let bundle = upload_bundle(&expected_workspace_root, &upload_id)?;
            let plan = bundle
                .plan(workspace, &expected_workspace_root, options)
                .map_err(|error| error.to_string())?;
            state.archives.cache(&expected_workspace_root, bundle, plan)
        })
    })
    .await
    .map_err(|error| format!("Plan archive task failed: {error}"))?
}

struct PlanGuard {
    state: ArchiveState,
    id: String,
}
impl Drop for PlanGuard {
    fn drop(&mut self) {
        if let Ok(mut plans) = self.state.plans.lock() {
            plans.remove(&self.id);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn archive_extract(
    state: State<'_, DesktopState>,
    plan_id: String,
    expected_workspace_root: String,
    on_progress: Channel<ArchiveProgress>,
) -> Result<ArchiveResult, String> {
    let state = state.inner().clone();
    let permit = state
        .archives
        .permits
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "Archive extractor is unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        with_workspace(&state, &expected_workspace_root, |workspace| {
            let cached = state.archives.start(&plan_id, &expected_workspace_root)?;
            let _guard = PlanGuard {
                state: state.archives.clone(),
                id: plan_id,
            };
            let mut last = Instant::now();
            cached
                .bundle
                .extract(
                    workspace,
                    &expected_workspace_root,
                    &cached.plan,
                    &cached.cancel,
                    |progress| {
                        if progress.done == progress.total
                            || last.elapsed() >= Duration::from_millis(50)
                        {
                            let _ = on_progress.send(progress);
                            last = Instant::now();
                        }
                    },
                )
                .map_err(|error| error.to_string())
        })
    })
    .await
    .map_err(|error| format!("Extract archive task failed: {error}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn archive_cancel(state: State<'_, DesktopState>, plan_id: String) -> Result<(), String> {
    state.archives.cancel(&plan_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn fixture() -> (tempfile::TempDir, CoreWorkspace, ZipBundle, ArchivePlan) {
        let directory = tempfile::tempdir().unwrap();
        let workspace = CoreWorkspace::open(directory.path()).unwrap();
        let data = base64::engine::general_purpose::STANDARD.decode("UEsDBBQAAAAAANVRXV2GphA2BQAAAAUAAAAJAAAAaGVsbG8udHh0aGVsbG9QSwECFAMUAAAAAADVUV1dhqYQNgUAAAAFAAAACQAAAAAAAAAAAAAAgAEAAAAAaGVsbG8udHh0UEsFBgAAAAABAAEANwAAACwAAAAAAA==").unwrap();
        let bundle = ZipBundle::new(Arc::new(data)).unwrap();
        let plan = bundle
            .plan(
                &workspace,
                &workspace.workspace().root,
                ArchiveExtractOptions::default(),
            )
            .unwrap();
        (directory, workspace, bundle, plan)
    }

    #[test]
    fn stale_archive_workspace_never_reaches_the_upload_reader() {
        let (_directory, workspace, _, _) = fixture();
        let state = DesktopState::default();
        *state.workspace.lock().unwrap() = Some(Arc::new(Mutex::new(workspace)));
        let result = with_workspace(&state, "stale root", |_| -> Result<(), String> {
            panic!("reader must not run");
        });
        assert!(result.unwrap_err().contains("workspace changed"));
    }

    #[test]
    fn native_archive_plans_are_bounded_and_idle_cancel_releases_capacity() {
        let (_directory, workspace, bundle, plan) = fixture();
        let root = workspace.workspace().root;
        let state = ArchiveState::default();
        let mut ids = Vec::new();
        for _ in 0..MAX_PLANS {
            ids.push(
                state
                    .cache(&root, bundle.clone(), plan.clone())
                    .unwrap()
                    .plan_id,
            );
        }
        assert!(state.cache(&root, bundle.clone(), plan.clone()).is_err());
        state.cancel(&ids[0]).unwrap();
        assert!(state.cache(&root, bundle, plan).is_ok());
    }

    #[test]
    fn native_archive_plan_runs_once_and_cancellation_reaches_the_active_snapshot() {
        let (_directory, workspace, bundle, plan) = fixture();
        let root = workspace.workspace().root;
        let state = ArchiveState::default();
        let id = state.cache(&root, bundle, plan).unwrap().plan_id;
        let active = state.start(&id, &root).unwrap();
        assert!(state.start(&id, &root).is_err());
        state.cancel(&id).unwrap();
        assert!(active.cancel.is_cancelled());
        drop(PlanGuard {
            state: state.clone(),
            id: id.clone(),
        });
        assert!(!state.plans.lock().unwrap().contains_key(&id));
    }

    #[test]
    fn expired_and_wrong_workspace_plans_are_refused_and_cancelled() {
        let (_directory, workspace, bundle, plan) = fixture();
        let root = workspace.workspace().root;
        let state = ArchiveState::default();
        let id = state
            .cache(&root, bundle.clone(), plan.clone())
            .unwrap()
            .plan_id;
        let token = {
            let mut plans = state.plans.lock().unwrap();
            let cached = plans.get_mut(&id).unwrap();
            cached.created = Instant::now() - PLAN_LIFETIME - Duration::from_secs(1);
            cached.cancel.clone()
        };
        assert!(state.start(&id, &root).is_err());
        assert!(token.is_cancelled());
        let id = state.cache(&root, bundle, plan).unwrap().plan_id;
        assert!(state.start(&id, "new workspace").is_err());
        assert!(state.plans.lock().unwrap().is_empty());
    }
}
