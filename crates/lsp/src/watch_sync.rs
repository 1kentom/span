//! Delivery policy for `workspace/didChangeWatchedFiles`: which directories never
//! produce notifications, how repeated events for one path coalesce, how large one
//! notification may be, and how a server that fell behind is brought back in step
//! without asking the user to restart it.
//!
//! Every type here takes the current time as an argument, so tests drive it with a
//! fake clock. Nothing in this module starts a thread or a timer.

use lsp_types::{FileChangeType, FileEvent, Uri};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// Directory names that never produce watched-file notifications. `.git` is not in
/// this list on purpose: it is excluded unconditionally and cannot be re-enabled.
pub const DEFAULT_EXCLUDED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
    ".pnpm-store",
    ".span",
];

/// Version control metadata, never watched for language servers.
const ALWAYS_EXCLUDED_DIRS: &[&str] = &[".git", ".hg", ".svn"];

/// Largest `changes` array sent in one notification. More changes become more notifications.
pub const MAX_NOTIFY_BATCH: usize = 500;
/// Window in which repeated events for the same path fold into one change.
pub const DEBOUNCE: Duration = Duration::from_millis(100);
/// Distinct paths held between deliveries. More than this marks the servers for resync.
pub const MAX_PENDING_PATHS: usize = 8192;
/// Two overflows this close together count as a server that keeps falling behind.
pub const OVERFLOW_WINDOW: Duration = Duration::from_secs(60);
/// Automatic restarts allowed per [`RESTART_WINDOW`].
pub const MAX_AUTO_RESTARTS: usize = 3;
pub const RESTART_WINDOW: Duration = Duration::from_secs(600);
/// First automatic restart delay, doubled for each restart still inside the window.
pub const RESTART_BACKOFF: Duration = Duration::from_secs(1);

/// The directory exclusions in force: the defaults minus what user settings re-enable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exclusions {
    names: HashSet<String>,
}

impl Default for Exclusions {
    fn default() -> Self {
        Self::new(&[])
    }
}

impl Exclusions {
    /// `include` names default exclusions to watch anyway. Version control metadata
    /// stays excluded whatever it says.
    pub fn new(include: &[String]) -> Self {
        let names = DEFAULT_EXCLUDED_DIRS
            .iter()
            .filter(|name| !include.iter().any(|item| item == *name))
            .chain(ALWAYS_EXCLUDED_DIRS)
            .map(|name| (*name).to_owned())
            .collect();
        Self { names }
    }

    pub fn excludes_dir(&self, name: &OsStr) -> bool {
        name.to_str().is_some_and(|name| self.names.contains(name))
    }

    /// Whether `relative` (a path below a watched root) lies inside an excluded
    /// directory, or is one. Purely lexical: deleted paths are judged the same way.
    pub fn excludes(&self, relative: &Path) -> bool {
        relative
            .components()
            .any(|component| self.excludes_dir(component.as_os_str()))
    }
}

/// A folder whose `.git` is a file is a linked worktree or a submodule: a separate
/// checkout that happens to sit inside this one, not part of this workspace's tree.
pub fn is_nested_checkout(dir: &Path) -> bool {
    fs::symlink_metadata(dir.join(".git")).is_ok_and(|meta| meta.is_file())
}

/// Whether `path` lies in a nested checkout strictly below `root`. Checks each existing
/// ancestor once; `cache` keeps the answers for one batch.
pub fn in_nested_checkout(root: &Path, path: &Path, cache: &mut HashMap<PathBuf, bool>) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut dir = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    for component in components.iter().take(components.len().saturating_sub(1)) {
        dir.push(component);
        let nested = *cache
            .entry(dir.clone())
            .or_insert_with(|| is_nested_checkout(&dir));
        if nested {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

/// Folds events for the same path between deliveries. Created then deleted cancels
/// out, deleted then created is a change, and repeats collapse. Bounded: once
/// [`MAX_PENDING_PATHS`] distinct paths wait, new paths are not stored and
/// [`Coalescer::overflowed`] tells the caller to resync instead of losing them quietly.
pub struct Coalescer {
    capacity: usize,
    order: Vec<PathBuf>,
    pending: HashMap<PathBuf, (Uri, FileChangeType)>,
    overflowed: bool,
    first: Option<Instant>,
}

impl Default for Coalescer {
    fn default() -> Self {
        Self::with_capacity(MAX_PENDING_PATHS)
    }
}

impl Coalescer {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            order: Vec::new(),
            pending: HashMap::new(),
            overflowed: false,
            first: None,
        }
    }

    pub fn push(&mut self, event: FileEvent, now: Instant) {
        let Some(path) = uri_path(&event.uri) else {
            return;
        };
        self.first.get_or_insert(now);
        match self.pending.get(&path).map(|(_, typ)| *typ) {
            None => {
                if self.pending.len() >= self.capacity {
                    self.overflowed = true;
                    return;
                }
                self.order.push(path.clone());
                self.pending.insert(path, (event.uri, event.typ));
            }
            Some(previous) => match merge(previous, event.typ) {
                Some(typ) => {
                    self.pending.insert(path, (event.uri, typ));
                }
                None => {
                    self.pending.remove(&path);
                }
            },
        }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn overflowed(&self) -> bool {
        self.overflowed
    }

    /// When the window that began with the first held event closes.
    pub fn due(&self) -> Option<Instant> {
        self.first.map(|first| first + DEBOUNCE)
    }

    /// Everything held, in arrival order, split into notifications of at most `max`
    /// changes. Also reports whether paths were refused since the last drain.
    pub fn drain(&mut self, max: usize) -> (Vec<Vec<FileEvent>>, bool) {
        let mut changes = Vec::with_capacity(self.pending.len());
        for path in self.order.drain(..) {
            if let Some((uri, typ)) = self.pending.remove(&path) {
                changes.push(FileEvent::new(uri, typ));
            }
        }
        self.pending.clear();
        self.first = None;
        let overflowed = std::mem::take(&mut self.overflowed);
        (batches(changes, max), overflowed)
    }
}

/// The net effect of `next` arriving after `previous` for one path, or `None` when
/// they cancel out.
pub fn merge(previous: FileChangeType, next: FileChangeType) -> Option<FileChangeType> {
    use FileChangeType as T;
    Some(match (previous, next) {
        (T::CREATED, T::DELETED) => return None,
        (T::CREATED, _) => T::CREATED,
        (T::DELETED, T::DELETED) => T::DELETED,
        (T::DELETED, _) => T::CHANGED,
        (_, T::DELETED) => T::DELETED,
        _ => T::CHANGED,
    })
}

/// Splits `changes` into chunks of at most `max` (at least one) items.
pub fn batches(changes: Vec<FileEvent>, max: usize) -> Vec<Vec<FileEvent>> {
    let max = max.max(1);
    let mut out = Vec::with_capacity(changes.len().div_ceil(max));
    let mut iter = changes.into_iter().peekable();
    while iter.peek().is_some() {
        out.push(iter.by_ref().take(max).collect());
    }
    out
}

fn uri_path(uri: &Uri) -> Option<PathBuf> {
    url::Url::parse(uri.as_str()).ok()?.to_file_path().ok()
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/// What to do for a server that missed filesystem notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Send the files that matter again, found by a bounded scan.
    Resync,
    /// It keeps falling behind: restart it after `delay`. `attempt` counts from 1.
    Restart { delay: Duration, attempt: usize },
    /// Automatic restarts are used up for now. Resync anyway and tell the user once.
    Exhausted,
}

/// Per server history of overflows and automatic restarts.
#[derive(Debug, Default, Clone)]
pub struct RecoveryPolicy {
    overflows: VecDeque<Instant>,
    restarts: VecDeque<Instant>,
    warned: bool,
}

impl RecoveryPolicy {
    pub fn on_overflow(&mut self, now: Instant) -> Recovery {
        prune(&mut self.overflows, now, OVERFLOW_WINDOW);
        prune(&mut self.restarts, now, RESTART_WINDOW);
        if self.restarts.len() < MAX_AUTO_RESTARTS {
            self.warned = false;
        }
        self.overflows.push_back(now);
        if self.overflows.len() < 2 {
            return Recovery::Resync;
        }
        if self.restarts.len() >= MAX_AUTO_RESTARTS {
            if self.warned {
                return Recovery::Resync;
            }
            self.warned = true;
            return Recovery::Exhausted;
        }
        let attempt = self.restarts.len() + 1;
        let delay = RESTART_BACKOFF * (1u32 << self.restarts.len().min(16));
        self.restarts.push_back(now);
        self.overflows.clear();
        Recovery::Restart { delay, attempt }
    }

    /// The user restarted the server: start counting afresh.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn restarts_in_window(&self, now: Instant) -> usize {
        self.restarts
            .iter()
            .filter(|at| now.saturating_duration_since(**at) < RESTART_WINDOW)
            .count()
    }
}

fn prune(times: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while times
        .front()
        .is_some_and(|at| now.saturating_duration_since(*at) >= window)
    {
        times.pop_front();
    }
}

// ---------------------------------------------------------------------------
// Resync scan
// ---------------------------------------------------------------------------

/// Bounds for one resync scan.
#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    /// Directory entries examined before the scan stops.
    pub max_entries: usize,
    /// Changes reported before the scan stops.
    pub max_changes: usize,
    pub max_depth: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_entries: 50_000,
            max_changes: 5_000,
            max_depth: 32,
        }
    }
}

#[derive(Debug, Default)]
pub struct ScanResult {
    pub changes: Vec<FileEvent>,
    /// A limit stopped the scan before it covered the whole tree.
    pub truncated: bool,
}

/// Project configuration that a resync always re-announces, because a missed change
/// to one of these changes how the server sees every other file.
pub fn is_project_config(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    name == "package.json"
        || ((name.starts_with("tsconfig") || name.starts_with("jsconfig"))
            && name.ends_with(".json"))
}

/// Walks `root` without following symlinks, skipping excluded directories, nested
/// checkouts and anything `wanted` rejects. Reports project configuration files and
/// files modified at or after `since` as changed. Without `since` only project
/// configuration is reported, so a first resync never floods a server.
pub fn resync_scan(
    root: &Path,
    since: Option<SystemTime>,
    exclusions: &Exclusions,
    wanted: &dyn Fn(&Path) -> bool,
    limits: ScanLimits,
) -> ScanResult {
    let mut result = ScanResult::default();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut examined = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            examined += 1;
            if examined > limits.max_entries {
                result.truncated = true;
                return result;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name();
            let path = entry.path();
            if file_type.is_dir() {
                if depth + 1 < limits.max_depth
                    && !exclusions.excludes_dir(&name)
                    && !is_nested_checkout(&path)
                {
                    stack.push((path, depth + 1));
                } else if depth + 1 >= limits.max_depth {
                    result.truncated = true;
                }
                continue;
            }
            if !file_type.is_file() || !wanted(&path) {
                continue;
            }
            let recent = since.is_some_and(|since| {
                entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .is_ok_and(|modified| modified >= since)
            });
            if !recent && !is_project_config(&name) {
                continue;
            }
            let Ok(uri) = crate::path_to_uri(&path) else {
                continue;
            };
            if result.changes.len() >= limits.max_changes {
                result.truncated = true;
                return result;
            }
            result
                .changes
                .push(FileEvent::new(uri, FileChangeType::CHANGED));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn ev(path: &Path, typ: FileChangeType) -> FileEvent {
        FileEvent::new(crate::path_to_uri(path).unwrap(), typ)
    }

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(dir.path()).unwrap();
        (dir, path)
    }

    #[test]
    fn exclusions_cover_build_output_and_dependencies_but_not_sources() {
        let ex = Exclusions::default();
        for path in [
            "node_modules/react/index.js",
            "packages/app/node_modules/x/y.ts",
            "target/debug/build.rs",
            "dist/index.js",
            "build/out.js",
            "out/main.js",
            ".next/cache/x",
            ".turbo/log",
            ".cache/x",
            ".pnpm-store/v3/files/00/abc",
            ".span/state.json",
            ".git/index",
            "sub/.git/HEAD",
        ] {
            assert!(ex.excludes(Path::new(path)), "{path}");
        }
        for path in ["src/index.ts", "tsconfig.json", "packages/app/src/dist.ts"] {
            assert!(!ex.excludes(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn user_settings_re_enable_defaults_but_never_version_control() {
        let ex = Exclusions::new(&["build".into(), ".git".into()]);
        assert!(!ex.excludes(Path::new("build/gen.ts")));
        assert!(ex.excludes(Path::new("dist/gen.ts")));
        assert!(ex.excludes(Path::new(".git/config")));
    }

    #[test]
    fn nested_checkouts_are_detected_by_a_git_file() {
        let (_dir, root) = root();
        fs::create_dir_all(root.join("_work/feature/src")).unwrap();
        fs::write(root.join("_work/feature/.git"), "gitdir: elsewhere\n").unwrap();
        fs::create_dir_all(root.join("vendor/lib/.git")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        let mut cache = HashMap::new();
        assert!(in_nested_checkout(
            &root,
            &root.join("_work/feature/src/a.ts"),
            &mut cache
        ));
        assert!(in_nested_checkout(
            &root,
            &root.join("_work/feature/gone/deleted.ts"),
            &mut cache
        ));
        // A directory .git is a plain nested repository, not a linked checkout.
        assert!(!in_nested_checkout(
            &root,
            &root.join("vendor/lib/a.ts"),
            &mut cache
        ));
        assert!(!in_nested_checkout(
            &root,
            &root.join("src/a.ts"),
            &mut cache
        ));
        // The root's own .git file (the workspace itself is a worktree) does not count.
        fs::write(root.join(".git"), "gitdir: elsewhere\n").unwrap();
        assert!(!in_nested_checkout(
            &root,
            &root.join("src/a.ts"),
            &mut HashMap::new()
        ));
    }

    #[test]
    fn merge_rules_fold_lifecycles() {
        use FileChangeType as T;
        assert_eq!(merge(T::CREATED, T::DELETED), None);
        assert_eq!(merge(T::CREATED, T::CHANGED), Some(T::CREATED));
        assert_eq!(merge(T::DELETED, T::CREATED), Some(T::CHANGED));
        assert_eq!(merge(T::CHANGED, T::DELETED), Some(T::DELETED));
        assert_eq!(merge(T::CHANGED, T::CHANGED), Some(T::CHANGED));
        assert_eq!(merge(T::DELETED, T::DELETED), Some(T::DELETED));
    }

    #[test]
    fn coalescer_dedupes_within_the_window_and_keeps_arrival_order() {
        let (_dir, root) = root();
        let t0 = Instant::now();
        let mut c = Coalescer::default();
        let a = root.join("a.ts");
        let b = root.join("b.ts");
        let tmp = root.join("tmp.ts");
        for i in 0..50 {
            c.push(
                ev(&a, FileChangeType::CHANGED),
                t0 + Duration::from_millis(i),
            );
        }
        c.push(ev(&b, FileChangeType::CREATED), t0);
        c.push(ev(&b, FileChangeType::CHANGED), t0);
        c.push(ev(&tmp, FileChangeType::CREATED), t0);
        c.push(ev(&tmp, FileChangeType::DELETED), t0);
        assert_eq!(c.len(), 2);
        assert_eq!(c.due(), Some(t0 + DEBOUNCE));
        let (batches, overflowed) = c.drain(MAX_NOTIFY_BATCH);
        assert!(!overflowed);
        assert_eq!(batches.len(), 1);
        assert_eq!(
            batches[0],
            vec![
                ev(&a, FileChangeType::CHANGED),
                ev(&b, FileChangeType::CREATED)
            ]
        );
        assert!(c.is_empty());
        assert_eq!(c.due(), None);
    }

    #[test]
    fn coalescer_is_bounded_and_reports_refused_paths() {
        let (_dir, root) = root();
        let now = Instant::now();
        let mut c = Coalescer::with_capacity(3);
        for i in 0..10 {
            c.push(
                ev(&root.join(format!("{i}.ts")), FileChangeType::CHANGED),
                now,
            );
        }
        assert_eq!(c.len(), 3);
        assert!(c.overflowed());
        // Known paths still merge after the bound is reached.
        c.push(ev(&root.join("0.ts"), FileChangeType::DELETED), now);
        let (batches, overflowed) = c.drain(2);
        assert!(overflowed);
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0][0].typ, FileChangeType::DELETED);
        assert!(!c.overflowed(), "drain resets the flag");
    }

    #[test]
    fn batches_cap_each_notification() {
        let (_dir, root) = root();
        let changes: Vec<_> = (0..1201)
            .map(|i| ev(&root.join(format!("{i}.ts")), FileChangeType::CHANGED))
            .collect();
        let out = batches(changes, MAX_NOTIFY_BATCH);
        assert_eq!(
            out.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![500, 500, 201]
        );
        assert!(batches(Vec::new(), MAX_NOTIFY_BATCH).is_empty());
    }

    #[test]
    fn a_single_overflow_resyncs_and_repeats_restart_with_backoff_then_give_up() {
        let t0 = Instant::now();
        let mut p = RecoveryPolicy::default();
        assert_eq!(p.on_overflow(t0), Recovery::Resync);
        // An overflow outside the window is again only a resync.
        let t1 = t0 + OVERFLOW_WINDOW + Duration::from_secs(1);
        assert_eq!(p.on_overflow(t1), Recovery::Resync);
        let mut now = t1;
        let mut delays = Vec::new();
        for attempt in 1..=MAX_AUTO_RESTARTS {
            now += Duration::from_secs(5);
            match p.on_overflow(now) {
                Recovery::Restart { delay, attempt: a } => {
                    assert_eq!(a, attempt);
                    delays.push(delay);
                }
                other => panic!("expected restart, got {other:?}"),
            }
            now += Duration::from_secs(5);
            assert_eq!(p.on_overflow(now), Recovery::Resync, "first after restart");
        }
        assert_eq!(
            delays,
            vec![
                Duration::from_secs(1),
                Duration::from_secs(2),
                Duration::from_secs(4)
            ]
        );
        now += Duration::from_secs(5);
        assert_eq!(p.on_overflow(now), Recovery::Exhausted);
        now += Duration::from_secs(5);
        assert_eq!(p.on_overflow(now), Recovery::Resync, "warn only once");
        assert_eq!(p.restarts_in_window(now), MAX_AUTO_RESTARTS);
        // Ten minutes later the restart budget is back.
        now += RESTART_WINDOW;
        assert_eq!(p.restarts_in_window(now), 0);
        assert_eq!(p.on_overflow(now), Recovery::Resync);
        now += Duration::from_secs(1);
        assert!(matches!(
            p.on_overflow(now),
            Recovery::Restart { attempt: 1, .. }
        ));
        p.reset();
        assert_eq!(p.on_overflow(now), Recovery::Resync);
    }

    #[test]
    fn resync_scan_reports_config_and_recent_files_inside_registered_globs() {
        let (_dir, root) = root();
        for dir in ["src", "node_modules/pkg", "dist", "_work/wt/src"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("_work/wt/.git"), "gitdir: x\n").unwrap();
        for file in [
            "package.json",
            "tsconfig.json",
            "tsconfig.build.json",
            "src/old.ts",
            "src/notes.md",
            "node_modules/pkg/index.ts",
            "node_modules/pkg/package.json",
            "dist/index.ts",
            "_work/wt/src/a.ts",
            "_work/wt/package.json",
        ] {
            fs::write(root.join(file), "x").unwrap();
        }
        let wanted = |path: &Path| path.extension().is_some_and(|e| e == "ts" || e == "json");
        // A file URI drops the Windows verbatim prefix (`\\?\`) that canonicalize adds,
        // so compare against the root after the same round trip.
        let base = uri_path(&crate::path_to_uri(&root).unwrap()).unwrap();
        let names = |scan: &ScanResult| {
            let mut names: Vec<_> = scan
                .changes
                .iter()
                .map(|c| {
                    assert_eq!(c.typ, FileChangeType::CHANGED);
                    let path = uri_path(&c.uri).unwrap();
                    path.strip_prefix(&base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect();
            names.sort();
            names
        };
        let ex = Exclusions::default();
        let first = resync_scan(&root, None, &ex, &wanted, ScanLimits::default());
        assert_eq!(
            names(&first),
            vec!["package.json", "tsconfig.build.json", "tsconfig.json"]
        );
        let since = SystemTime::now() - Duration::from_secs(3600);
        let recent = resync_scan(&root, Some(since), &ex, &wanted, ScanLimits::default());
        assert_eq!(
            names(&recent),
            vec![
                "package.json",
                "src/old.ts",
                "tsconfig.build.json",
                "tsconfig.json"
            ]
        );
        assert!(!recent.truncated);
        let future = SystemTime::now() + Duration::from_secs(3600);
        let none_recent = resync_scan(&root, Some(future), &ex, &wanted, ScanLimits::default());
        assert_eq!(names(&none_recent).len(), 3);
        let capped = resync_scan(
            &root,
            Some(since),
            &ex,
            &wanted,
            ScanLimits {
                max_changes: 2,
                ..ScanLimits::default()
            },
        );
        assert_eq!(capped.changes.len(), 2);
        assert!(capped.truncated);
    }
}
