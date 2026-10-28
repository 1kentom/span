//! Background workspace file indexing for file-name lookup.
//!
//! The index stores paths and basic file metadata only. It does not read file
//! contents, search text, or parse language symbols.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, BinaryHeap},
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        Arc, Mutex, RwLock,
    },
};

use ignore::WalkBuilder;
use nucleo_matcher::{
    pattern::{CaseMatching, Normalization, Pattern},
    Config, Matcher, Utf32Str,
};
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const MAX_RESULTS: usize = 100;
const PROGRESS_INTERVAL: u64 = 128;

#[derive(Debug, Error)]
pub enum IndexError {
    #[error("workspace path could not be canonicalized: {0}")]
    Canonicalize(#[source] std::io::Error),
    #[error("workspace root is not a directory")]
    NotDirectory,
    #[error("path is outside the active workspace")]
    OutsideWorkspace,
    #[error("path is not a regular file")]
    NotFile,
    #[error("index state lock was poisoned")]
    Poisoned,
    #[error("background query worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceHandle {
    generation: u64,
    root: PathBuf,
}

impl WorkspaceHandle {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexedFile {
    pub relative_path: PathBuf,
    pub absolute_path: PathBuf,
    pub size_bytes: u64,
    pub modified_unix_ms: Option<u128>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScanStatus {
    Idle,
    Scanning,
    Ready,
    Partial,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexSnapshot {
    pub generation: u64,
    pub root: PathBuf,
    pub status: ScanStatus,
    pub scanned_entries: u64,
    pub indexed_files: usize,
    pub error_count: u64,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchResult {
    pub relative_path: PathBuf,
    pub absolute_path: PathBuf,
    pub score: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileEvent {
    Upsert(PathBuf),
    Remove(PathBuf),
    Rename { from: PathBuf, to: PathBuf },
}

#[derive(Clone, Default)]
pub struct FileIndex {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    state: RwLock<Option<State>>,
    active_scan: Mutex<Option<(u64, CancellationToken)>>,
    next_generation: Mutex<u64>,
    next_scan_id: AtomicU64,
}

struct State {
    generation: u64,
    root: PathBuf,
    files: BTreeMap<PathBuf, IndexedFile>,
    scan_overlay: BTreeMap<PathBuf, Option<IndexedFile>>,
    status: ScanStatus,
    scanned_entries: u64,
    indexed_progress: usize,
    error_count: u64,
    last_error: Option<String>,
}

impl FileIndex {
    /// Start a new workspace generation. Register the filesystem watcher after
    /// this returns and before calling `start_scan`; events received before or
    /// during the initial scan are replayed over the scan snapshot.
    pub async fn open_workspace(
        &self,
        root: impl AsRef<Path>,
    ) -> Result<WorkspaceHandle, IndexError> {
        let root = tokio::fs::canonicalize(root)
            .await
            .map_err(IndexError::Canonicalize)?;
        if !root.is_dir() {
            return Err(IndexError::NotDirectory);
        }

        if let Some((_, token)) = self
            .inner
            .active_scan
            .lock()
            .map_err(|_| IndexError::Poisoned)?
            .take()
        {
            token.cancel();
        }

        let generation = {
            let mut next = self
                .inner
                .next_generation
                .lock()
                .map_err(|_| IndexError::Poisoned)?;
            *next = next.wrapping_add(1).max(1);
            *next
        };

        *self.inner.state.write().map_err(|_| IndexError::Poisoned)? = Some(State {
            generation,
            root: root.clone(),
            files: BTreeMap::new(),
            scan_overlay: BTreeMap::new(),
            status: ScanStatus::Idle,
            scanned_entries: 0,
            indexed_progress: 0,
            error_count: 0,
            last_error: None,
        });

        Ok(WorkspaceHandle { generation, root })
    }

    /// Begin a cancellable background scan. The returned join handle is
    /// optional to await; the index remains queryable while the scan runs.
    pub fn start_scan(&self, workspace: &WorkspaceHandle) -> Result<JoinHandle<()>, IndexError> {
        self.ensure_active(workspace)?;

        if let Some((_, token)) = self
            .inner
            .active_scan
            .lock()
            .map_err(|_| IndexError::Poisoned)?
            .take()
        {
            token.cancel();
        }

        let token = CancellationToken::new();
        let scan_id = self
            .inner
            .next_scan_id
            .fetch_add(1, AtomicOrdering::Relaxed)
            + 1;
        *self
            .inner
            .active_scan
            .lock()
            .map_err(|_| IndexError::Poisoned)? = Some((scan_id, token.clone()));
        {
            let mut guard = self.inner.state.write().map_err(|_| IndexError::Poisoned)?;
            let state = active_state_mut(&mut guard, workspace)?;
            state.status = ScanStatus::Scanning;
            state.scanned_entries = 0;
            state.indexed_progress = 0;
            state.error_count = 0;
            state.last_error = None;
        }

        let index = self.clone();
        let workspace = workspace.clone();
        Ok(tokio::task::spawn_blocking(move || {
            index.scan_blocking(&workspace, token, scan_id);
        }))
    }

    /// Apply a watcher or save/rename event. A watcher should be attached to
    /// the canonical workspace root only. Events are coalesced by path while a
    /// scan is running, so the newest event wins when the initial scan commits.
    pub fn apply_event(
        &self,
        workspace: &WorkspaceHandle,
        event: FileEvent,
    ) -> Result<(), IndexError> {
        self.ensure_active(workspace)?;
        match event {
            FileEvent::Upsert(path) => self.apply_upsert(workspace, &path),
            FileEvent::Remove(path) => self.apply_remove(workspace, &path),
            FileEvent::Rename { from, to } => {
                self.apply_remove(workspace, &from)?;
                self.apply_upsert(workspace, &to)
            }
        }
    }

    pub fn snapshot(&self, workspace: &WorkspaceHandle) -> Result<IndexSnapshot, IndexError> {
        let guard = self.inner.state.read().map_err(|_| IndexError::Poisoned)?;
        let state = active_state(&guard, workspace)?;
        Ok(IndexSnapshot {
            generation: state.generation,
            root: state.root.clone(),
            status: state.status,
            scanned_entries: state.scanned_entries,
            indexed_files: if state.status == ScanStatus::Scanning {
                state.indexed_progress
            } else {
                state.files.len()
            },
            error_count: state.error_count,
            last_error: state.last_error.clone(),
        })
    }

    /// Fuzzy-match indexed relative paths in a blocking worker and return at
    /// most 100 deterministic results. The per-query heap also stays bounded
    /// to the requested result count.
    pub async fn query(
        &self,
        workspace: &WorkspaceHandle,
        query: impl Into<String>,
        limit: usize,
    ) -> Result<Vec<SearchResult>, IndexError> {
        let query = query.into();
        let files = {
            let guard = self.inner.state.read().map_err(|_| IndexError::Poisoned)?;
            active_state(&guard, workspace)?
                .files
                .values()
                .cloned()
                .collect::<Vec<_>>()
        };
        let limit = limit.min(MAX_RESULTS);
        Ok(tokio::task::spawn_blocking(move || fuzzy_query(files, &query, limit)).await?)
    }

    fn ensure_active(&self, workspace: &WorkspaceHandle) -> Result<(), IndexError> {
        let guard = self.inner.state.read().map_err(|_| IndexError::Poisoned)?;
        active_state(&guard, workspace).map(|_| ())
    }

    fn apply_upsert(&self, workspace: &WorkspaceHandle, path: &Path) -> Result<(), IndexError> {
        let Some(file) = canonical_file(workspace, path)? else {
            return Ok(());
        };
        let mut guard = self.inner.state.write().map_err(|_| IndexError::Poisoned)?;
        let state = active_state_mut(&mut guard, workspace)?;
        state.files.insert(file.relative_path.clone(), file.clone());
        if state.status == ScanStatus::Scanning {
            state
                .scan_overlay
                .insert(file.relative_path.clone(), Some(file));
        }
        Ok(())
    }

    fn apply_remove(&self, workspace: &WorkspaceHandle, path: &Path) -> Result<(), IndexError> {
        let relative = lexical_relative(&workspace.root, path)?;
        let mut guard = self.inner.state.write().map_err(|_| IndexError::Poisoned)?;
        let state = active_state_mut(&mut guard, workspace)?;
        state.files.remove(&relative);
        if state.status == ScanStatus::Scanning {
            state.scan_overlay.insert(relative, None);
        }
        Ok(())
    }

    fn scan_blocking(&self, workspace: &WorkspaceHandle, token: CancellationToken, scan_id: u64) {
        let mut scanned = BTreeMap::new();
        let mut visited = 0_u64;
        let mut error_count = 0_u64;
        let mut last_error = None;
        let walker = WalkBuilder::new(&workspace.root)
            .hidden(false)
            .require_git(false)
            .follow_links(false)
            .build();

        for item in walker {
            if token.is_cancelled() || !self.is_active_generation(workspace.generation) {
                return;
            }
            match item {
                Ok(entry) => {
                    visited += 1;
                    if entry.file_type().is_some_and(|kind| kind.is_file()) {
                        match scan_file(workspace, entry.path()) {
                            Ok(Some(file)) => {
                                scanned.insert(file.relative_path.clone(), file);
                            }
                            Ok(None) => {}
                            Err(error) => {
                                error_count += 1;
                                last_error = Some(error.to_string());
                            }
                        }
                    }
                    if visited % PROGRESS_INTERVAL == 0 {
                        self.set_progress(workspace.generation, visited, scanned.len());
                    }
                }
                Err(error) => {
                    error_count += 1;
                    last_error = Some(error.to_string());
                }
            }
        }

        if token.is_cancelled() || !self.is_active_generation(workspace.generation) {
            return;
        }

        if let Ok(mut guard) = self.inner.state.write() {
            if let Some(state) = guard
                .as_mut()
                .filter(|state| state.generation == workspace.generation)
            {
                for (path, event_file) in std::mem::take(&mut state.scan_overlay) {
                    match event_file {
                        Some(file) => {
                            scanned.insert(path, file);
                        }
                        None => {
                            scanned.remove(&path);
                        }
                    }
                }
                state.files = scanned;
                state.scanned_entries = visited;
                state.indexed_progress = state.files.len();
                state.error_count = error_count;
                state.last_error = last_error;
                state.status = if error_count == 0 {
                    ScanStatus::Ready
                } else if state.files.is_empty() {
                    ScanStatus::Failed
                } else {
                    ScanStatus::Partial
                };
            }
        }
        if let Ok(mut active) = self.inner.active_scan.lock() {
            if active
                .as_ref()
                .is_some_and(|(current_id, _)| *current_id == scan_id)
            {
                *active = None;
            }
        }
    }

    fn is_active_generation(&self, generation: u64) -> bool {
        self.inner
            .state
            .read()
            .ok()
            .and_then(|guard| guard.as_ref().map(|state| state.generation == generation))
            .unwrap_or(false)
    }

    fn set_progress(&self, generation: u64, visited: u64, indexed: usize) {
        if let Ok(mut guard) = self.inner.state.write() {
            if let Some(state) = guard
                .as_mut()
                .filter(|state| state.generation == generation)
            {
                state.scanned_entries = visited;
                state.indexed_progress = indexed;
            }
        }
    }
}

fn active_state<'a>(
    guard: &'a Option<State>,
    workspace: &WorkspaceHandle,
) -> Result<&'a State, IndexError> {
    guard
        .as_ref()
        .filter(|state| state.generation == workspace.generation && state.root == workspace.root)
        .ok_or(IndexError::OutsideWorkspace)
}

fn active_state_mut<'a>(
    guard: &'a mut Option<State>,
    workspace: &WorkspaceHandle,
) -> Result<&'a mut State, IndexError> {
    guard
        .as_mut()
        .filter(|state| state.generation == workspace.generation && state.root == workspace.root)
        .ok_or(IndexError::OutsideWorkspace)
}

fn scan_file(workspace: &WorkspaceHandle, path: &Path) -> Result<Option<IndexedFile>, IndexError> {
    let kind = fs::symlink_metadata(path)
        .map_err(IndexError::Canonicalize)?
        .file_type();
    if kind.is_symlink() || !kind.is_file() {
        return Ok(None);
    }
    let canonical = fs::canonicalize(path).map_err(IndexError::Canonicalize)?;
    if !canonical.starts_with(&workspace.root) {
        return Ok(None);
    }
    metadata_file(&workspace.root, &canonical).map(Some)
}

fn canonical_file(
    workspace: &WorkspaceHandle,
    path: &Path,
) -> Result<Option<IndexedFile>, IndexError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.root.join(path)
    };
    let canonical = match fs::canonicalize(&absolute) {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(IndexError::Canonicalize(error)),
    };
    if !canonical.starts_with(&workspace.root) {
        return Err(IndexError::OutsideWorkspace);
    }
    let metadata = fs::metadata(&canonical).map_err(IndexError::Canonicalize)?;
    if !metadata.is_file() {
        return Err(IndexError::NotFile);
    }
    Ok(Some(file_from_metadata(workspace, canonical, metadata)?))
}

fn metadata_file(root: &Path, canonical: &Path) -> Result<IndexedFile, IndexError> {
    let metadata = fs::metadata(canonical).map_err(IndexError::Canonicalize)?;
    file_from_metadata_parts(root, canonical.to_path_buf(), metadata)
}

fn file_from_metadata(
    workspace: &WorkspaceHandle,
    canonical: PathBuf,
    metadata: fs::Metadata,
) -> Result<IndexedFile, IndexError> {
    file_from_metadata_parts(&workspace.root, canonical, metadata)
}

fn file_from_metadata_parts(
    root: &Path,
    canonical: PathBuf,
    metadata: fs::Metadata,
) -> Result<IndexedFile, IndexError> {
    let relative_path = canonical
        .strip_prefix(root)
        .map_err(|_| IndexError::OutsideWorkspace)?
        .to_path_buf();
    let modified_unix_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis());
    Ok(IndexedFile {
        relative_path,
        absolute_path: canonical,
        size_bytes: metadata.len(),
        modified_unix_ms,
    })
}

fn lexical_relative(root: &Path, path: &Path) -> Result<PathBuf, IndexError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let absolute = match fs::canonicalize(&absolute) {
        Ok(canonical) => canonical,
        Err(_) => {
            let parent = absolute.parent().ok_or(IndexError::OutsideWorkspace)?;
            let name = absolute.file_name().ok_or(IndexError::NotFile)?;
            match fs::canonicalize(parent) {
                Ok(parent) => parent.join(name),
                Err(_) => absolute,
            }
        }
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(IndexError::OutsideWorkspace);
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    let relative = normalized
        .strip_prefix(root)
        .map_err(|_| IndexError::OutsideWorkspace)?;
    if relative.as_os_str().is_empty() {
        return Err(IndexError::NotFile);
    }
    Ok(relative.to_path_buf())
}

fn fuzzy_query(files: Vec<IndexedFile>, query: &str, limit: usize) -> Vec<SearchResult> {
    if limit == 0 {
        return Vec::new();
    }
    if query.trim().is_empty() {
        return files
            .into_iter()
            .take(limit)
            .map(|file| SearchResult {
                relative_path: file.relative_path,
                absolute_path: file.absolute_path,
                score: 0,
            })
            .collect();
    }

    let pattern = Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut char_buffer = Vec::new();
    let mut best = BinaryHeap::with_capacity(limit + 1);
    for file in files {
        let candidate = file.relative_path.to_string_lossy();
        let candidate = Utf32Str::new(candidate.as_ref(), &mut char_buffer);
        let Some(score) = pattern.score(candidate, &mut matcher) else {
            continue;
        };
        let item = HeapItem(SearchResult {
            relative_path: file.relative_path,
            absolute_path: file.absolute_path,
            score,
        });
        if best.len() < limit {
            best.push(item);
        } else if best.peek().is_some_and(|worst| item < *worst) {
            best.pop();
            best.push(item);
        }
    }
    let mut results = best
        .into_vec()
        .into_iter()
        .map(|item| item.0)
        .collect::<Vec<_>>();
    results.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    results
}

#[derive(Debug, Eq, PartialEq)]
struct HeapItem(SearchResult);

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0
            .score
            .cmp(&other.0.score)
            .reverse()
            .then_with(|| self.0.relative_path.cmp(&other.0.relative_path))
    }
}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests;
