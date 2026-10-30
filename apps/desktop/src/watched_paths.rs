//! Scoped disk notifications for LSP, independent of Explorer visibility settings.
//!
//! LSP permits directory events. Only the directory path actually reported by the
//! watcher is sent: this module never invents descendant events or scans a tree.
//! Ignore rules are evaluated from bounded, current on-disk ancestor files, even
//! when the reported entry or several of its parent directories were deleted.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{
    event::{CreateKind, ModifyKind, RemoveKind, RenameMode},
    Event, EventKind,
};
use span_lsp::lsp_types::{FileChangeType, FileEvent};
use span_lsp::watch_sync::{in_nested_checkout, is_nested_checkout, Exclusions};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
};

const MAX_CHANGES: usize = 1024;
const MAX_INPUT: usize = 4096;
const MAX_DEPTH: usize = 64;
const MAX_IGNORE_BYTES: usize = 128 * 1024;
const MAX_TOTAL_IGNORE_BYTES: usize = 1024 * 1024;
const MAX_IGNORE_FILES: usize = 256;
const MAX_IGNORE_CACHE: usize = 4096;
const MAX_IGNORE_LINES: usize = 8192;
const MAX_IGNORE_LINE_BYTES: usize = 4096;

static EXCLUSIONS: RwLock<Option<Arc<Exclusions>>> = RwLock::new(None);

/// Directory exclusions for language server notifications, from user settings.
pub(crate) fn set_exclusions(exclusions: Exclusions) {
    if let Ok(mut current) = EXCLUSIONS.write() {
        *current = Some(Arc::new(exclusions));
    }
}

pub(crate) fn exclusions() -> Arc<Exclusions> {
    EXCLUSIONS
        .read()
        .ok()
        .and_then(|current| current.clone())
        .unwrap_or_default()
}

/// Whether some path of `event` could matter to a language server: not inside an
/// excluded directory and not inside a nested checkout. Used before an event is
/// queued, so benign dependency installs and builds do not count as lost
/// notifications. Rescan flags always signal global loss.
pub(crate) fn lsp_relevant(
    root: &Path,
    supplied_root: &Path,
    event: &Event,
    exclusions: &Exclusions,
    nested: &mut HashMap<PathBuf, bool>,
) -> bool {
    event.need_rescan()
        || event.paths.is_empty()
        || event.paths.iter().any(|path| {
            let relative = path
                .strip_prefix(root)
                .or_else(|_| path.strip_prefix(supplied_root))
                .unwrap_or(path);
            let absolute = root.join(relative);
            let parent_excluded = relative
                .parent()
                .is_some_and(|parent| exclusions.excludes(parent));
            // The reported entry itself only counts as excluded when it is a
            // folder: a regular file may share a name such as `dist`.
            let self_excluded = relative
                .file_name()
                .is_some_and(|name| exclusions.excludes_dir(name))
                && fs::symlink_metadata(&absolute).is_ok_and(|meta| meta.is_dir());
            !parent_excluded && !self_excluded && !in_nested_checkout(root, &absolute, nested)
        })
}

pub(crate) struct WatchedBatch {
    pub(crate) root: PathBuf,
    pub(crate) changes: Vec<FileEvent>,
    pub(crate) incomplete: bool,
}

pub(crate) fn watched_batch(
    root: &Path,
    batch: &[notify::Result<Event>],
    overflow: bool,
) -> WatchedBatch {
    let mut result = WatchedBatch {
        root: root.to_path_buf(),
        changes: Vec::new(),
        incomplete: overflow,
    };
    let Ok(canonical_root) = fs::canonicalize(root) else {
        result.incomplete = true;
        return result;
    };
    if !canonical_root.is_dir() {
        result.incomplete = true;
        return result;
    }
    result.root = canonical_root.clone();
    let exclusions = exclusions();
    let mut nested = HashMap::new();
    let mut policy = IgnorePolicy::new(&canonical_root, &exclusions);
    let rename_kinds = rename_kinds(&canonical_root, root, batch);
    let mut seen = HashMap::new();
    let mut paths_examined = 0;
    if batch.len() > MAX_INPUT {
        result.incomplete = true;
    }
    for (event_index, event) in batch.iter().take(MAX_INPUT).enumerate() {
        let Ok(event) = event else {
            result.incomplete = true;
            continue;
        };
        // Global loss signals and the raw endpoint budget apply even when all
        // endpoints belong to excluded folders or nested checkouts.
        result.incomplete |= event.need_rescan();
        if event.paths.len() > MAX_INPUT - paths_examined {
            result.incomplete = true;
            break;
        }
        paths_examined += event.paths.len();
        if !lsp_relevant(&canonical_root, root, event, &exclusions, &mut nested) {
            continue;
        }
        let (typ, hint) = match event.kind {
            EventKind::Access(_) => continue,
            EventKind::Create(kind) => (
                FileChangeType::CREATED,
                match kind {
                    CreateKind::File => Some(false),
                    CreateKind::Folder => Some(true),
                    _ => None,
                },
            ),
            EventKind::Remove(kind) => (
                FileChangeType::DELETED,
                match kind {
                    RemoveKind::File => Some(false),
                    RemoveKind::Folder => Some(true),
                    _ => None,
                },
            ),
            EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => {
                (FileChangeType::CHANGED, None)
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                (FileChangeType::DELETED, None)
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => (FileChangeType::CREATED, None),
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() == 2 => {
                for ((path_index, path), typ) in event
                    .paths
                    .iter()
                    .enumerate()
                    .zip([FileChangeType::DELETED, FileChangeType::CREATED])
                {
                    push_change(
                        &mut result,
                        &mut policy,
                        &mut seen,
                        &canonical_root,
                        root,
                        path,
                        typ,
                        rename_kinds.get(&(event_index, path_index)).copied(),
                    );
                }
                continue;
            }
            // macOS reports renames without a direction and some backends report
            // unspecific modifications. The path's existence settles what happened.
            EventKind::Modify(ModifyKind::Name(RenameMode::Any | RenameMode::Other))
                if event.paths.len() == 1 =>
            {
                if fs::symlink_metadata(canonical_root.join(&event.paths[0])).is_ok() {
                    (FileChangeType::CREATED, None)
                } else {
                    (FileChangeType::DELETED, None)
                }
            }
            // An unspecific modification of an entry that still exists (Windows
            // reports every write this way) is a change. Anything vaguer stays
            // uncertain and leads to a resync rather than an invented event.
            EventKind::Modify(ModifyKind::Any | ModifyKind::Other)
                if event.paths.len() == 1
                    && !event.need_rescan()
                    && fs::symlink_metadata(canonical_root.join(&event.paths[0])).is_ok() =>
            {
                (FileChangeType::CHANGED, None)
            }
            _ => {
                // Unsupported kinds only lose useful information when an endpoint
                // could be visible. FSEvents reports unclassified Git metadata
                // renames during ordinary index updates.
                if event.paths.is_empty() {
                    result.incomplete = true;
                }
                for path in &event.paths {
                    match scoped_path(&canonical_root, root, path) {
                        Ok(None) => {}
                        Ok(Some(path)) => {
                            if policy.visible_kind(&path.path, path.is_dir) != Ok(false) {
                                result.incomplete = true;
                            }
                        }
                        Err(_) => result.incomplete = true,
                    }
                }
                continue;
            }
        };
        if event.paths.is_empty() {
            result.incomplete = true;
        }
        for (path_index, path) in event.paths.iter().enumerate() {
            push_change(
                &mut result,
                &mut policy,
                &mut seen,
                &canonical_root,
                root,
                path,
                typ,
                hint.or_else(|| rename_kinds.get(&(event_index, path_index)).copied()),
            );
        }
    }
    result
}

/// A paired rename can identify a missing source's kind from its scoped target.
/// Split events share kind information only with an equal, nonempty tracker.
/// Hints are keyed by event and endpoint, so unrelated paths cannot reuse them.
fn rename_kinds(
    root: &Path,
    supplied_root: &Path,
    batch: &[notify::Result<Event>],
) -> HashMap<(usize, usize), bool> {
    type Endpoints<'a> = (Vec<(usize, &'a Path)>, Vec<(usize, &'a Path)>);
    let mut hints = HashMap::new();
    let mut split = HashMap::<usize, Endpoints<'_>>::new();
    for (index, event) in batch.iter().take(MAX_INPUT).enumerate() {
        let Ok(event) = event else {
            continue;
        };
        match event.kind {
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() == 2 => {
                if let Some(kind) =
                    infer_rename_kind(root, supplied_root, &event.paths[0], &event.paths[1])
                {
                    hints.insert((index, 0), kind);
                    hints.insert((index, 1), kind);
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) if event.paths.len() == 1 => {
                if let Some(tracker) = event.tracker() {
                    split
                        .entry(tracker)
                        .or_default()
                        .0
                        .push((index, &event.paths[0]));
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) if event.paths.len() == 1 => {
                if let Some(tracker) = event.tracker() {
                    split
                        .entry(tracker)
                        .or_default()
                        .1
                        .push((index, &event.paths[0]));
                }
            }
            _ => {}
        }
    }
    for (from, to) in split.into_values() {
        if from.len() == 1 && to.len() == 1 {
            if let Some(kind) = infer_rename_kind(root, supplied_root, from[0].1, to[0].1) {
                hints.insert((from[0].0, 0), kind);
                hints.insert((to[0].0, 0), kind);
            }
        }
    }
    hints
}

fn infer_rename_kind(root: &Path, supplied_root: &Path, from: &Path, to: &Path) -> Option<bool> {
    let from = scoped_path(root, supplied_root, from).ok()??;
    let to = scoped_path(root, supplied_root, to).ok()??;
    from.is_dir.or(to.is_dir)
}

#[allow(clippy::too_many_arguments)]
fn push_change(
    result: &mut WatchedBatch,
    policy: &mut IgnorePolicy<'_>,
    seen: &mut HashMap<PathBuf, (FileChangeType, bool)>,
    root: &Path,
    supplied_root: &Path,
    raw_path: &Path,
    typ: FileChangeType,
    directory_hint: Option<bool>,
) {
    let path = match scoped_path(root, supplied_root, raw_path) {
        Ok(Some(path)) => path,
        Ok(None) => return,
        Err(_) => {
            result.incomplete = true;
            return;
        }
    };
    // Track every scoped transition, including filtered ones, so a later
    // recreate is not mistaken for a duplicate of an earlier create.
    let previous = seen.insert(path.path.clone(), (typ, false));
    let is_dir = path.is_dir.or(directory_hint);
    match policy.visible_kind(&path.path, is_dir) {
        Ok(true) => {}
        Ok(false) => return,
        Err(()) => {
            result.incomplete = true;
            return;
        }
    }
    let Ok(uri) = span_lsp::path_to_uri(&path.path) else {
        result.incomplete = true;
        return;
    };
    let event = FileEvent::new(uri, typ);
    if previous == Some((typ, true)) {
        seen.insert(path.path, (typ, true));
        return;
    }
    if result.changes.len() >= MAX_CHANGES {
        result.incomplete = true;
        return;
    }
    seen.insert(path.path, (typ, true));
    result.changes.push(event);
}

struct ScopedPath {
    path: PathBuf,
    is_dir: Option<bool>,
}

/// Check every existing component, rather than canonicalizing only the immediate
/// parent. A removed nested subtree still has an existing in-workspace ancestor.
/// Symlink components are excluded consistently with background follow_links(false).
fn scoped_path(root: &Path, supplied_root: &Path, raw: &Path) -> io::Result<Option<ScopedPath>> {
    if raw.components().any(|c| matches!(c, Component::ParentDir)) {
        return Ok(None);
    }
    let relative = if raw.is_absolute() {
        match raw
            .strip_prefix(root)
            .or_else(|_| raw.strip_prefix(supplied_root))
        {
            Ok(relative) => relative,
            Err(_) => return Ok(None),
        }
    } else {
        raw
    };
    if relative.components().count() > MAX_DEPTH {
        return Err(io::Error::other("watched path exceeds depth bound"));
    }
    let path = root.join(relative);
    let mut current = root.to_path_buf();
    let mut nearest = current.clone();
    let mut is_dir = if relative.as_os_str().is_empty() {
        Some(true)
    } else {
        None
    };
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        match component {
            Component::CurDir => continue,
            Component::Normal(name) => current.push(name),
            _ => return Ok(None),
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Ok(None);
                }
                if index + 1 < components.len() && !metadata.is_dir() {
                    return Ok(None);
                }
                if index + 1 == components.len() {
                    is_dir = Some(metadata.is_dir());
                }
                nearest = current.clone();
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    if !fs::canonicalize(nearest)?.starts_with(root) {
        return Ok(None);
    }
    Ok(Some(ScopedPath { path, is_dir }))
}

#[derive(Clone)]
struct Rules {
    ignore: Option<Arc<Gitignore>>,
    git: Option<Arc<Gitignore>>,
    exclude: Option<Arc<Gitignore>>,
    git_boundary: bool,
}

type CachedIgnore = Result<Option<Arc<Gitignore>>, ()>;

struct IgnorePolicy<'a> {
    root: &'a Path,
    exclusions: &'a Exclusions,
    cache: HashMap<PathBuf, CachedIgnore>,
    bytes: usize,
    files: usize,
}

impl<'a> IgnorePolicy<'a> {
    fn new(root: &'a Path, exclusions: &'a Exclusions) -> Self {
        Self {
            root,
            exclusions,
            cache: HashMap::new(),
            bytes: 0,
            files: 0,
        }
    }

    /// Without a reliable kind, do not silently turn a regular filename into
    /// a directory exclusion. Divergent classifications require reconciliation.
    fn visible_kind(&mut self, path: &Path, is_dir: Option<bool>) -> Result<bool, ()> {
        if let Some(is_dir) = is_dir {
            return self.visible(path, is_dir);
        }
        let file_visible = self.visible(path, false)?;
        let directory_visible = self.visible(path, true)?;
        if file_visible != directory_visible {
            return Err(());
        }
        Ok(file_visible)
    }

    fn visible(&mut self, path: &Path, is_dir: bool) -> Result<bool, ()> {
        let relative = path.strip_prefix(self.root).map_err(|_| ())?;
        let components: Vec<_> = relative.components().collect();
        let mut prefix = self.root.to_path_buf();
        let mut rules = vec![self.rules(&prefix)?];
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                continue;
            };
            prefix.push(name);
            let directory = index + 1 < components.len() || is_dir;
            if protected(name, directory)
                || directory && self.exclusions.excludes_dir(name)
                || directory && index + 1 < components.len() && is_nested_checkout(&prefix)
                || ignored(&rules, &prefix, directory)
            {
                return Ok(false);
            }
            if index + 1 < components.len() {
                rules.push(self.rules(&prefix)?);
            }
        }
        Ok(true)
    }

    fn rules(&mut self, directory: &Path) -> Result<Rules, ()> {
        let ignore = self.load(&directory.join(".ignore"), directory)?;
        let git = self.load(&directory.join(".gitignore"), directory)?;
        // Worktree .git files and symlinked git metadata may point outside the
        // workspace. Never read through them to discover an exclude file.
        let git_dir = directory.join(".git");
        let info = git_dir.join("info");
        let exclude = if normal_directory(&git_dir) && normal_directory(&info) {
            self.load(&info.join("exclude"), directory)?
        } else {
            None
        };
        Ok(Rules {
            ignore,
            git,
            exclude,
            git_boundary: fs::symlink_metadata(&git_dir).is_ok(),
        })
    }

    fn load(&mut self, path: &Path, base: &Path) -> CachedIgnore {
        if let Some(cached) = self.cache.get(path) {
            return cached.clone();
        }
        if self.cache.len() >= MAX_IGNORE_CACHE {
            return Err(());
        }
        let loaded = self.read(path, base);
        self.cache.insert(path.to_path_buf(), loaded.clone());
        loaded
    }

    fn read(&mut self, path: &Path, base: &Path) -> CachedIgnore {
        let scoped = scoped_path(self.root, self.root, path)
            .map_err(|_| ())?
            .ok_or(())?;
        let metadata = match fs::symlink_metadata(&scoped.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_IGNORE_BYTES as u64
            || self.files >= MAX_IGNORE_FILES
            || self.bytes >= MAX_TOTAL_IGNORE_BYTES
        {
            return Err(());
        }
        let allowance = MAX_IGNORE_BYTES.min(MAX_TOTAL_IGNORE_BYTES - self.bytes);
        if metadata.len() > allowance as u64 {
            return Err(());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FILE_FLAG_OPEN_REPARSE_POINT prevents following a replaced link.
            options.custom_flags(0x0020_0000);
        }
        let file = options.open(path).map_err(|_| ())?;
        let opened = file.metadata().map_err(|_| ())?;
        if !opened.is_file() || opened.file_type().is_symlink() {
            return Err(());
        }
        let mut bytes = Vec::new();
        let read = file.take(allowance as u64 + 1).read_to_end(&mut bytes);
        self.bytes += bytes.len();
        self.files += 1;
        if read.is_err() || bytes.len() > allowance {
            return Err(());
        }
        let source = std::str::from_utf8(&bytes).map_err(|_| ())?;
        let mut builder = GitignoreBuilder::new(base);
        for (index, line) in source.lines().enumerate() {
            if index >= MAX_IGNORE_LINES || line.len() > MAX_IGNORE_LINE_BYTES {
                return Err(());
            }
            builder
                .add_line(Some(path.to_path_buf()), line)
                .map_err(|_| ())?;
        }
        builder
            .build()
            .map(|matcher| Some(Arc::new(matcher)))
            .map_err(|_| ())
    }
}

fn normal_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

fn ignored(rules: &[Rules], path: &Path, is_dir: bool) -> bool {
    // As in ignore::WalkBuilder, .ignore takes precedence over .gitignore,
    // followed by git's info/exclude. The nearest matching ancestor wins per kind.
    for layer in 0..3 {
        for rules in rules.iter().rev() {
            let matcher = match layer {
                0 => &rules.ignore,
                1 => &rules.git,
                _ => &rules.exclude,
            };
            if let Some(matcher) = matcher {
                let matched = matcher.matched(path, is_dir);
                if matched.is_ignore() {
                    return true;
                }
                if matched.is_whitelist() {
                    return false;
                }
            }
            if layer > 0 && rules.git_boundary {
                break;
            }
        }
    }
    false
}

fn protected(name: &std::ffi::OsStr, directory: bool) -> bool {
    matches!(
        name.to_str(),
        Some(".git" | ".hg" | ".svn" | ".DS_Store" | "Thumbs.db")
    ) || directory && matches!(name.to_str(), Some("node_modules" | ".span"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, DataChange, Flag};

    fn event(kind: EventKind, paths: &[&Path]) -> notify::Result<Event> {
        Ok(paths.iter().fold(Event::new(kind), |event, path| {
            event.add_path(path.to_path_buf())
        }))
    }

    fn actual(root: &Path, path: &str, kind: FileChangeType) -> FileEvent {
        FileEvent::new(span_lsp::path_to_uri(&root.join(path)).unwrap(), kind)
    }

    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn scoped_creates_changes_nested_deletes_and_directories_are_actual_events() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join(".classpath"), "x").unwrap();
        fs::create_dir(root.join("folder")).unwrap();
        fs::write(root.join("folder/child.java"), "x").unwrap();
        fs::create_dir_all(root.join("gone/deep")).unwrap();
        fs::write(root.join("gone/deep/Removed.java"), "x").unwrap();
        fs::remove_dir_all(root.join("gone")).unwrap();
        let result = watched_batch(
            &root,
            &[
                event(
                    EventKind::Create(CreateKind::File),
                    &[Path::new(".classpath")],
                ),
                event(
                    EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                    &[&root.join(".classpath")],
                ),
                event(
                    EventKind::Remove(RemoveKind::File),
                    &[&root.join("gone/deep/Removed.java")],
                ),
                event(
                    EventKind::Create(CreateKind::Folder),
                    &[&root.join("folder")],
                ),
            ],
            false,
        );
        assert!(!result.incomplete);
        assert_eq!(
            result.changes,
            vec![
                actual(&root, ".classpath", FileChangeType::CREATED),
                actual(&root, ".classpath", FileChangeType::CHANGED),
                actual(&root, "gone/deep/Removed.java", FileChangeType::DELETED),
                actual(&root, "folder", FileChangeType::CREATED),
            ]
        );
    }

    #[test]
    fn renames_emit_delete_create_and_deduplicate_same_kind_only() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        let result = watched_batch(
            &root,
            &[
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                    &[Path::new("old.java"), Path::new("new.java")],
                ),
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                    &[Path::new("old.java")],
                ),
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                    &[Path::new("new.java")],
                ),
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                    &[Path::new("new.java")],
                ),
            ],
            false,
        );
        assert!(!result.incomplete);
        assert_eq!(
            result.changes,
            vec![
                actual(&root, "old.java", FileChangeType::DELETED),
                actual(&root, "new.java", FileChangeType::CREATED),
                actual(&root, "new.java", FileChangeType::DELETED),
            ]
        );
    }

    #[test]
    fn repeated_events_preserve_recreate_and_redelete_transitions() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("cycle.json"), "{}").unwrap();
        for kinds in [
            [
                FileChangeType::CREATED,
                FileChangeType::DELETED,
                FileChangeType::CREATED,
            ],
            [
                FileChangeType::DELETED,
                FileChangeType::CREATED,
                FileChangeType::DELETED,
            ],
        ] {
            let mut batch = Vec::new();
            for kind in kinds {
                let native = if kind == FileChangeType::CREATED {
                    EventKind::Create(CreateKind::File)
                } else {
                    EventKind::Remove(RemoveKind::File)
                };
                batch.push(event(native, &[Path::new("cycle.json")]));
                batch.push(event(native, &[Path::new("cycle.json")]));
            }
            let result = watched_batch(&root, &batch, false);
            assert!(!result.incomplete);
            assert_eq!(
                result.changes,
                kinds
                    .into_iter()
                    .map(|kind| actual(&root, "cycle.json", kind))
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn rename_of_regular_file_named_like_ignored_directory_keeps_deleted_uri() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        fs::write(root.join("newfile"), "regular file").unwrap();
        let expected = vec![
            actual(&root, "dist", FileChangeType::DELETED),
            actual(&root, "newfile", FileChangeType::CREATED),
        ];
        let paired = watched_batch(
            &root,
            &[event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &[Path::new("dist"), Path::new("newfile")],
            )],
            false,
        );
        assert!(!paired.incomplete);
        assert_eq!(paired.changes, expected);
        for tracker in [None, Some(7)] {
            let mut from = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path("dist".into());
            let mut to = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
                .add_path("newfile".into());
            if let Some(tracker) = tracker {
                from = from.set_tracker(tracker);
                to = to.set_tracker(tracker);
            }
            let split = watched_batch(&root, &[Ok(from), Ok(to)], false);
            if tracker.is_some() {
                assert!(!split.incomplete);
                assert_eq!(split.changes, expected);
            } else {
                assert!(split.incomplete);
                assert_eq!(
                    split.changes,
                    vec![actual(&root, "newfile", FileChangeType::CREATED)]
                );
            }
        }
        let unknown = watched_batch(
            &root,
            &[event(
                EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                &[Path::new("dist")],
            )],
            false,
        );
        assert!(unknown.incomplete);
        assert!(unknown.changes.is_empty());
        let explicit_file = watched_batch(
            &root,
            &[event(
                EventKind::Remove(RemoveKind::File),
                &[Path::new("dist")],
            )],
            false,
        );
        assert!(!explicit_file.incomplete);
        assert_eq!(
            explicit_file.changes,
            vec![actual(&root, "dist", FileChangeType::DELETED)]
        );
    }

    #[test]
    fn untracked_unrelated_from_to_events_never_share_file_or_directory_kind() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        for source_is_directory in [true, false] {
            let destination = if source_is_directory {
                fs::create_dir(root.join("dist")).unwrap();
                fs::remove_dir(root.join("dist")).unwrap();
                fs::write(root.join("created-file"), "unrelated file").unwrap();
                "created-file"
            } else {
                fs::write(root.join("dist"), "removed regular file").unwrap();
                fs::remove_file(root.join("dist")).unwrap();
                fs::create_dir(root.join("created-directory")).unwrap();
                "created-directory"
            };
            let result = watched_batch(
                &root,
                &[
                    event(
                        EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                        &[Path::new("dist")],
                    ),
                    event(
                        EventKind::Modify(ModifyKind::Name(RenameMode::To)),
                        &[Path::new(destination)],
                    ),
                ],
                false,
            );
            assert!(result.incomplete);
            assert_eq!(
                result.changes,
                vec![actual(&root, destination, FileChangeType::CREATED)]
            );
        }
    }

    #[test]
    fn ignores_apply_to_deleted_paths_with_nested_negation_and_hidden_configs() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::create_dir_all(root.join(".git/info")).unwrap();
        fs::write(root.join(".gitignore"), "*.java\nblocked/\n").unwrap();
        fs::write(root.join("nested/.gitignore"), "!Keep.java\n").unwrap();
        fs::write(root.join(".ignore"), "*.secret\n").unwrap();
        fs::write(root.join("nested/.ignore"), "!visible.secret\n").unwrap();
        fs::write(root.join(".git/info/exclude"), "*.local\n").unwrap();
        let names = [
            "Gone.java",
            "nested/Gone.java",
            "nested/Keep.java",
            "nested/visible.secret",
            "private.secret",
            "config.local",
            "blocked/deep/Keep.java",
            ".project",
            // `build` is a default watch exclusion, so only the other folder survives.
            "build/Source.txt",
            "generated/Source.txt",
        ];
        let batch: Vec<_> = names
            .iter()
            .map(|name| event(EventKind::Remove(RemoveKind::File), &[Path::new(name)]))
            .collect();
        let result = watched_batch(&root, &batch, false);
        assert!(!result.incomplete);
        assert_eq!(
            result.changes,
            [
                "nested/Keep.java",
                "nested/visible.secret",
                ".project",
                "generated/Source.txt"
            ]
            .iter()
            .map(|name| actual(&root, name, FileChangeType::DELETED))
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn metadata_dependencies_and_traversal_are_excluded_but_regular_names_survive() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        let outside = root.parent().unwrap().join("outside.java");
        let batch = [
            event(
                EventKind::Remove(RemoveKind::File),
                &[
                    Path::new("node_modules/pkg/secret.java"),
                    Path::new(".git/config"),
                    Path::new(".hg/store"),
                    Path::new(".span/state.json"),
                    Path::new(".DS_Store"),
                    Path::new("a/../safe.java"),
                    &outside,
                ],
            ),
            event(
                EventKind::Remove(RemoveKind::File),
                &[Path::new("node_modules")],
            ),
        ];
        let result = watched_batch(&root, &batch, false);
        assert_eq!(
            result.changes,
            vec![actual(&root, "node_modules", FileChangeType::DELETED)]
        );
    }

    #[test]
    fn unclassified_git_metadata_renames_are_complete_and_empty() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::write(root.join(".git/index"), "index").unwrap();
        let result = watched_batch(
            &root,
            &[
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                    &[&root.join(".git/index.lock")],
                ),
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                    &[&root.join(".git/index")],
                ),
            ],
            false,
        );
        assert!(result.changes.is_empty());
        assert!(!result.incomplete);
    }

    #[test]
    fn unsupported_events_require_every_endpoint_to_be_proven_excluded() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join(".ignore"), "*.ignored\n").unwrap();
        let outside = root.parent().unwrap().join("outside.java");
        for kind in [
            EventKind::Any,
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Other)),
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        ] {
            let excluded = watched_batch(
                &root,
                &[
                    event(kind, &[Path::new(".git/index")]),
                    event(kind, &[Path::new("deleted.ignored")]),
                    event(kind, &[&outside]),
                ],
                false,
            );
            assert!(excluded.changes.is_empty());
            assert!(!excluded.incomplete, "{kind:?}");
        }
        for paths in [
            vec![],
            vec![Path::new("visible.java")],
            vec![Path::new("node_modules")],
            vec![Path::new(".git/index"), Path::new("visible.java")],
            vec![Path::new("visible.java"), Path::new(".git/index")],
        ] {
            let result = watched_batch(&root, &[event(EventKind::Any, &paths)], false);
            assert!(result.changes.is_empty());
            assert!(result.incomplete, "{paths:?}");
        }
        fs::write(root.join(".ignore"), "x".repeat(MAX_IGNORE_BYTES + 1)).unwrap();
        let uncertain = watched_batch(
            &root,
            &[event(EventKind::Any, &[Path::new("unknown.java")])],
            false,
        );
        assert!(uncertain.changes.is_empty());
        assert!(uncertain.incomplete);
    }

    #[test]
    fn excluded_unsupported_events_preserve_global_loss_and_path_limits() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        let excluded = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any)))
            .add_path(root.join(".git/index"));
        for (batch, overflow) in [
            (vec![Ok(excluded.clone())], true),
            (vec![Ok(excluded.clone().set_flag(Flag::Rescan))], false),
            (
                vec![
                    Ok(excluded.clone()),
                    Err(notify::Error::generic("watch failed")),
                ],
                false,
            ),
        ] {
            let result = watched_batch(&root, &batch, overflow);
            assert!(result.changes.is_empty());
            assert!(result.incomplete);
        }
        let oversized = (0..MAX_INPUT).fold(excluded, |event, _| {
            event.add_path(root.join(".git/index.lock"))
        });
        let result = watched_batch(&root, &[Ok(oversized)], false);
        assert!(result.changes.is_empty());
        assert!(result.incomplete);
    }

    #[test]
    fn access_is_ignored_and_uncertainty_does_not_fabricate_events() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        let access = event(
            EventKind::Access(AccessKind::Read),
            &[Path::new("read.java")],
        );
        let access_result = watched_batch(&root, &[access], false);
        assert!(access_result.changes.is_empty());
        assert!(!access_result.incomplete);
        let flagged = Event::new(EventKind::Create(CreateKind::File))
            .add_path("known.java".into())
            .set_flag(Flag::Rescan);
        let result = watched_batch(
            &root,
            &[
                event(EventKind::Any, &[Path::new("unknown.java")]),
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                    &[Path::new("only-one.java")],
                ),
                Err(notify::Error::generic("watch failed")),
                Ok(flagged),
            ],
            true,
        );
        assert!(result.incomplete);
        assert_eq!(
            result.changes,
            vec![actual(&root, "known.java", FileChangeType::CREATED)]
        );
    }

    #[test]
    fn batches_and_ignore_reads_are_bounded() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        let paths: Vec<_> = (0..MAX_CHANGES + 1)
            .map(|i| root.join(format!("{i}.java")))
            .collect();
        let large_event = paths.into_iter().fold(
            Event::new(EventKind::Create(CreateKind::File)),
            |event, path| event.add_path(path),
        );
        let result = watched_batch(&root, &[Ok(large_event)], false);
        assert!(result.incomplete);
        assert_eq!(result.changes.len(), MAX_CHANGES);
        fs::write(root.join(".ignore"), "x".repeat(MAX_IGNORE_BYTES + 1)).unwrap();
        let result = watched_batch(
            &root,
            &[event(
                EventKind::Remove(RemoveKind::File),
                &[Path::new("deleted.java")],
            )],
            false,
        );
        assert!(result.incomplete);
        assert!(result.changes.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn outside_symlinks_and_symlinked_ignore_files_are_never_followed() {
        use std::os::unix::fs::symlink;
        let temp = root();
        let outside = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(outside.path().join("External.java"), "x").unwrap();
        symlink(outside.path(), root.join("escape")).unwrap();
        let result = watched_batch(
            &root,
            &[
                event(
                    EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                    &[&root.join("escape/External.java")],
                ),
                event(
                    EventKind::Remove(RemoveKind::File),
                    &[&root.join("escape/missing/deep/Deleted.java")],
                ),
            ],
            false,
        );
        assert!(result.changes.is_empty());
        fs::write(outside.path().join("ignore"), "*.java\n").unwrap();
        symlink(outside.path().join("ignore"), root.join(".gitignore")).unwrap();
        let result = watched_batch(
            &root,
            &[event(
                EventKind::Remove(RemoveKind::File),
                &[Path::new("Deleted.java")],
            )],
            false,
        );
        assert!(result.incomplete);
        assert!(result.changes.is_empty());
    }

    #[test]
    fn dependency_build_and_nested_checkout_churn_never_marks_a_batch_incomplete() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        for dir in [
            "node_modules/.pnpm/pkg",
            "target/debug",
            ".pnpm-store/v3",
            "dist",
            "_work/feature/src",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("_work/feature/.git"), "gitdir: elsewhere\n").unwrap();
        let result = watched_batch(
            &root,
            &[
                event(EventKind::Other, &[&root.join("node_modules")]),
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                    &[&root.join("node_modules/.pnpm/pkg/index.js")],
                ),
                event(
                    EventKind::Modify(ModifyKind::Any),
                    &[&root.join("target/debug/span")],
                ),
                event(
                    EventKind::Create(CreateKind::File),
                    &[&root.join(".pnpm-store/v3/blob")],
                ),
                event(
                    EventKind::Create(CreateKind::File),
                    &[&root.join("dist/index.js")],
                ),
                event(
                    EventKind::Create(CreateKind::File),
                    &[&root.join("_work/feature/src/a.ts")],
                ),
            ],
            false,
        );
        assert!(!result.incomplete);
        assert!(result.changes.is_empty());
    }

    #[test]
    fn global_rescan_is_relevant_even_when_its_endpoints_are_excluded() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join("_work/feature/src")).unwrap();
        fs::write(root.join("_work/feature/.git"), "gitdir: elsewhere\n").unwrap();
        let exclusions = exclusions();
        let mut nested = HashMap::new();
        for path in [".git/index", "node_modules", "_work/feature/src/a.ts"] {
            let benign = Event::new(EventKind::Other).add_path(root.join(path));
            assert!(!lsp_relevant(
                &root,
                &root,
                &benign,
                &exclusions,
                &mut nested
            ));
            let rescan = benign.set_flag(Flag::Rescan);
            assert!(lsp_relevant(
                &root,
                &root,
                &rescan,
                &exclusions,
                &mut nested
            ));
            let result = watched_batch(&root, &[Ok(rescan)], false);
            assert!(result.incomplete, "{path}");
            assert!(result.changes.is_empty(), "{path}");
        }
    }

    #[test]
    fn undirected_renames_and_unspecific_modifications_are_resolved_from_disk() {
        let temp = root();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("present.ts"), "x").unwrap();
        let result = watched_batch(
            &root,
            &[
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                    &[&root.join("present.ts")],
                ),
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
                    &[&root.join("moved-away.ts")],
                ),
                event(
                    EventKind::Modify(ModifyKind::Any),
                    &[&root.join("present.ts")],
                ),
            ],
            false,
        );
        assert!(!result.incomplete);
        assert_eq!(
            result.changes,
            vec![
                actual(&root, "present.ts", FileChangeType::CREATED),
                actual(&root, "moved-away.ts", FileChangeType::DELETED),
                actual(&root, "present.ts", FileChangeType::CHANGED),
            ]
        );
    }
}
