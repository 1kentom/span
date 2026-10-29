use notify::{
    event::{ModifyKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::{Deserialize, Serialize};
use span_file_index::{
    FileEvent, FileIndex, IndexError, IndexSnapshot, QueryResults, ScanStatus, ScanVisibility,
    SearchResult, WorkspaceHandle,
};
use specta::Type;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::State;

const EVENT_CAPACITY: usize = 1024;
const COALESCE_WINDOW: Duration = Duration::from_millis(65);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FileIndexStatusKind {
    Idle,
    Scanning,
    Ready,
    Partial,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexStatus {
    pub workspace_root: String,
    pub generation: u64,
    pub status: FileIndexStatusKind,
    pub scanned_entries: u64,
    pub indexed_files: u32,
    pub error_count: u64,
    pub last_error: Option<String>,
    pub watcher_ready: bool,
    pub watcher_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexMatch {
    pub path: String,
    pub score: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexQueryResponse {
    pub workspace_root: String,
    pub generation: u64,
    pub request_id: u64,
    pub results: Vec<FileIndexMatch>,
}

#[derive(Clone, Default)]
pub struct FileIndexRuntime {
    inner: Arc<RuntimeInner>,
}

#[derive(Default)]
struct RuntimeInner {
    index: FileIndex,
    current: Mutex<Option<WatchSession>>,
    watcher_error: Arc<Mutex<Option<String>>>,
}

struct WatchSession {
    handle: WorkspaceHandle,
    stop: Arc<AtomicBool>,
    watcher: Option<RecommendedWatcher>,
    worker: Option<JoinHandle<()>>,
}

impl FileIndexRuntime {
    /// Prepare the scoped watcher first, then activate an isolated index
    /// generation and launch its background scan without waiting for traversal.
    #[cfg(test)]
    pub async fn activate(&self, root: PathBuf) -> Result<(), String> {
        self.activate_with_visibility(root, ScanVisibility::default())
            .await
    }

    pub async fn activate_with_visibility(
        &self,
        root: PathBuf,
        visibility: ScanVisibility,
    ) -> Result<(), String> {
        let prepared = tokio::task::spawn_blocking(move || prepare_watcher(root))
            .await
            .map_err(|error| format!("Watcher setup task failed: {error}"))??;
        let (root, watcher, receiver, overflow) = prepared;
        // Allocate the worker before changing index generations. If thread
        // creation fails, the currently open workspace and its scan remain
        // active. The worker waits for the new handle while open_workspace
        // installs it, so watcher registration still precedes scanning.
        let (handle_sender, handle_receiver) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker_overflow = Arc::clone(&overflow);
        let watcher_error = Arc::clone(&self.inner.watcher_error);
        let index = self.inner.index.clone();
        let worker_root = root.clone();
        let worker = thread::Builder::new()
            .name("span-file-index-watch".to_owned())
            .spawn(move || {
                let Ok(handle) = handle_receiver.recv() else {
                    return;
                };
                watch_loop(
                    index,
                    handle,
                    worker_root,
                    receiver,
                    worker_stop,
                    worker_overflow,
                    watcher_error,
                )
            })
            .map_err(|error| format!("Could not start workspace watcher worker: {error}"))?;
        let handle = self
            .inner
            .index
            .open_workspace(&root)
            .await
            .map_err(index_error);
        let handle = match handle {
            Ok(handle) => handle,
            Err(error) => {
                drop(handle_sender);
                let _ = worker.join();
                return Err(error);
            }
        };
        if let Err(error) = self.inner.index.set_visibility(&handle, visibility) {
            drop(handle_sender);
            let _ = self.inner.index.close_workspace(&handle);
            let _ = worker.join();
            return Err(index_error(error));
        }
        if handle_sender.send(handle.clone()).is_err() {
            let _ = self.inner.index.close_workspace(&handle);
            let _ = worker.join();
            return Err("Workspace watcher worker stopped before activation".to_owned());
        }

        let previous = {
            let mut current = self
                .inner
                .current
                .lock()
                .map_err(|_| "File index state is unavailable".to_owned())?;
            current.replace(WatchSession {
                handle: handle.clone(),
                stop,
                watcher: Some(watcher),
                worker: Some(worker),
            })
        };
        drop(previous);
        *self
            .inner
            .watcher_error
            .lock()
            .map_err(|_| "File index state is unavailable".to_owned())? = None;
        self.inner.index.start_scan(&handle).map_err(index_error)?;
        Ok(())
    }

    pub fn current_handle(&self) -> Result<Option<WorkspaceHandle>, String> {
        Ok(self
            .inner
            .current
            .lock()
            .map_err(|_| "File index state is unavailable".to_owned())?
            .as_ref()
            .map(|session| session.handle.clone()))
    }

    pub fn status(&self, expected_root: &Path) -> Result<Option<FileIndexStatus>, String> {
        let Some(handle) = self.current_handle()? else {
            return Ok(None);
        };
        if !same_path(handle.root(), expected_root) {
            return Err("File index workspace is changing. Retry shortly.".to_owned());
        }
        let snapshot = self.inner.index.snapshot(&handle).map_err(index_error)?;
        let watcher_error = self
            .inner
            .watcher_error
            .lock()
            .map_err(|_| "File index state is unavailable".to_owned())?
            .clone();
        let watcher_ready = self
            .inner
            .current
            .lock()
            .map_err(|_| "File index state is unavailable".to_owned())?
            .is_some();
        Ok(Some(status_dto(snapshot, watcher_ready, watcher_error)))
    }

    pub async fn query(
        &self,
        expected_root: &Path,
        query: impl Into<String>,
        limit: u8,
    ) -> Result<FileIndexQueryResponse, String> {
        let handle = self
            .current_handle()?
            .ok_or_else(|| "Open a folder before finding files".to_owned())?;
        if !same_path(handle.root(), expected_root) {
            return Err("File index workspace is changing. Retry shortly.".to_owned());
        }
        let result = self
            .inner
            .index
            .query(&handle, query.into(), usize::from(limit.min(100)))
            .await
            .map_err(index_error)?;
        if self
            .current_handle()?
            .is_none_or(|active| active.generation() != result.generation)
        {
            return Err("File query was superseded by a workspace change".to_owned());
        }
        Ok(query_dto(handle.root(), result))
    }

    pub fn configure_visibility(
        &self,
        expected_root: &Path,
        visibility: ScanVisibility,
    ) -> Result<(), String> {
        let handle = self
            .current_handle()?
            .ok_or_else(|| "Open a folder before finding files".to_owned())?;
        if !same_path(handle.root(), expected_root) {
            return Err("File index workspace is changing. Retry shortly.".to_owned());
        }
        if self
            .inner
            .index
            .set_visibility(&handle, visibility)
            .map_err(index_error)?
        {
            self.inner.index.start_scan(&handle).map_err(index_error)?;
        }
        Ok(())
    }

    pub fn reconcile(&self, expected_root: &Path) -> Result<FileIndexStatus, String> {
        let handle = self
            .current_handle()?
            .ok_or_else(|| "Open a folder before reconciling its file index".to_owned())?;
        if !same_path(handle.root(), expected_root) {
            return Err("File index workspace is changing. Retry shortly.".to_owned());
        }
        self.inner.index.start_scan(&handle).map_err(index_error)?;
        let snapshot = self.inner.index.snapshot(&handle).map_err(index_error)?;
        let watcher_error = self
            .inner
            .watcher_error
            .lock()
            .map_err(|_| "File index state is unavailable".to_owned())?
            .clone();
        Ok(status_dto(snapshot, true, watcher_error))
    }

    pub fn apply(&self, event: FileEvent) -> Result<(), String> {
        let Some(handle) = self.current_handle()? else {
            return Ok(());
        };
        self.inner
            .index
            .apply_event(&handle, event)
            .map_err(index_error)
    }

    pub fn apply_for_root(&self, expected_root: &Path, event: FileEvent) -> Result<(), String> {
        let Some(handle) = self.current_handle()? else {
            return Ok(());
        };
        if !same_path(handle.root(), expected_root) {
            return Ok(());
        }
        self.inner
            .index
            .apply_event(&handle, event)
            .map_err(index_error)
    }

    pub fn shutdown(&self) {
        let previous = self
            .inner
            .current
            .lock()
            .ok()
            .and_then(|mut current| current.take());
        if let Some(session) = previous {
            let _ = self.inner.index.close_workspace(&session.handle);
            drop(session);
        }
    }
}

impl Drop for WatchSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.watcher.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

type PreparedWatcher = (
    PathBuf,
    RecommendedWatcher,
    Receiver<notify::Result<Event>>,
    Arc<AtomicBool>,
);

fn prepare_watcher(root: PathBuf) -> Result<PreparedWatcher, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Could not canonicalize workspace for watching: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace watcher root is not a directory".to_owned());
    }
    let (sender, receiver) = mpsc::sync_channel(EVENT_CAPACITY);
    let overflow = Arc::new(AtomicBool::new(false));
    let callback_overflow = Arc::clone(&overflow);
    let watcher = notify::recommended_watcher(move |event| {
        if let Err(TrySendError::Full(_)) = sender.try_send(event) {
            callback_overflow.store(true, Ordering::Release);
        }
    })
    .map_err(|error| format!("Could not create workspace watcher: {error}"))?;
    let mut watcher = watcher;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| format!("Could not watch workspace root: {error}"))?;
    Ok((root, watcher, receiver, overflow))
}

fn watch_loop(
    index: FileIndex,
    handle: WorkspaceHandle,
    root: PathBuf,
    receiver: Receiver<notify::Result<Event>>,
    stop: Arc<AtomicBool>,
    overflow: Arc<AtomicBool>,
    watcher_error: Arc<Mutex<Option<String>>>,
) {
    while !stop.load(Ordering::Acquire) {
        let first = match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(first) => first,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                clear_recovery_error_if_ready(&index, &handle, &watcher_error);
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        let mut batch = vec![first];
        let deadline = Instant::now() + COALESCE_WINDOW;
        while batch.len() < EVENT_CAPACITY {
            let wait = deadline.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                break;
            }
            match receiver.recv_timeout(wait) {
                Ok(event) => batch.push(event),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if stop.load(Ordering::Acquire) {
            return;
        }
        let force_rescan = overflow.swap(false, Ordering::AcqRel);
        let rescan = force_rescan || process_batch(&index, &handle, &root, batch);
        if rescan {
            let message = if force_rescan {
                "Filesystem watcher event queue overflowed; reconciling the index".to_owned()
            } else {
                "Filesystem events require index reconciliation".to_owned()
            };
            if let Ok(mut error) = watcher_error.lock() {
                *error = Some(message);
            }
            let _ = index.start_scan_thread(&handle);
        }
    }
}

fn clear_recovery_error_if_ready(
    index: &FileIndex,
    handle: &WorkspaceHandle,
    watcher_error: &Mutex<Option<String>>,
) {
    let is_scanning = index
        .snapshot(handle)
        .is_ok_and(|snapshot| snapshot.status == ScanStatus::Scanning);
    if !is_scanning {
        if let Ok(mut error) = watcher_error.lock() {
            *error = None;
        }
    }
}

fn process_batch(
    index: &FileIndex,
    handle: &WorkspaceHandle,
    root: &Path,
    batch: Vec<notify::Result<Event>>,
) -> bool {
    let mut rescan = false;
    let mut changes = Vec::<PlannedEvent>::new();
    let mut latest_path_event = HashMap::<PathBuf, u64>::new();
    let mut sequence = 0_u64;
    let mut rename_from = Vec::new();
    let mut rename_to = Vec::new();

    for event in batch {
        let Ok(event) = event else {
            rescan = true;
            continue;
        };
        match event.kind {
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
                let from = &event.paths[0];
                let to = &event.paths[1];
                if is_dir_event(index, handle, from) || to.is_dir() {
                    rescan = true;
                } else if let (Some(from), Some(to)) =
                    (scoped_event_path(root, from), scoped_event_path(root, to))
                {
                    if ignore_config_changed(root, &from) || ignore_config_changed(root, &to) {
                        rescan = true;
                    } else {
                        plan_event(
                            &mut changes,
                            &mut latest_path_event,
                            &mut sequence,
                            FileEvent::Rename {
                                from: from.clone(),
                                to: to.clone(),
                            },
                            vec![from, to],
                        );
                    }
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                rename_from.extend(event.paths);
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                rename_to.extend(event.paths);
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => rescan = true,
            EventKind::Remove(_) => {
                for raw_path in event.paths {
                    let Some(path) = scoped_event_path(root, &raw_path) else {
                        continue;
                    };
                    if ignore_config_changed(root, &path) || is_dir_event(index, handle, &path) {
                        rescan = true;
                    } else {
                        plan_event(
                            &mut changes,
                            &mut latest_path_event,
                            &mut sequence,
                            FileEvent::Remove(path.clone()),
                            vec![path],
                        );
                    }
                }
            }
            EventKind::Create(_) | EventKind::Modify(_) => {
                for raw_path in event.paths {
                    let Some(path) = scoped_event_path(root, &raw_path) else {
                        continue;
                    };
                    if ignore_config_changed(root, &path) || path.is_dir() {
                        rescan = true;
                    } else {
                        plan_event(
                            &mut changes,
                            &mut latest_path_event,
                            &mut sequence,
                            FileEvent::Upsert(path.clone()),
                            vec![path],
                        );
                    }
                }
            }
            EventKind::Any | EventKind::Other => rescan = true,
            _ => {}
        }
    }

    if rename_from.len() != rename_to.len() {
        rescan = true;
    } else {
        for (from, to) in rename_from.into_iter().zip(rename_to) {
            let (Some(from), Some(to)) =
                (scoped_event_path(root, &from), scoped_event_path(root, &to))
            else {
                continue;
            };
            if is_dir_event(index, handle, &from)
                || to.is_dir()
                || ignore_config_changed(root, &from)
                || ignore_config_changed(root, &to)
            {
                rescan = true;
            } else {
                plan_event(
                    &mut changes,
                    &mut latest_path_event,
                    &mut sequence,
                    FileEvent::Rename {
                        from: from.clone(),
                        to: to.clone(),
                    },
                    vec![from, to],
                );
            }
        }
    }

    if rescan {
        return true;
    }
    if changes.len() > 256 {
        return true;
    }
    changes.sort_by_key(|event| event.sequence);
    for planned in changes {
        let keep = if let FileEvent::Rename { from, to } = &planned.event {
            latest_path_event.get(from) == Some(&planned.sequence)
                && latest_path_event
                    .get(to)
                    .is_some_and(|latest| *latest >= planned.sequence)
        } else {
            planned
                .paths
                .first()
                .and_then(|path| latest_path_event.get(path))
                == Some(&planned.sequence)
        };
        if keep && index.apply_event(handle, planned.event).is_err() {
            return true;
        }
    }
    false
}

struct PlannedEvent {
    sequence: u64,
    paths: Vec<PathBuf>,
    event: FileEvent,
}

fn plan_event(
    planned: &mut Vec<PlannedEvent>,
    latest_path_event: &mut HashMap<PathBuf, u64>,
    sequence: &mut u64,
    event: FileEvent,
    paths: Vec<PathBuf>,
) {
    *sequence += 1;
    for path in &paths {
        latest_path_event.insert(path.clone(), *sequence);
    }
    planned.push(PlannedEvent {
        sequence: *sequence,
        paths,
        event,
    });
}

fn is_dir_event(index: &FileIndex, handle: &WorkspaceHandle, path: &Path) -> bool {
    path.is_dir() || index.contains_descendant(handle, path).unwrap_or(true)
}

fn scoped_event_path(root: &Path, path: &Path) -> Option<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let scoped = match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => {
            let parent = path.parent()?.canonicalize().ok()?;
            parent.join(path.file_name()?)
        }
    };
    scoped.starts_with(root).then_some(scoped)
}

fn ignore_config_changed(root: &Path, path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name == ".gitignore" || name == ".ignore")
        || path.ends_with(Path::new(".git/info/exclude"))
        || path == root.join(".git/info/exclude")
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn index_error(error: IndexError) -> String {
    error.to_string()
}

fn status_dto(
    snapshot: IndexSnapshot,
    watcher_ready: bool,
    watcher_error: Option<String>,
) -> FileIndexStatus {
    FileIndexStatus {
        workspace_root: snapshot.root.to_string_lossy().into_owned(),
        generation: snapshot.generation,
        status: match snapshot.status {
            ScanStatus::Idle => FileIndexStatusKind::Idle,
            ScanStatus::Scanning => FileIndexStatusKind::Scanning,
            ScanStatus::Ready => FileIndexStatusKind::Ready,
            ScanStatus::Partial => FileIndexStatusKind::Partial,
            ScanStatus::Failed => FileIndexStatusKind::Failed,
        },
        scanned_entries: snapshot.scanned_entries,
        indexed_files: snapshot.indexed_files.min(u32::MAX as usize) as u32,
        error_count: snapshot.error_count,
        last_error: snapshot.last_error,
        watcher_ready,
        watcher_error,
    }
}

fn query_dto(root: &Path, result: QueryResults) -> FileIndexQueryResponse {
    FileIndexQueryResponse {
        workspace_root: root.to_string_lossy().into_owned(),
        generation: result.generation,
        request_id: result.request_id,
        results: result.results.into_iter().map(search_dto).collect(),
    }
}

fn search_dto(result: SearchResult) -> FileIndexMatch {
    FileIndexMatch {
        path: result.relative_path.to_string_lossy().replace('\\', "/"),
        score: result.score,
    }
}

async fn refresh_visibility(
    state: &crate::DesktopState,
    expected_root: &Path,
) -> Result<(), String> {
    let root = expected_root.to_owned();
    let runtime = state.file_index.clone();
    // Read and apply under the same workspace lock as settings mutations.
    // Overlapping status/query calls cannot reapply an older captured policy.
    crate::with_workspace(state.clone(), move |workspace| {
        if Path::new(&workspace.workspace().root) != root {
            return Err(span_core::CoreError::InvalidEdit(
                "File index workspace is changing. Retry shortly.".to_owned(),
            ));
        }
        runtime
            .configure_visibility(&root, workspace.scan_visibility())
            .map_err(span_core::CoreError::Search)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn file_index_status(
    state: State<'_, crate::DesktopState>,
) -> Result<Option<FileIndexStatus>, String> {
    let state = state.inner().clone();
    let expected_root = state
        .file_index_root
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone();
    let Some(expected_root) = expected_root else {
        return Ok(None);
    };
    refresh_visibility(&state, &expected_root).await?;
    state.file_index.status(&expected_root)
}

#[tauri::command]
#[specta::specta]
pub async fn query_file(
    state: State<'_, crate::DesktopState>,
    query: String,
    limit: u8,
) -> Result<FileIndexQueryResponse, String> {
    let state = state.inner().clone();
    let expected_root = state
        .file_index_root
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a folder before finding files".to_owned())?;
    refresh_visibility(&state, &expected_root).await?;
    state.file_index.query(&expected_root, query, limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn reconcile_file_index(
    state: State<'_, crate::DesktopState>,
) -> Result<FileIndexStatus, String> {
    let state = state.inner().clone();
    let expected_root = state
        .file_index_root
        .lock()
        .map_err(|_| "Workspace state is unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Open a folder before reconciling its file index".to_owned())?;
    refresh_visibility(&state, &expected_root).await?;
    state.file_index.reconcile(&expected_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Duration};

    fn write(root: &Path, relative: &str, text: &str) -> PathBuf {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }

    #[tokio::test]
    async fn visibility_change_keeps_the_watcher_and_workspace_generation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        write(&root, ".gitignore", "ignored/\n");
        write(&root, ".hidden.rs", "hidden");
        write(&root, "ignored/old.rs", "old");
        let runtime = FileIndexRuntime::default();
        runtime.activate(root.clone()).await.unwrap();
        wait_until_ready(&runtime, &root).await;
        let handle = runtime.current_handle().unwrap().unwrap();
        let policy = ScanVisibility {
            show_hidden_files: false,
            show_ignored_files: true,
        };
        runtime.configure_visibility(&root, policy).unwrap();
        wait_until_ready(&runtime, &root).await;
        assert_eq!(runtime.current_handle().unwrap().unwrap(), handle);
        assert!(runtime.status(&root).unwrap().unwrap().watcher_ready);
        assert!(runtime
            .query(&root, "hidden", 100)
            .await
            .unwrap()
            .results
            .is_empty());
        wait_for_path(&runtime, &root, "old", "ignored/old.rs").await;
        write(&root, "ignored/from-watcher.rs", "created");
        wait_for_path(&runtime, &root, "from-watcher", "ignored/from-watcher.rs").await;
        runtime.shutdown();
    }

    async fn wait_for_path(runtime: &FileIndexRuntime, root: &Path, query: &str, path: &str) {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Ok(response) = runtime.query(root, query.to_owned(), 100).await {
                    if response.results.iter().any(|item| item.path == path) {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for indexed path {path}"));
    }

    async fn wait_until_ready(runtime: &FileIndexRuntime, root: &Path) {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if runtime
                    .status(root)
                    .ok()
                    .flatten()
                    .is_some_and(|status| matches!(status.status, FileIndexStatusKind::Ready))
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("timed out waiting for file index scan");
    }

    async fn wait_for_absence(runtime: &FileIndexRuntime, root: &Path, path: &str) {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let absent = runtime
                    .query(root, "", 100)
                    .await
                    .is_ok_and(|response| !response.results.iter().any(|item| item.path == path));
                if absent {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for path removal {path}"));
    }

    #[tokio::test]
    async fn real_watcher_replays_scan_deltas_and_reconciles_deletes_renames_ignores_and_directory_moves(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        write(&root, ".gitignore", "ignored/\n");
        write(&root, "deleted.rs", "to delete");
        write(&root, "rename-before.rs", "to rename");
        write(&root, "folder/source.rs", "folder move");
        fs::create_dir_all(root.join("src")).unwrap();
        for item in 0..5000 {
            write(&root, &format!("src/file_{item:04}.rs"), "fixture");
        }

        let runtime = FileIndexRuntime::default();
        runtime.activate(root.clone()).await.unwrap();
        assert!(matches!(
            runtime.status(&root).unwrap().unwrap().status,
            FileIndexStatusKind::Scanning
        ));

        let created = write(
            &root,
            "watcher-hit.rs",
            "created after watcher registration",
        );
        write(&root, "ignored/private.rs", "must remain ignored");
        fs::remove_file(root.join("deleted.rs")).unwrap();
        fs::rename(root.join("rename-before.rs"), root.join("rename-after.rs")).unwrap();
        fs::rename(root.join("folder"), root.join("moved-folder")).unwrap();

        wait_for_path(&runtime, &root, "watcher-hit", "watcher-hit.rs").await;
        wait_for_path(&runtime, &root, "rename-after", "rename-after.rs").await;
        wait_for_path(&runtime, &root, "moved-folder", "moved-folder/source.rs").await;
        wait_until_ready(&runtime, &root).await;

        let deleted = runtime.query(&root, "deleted", 20).await.unwrap();
        assert!(deleted.results.is_empty());
        let ignored = runtime.query(&root, "private", 20).await.unwrap();
        assert!(ignored.results.is_empty());
        let old_name = runtime.query(&root, "rename-before", 20).await.unwrap();
        assert!(old_name.results.is_empty());
        assert!(created.exists());

        fs::write(root.join(".gitignore"), "ignored/\nwatcher-hit.rs\n").unwrap();
        wait_for_absence(&runtime, &root, "watcher-hit.rs").await;

        runtime.shutdown();
        assert!(runtime.current_handle().unwrap().is_none());
    }

    #[tokio::test]
    async fn rapid_workspace_switch_stops_old_watcher_and_marks_queries_by_generation() {
        let first = tempfile::tempdir().unwrap();
        let first_root = first.path().canonicalize().unwrap();
        for item in 0..500 {
            write(first.path(), &format!("a/item_{item:04}.rs"), "fixture");
        }
        let second = tempfile::tempdir().unwrap();
        let second_root = second.path().canonicalize().unwrap();
        write(second.path(), "current.rs", "current");

        let runtime = FileIndexRuntime::default();
        runtime.activate(first_root.clone()).await.unwrap();
        runtime.activate(second_root.clone()).await.unwrap();
        write(first.path(), "late-stale.rs", "stale");
        wait_for_path(&runtime, &second_root, "current", "current.rs").await;
        wait_until_ready(&runtime, &second_root).await;

        let first_query = runtime.query(&second_root, "c", 100);
        let second_query = runtime.query(&second_root, "current", 100);
        let (first_result, second_result) = tokio::join!(first_query, second_query);
        for result in [first_result, second_result].into_iter().flatten() {
            assert_eq!(result.workspace_root, second_root.to_string_lossy());
            assert_eq!(
                result.generation,
                runtime.current_handle().unwrap().unwrap().generation()
            );
        }
        assert!(runtime
            .query(&second_root, "late-stale", 20)
            .await
            .unwrap()
            .results
            .is_empty());

        runtime.shutdown();
    }

    #[tokio::test]
    async fn synthetic_rename_directory_move_and_watcher_error_choose_safe_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        write(&root, "old.rs", "old");
        write(&root, "folder/inside.rs", "inside");
        let index = FileIndex::default();
        let handle = index.open_workspace(&root).await.unwrap();
        index.start_scan(&handle).unwrap().await.unwrap();

        fs::rename(root.join("old.rs"), root.join("new.rs")).unwrap();
        let rename = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(root.join("old.rs"))
            .add_path(root.join("new.rs"));
        assert!(!process_batch(&index, &handle, &root, vec![Ok(rename)]));
        let paths = index.query(&handle, "", 20).await.unwrap();
        assert!(!paths
            .results
            .iter()
            .any(|result| result.relative_path == Path::new("old.rs")));
        assert!(paths
            .results
            .iter()
            .any(|result| result.relative_path == Path::new("new.rs")));

        fs::rename(root.join("folder"), root.join("moved")).unwrap();
        let directory_move = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(root.join("folder"))
            .add_path(root.join("moved"));
        assert!(process_batch(
            &index,
            &handle,
            &root,
            vec![Ok(directory_move)]
        ));

        assert!(process_batch(
            &index,
            &handle,
            &root,
            vec![Err(notify::Error::generic("synthetic watcher error"))]
        ));
    }

    #[tokio::test]
    async fn watcher_queue_overflow_forces_a_reconcile_scan() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        write(&root, "before.rs", "before");
        let index = FileIndex::default();
        let handle = index.open_workspace(&root).await.unwrap();
        index.start_scan(&handle).unwrap().await.unwrap();
        write(&root, "missed.rs", "created before overflow recovery");

        let (sender, receiver) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let overflow = Arc::new(AtomicBool::new(true));
        let watcher_error = Arc::new(Mutex::new(None));
        let worker_index = index.clone();
        let worker_handle = handle.clone();
        let worker_root = root.clone();
        let worker_stop = Arc::clone(&stop);
        let worker_overflow = Arc::clone(&overflow);
        let worker_error = Arc::clone(&watcher_error);
        let worker = thread::spawn(move || {
            watch_loop(
                worker_index,
                worker_handle,
                worker_root,
                receiver,
                worker_stop,
                worker_overflow,
                worker_error,
            )
        });
        sender
            .send(Ok(
                Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join("missed.rs"))
            ))
            .unwrap();

        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if index
                    .query(&handle, "missed.rs", 20)
                    .await
                    .is_ok_and(|result| {
                        result
                            .results
                            .iter()
                            .any(|file| file.relative_path == Path::new("missed.rs"))
                    })
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("overflow reconciliation did not index missed file");
        stop.store(true, Ordering::Release);
        drop(sender);
        worker.join().unwrap();
    }
}
