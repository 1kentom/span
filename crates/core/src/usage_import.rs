//! Importers for agents' own local usage logs (ADR 0012, source B), on by
//! default: Claude Code's `projects/**/*.jsonl` (subagent transcripts
//! included), Codex's `sessions/**/rollout-*.jsonl` (and `.jsonl.gz` and
//! `.jsonl.zst`), Gemini CLI's `tmp/*/chats/*.json[l]`, OpenCode's legacy
//! `storage/message/**/*.json` and OpenCode 1.2+'s `opencode.db` (see
//! [`crate::usage_import_opencode`]).
//!
//! Read only. Only token counts, model ids, session ids, timestamps and a
//! reported cost leave a log line; prompt text, replies and tool output are
//! parsed past and never kept. The scan is incremental: each file resumes at
//! the byte after its last complete line while its first bytes are unchanged,
//! and a rewritten file is read again from the start with its earlier counts
//! replaced. The cache keeps a hash of each path, never the path. Symlinks are
//! never followed, and depth, file count, file size and line length are capped.
use crate::session_meta::{SessionMeta, SessionUsage, UsageBucket};
use crate::usage::{day_from_number, TokenCounts};
use crate::{io_error, workspace::atomic_write, CoreError, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Agent ids of imported sessions. They never collide with a catalog id.
pub const IMPORTED_CLAUDE_ID: &str = "claude-code-logs";
pub const IMPORTED_CODEX_ID: &str = "codex-logs";
pub const IMPORTED_GEMINI_ID: &str = "gemini-logs";
pub const IMPORTED_OPENCODE_ID: &str = "opencode-logs";
/// 3: compressed and database file states (zstd rollouts, `opencode.db`).
const CACHE_VERSION: u32 = 3;
const HEAD_BYTES: usize = 4096;

pub fn is_imported_agent(agent_id: &str) -> bool {
    matches!(
        agent_id,
        IMPORTED_CLAUDE_ID | IMPORTED_CODEX_ID | IMPORTED_GEMINI_ID | IMPORTED_OPENCODE_ID
    )
}

/// Which agent's logs a root holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportKind {
    Claude,
    Codex,
    Gemini,
    OpenCode,
}

impl ImportKind {
    fn agent_id(self) -> &'static str {
        match self {
            ImportKind::Claude => IMPORTED_CLAUDE_ID,
            ImportKind::Codex => IMPORTED_CODEX_ID,
            ImportKind::Gemini => IMPORTED_GEMINI_ID,
            ImportKind::OpenCode => IMPORTED_OPENCODE_ID,
        }
    }
    fn agent_name(self) -> &'static str {
        match self {
            ImportKind::Claude => "Claude Code (local logs)",
            ImportKind::Codex => "Codex (local logs)",
            ImportKind::Gemini => "Gemini CLI (local logs)",
            ImportKind::OpenCode => "OpenCode (local logs)",
        }
    }
    /// Whether a file belongs to this kind. Gemini chats must sit in a
    /// `chats` folder (its `tmp` folder also holds checkpoints and logs).
    fn wants(self, path: &Path) -> bool {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default();
        match self {
            ImportKind::Claude => name.ends_with(".jsonl"),
            ImportKind::Codex => {
                name.starts_with("rollout-")
                    && (name.ends_with(".jsonl")
                        || name.ends_with(".jsonl.gz")
                        || name.ends_with(".jsonl.zst"))
            }
            ImportKind::Gemini => {
                (name.ends_with(".jsonl") || name.ends_with(".json"))
                    && path
                        .components()
                        .any(|c| c.as_os_str().to_string_lossy() == "chats")
            }
            ImportKind::OpenCode => name.ends_with(".json"),
        }
    }
    /// Files read whole on every change instead of resumed at an offset:
    /// compressed rollouts, OpenCode's one-message files, and Gemini chats
    /// (whose messages are rewritten in place as tokens arrive).
    fn whole_file(self, path: &Path) -> bool {
        match self {
            ImportKind::Claude => false,
            ImportKind::Codex => is_compressed(path),
            ImportKind::Gemini | ImportKind::OpenCode => true,
        }
    }
}

/// A gzip or zstd compressed rollout.
fn is_compressed(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "gz" || e == "zst")
}

/// Bounds on one scan.
#[derive(Debug, Clone, Copy)]
pub struct ImportLimits {
    pub max_depth: usize,
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_line_bytes: usize,
    /// Decoded bytes kept from one compressed rollout; a larger one is
    /// skipped and reported.
    pub max_decompressed_bytes: u64,
    /// Rows read from one database query page, and from one database in all.
    pub db_page_rows: usize,
    pub max_db_rows: usize,
}

impl Default for ImportLimits {
    fn default() -> Self {
        ImportLimits {
            max_depth: 6,
            max_files: 20_000,
            max_file_bytes: 512 * 1024 * 1024,
            max_line_bytes: 16 * 1024 * 1024,
            max_decompressed_bytes: 256 * 1024 * 1024,
            db_page_rows: 2_000,
            max_db_rows: 2_000_000,
        }
    }
}

/// The log folders to read, from the environment the way each agent finds
/// its own: `CLAUDE_CONFIG_DIR` (comma separated) else `~/.config/claude` and
/// `~/.claude`, each with `projects/`; `CODEX_HOME` else `~/.codex`, with
/// `sessions/` and `archived_sessions/`.
pub fn default_roots(
    home: Option<&Path>,
    claude_config_dir: Option<&str>,
    codex_home: Option<&str>,
) -> Vec<(ImportKind, PathBuf)> {
    let mut roots = vec![];
    let claude: Vec<PathBuf> = match claude_config_dir.map(str::trim).filter(|v| !v.is_empty()) {
        Some(list) => list
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .collect(),
        None => home
            .map(|h| vec![h.join(".config/claude"), h.join(".claude")])
            .unwrap_or_default(),
    };
    for dir in claude {
        roots.push((ImportKind::Claude, dir.join("projects")));
    }
    let codex = codex_home
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|h| h.join(".codex")));
    if let Some(dir) = codex {
        roots.push((ImportKind::Codex, dir.join("sessions")));
        roots.push((ImportKind::Codex, dir.join("archived_sessions")));
    }
    roots
}

/// Gemini CLI's and OpenCode's folders: `~/.gemini/tmp` (chats live in
/// `<project>/chats/`), and OpenCode's data folder (`OPENCODE_DATA_DIR`,
/// comma separated, else `$XDG_DATA_HOME/opencode`, else
/// `~/.local/share/opencode`) with `storage/message/`.
pub fn more_roots(
    home: Option<&Path>,
    opencode_data_dir: Option<&str>,
    xdg_data_home: Option<&str>,
) -> Vec<(ImportKind, PathBuf)> {
    let mut roots = vec![];
    if let Some(home) = home {
        roots.push((ImportKind::Gemini, home.join(".gemini/tmp")));
    }
    let opencode: Vec<PathBuf> = match opencode_data_dir.map(str::trim).filter(|v| !v.is_empty()) {
        Some(list) => list
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .collect(),
        None => xdg_data_home
            .map(str::trim)
            .filter(|v| !v.is_empty() && Path::new(v).is_absolute())
            .map(|v| PathBuf::from(v).join("opencode"))
            .or_else(|| home.map(|h| h.join(".local/share/opencode")))
            .into_iter()
            .collect(),
    };
    for dir in opencode {
        roots.push((ImportKind::OpenCode, dir.join("storage/message")));
    }
    roots
}

/// One hour, model and session of one log file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportBucket {
    /// Hours since 1970-01-01 UTC.
    pub hour: u32,
    pub model: String,
    pub session: String,
    pub turns: u32,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub thought: u64,
    pub total: u64,
    /// Cost the log itself recorded (Claude's `costUSD`), in millionths of USD.
    pub cost_micros: u64,
}

/// What the cache knows about one file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FileState {
    pub kind: Option<ImportKind>,
    pub len: u64,
    /// Bytes read so far: always just after a complete line.
    pub offset: u64,
    /// Hash of the first bytes, to notice a rewritten file.
    pub head: u64,
    /// Codex: the session id, the current model and the last cumulative usage.
    pub session: String,
    pub model: String,
    pub last_total: TokenCounts,
    pub buckets: Vec<ImportBucket>,
    /// Claude: dedupe keys (message id and request id) this file contributed.
    pub keys: Vec<u64>,
    /// A gzip or zstd rollout: a plain copy of the same session wins.
    pub compressed: bool,
    /// An OpenCode database: its sessions replace the same sessions read from
    /// OpenCode's older JSON message files.
    pub database: bool,
    /// Database: the largest `time_updated` read, the incremental watermark.
    pub watermark: i64,
}

/// The importer's cache: one entry per log file, keyed by a hash of its path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportCache {
    pub version: u32,
    pub files: BTreeMap<String, FileState>,
    /// Unix milliseconds of the last finished scan.
    pub scanned_ms: u64,
}

impl ImportCache {
    /// Missing or unreadable: empty (the next scan rebuilds it).
    pub fn load(path: &Path) -> ImportCache {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ImportCache>(&bytes).ok())
            .filter(|cache| cache.version == CACHE_VERSION)
            .unwrap_or_default()
    }
    pub fn save(&mut self, path: &Path) -> Result<()> {
        self.version = CACHE_VERSION;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| io_error("Create usage import cache folder", parent, e))?;
        }
        let bytes = serde_json::to_vec(self).map_err(|e| CoreError::Settings(e.to_string()))?;
        atomic_write(path, &bytes)
    }
}

/// Progress and outcome of a scan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Log files found (within the caps).
    pub files_total: u32,
    /// Files handled so far.
    pub files_done: u32,
    /// Files that had new bytes to read.
    pub files_read: u32,
    pub bytes_read: u64,
    /// Usage entries counted in this scan.
    pub entries: u32,
    /// Entries left out as duplicates.
    pub duplicates: u32,
    /// Files skipped for a cap or a read error.
    pub skipped: u32,
    /// True when a cap stopped the file listing early.
    pub truncated: bool,
    /// Compressed files read (gzip and zstd rollouts).
    pub compressed_read: u32,
    /// Compressed files skipped because they decode past the size cap.
    pub compressed_skipped: u32,
    /// OpenCode databases read.
    pub databases_read: u32,
    /// Kinds that had at least one log file, in a fixed order.
    pub kinds: Vec<ImportKind>,
    /// Plain notes about sources found but not read.
    pub notes: Vec<String>,
}

/// 64-bit FNV-1a, stable across platforms and releases.
pub(crate) fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn path_key(path: &Path) -> String {
    format!("{:016x}", fnv(path.to_string_lossy().as_bytes()))
}

/// Log files under `root`, depth first, sorted. Symlinks (to files or
/// folders) are never followed.
fn list_files(
    kind: ImportKind,
    root: &Path,
    limits: &ImportLimits,
    out: &mut Vec<(ImportKind, PathBuf)>,
) -> bool {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut truncated = false;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries.into_iter().rev() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if depth < limits.max_depth {
                    stack.push((entry.path(), depth + 1));
                }
            } else if file_type.is_file() && kind.wants(&entry.path()) {
                if out.len() >= limits.max_files {
                    truncated = true;
                    return truncated;
                }
                out.push((kind, entry.path()));
            }
        }
    }
    truncated
}

/// Reads new bytes of every log file into `cache`. `progress` sees the report
/// after each file. Files that disappeared are dropped from the cache. A live
/// OpenCode database is copied into a folder under the system temp folder;
/// [`scan_in`] picks that folder.
pub fn scan(
    roots: &[(ImportKind, PathBuf)],
    cache: &mut ImportCache,
    limits: &ImportLimits,
    progress: &mut dyn FnMut(&ScanReport),
) -> ScanReport {
    let work = std::env::temp_dir().join("span-usage-import");
    scan_in(roots, cache, limits, &work, progress)
}

/// [`scan`], copying a live (WAL) OpenCode database into a fresh folder under
/// `work_dir`, removed again after the read.
pub fn scan_in(
    roots: &[(ImportKind, PathBuf)],
    cache: &mut ImportCache,
    limits: &ImportLimits,
    work_dir: &Path,
    progress: &mut dyn FnMut(&ScanReport),
) -> ScanReport {
    let mut files = vec![];
    let mut report = ScanReport::default();
    for (kind, root) in roots {
        // The root itself must be a real folder, not a link elsewhere.
        if fs::symlink_metadata(root).is_ok_and(|m| m.is_dir()) {
            report.truncated |= list_files(*kind, root, limits, &mut files);
        }
    }
    let mut databases: Vec<PathBuf> = vec![];
    for (_, root) in roots.iter().filter(|(k, _)| *k == ImportKind::OpenCode) {
        for db in crate::usage_import_opencode::databases(root) {
            if !databases.contains(&db) {
                databases.push(db);
            }
        }
    }
    for kind in [
        ImportKind::Claude,
        ImportKind::Codex,
        ImportKind::Gemini,
        ImportKind::OpenCode,
    ] {
        if files.iter().any(|(k, _)| *k == kind)
            || (kind == ImportKind::OpenCode && !databases.is_empty())
        {
            report.kinds.push(kind);
        }
    }
    report.files_total = (files.len() + databases.len()) as u32;
    progress(&report);
    let present: HashSet<String> = files
        .iter()
        .map(|(_, p)| path_key(p))
        .chain(databases.iter().map(|p| path_key(p)))
        .collect();
    cache.files.retain(|key, _| present.contains(key));
    for db in &databases {
        let key = path_key(db);
        let mut state = cache.files.remove(&key).unwrap_or_default();
        crate::usage_import_opencode::read_database(db, &mut state, limits, work_dir, &mut report);
        cache.files.insert(key, state);
        report.files_done += 1;
        progress(&report);
    }
    let mut seen: HashSet<u64> = cache
        .files
        .values()
        .flat_map(|f| f.keys.iter().copied())
        .collect();
    for (kind, path) in files {
        let key = path_key(&path);
        let mut state = cache.files.remove(&key).unwrap_or_default();
        match read_file(kind, &path, &mut state, &mut seen, limits, &mut report) {
            Ok(()) => {}
            Err(_) => report.skipped += 1,
        }
        cache.files.insert(key, state);
        report.files_done += 1;
        progress(&report);
    }
    report
}

fn read_file(
    kind: ImportKind,
    path: &Path,
    state: &mut FileState,
    seen: &mut HashSet<u64>,
    limits: &ImportLimits,
    report: &mut ScanReport,
) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|e| io_error("Read log file", path, e))?;
    if !metadata.is_file() {
        return Err(CoreError::Settings("Not a regular file".into()));
    }
    let len = metadata.len();
    if len > limits.max_file_bytes {
        return Err(CoreError::Settings("Log file is over the size cap".into()));
    }
    let mut file = File::open(path).map_err(|e| io_error("Read log file", path, e))?;
    let mut head = vec![0u8; HEAD_BYTES.min(len as usize)];
    file.read_exact(&mut head)
        .map_err(|e| io_error("Read log file", path, e))?;
    let head_hash = fnv(&head);
    if kind.whole_file(path) {
        return read_whole(
            kind, path, file, len, head_hash, state, seen, limits, report,
        );
    }
    // A file shorter than HEAD_BYTES that grew has a different head hash,
    // so it is read again from the start, as is any rewritten file.
    let resumable = state.kind == Some(kind) && state.head == head_hash && len >= state.offset;
    if !resumable {
        for key in &state.keys {
            seen.remove(key);
        }
        *state = FileState {
            kind: Some(kind),
            ..FileState::default()
        };
    }
    state.head = head_hash;
    if len == state.offset {
        state.len = len;
        return Ok(());
    }
    file.seek(SeekFrom::Start(state.offset))
        .map_err(|e| io_error("Read log file", path, e))?;
    let mut bytes = Vec::with_capacity((len - state.offset) as usize);
    file.take(len - state.offset)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error("Read log file", path, e))?;
    // Only complete lines: a line still being written is read next time.
    let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else {
        state.len = len;
        return Ok(());
    };
    report.files_read += 1;
    report.bytes_read += end as u64 + 1;
    let fallback_session = fallback_session(path);
    let mut entries = vec![];
    for line in bytes[..end].split(|b| *b == b'\n') {
        if line.is_empty() || line.len() > limits.max_line_bytes {
            continue;
        }
        let entry = match kind {
            ImportKind::Claude => claude_entry(line, seen, &mut state.keys, report),
            _ => codex_entry(line, state),
        };
        entries.extend(entry);
    }
    add_entries(kind, state, entries, &fallback_session, report);
    state.offset += end as u64 + 1;
    state.len = len;
    Ok(())
}

fn fallback_session(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    name.split('.').next().unwrap_or_default().to_owned()
}

/// Adds entries to the file's hour, model and session buckets.
pub(crate) fn add_entries(
    kind: ImportKind,
    state: &mut FileState,
    entries: Vec<Entry>,
    fallback_session: &str,
    report: &mut ScanReport,
) {
    let mut buckets: HashMap<(u32, String, String), ImportBucket> = state
        .buckets
        .drain(..)
        .map(|b| ((b.hour, b.model.clone(), b.session.clone()), b))
        .collect();
    for entry in entries {
        report.entries += 1;
        let session = if entry.session.is_empty() {
            if kind == ImportKind::Codex && !state.session.is_empty() {
                state.session.clone()
            } else {
                fallback_session.to_owned()
            }
        } else {
            entry.session
        };
        let bucket = buckets
            .entry((entry.hour, entry.model.clone(), session.clone()))
            .or_insert_with(|| ImportBucket {
                hour: entry.hour,
                model: entry.model,
                session,
                ..ImportBucket::default()
            });
        bucket.turns = bucket.turns.saturating_add(1);
        bucket.input = bucket.input.saturating_add(entry.tokens.input);
        bucket.output = bucket.output.saturating_add(entry.tokens.output);
        bucket.cache_read = bucket.cache_read.saturating_add(entry.tokens.cache_read);
        bucket.cache_write = bucket.cache_write.saturating_add(entry.tokens.cache_write);
        bucket.thought = bucket.thought.saturating_add(entry.tokens.thought);
        bucket.total = bucket.total.saturating_add(entry.tokens.effective_total());
        bucket.cost_micros = bucket.cost_micros.saturating_add(entry.cost_micros);
    }
    let mut buckets: Vec<ImportBucket> = buckets.into_values().collect();
    buckets.sort_by(|a, b| (a.hour, &a.model, &a.session).cmp(&(b.hour, &b.model, &b.session)));
    state.buckets = buckets;
}

/// Keeps `key` once across all files; false (and counted) for a duplicate.
fn first_seen(
    key: u64,
    seen: &mut HashSet<u64>,
    keys: &mut Vec<u64>,
    report: &mut ScanReport,
) -> bool {
    if !seen.insert(key) {
        report.duplicates += 1;
        return false;
    }
    keys.push(key);
    true
}

/// A file read from the start whenever its length or first bytes change:
/// its earlier counts and dedupe keys are replaced. Gzip and zstd are decoded
/// as a stream with the decoded size capped; a compressed file past the cap is
/// skipped and reported, and a corrupt one keeps the complete lines decoded
/// before the damage.
#[allow(clippy::too_many_arguments)]
fn read_whole(
    kind: ImportKind,
    path: &Path,
    mut file: File,
    len: u64,
    head_hash: u64,
    state: &mut FileState,
    seen: &mut HashSet<u64>,
    limits: &ImportLimits,
    report: &mut ScanReport,
) -> Result<()> {
    if state.kind == Some(kind) && state.head == head_hash && state.len == len {
        return Ok(());
    }
    for key in &state.keys {
        seen.remove(key);
    }
    let compressed = kind == ImportKind::Codex && is_compressed(path);
    *state = FileState {
        kind: Some(kind),
        head: head_hash,
        len,
        offset: len,
        compressed,
        ..FileState::default()
    };
    file.seek(SeekFrom::Start(0))
        .map_err(|e| io_error("Read log file", path, e))?;
    let mut bytes = vec![];
    if compressed {
        let cap = limits.max_decompressed_bytes;
        let outcome = if path.extension().is_some_and(|e| e == "zst") {
            read_zstd(file, cap, &mut bytes)
        } else {
            flate2::read::MultiGzDecoder::new(file)
                .take(cap + 1)
                .read_to_end(&mut bytes)
                .map(|_| ())
        };
        if bytes.len() as u64 > cap {
            report.compressed_skipped += 1;
            return Ok(());
        }
        if let Err(error) = outcome {
            // Keep the complete lines decoded before the damage, if any.
            match bytes.iter().rposition(|b| *b == b'\n') {
                Some(end) => bytes.truncate(end + 1),
                None => return Err(io_error("Decompress log file", path, error)),
            }
        }
        report.compressed_read += 1;
    } else {
        file.read_to_end(&mut bytes)
            .map_err(|e| io_error("Read log file", path, e))?;
    }
    report.files_read += 1;
    report.bytes_read += len;
    let fallback = fallback_session(path);
    let mut keys = vec![];
    let entries: Vec<Entry> = match kind {
        ImportKind::OpenCode => {
            let session = path
                .parent()
                .and_then(Path::file_name)
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            opencode_entry(&bytes, &session, &fallback)
                .filter(|(_, key)| first_seen(*key, seen, &mut keys, report))
                .map(|(entry, _)| entry)
                .into_iter()
                .collect()
        }
        ImportKind::Gemini => gemini_entries(&bytes, limits)
            .into_iter()
            .filter(|(_, key)| first_seen(*key, seen, &mut keys, report))
            .map(|(entry, _)| entry)
            .collect(),
        ImportKind::Codex | ImportKind::Claude => {
            let mut out = vec![];
            for line in bytes.split(|b| *b == b'\n') {
                if line.is_empty() || line.len() > limits.max_line_bytes {
                    continue;
                }
                let entry = match kind {
                    ImportKind::Claude => claude_entry(line, seen, &mut keys, report),
                    _ => codex_entry(line, state),
                };
                out.extend(entry);
            }
            out
        }
    };
    state.keys.extend(keys);
    add_entries(kind, state, entries, &fallback, report);
    Ok(())
}

/// Decodes every zstd frame of `file` into `out`, stopping one byte past `cap`
/// (the caller checks the length). Pure Rust, streaming.
fn read_zstd(file: File, cap: u64, out: &mut Vec<u8>) -> std::io::Result<()> {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(file);
    loop {
        if reader.fill_buf()?.is_empty() {
            return Ok(());
        }
        let decoder = ruzstd::decoding::StreamingDecoder::new(&mut reader)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        let room = (cap + 1).saturating_sub(out.len() as u64);
        decoder.take(room).read_to_end(out)?;
        if out.len() as u64 > cap {
            return Ok(());
        }
    }
}

/// Hours since the epoch of Unix milliseconds.
pub(crate) fn hour_of_ms(ms: f64) -> Option<u32> {
    (ms.is_finite() && ms > 0.0).then(|| (ms / 3_600_000.0) as u32)
}

/// Whether a model's prices count cached tokens inside input (OpenAI and
/// Google), so tokens reported apart are folded in to match the ledger.
pub(crate) fn input_includes_cache(model: &str) -> bool {
    let id = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_ascii_lowercase();
    id.starts_with("gpt")
        || id.starts_with("gemini")
        || id.starts_with("codex")
        || id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
}

/// OpenCode's token fields as ledger counts: its input excludes cache, and
/// reasoning is billed as output.
pub(crate) fn opencode_counts(
    model: &str,
    uncached: u64,
    output: u64,
    reasoning: u64,
    cache_read: u64,
    cache_write: u64,
) -> TokenCounts {
    let output = output.saturating_add(reasoning);
    let input = if input_includes_cache(model) {
        uncached.saturating_add(cache_read)
    } else {
        uncached
    };
    TokenCounts {
        input,
        output,
        cache_read,
        cache_write,
        thought: reasoning,
        total: uncached
            .saturating_add(cache_read)
            .saturating_add(cache_write)
            .saturating_add(output),
    }
}

/// One OpenCode assistant message file (`storage/message/<session>/<id>.json`):
/// `tokens.{input, output, reasoning, cache.{read, write}}`, `modelID` (or
/// `model.id`), `time.created` in ms and `cost`. Input there excludes cache.
fn opencode_entry(bytes: &[u8], session_dir: &str, file_id: &str) -> Option<(Entry, u64)> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let message = value.as_object()?;
    if message
        .get("role")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|role| role != "assistant")
    {
        return None;
    }
    let text = |v: Option<&serde_json::Value>| {
        v.and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let model_ref = message.get("model");
    let model = [
        text(model_ref.and_then(|m| m.get("id"))),
        text(model_ref.and_then(|m| m.get("modelID"))),
        text(message.get("modelID")),
    ]
    .into_iter()
    .find(|m| !m.is_empty())?;
    let tokens = message.get("tokens")?;
    let n = |v: Option<&serde_json::Value>| v.and_then(serde_json::Value::as_u64).unwrap_or(0);
    let counts = opencode_counts(
        &model,
        n(tokens.get("input")),
        n(tokens.get("output")),
        n(tokens.get("reasoning")),
        n(tokens.get("cache").and_then(|c| c.get("read"))),
        n(tokens.get("cache").and_then(|c| c.get("write"))),
    );
    if counts.is_empty() {
        return None;
    }
    let created = message
        .get("time")
        .and_then(|t| t.get("created"))
        .and_then(serde_json::Value::as_f64)?;
    let id = [text(message.get("id")), file_id.to_owned()]
        .into_iter()
        .find(|v| !v.is_empty())?;
    let session = [text(message.get("sessionID")), session_dir.to_owned()]
        .into_iter()
        .find(|v| !v.is_empty())
        .unwrap_or_default();
    let cost_micros = message
        .get("cost")
        .and_then(serde_json::Value::as_f64)
        .filter(|c| c.is_finite() && *c > 0.0)
        .map(|c| (c * 1_000_000.0).round() as u64)
        .unwrap_or(0);
    Some((
        Entry {
            hour: hour_of_ms(created)?,
            model: model.chars().take(128).collect(),
            session: session.chars().take(256).collect(),
            tokens: counts,
            cost_micros,
        },
        fnv(format!("opencode\u{0}{id}").as_bytes()),
    ))
}

/// Gemini CLI chat records: JSONL (a metadata line with `sessionId`, then
/// messages and `$set`, `$patch` and `$rewindTo` records) or the older single
/// JSON `{sessionId, messages: [...]}`. Every `type: "gemini"` message with
/// `tokens` counts once by id, last version winning. A rewind does not refund
/// tokens already spent, so rewound messages still count. Google counts
/// cached tokens inside input; thoughts are billed as output.
fn gemini_entries(bytes: &[u8], limits: &ImportLimits) -> Vec<(Entry, u64)> {
    let mut session = String::new();
    let mut order: Vec<String> = vec![];
    let mut messages: HashMap<String, serde_json::Value> = HashMap::new();
    let mut take = |value: serde_json::Value, session: &mut String| {
        if let Some(id) = value.get("sessionId").and_then(serde_json::Value::as_str) {
            if session.is_empty() {
                *session = id.chars().take(256).collect();
            }
        }
        if value.get("type").and_then(serde_json::Value::as_str) != Some("gemini") {
            return;
        }
        let Some(id) = value
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
        else {
            return;
        };
        if !messages.contains_key(&id) {
            order.push(id.clone());
        }
        messages.insert(id, value);
    };
    let trimmed = bytes
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .map(|i| &bytes[i..])
        .unwrap_or(&[]);
    let whole: Option<serde_json::Value> = serde_json::from_slice(trimmed).ok();
    match whole {
        Some(serde_json::Value::Object(record)) if record.contains_key("messages") => {
            if let Some(id) = record.get("sessionId").and_then(serde_json::Value::as_str) {
                session = id.chars().take(256).collect();
            }
            for message in record
                .get("messages")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                take(message, &mut session);
            }
        }
        _ => {
            for line in bytes.split(|b| *b == b'\n') {
                if line.is_empty() || line.len() > limits.max_line_bytes {
                    continue;
                }
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
                    take(value, &mut session);
                }
            }
        }
    }
    let mut out = vec![];
    for id in order {
        let Some(message) = messages.get(&id) else {
            continue;
        };
        let Some(tokens) = message.get("tokens").filter(|t| t.is_object()) else {
            continue;
        };
        let n = |key: &str| {
            tokens
                .get(key)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0)
        };
        let thoughts = n("thoughts");
        let input = n("input") + n("tool");
        let output = n("output") + thoughts;
        let total = n("total");
        let counts = TokenCounts {
            input,
            output,
            cache_read: n("cached"),
            cache_write: 0,
            thought: thoughts,
            total: if total > 0 { total } else { input + output },
        };
        if counts.is_empty() {
            continue;
        }
        let Some(hour) = message
            .get("timestamp")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_hour)
        else {
            continue;
        };
        let model = message
            .get("model")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .chars()
            .take(128)
            .collect();
        out.push((
            Entry {
                hour,
                model,
                session: session.clone(),
                tokens: counts,
                cost_micros: 0,
            },
            fnv(format!("gemini\u{0}{session}\u{0}{id}").as_bytes()),
        ));
    }
    out
}

pub(crate) struct Entry {
    pub(crate) hour: u32,
    pub(crate) model: String,
    pub(crate) session: String,
    pub(crate) tokens: TokenCounts,
    pub(crate) cost_micros: u64,
}

/// Hours since the Unix epoch of an RFC 3339 time such as
/// `2026-10-29T12:34:56.789Z` or `...+02:00`.
pub fn parse_hour(text: &str) -> Option<u32> {
    let b = text.as_bytes();
    if b.len() < 19 || b[10] != b'T' && b[10] != b' ' {
        return None;
    }
    let (y, m, d) = crate::usage::parse_day(&text[..10])?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    let rest = &text[19..];
    let rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset_minutes: i64 = match rest.as_bytes().first() {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let h: i64 = rest.get(1..3)?.parse().ok()?;
            let mm: i64 = rest.get(rest.len() - 2..)?.parse().ok()?;
            let total = h * 60 + mm;
            if *sign == b'+' {
                total
            } else {
                -total
            }
        }
        _ => return None,
    };
    let days = crate::usage::days_since_epoch(y, m, d);
    let minutes = days * 1440 + hour * 60 + minute - offset_minutes;
    u32::try_from(minutes.div_euclid(60)).ok()
}

#[derive(Deserialize)]
struct ClaudeLine {
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<ClaudeMessage>,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize)]
struct ClaudeUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

/// One assistant message with usage, deduplicated on message id plus request
/// id (a resumed session repeats earlier messages in a new file).
fn claude_entry(
    line: &[u8],
    seen: &mut HashSet<u64>,
    keys: &mut Vec<u64>,
    report: &mut ScanReport,
) -> Option<Entry> {
    let parsed: ClaudeLine = serde_json::from_slice(line).ok()?;
    let message = parsed.message?;
    let usage = message.usage?;
    let model = message.model.unwrap_or_default();
    if model == "<synthetic>" {
        return None;
    }
    let hour = parse_hour(parsed.timestamp.as_deref()?)?;
    if let (Some(id), Some(request)) = (message.id.as_deref(), parsed.request_id.as_deref()) {
        let key = fnv(format!("{id}\u{0}{request}").as_bytes());
        if !seen.insert(key) {
            report.duplicates += 1;
            return None;
        }
        keys.push(key);
    }
    let input = usage.input_tokens.unwrap_or(0);
    let output = usage.output_tokens.unwrap_or(0);
    let cache_write = usage.cache_creation_input_tokens.unwrap_or(0);
    let cache_read = usage.cache_read_input_tokens.unwrap_or(0);
    let tokens = TokenCounts {
        input,
        output,
        cache_read,
        cache_write,
        thought: 0,
        total: input + output + cache_read + cache_write,
    };
    if tokens.is_empty() {
        return None;
    }
    let cost_micros = parsed
        .cost_usd
        .filter(|c| c.is_finite() && *c > 0.0)
        .map(|c| (c * 1_000_000.0).round() as u64)
        .unwrap_or(0);
    Some(Entry {
        hour,
        model,
        session: parsed.session_id.unwrap_or_default(),
        tokens,
        cost_micros,
    })
}

#[derive(Deserialize)]
struct CodexLine {
    timestamp: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<serde_json::Value>,
}

fn codex_usage(value: Option<&serde_json::Value>) -> Option<TokenCounts> {
    let value = value?.as_object()?;
    let n = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    };
    let input = n("input_tokens");
    let output = n("output_tokens");
    let total = n("total_tokens");
    Some(TokenCounts {
        input,
        output,
        cache_read: n("cached_input_tokens"),
        cache_write: 0,
        thought: n("reasoning_output_tokens"),
        // Cached input is part of input for OpenAI, so the total is input
        // plus output, never plus the cache again.
        total: if total > 0 { total } else { input + output },
    })
}

fn minus(a: &TokenCounts, b: &TokenCounts) -> TokenCounts {
    TokenCounts {
        input: a.input.saturating_sub(b.input),
        output: a.output.saturating_sub(b.output),
        cache_read: a.cache_read.saturating_sub(b.cache_read),
        cache_write: a.cache_write.saturating_sub(b.cache_write),
        thought: a.thought.saturating_sub(b.thought),
        total: a.total.saturating_sub(b.total),
    }
}

/// `session_meta` sets the session, `turn_context` the model, and each new
/// `token_count` event adds its `last_token_usage` (or the growth of
/// `total_token_usage`). A repeated cumulative total adds nothing.
fn codex_entry(line: &[u8], state: &mut FileState) -> Option<Entry> {
    let parsed: CodexLine = serde_json::from_slice(line).ok()?;
    let payload = parsed.payload?;
    match parsed.kind.as_deref()? {
        "session_meta" => {
            if let Some(id) = payload.get("id").and_then(serde_json::Value::as_str) {
                state.session = id.chars().take(256).collect();
            }
            None
        }
        "turn_context" => {
            if let Some(model) = payload.get("model").and_then(serde_json::Value::as_str) {
                state.model = model.chars().take(128).collect();
            }
            None
        }
        "event_msg"
            if payload.get("type").and_then(serde_json::Value::as_str) == Some("token_count") =>
        {
            let info = payload.get("info")?;
            let total = codex_usage(info.get("total_token_usage"));
            if let Some(total) = total {
                if total == state.last_total {
                    return None;
                }
            }
            let tokens = codex_usage(info.get("last_token_usage"))
                .or_else(|| total.map(|t| minus(&t, &state.last_total)))?;
            if let Some(total) = total {
                state.last_total = total;
            }
            if tokens.is_empty() {
                return None;
            }
            Some(Entry {
                hour: parse_hour(parsed.timestamp.as_deref()?)?,
                model: state.model.clone(),
                session: state.session.clone(),
                tokens,
                cost_micros: 0,
            })
        }
        _ => None,
    }
}

/// File keys whose counts are left out because another file holds the same
/// session: a compressed Codex rollout when a plain copy of that session
/// exists (or, among compressed copies only, all but the one with most
/// turns), and OpenCode JSON message files for a session its database holds.
fn superseded(cache: &ImportCache) -> (HashSet<&str>, HashSet<&str>) {
    let mut codex: HashMap<&str, Vec<(&str, &FileState)>> = HashMap::new();
    for (key, state) in &cache.files {
        if state.kind == Some(ImportKind::Codex) && !state.session.is_empty() {
            codex
                .entry(state.session.as_str())
                .or_default()
                .push((key, state));
        }
    }
    let mut dropped = HashSet::new();
    for copies in codex.values() {
        if copies.len() < 2 || copies.iter().all(|(_, s)| !s.compressed) {
            continue;
        }
        let turns = |s: &FileState| s.buckets.iter().map(|b| u64::from(b.turns)).sum::<u64>();
        let keep = copies
            .iter()
            .max_by_key(|(key, s)| (!s.compressed, turns(s), std::cmp::Reverse(*key)))
            .map(|(key, _)| *key);
        for (key, state) in copies {
            // Every plain copy counts; compressed copies give way.
            if state.compressed && Some(*key) != keep {
                dropped.insert(*key);
            }
        }
    }
    let database_sessions: HashSet<&str> = cache
        .files
        .values()
        .filter(|s| s.database)
        .flat_map(|s| s.buckets.iter().map(|b| b.session.as_str()))
        .collect();
    (dropped, database_sessions)
}

/// The cache as sessions the usage ledger can sum, with local days from
/// `utc_offset_minutes`. Sessions in `tracked` (ids Span recorded itself)
/// are left out so a session is never counted twice, as are copies of one
/// session in two logs (see [`superseded`]).
pub fn imported_sessions(
    cache: &ImportCache,
    utc_offset_minutes: i32,
    tracked: &HashSet<String>,
) -> Vec<SessionMeta> {
    let mut sessions: HashMap<(ImportKind, String), SessionMeta> = HashMap::new();
    let (dropped, database_sessions) = superseded(cache);
    for (key, state) in &cache.files {
        let Some(kind) = state.kind else {
            continue;
        };
        if dropped.contains(key.as_str()) {
            continue;
        }
        let json_opencode = kind == ImportKind::OpenCode && !state.database;
        for bucket in &state.buckets {
            if bucket.session.is_empty() || tracked.contains(&bucket.session) {
                continue;
            }
            if json_opencode && database_sessions.contains(bucket.session.as_str()) {
                continue;
            }
            let ms = u64::from(bucket.hour) * 3_600_000;
            let meta = sessions
                .entry((kind, bucket.session.clone()))
                .or_insert_with(|| SessionMeta {
                    agent_id: kind.agent_id().into(),
                    connection_name: kind.agent_name().into(),
                    session_id: bucket.session.clone(),
                    title_override: None,
                    archived: false,
                    first_seen_ms: ms,
                    last_active_ms: ms,
                    models: vec![],
                    agents: vec![],
                    files_changed: 0,
                    lines_added: 0,
                    lines_removed: 0,
                    stop_reason_last: None,
                    parent: None,
                    continues: None,
                    changes_tracked: false,
                    usage: Some(SessionUsage::default()),
                    permission_mode: None,
                });
            meta.first_seen_ms = meta.first_seen_ms.min(ms);
            meta.last_active_ms = meta.last_active_ms.max(ms + 3_599_999);
            let minutes = i64::from(bucket.hour) * 60 + i64::from(utc_offset_minutes);
            let day = day_from_number(minutes.div_euclid(1440));
            let usage = meta.usage.as_mut().expect("set above");
            let incoming = UsageBucket {
                day,
                model: bucket.model.clone(),
                turns: bucket.turns,
                turns_with_tokens: bucket.turns,
                input: bucket.input,
                output: bucket.output,
                cache_read: bucket.cache_read,
                cache_write: bucket.cache_write,
                thought: bucket.thought,
                total: bucket.total,
                cost_micros: bucket.cost_micros,
                currency: (bucket.cost_micros > 0).then(|| "USD".to_owned()),
            };
            match usage
                .buckets
                .iter_mut()
                .find(|b| b.day == incoming.day && b.model == incoming.model)
            {
                Some(existing) => existing.add(&incoming),
                None => usage.buckets.push(incoming),
            }
        }
    }
    sessions.into_values().collect()
}

/// Length of a Claude Code usage block: five hours.
pub const BLOCK_HOURS: u32 = 5;

/// One Claude Code five-hour usage block, by ccusage's rules: a block starts
/// at the hour of the first message after the previous block ended and lasts
/// five hours. Read from Claude Code's local logs at hour resolution.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageBlock {
    /// Unix milliseconds of the block's first hour.
    pub start_ms: u64,
    /// Unix milliseconds the block ends (start plus five hours).
    pub end_ms: u64,
    /// Unix milliseconds of the start of the last hour with a message.
    pub last_ms: u64,
    /// The block has not ended yet.
    pub active: bool,
    pub turns: u32,
    pub tokens: TokenCounts,
    pub cost: crate::usage::UsageCost,
    /// Models used in the block, largest first.
    pub models: Vec<String>,
}

/// Claude Code's five-hour blocks from the import cache, oldest first, with
/// blocks that ended before `since_ms` left out. Messages repeated across
/// files were already counted once when read.
pub fn claude_blocks(
    cache: &ImportCache,
    prices: &crate::usage::PriceTable,
    now_ms: u64,
    since_ms: u64,
) -> Vec<UsageBlock> {
    // Hour, then model: summed over every Claude file.
    let mut hours: BTreeMap<u32, BTreeMap<String, ImportBucket>> = BTreeMap::new();
    for state in cache.files.values() {
        if state.kind != Some(ImportKind::Claude) {
            continue;
        }
        for b in &state.buckets {
            let slot = hours
                .entry(b.hour)
                .or_default()
                .entry(b.model.clone())
                .or_insert_with(|| ImportBucket {
                    hour: b.hour,
                    model: b.model.clone(),
                    ..ImportBucket::default()
                });
            slot.turns = slot.turns.saturating_add(b.turns);
            slot.input = slot.input.saturating_add(b.input);
            slot.output = slot.output.saturating_add(b.output);
            slot.cache_read = slot.cache_read.saturating_add(b.cache_read);
            slot.cache_write = slot.cache_write.saturating_add(b.cache_write);
            slot.thought = slot.thought.saturating_add(b.thought);
            slot.total = slot.total.saturating_add(b.total);
            slot.cost_micros = slot.cost_micros.saturating_add(b.cost_micros);
        }
    }
    const HOUR_MS: u64 = 3_600_000;
    let mut blocks: Vec<(UsageBlock, BTreeMap<String, u64>)> = vec![];
    for (hour, models) in hours {
        let open = blocks
            .last()
            .is_some_and(|(block, _)| u64::from(hour) * HOUR_MS < block.end_ms);
        if !open {
            let start_ms = u64::from(hour) * HOUR_MS;
            blocks.push((
                UsageBlock {
                    start_ms,
                    end_ms: start_ms + u64::from(BLOCK_HOURS) * HOUR_MS,
                    last_ms: start_ms,
                    active: false,
                    turns: 0,
                    tokens: TokenCounts::default(),
                    cost: crate::usage::UsageCost::empty(),
                    models: vec![],
                },
                BTreeMap::new(),
            ));
        }
        let (block, by_model) = blocks.last_mut().expect("pushed above");
        block.last_ms = u64::from(hour) * HOUR_MS;
        for bucket in models.into_values() {
            let usage = UsageBucket {
                day: String::new(),
                model: bucket.model.clone(),
                turns: bucket.turns,
                turns_with_tokens: bucket.turns,
                input: bucket.input,
                output: bucket.output,
                cache_read: bucket.cache_read,
                cache_write: bucket.cache_write,
                thought: bucket.thought,
                total: bucket.total,
                cost_micros: bucket.cost_micros,
                currency: (bucket.cost_micros > 0).then(|| "USD".to_owned()),
            };
            block.cost.add(&crate::usage::bucket_cost(&usage, prices));
            block.turns = block.turns.saturating_add(bucket.turns);
            block.tokens.add(&TokenCounts {
                input: bucket.input,
                output: bucket.output,
                cache_read: bucket.cache_read,
                cache_write: bucket.cache_write,
                thought: bucket.thought,
                total: bucket.total,
            });
            *by_model.entry(bucket.model).or_default() += bucket.total;
        }
    }
    blocks
        .into_iter()
        .filter(|(block, _)| block.end_ms > since_ms)
        .map(|(mut block, by_model)| {
            block.active = now_ms < block.end_ms;
            let mut models: Vec<(String, u64)> = by_model.into_iter().collect();
            models.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            block.models = models
                .into_iter()
                .map(|(m, _)| m)
                .filter(|m| !m.is_empty())
                .collect();
            block
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::{summarize, PriceTable, UsageRange, UsageSource};

    fn write(path: &Path, lines: &[String]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            lines.iter().map(|l| format!("{l}\n")).collect::<String>(),
        )
        .unwrap();
    }

    fn append(path: &Path, lines: &[String]) {
        let mut text = fs::read_to_string(path).unwrap();
        for line in lines {
            text.push_str(line);
            text.push('\n');
        }
        fs::write(path, text).unwrap();
    }

    fn claude(id: &str, request: &str, time: &str, input: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{time}","sessionId":"sess-a","requestId":"{request}","message":{{"id":"{id}","model":"claude-opus-5-5","role":"assistant","content":[{{"type":"text","text":"generated sample reply"}}],"usage":{{"input_tokens":{input},"output_tokens":{output},"cache_creation_input_tokens":10,"cache_read_input_tokens":100}}}}}}"#
        )
    }

    fn codex_token(time: &str, total_in: u64, total_out: u64, last: Option<(u64, u64)>) -> String {
        let last = last
            .map(|(i, o)| format!(r#","last_token_usage":{{"input_tokens":{i},"cached_input_tokens":0,"output_tokens":{o},"reasoning_output_tokens":0,"total_tokens":{}}}"#, i + o))
            .unwrap_or_default();
        format!(
            r#"{{"timestamp":"{time}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{total_in},"cached_input_tokens":0,"output_tokens":{total_out},"reasoning_output_tokens":0,"total_tokens":{}}}{last}}}}}}}"#,
            total_in + total_out
        )
    }

    fn scan_all(roots: &[(ImportKind, PathBuf)], cache: &mut ImportCache) -> ScanReport {
        scan(roots, cache, &ImportLimits::default(), &mut |_| {})
    }

    #[test]
    fn usage_import_roots_follow_each_agents_environment() {
        let home = Path::new("/home/sample");
        let roots = default_roots(Some(home), None, None);
        assert_eq!(
            roots[0],
            (ImportKind::Claude, home.join(".config/claude/projects"))
        );
        assert_eq!(
            roots[1],
            (ImportKind::Claude, home.join(".claude/projects"))
        );
        assert_eq!(roots[2], (ImportKind::Codex, home.join(".codex/sessions")));
        let custom = default_roots(Some(home), Some("/a, /b"), Some("/c"));
        assert_eq!(custom.len(), 4);
        assert_eq!(
            custom[1],
            (ImportKind::Claude, PathBuf::from("/b/projects"))
        );
        assert_eq!(
            custom[3],
            (ImportKind::Codex, PathBuf::from("/c/archived_sessions"))
        );
    }

    #[test]
    fn usage_import_parses_rfc3339_hours() {
        assert_eq!(parse_hour("1970-01-01T01:00:00Z"), Some(1));
        assert_eq!(parse_hour("1970-01-01T03:30:00.123+02:00"), Some(1));
        assert_eq!(parse_hour("1970-01-02T00:00:00-01:00"), Some(25));
        assert_eq!(parse_hour("not a time"), None);
    }

    #[test]
    fn usage_import_claude_dedupes_resumed_copies_and_resumes_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("claude/projects");
        let first = root.join("project-a/sess-a.jsonl");
        write(&first, &[
            r#"{"type":"user","timestamp":"2026-10-29T10:00:00Z","message":{"role":"user","content":"sample prompt"}}"#.into(),
            claude("msg-1", "req-1", "2026-10-29T10:00:01Z", 1000, 200),
            claude("msg-1", "req-1", "2026-10-29T10:00:01Z", 1000, 200),
        ]);
        // A resumed session copies the earlier message into a new file.
        let second = root.join("project-a/sess-b.jsonl");
        write(
            &second,
            &[claude("msg-1", "req-1", "2026-10-29T10:00:01Z", 1000, 200)],
        );
        let roots = vec![(ImportKind::Claude, root.clone())];
        let mut cache = ImportCache::default();
        let report = scan_all(&roots, &mut cache);
        assert_eq!(
            (report.files_total, report.entries, report.duplicates),
            (2, 1, 2)
        );
        append(
            &first,
            &[claude("msg-2", "req-2", "2026-10-29T11:00:00Z", 50, 5)],
        );
        let report = scan_all(&roots, &mut cache);
        assert_eq!(report.entries, 1);
        assert_eq!(report.files_read, 1, "the unchanged file is not read again");
        let sessions = imported_sessions(&cache, 0, &HashSet::new());
        assert_eq!(sessions.len(), 1);
        let bucket = &sessions[0].usage.as_ref().unwrap().buckets[0];
        assert_eq!((bucket.input, bucket.output, bucket.turns), (1050, 205, 2));
        assert_eq!(bucket.total, 1050 + 205 + 2 * 110);
        let cache_text = serde_json::to_string(&cache).unwrap();
        assert!(
            !cache_text.contains("sample prompt") && !cache_text.contains("generated sample reply")
        );
        assert!(
            !cache_text.contains("project-a"),
            "the cache keeps path hashes only"
        );
    }

    #[test]
    fn usage_import_rewritten_file_replaces_its_counts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        let file = root.join("p/s.jsonl");
        let pad = format!(
            r#"{{"type":"summary","summary":"{}"}}"#,
            "x".repeat(HEAD_BYTES)
        );
        write(
            &file,
            &[
                pad.clone(),
                claude("m1", "r1", "2026-10-29T10:00:00Z", 10, 1),
            ],
        );
        let roots = vec![(ImportKind::Claude, root)];
        let mut cache = ImportCache::default();
        scan_all(&roots, &mut cache);
        write(
            &file,
            &[
                pad.replace('x', "y"),
                claude("m1", "r1", "2026-10-29T10:00:00Z", 10, 1),
            ],
        );
        let report = scan_all(&roots, &mut cache);
        assert_eq!((report.entries, report.duplicates), (1, 0));
        let sessions = imported_sessions(&cache, 0, &HashSet::new());
        assert_eq!(sessions[0].usage.as_ref().unwrap().buckets[0].turns, 1);
    }

    #[test]
    fn usage_import_codex_uses_last_usage_turn_model_and_skips_repeats() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("codex/sessions");
        let file = root.join("2026/10/29/rollout-2026-10-29T10-00-00-sample.jsonl");
        write(&file, &[
            r#"{"timestamp":"2026-10-29T10:00:00Z","type":"session_meta","payload":{"id":"codex-session-1","cwd":"/sample"}}"#.into(),
            r#"{"timestamp":"2026-10-29T10:00:01Z","type":"turn_context","payload":{"model":"gpt-5.5-codex"}}"#.into(),
            r#"{"timestamp":"2026-10-29T10:00:02Z","type":"response_item","payload":{"type":"message","content":"sample text"}}"#.into(),
            codex_token("2026-10-29T10:00:03Z", 100, 10, Some((100, 10))),
            codex_token("2026-10-29T10:00:04Z", 100, 10, Some((100, 10))),
            codex_token("2026-10-29T10:00:05Z", 250, 30, None),
            r#"{"timestamp":"2026-10-29T10:00:06Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#.into(),
        ]);
        std::fs::write(root.join("notes.jsonl"), "{}\n").unwrap();
        let roots = vec![(ImportKind::Codex, root)];
        let mut cache = ImportCache::default();
        let report = scan_all(&roots, &mut cache);
        assert_eq!((report.files_total, report.entries), (1, 2));
        let sessions = imported_sessions(&cache, 0, &HashSet::new());
        assert_eq!(sessions[0].session_id, "codex-session-1");
        assert_eq!(sessions[0].agent_id, IMPORTED_CODEX_ID);
        let bucket = &sessions[0].usage.as_ref().unwrap().buckets[0];
        assert_eq!(bucket.model, "gpt-5.5-codex");
        assert_eq!((bucket.input, bucket.output, bucket.total), (250, 30, 280));
        // Span tracked this session itself: it is left out.
        let tracked = HashSet::from(["codex-session-1".to_owned()]);
        assert!(imported_sessions(&cache, 0, &tracked).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn usage_import_never_follows_symlinks_and_honours_caps() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        write(
            &outside.join("x.jsonl"),
            &[claude("m", "r", "2026-10-29T10:00:00Z", 1, 1)],
        );
        let root = dir.path().join("projects");
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("x.jsonl"), root.join("file.jsonl")).unwrap();
        for i in 0..3 {
            write(
                &root.join(format!("p/{i}.jsonl")),
                &[claude(&format!("m{i}"), "r", "2026-10-29T10:00:00Z", 1, 1)],
            );
        }
        let roots = vec![(ImportKind::Claude, root.clone())];
        let mut cache = ImportCache::default();
        assert_eq!(scan_all(&roots, &mut cache).files_total, 3);
        let limits = ImportLimits {
            max_files: 2,
            ..ImportLimits::default()
        };
        let report = scan(&roots, &mut ImportCache::default(), &limits, &mut |_| {});
        assert!(report.truncated);
        assert_eq!(report.files_total, 2);
        // A root that is itself a link is not read.
        let linked_root = dir.path().join("linked-projects");
        std::os::unix::fs::symlink(&root, &linked_root).unwrap();
        let report = scan_all(
            &[(ImportKind::Claude, linked_root)],
            &mut ImportCache::default(),
        );
        assert_eq!(report.files_total, 0);
    }

    #[test]
    fn usage_import_sessions_sum_with_local_days_and_the_source_filter() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        write(
            &root.join("p/s.jsonl"),
            &[claude("m1", "r1", "2026-10-28T23:30:00Z", 1_000_000, 0)],
        );
        let mut cache = ImportCache::default();
        scan_all(&[(ImportKind::Claude, root)], &mut cache);
        let path = dir.path().join("cache/import.json");
        cache.save(&path).unwrap();
        let cache = ImportCache::load(&path);
        // UTC+2: 23:30 UTC is already the next local day.
        let sessions = imported_sessions(&cache, 120, &HashSet::new());
        assert_eq!(
            sessions[0].usage.as_ref().unwrap().buckets[0].day,
            "2026-10-29"
        );
        let table = PriceTable::bundled();
        let imported = UsageRange {
            source: Some(UsageSource::Imported),
            ..UsageRange::default()
        };
        let summary = summarize(&sessions, &imported, &table);
        assert_eq!(summary.totals.sessions, 1);
        assert!(summary.agents[0].imported);
        let tracked = UsageRange {
            source: Some(UsageSource::Tracked),
            ..UsageRange::default()
        };
        assert_eq!(summarize(&sessions, &tracked, &table).totals.sessions, 0);
    }

    fn sidechain(id: &str, request: &str, time: &str, input: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":true,"agentId":"agent-1","timestamp":"{time}","sessionId":"sess-a","requestId":"{request}","message":{{"id":"{id}","model":"claude-haiku-4-5","usage":{{"input_tokens":{input},"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}}}}"#
        )
    }

    fn turn_context(model: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-10-29T10:00:00Z","type":"turn_context","payload":{{"model":"{model}","cwd":"/sample"}}}}"#
        )
    }

    fn session_meta(id: &str) -> String {
        format!(
            r#"{{"timestamp":"2026-10-29T10:00:00Z","type":"session_meta","payload":{{"id":"{id}"}}}}"#
        )
    }

    fn totals_by_model(cache: &ImportCache) -> BTreeMap<String, (u64, u32)> {
        let mut out = BTreeMap::new();
        for state in cache.files.values() {
            for b in &state.buckets {
                let entry = out.entry(b.model.clone()).or_insert((0u64, 0u32));
                entry.0 += b.input;
                entry.1 += b.turns;
            }
        }
        out
    }

    #[test]
    fn usage_import_claude_counts_subagent_sidechains_once_by_message_and_request_id() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        // The main transcript repeats one message per content block (same id
        // and request id); the subagent file repeats a sidechain message the
        // main file also logged.
        write(
            &root.join("proj/sess-a.jsonl"),
            &[
                claude("msg-1", "req-1", "2026-10-29T10:00:00Z", 100, 10),
                claude("msg-1", "req-1", "2026-10-29T10:00:01Z", 100, 10),
                sidechain("msg-s1", "req-s1", "2026-10-29T10:05:00Z", 40),
            ],
        );
        write(
            &root.join("proj/sess-a/subagents/agent-1.jsonl"),
            &[
                sidechain("msg-s1", "req-s1", "2026-10-29T10:05:00Z", 40),
                sidechain("msg-s2", "req-s2", "2026-10-29T10:06:00Z", 60),
                "{ not json".to_owned(),
            ],
        );
        let mut cache = ImportCache::default();
        let report = scan_all(&[(ImportKind::Claude, root)], &mut cache);
        assert_eq!(report.files_total, 2);
        assert_eq!(report.entries, 3);
        assert_eq!(report.duplicates, 2);
        assert_eq!(report.kinds, vec![ImportKind::Claude]);
        let models = totals_by_model(&cache);
        assert_eq!(models["claude-opus-5-5"], (100, 1));
        assert_eq!(models["claude-haiku-4-5"], (100, 2));
        // Both files roll up into the parent session.
        let sessions = imported_sessions(&cache, 0, &HashSet::new());
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "sess-a");
    }

    #[test]
    fn usage_import_codex_carries_the_turn_model_forward_and_reads_gzip_rollouts() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        let lines = vec![
            session_meta("codex-1"),
            turn_context("gpt-5.5-codex"),
            codex_token("2026-10-29T10:01:00Z", 100, 10, Some((100, 10))),
            // No new turn_context: the model carries forward.
            codex_token("2026-10-29T10:02:00Z", 150, 15, None),
            turn_context("gpt-5.5"),
            codex_token("2026-10-29T10:03:00Z", 170, 17, Some((20, 2))),
        ];
        write(&root.join("2026/10/29/rollout-a.jsonl"), &lines);
        let gz = root.join("2026/10/28/rollout-b.jsonl.gz");
        fs::create_dir_all(gz.parent().unwrap()).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(
            File::create(&gz).unwrap(),
            flate2::Compression::default(),
        );
        let text: String = [
            session_meta("codex-2"),
            turn_context("gpt-5-mini"),
            codex_token("2026-10-28T09:00:00Z", 7, 3, Some((7, 3))),
        ]
        .iter()
        .map(|l| format!("{l}\n"))
        .collect();
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap();
        // A corrupt zstd file is skipped without failing the scan.
        fs::write(
            root.join("2026/10/28/rollout-c.jsonl.zst"),
            b"\x28\xb5\x2f\xfd sample",
        )
        .unwrap();
        let mut cache = ImportCache::default();
        let report = scan_all(&[(ImportKind::Codex, root.clone())], &mut cache);
        assert_eq!(report.files_total, 3);
        assert_eq!(report.compressed_read, 1);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.compressed_skipped, 0);
        let models = totals_by_model(&cache);
        assert_eq!(models["gpt-5.5-codex"], (150, 2));
        assert_eq!(models["gpt-5.5"], (20, 1));
        assert_eq!(models["gpt-5-mini"], (7, 1));
        // An unchanged compressed file is not read again.
        let again = scan_all(&[(ImportKind::Codex, root)], &mut cache);
        assert_eq!(again.files_read, 0);
        assert_eq!(again.compressed_read, 0);
        assert_eq!(totals_by_model(&cache), models);
    }

    #[test]
    fn usage_import_opencode_reads_message_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("opencode");
        let root = data.join("storage/message");
        write(
            &root.join("ses_1/msg_1.json"),
            &[r#"{"id":"msg_1","sessionID":"ses_1","role":"assistant","modelID":"claude-sonnet-5","providerID":"anthropic","cost":0.25,"time":{"created":1792000000000,"completed":1792000009000},"tokens":{"input":1200,"output":300,"reasoning":50,"cache":{"read":9000,"write":400}}}"#.to_owned()],
        );
        write(
            &root.join("ses_1/msg_2.json"),
            &[r#"{"id":"msg_2","sessionID":"ses_1","role":"assistant","model":{"id":"gpt-5.5","providerID":"openai"},"time":{"created":1792000100000},"tokens":{"input":100,"output":10,"reasoning":0,"cache":{"read":900,"write":0}}}"#.to_owned()],
        );
        write(
            &root.join("ses_1/msg_0.json"),
            &[r#"{"id":"msg_0","role":"user","time":{"created":1792000000000}}"#.to_owned()],
        );
        let mut cache = ImportCache::default();
        let report = scan_all(&[(ImportKind::OpenCode, root)], &mut cache);
        assert_eq!(report.entries, 2);
        assert_eq!(report.databases_read, 0);
        let buckets: Vec<&ImportBucket> = cache.files.values().flat_map(|f| &f.buckets).collect();
        let sonnet = buckets
            .iter()
            .find(|b| b.model == "claude-sonnet-5")
            .unwrap();
        // Anthropic convention: input apart from cache; reasoning is output.
        assert_eq!(
            (
                sonnet.input,
                sonnet.output,
                sonnet.cache_read,
                sonnet.cache_write,
                sonnet.thought
            ),
            (1200, 350, 9000, 400, 50)
        );
        assert_eq!(sonnet.cost_micros, 250_000);
        assert_eq!(sonnet.session, "ses_1");
        // OpenAI convention: cached tokens folded into input for the ledger.
        let gpt = buckets.iter().find(|b| b.model == "gpt-5.5").unwrap();
        assert_eq!((gpt.input, gpt.cache_read, gpt.total), (1000, 900, 1010));
    }

    #[test]
    fn usage_import_gemini_counts_each_message_once_and_keeps_rewound_usage() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("tmp");
        write(
            &root.join("project-a/chats/session-2026-10-29T10-00-abcd1234.jsonl"),
            &[
                r#"{"sessionId":"gem-1","projectHash":"p","startTime":"2026-10-29T10:00:00Z","kind":"main"}"#.to_owned(),
                r#"{"id":"u1","timestamp":"2026-10-29T10:00:00Z","type":"user","content":"sample prompt"}"#.to_owned(),
                r#"{"id":"m1","timestamp":"2026-10-29T10:00:05Z","type":"gemini","model":"gemini-3-pro","content":"","tokens":null}"#.to_owned(),
                // The same message again once its tokens arrive: last wins.
                r#"{"id":"m1","timestamp":"2026-10-29T10:00:05Z","type":"gemini","model":"gemini-3-pro","content":"sample","tokens":{"input":5000,"output":200,"cached":3000,"thoughts":150,"tool":0,"total":5350}}"#.to_owned(),
                r#"{"id":"m2","timestamp":"2026-10-29T10:01:00Z","type":"gemini","model":"gemini-3-flash","tokens":{"input":100,"output":20,"cached":0,"thoughts":0,"tool":5,"total":125}}"#.to_owned(),
                r#"{"$rewindTo":"m2"}"#.to_owned(),
                r#"{"$set":{"lastUpdated":"2026-10-29T10:02:00Z"}}"#.to_owned(),
            ],
        );
        write(
            &root.join("project-b/chats/session-legacy.json"),
            &[r#"{"sessionId":"gem-2","messages":[{"id":"x1","timestamp":"2026-10-28T08:00:00Z","type":"gemini","model":"gemini-2.5-pro","tokens":{"input":10,"output":2,"cached":0,"thoughts":0,"tool":0,"total":12}}]}"#.to_owned()],
        );
        // Outside a chats folder: not a chat file.
        write(
            &root.join("project-a/logs.json"),
            &[r#"[{"type":"user"}]"#.to_owned()],
        );
        let mut cache = ImportCache::default();
        let report = scan_all(&[(ImportKind::Gemini, root.clone())], &mut cache);
        assert_eq!(report.files_total, 2);
        assert_eq!(report.entries, 3);
        let buckets: Vec<&ImportBucket> = cache.files.values().flat_map(|f| &f.buckets).collect();
        let pro = buckets.iter().find(|b| b.model == "gemini-3-pro").unwrap();
        assert_eq!(
            (
                pro.input,
                pro.output,
                pro.cache_read,
                pro.thought,
                pro.total,
                pro.turns
            ),
            (5000, 350, 3000, 150, 5350, 1)
        );
        assert_eq!(pro.session, "gem-1");
        let flash = buckets
            .iter()
            .find(|b| b.model == "gemini-3-flash")
            .unwrap();
        assert_eq!(flash.input, 105);
        let sessions = imported_sessions(&cache, 0, &HashSet::new());
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().all(|s| s.agent_id == IMPORTED_GEMINI_ID));
        // A rescan of unchanged files adds nothing.
        let again = scan_all(&[(ImportKind::Gemini, root)], &mut cache);
        assert_eq!(again.entries, 0);
    }

    #[test]
    fn usage_import_more_roots_follow_opencode_and_gemini_environment() {
        let home = Path::new("/home/sample");
        let roots = more_roots(Some(home), None, None);
        assert_eq!(roots[0], (ImportKind::Gemini, home.join(".gemini/tmp")));
        assert_eq!(
            roots[1],
            (
                ImportKind::OpenCode,
                home.join(".local/share/opencode/storage/message")
            )
        );
        // XDG_DATA_HOME must be absolute on the host, which on Windows needs a drive.
        let data = if cfg!(windows) { r"C:\data" } else { "/data" };
        let xdg = more_roots(Some(home), None, Some(data));
        assert_eq!(
            xdg[1],
            (
                ImportKind::OpenCode,
                Path::new(data).join("opencode").join("storage/message")
            )
        );
        // A relative XDG_DATA_HOME is ignored, as the XDG spec says.
        assert_eq!(
            more_roots(Some(home), None, Some("rel"))[1].1,
            home.join(".local/share/opencode/storage/message")
        );
        let custom = more_roots(Some(home), Some("/x, /y"), None);
        assert_eq!(custom.len(), 3);
        assert!(is_imported_agent(IMPORTED_OPENCODE_ID) && is_imported_agent(IMPORTED_GEMINI_ID));
    }

    #[test]
    fn usage_import_day_rows_carry_model_slices() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        write(
            &root.join("p/sess-a.jsonl"),
            &[
                claude("m1", "r1", "2026-10-29T10:00:00Z", 100, 10),
                sidechain("m2", "r2", "2026-10-29T11:00:00Z", 50),
            ],
        );
        let mut cache = ImportCache::default();
        scan_all(&[(ImportKind::Claude, root)], &mut cache);
        let sessions = imported_sessions(&cache, 0, &HashSet::new());
        let summary = summarize(&sessions, &UsageRange::default(), &PriceTable::bundled());
        let day = &summary.days[0];
        let mut models: Vec<&str> = day.models.iter().map(|m| m.model.as_str()).collect();
        models.sort();
        assert_eq!(models, vec!["claude-haiku-4-5", "claude-opus-5-5"]);
        assert!(day.models.iter().all(|m| m.agent_id == IMPORTED_CLAUDE_ID));
        assert_eq!(
            day.models.iter().map(|m| m.tokens).sum::<u64>(),
            day.agents[0].tokens
        );
    }

    fn zstd_rollout(path: &Path, lines: &[String]) {
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let bytes = ruzstd::encoding::compress_to_vec(
            text.as_bytes(),
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn codex_session(id: &str, model: &str, day: &str) -> Vec<String> {
        vec![
            session_meta(id),
            turn_context(model),
            codex_token(&format!("{day}T10:01:00Z"), 100, 10, Some((100, 10))),
            // No new turn_context: the model carries forward.
            codex_token(&format!("{day}T10:02:00Z"), 150, 15, None),
            turn_context("gpt-5.5"),
            codex_token(&format!("{day}T10:03:00Z"), 170, 17, Some((20, 2))),
        ]
    }

    #[test]
    fn usage_import_zstd_rollouts_follow_the_plain_rules_and_count_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        // Only compressed: read with the same carry forward rules.
        zstd_rollout(
            &root.join("2026/10/27/rollout-z.jsonl.zst"),
            &codex_session("codex-z", "gpt-5.5-codex", "2026-10-27"),
        );
        // The same session plain and compressed: the plain copy counts once.
        write(
            &root.join("2026/10/28/rollout-p.jsonl"),
            &codex_session("codex-p", "gpt-5-mini", "2026-10-28"),
        );
        zstd_rollout(
            &root.join("2026/10/28/rollout-p.jsonl.zst"),
            &codex_session("codex-p", "gpt-5-mini", "2026-10-28"),
        );
        let mut cache = ImportCache::default();
        let report = scan_all(&[(ImportKind::Codex, root.clone())], &mut cache);
        assert_eq!(report.files_total, 3);
        assert_eq!((report.compressed_read, report.compressed_skipped), (2, 0));
        assert_eq!(report.skipped, 0);
        let sessions = imported_sessions(&cache, 0, &HashSet::new());
        assert_eq!(sessions.len(), 2);
        let tokens = |id: &str| {
            let s = sessions.iter().find(|s| s.session_id == id).unwrap();
            let mut by_model: BTreeMap<String, (u64, u32)> = BTreeMap::new();
            for b in &s.usage.as_ref().unwrap().buckets {
                let e = by_model.entry(b.model.clone()).or_default();
                e.0 += b.input;
                e.1 += b.turns;
            }
            by_model
        };
        let z = tokens("codex-z");
        assert_eq!(z["gpt-5.5-codex"], (150, 2));
        assert_eq!(z["gpt-5.5"], (20, 1));
        let p = tokens("codex-p");
        assert_eq!(p["gpt-5-mini"], (150, 2), "plain and compressed count once");
        assert_eq!(p["gpt-5.5"], (20, 1));
        // An unchanged compressed file is not decoded again.
        let again = scan_all(&[(ImportKind::Codex, root)], &mut cache);
        assert_eq!((again.files_read, again.compressed_read), (0, 0));
    }

    #[test]
    fn usage_import_zstd_respects_the_decoded_size_cap_and_keeps_a_truncated_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        let mut big = codex_session("codex-big", "gpt-5.5", "2026-10-29");
        big.push(format!(
            r#"{{"type":"padding","payload":"{}"}}"#,
            "x".repeat(4096)
        ));
        zstd_rollout(&root.join("rollout-big.jsonl.zst"), &big);
        let limits = ImportLimits {
            max_decompressed_bytes: 2048,
            ..ImportLimits::default()
        };
        let mut cache = ImportCache::default();
        let report = scan(
            &[(ImportKind::Codex, root.clone())],
            &mut cache,
            &limits,
            &mut |_| {},
        );
        assert_eq!((report.compressed_skipped, report.compressed_read), (1, 0));
        assert!(imported_sessions(&cache, 0, &HashSet::new()).is_empty());
        // A cut off file keeps the complete lines decoded before the cut.
        let full = root.join("rollout-big.jsonl.zst");
        let mut bytes = fs::read(&full).unwrap();
        let cut = bytes.len() - 64;
        bytes.truncate(cut);
        fs::remove_file(&full).unwrap();
        let cut_path = root.join("rollout-cut.jsonl.zst");
        fs::write(&cut_path, &bytes).unwrap();
        let mut cache = ImportCache::default();
        let report = scan_all(&[(ImportKind::Codex, root)], &mut cache);
        assert_eq!(report.skipped + report.compressed_read, 1);
    }

    #[test]
    fn usage_import_claude_blocks_start_at_the_first_message_and_last_five_hours() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        write(
            &root.join("p/a.jsonl"),
            &[
                claude("m1", "r1", "2026-10-29T08:40:00Z", 100, 10),
                claude("m2", "r2", "2026-10-29T12:59:00Z", 200, 20),
                // 13:00 is five hours after 08:00: a new block.
                claude("m3", "r3", "2026-10-29T13:00:00Z", 300, 30),
                // A long gap, then another block.
                claude("m4", "r4", "2026-10-30T02:15:00Z", 1, 1),
            ],
        );
        // The same message in a second file counts once.
        write(
            &root.join("p/b.jsonl"),
            &[claude("m1", "r1", "2026-10-29T08:40:00Z", 100, 10)],
        );
        let mut cache = ImportCache::default();
        scan_all(&[(ImportKind::Claude, root)], &mut cache);
        let hour = |text: &str| u64::from(parse_hour(text).unwrap()) * 3_600_000;
        let now = hour("2026-10-30T03:00:00Z");
        let blocks = claude_blocks(&cache, &crate::usage::PriceTable::bundled(), now, 0);
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].start_ms, hour("2026-10-29T08:00:00Z"));
        assert_eq!(blocks[0].end_ms, hour("2026-10-29T13:00:00Z"));
        assert_eq!(blocks[0].last_ms, hour("2026-10-29T12:00:00Z"));
        assert_eq!((blocks[0].turns, blocks[0].tokens.input), (2, 300));
        assert!(blocks[0].cost.known && blocks[0].cost.usd > 0.0);
        assert_eq!(blocks[0].models, vec!["claude-opus-5-5".to_owned()]);
        assert_eq!(blocks[1].start_ms, hour("2026-10-29T13:00:00Z"));
        assert!(!blocks[1].active);
        assert!(blocks[2].active, "the latest block has not ended");
        // Blocks that ended before `since` are left out.
        let recent = claude_blocks(
            &cache,
            &crate::usage::PriceTable::bundled(),
            now,
            hour("2026-10-29T14:00:00Z"),
        );
        assert_eq!(recent.len(), 2);
    }
}
