//! Opt-in importers for agents' own local usage logs (ADR 0012, source B):
//! Claude Code's `projects/**/*.jsonl` and Codex's `sessions/**/rollout-*.jsonl`.
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
const CACHE_VERSION: u32 = 1;
const HEAD_BYTES: usize = 4096;

pub fn is_imported_agent(agent_id: &str) -> bool {
    agent_id == IMPORTED_CLAUDE_ID || agent_id == IMPORTED_CODEX_ID
}

/// Which agent's logs a root holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ImportKind {
    Claude,
    Codex,
}

impl ImportKind {
    fn agent_id(self) -> &'static str {
        match self {
            ImportKind::Claude => IMPORTED_CLAUDE_ID,
            ImportKind::Codex => IMPORTED_CODEX_ID,
        }
    }
    fn agent_name(self) -> &'static str {
        match self {
            ImportKind::Claude => "Claude Code (local logs)",
            ImportKind::Codex => "Codex (local logs)",
        }
    }
    fn wants(self, name: &str) -> bool {
        match self {
            ImportKind::Claude => name.ends_with(".jsonl"),
            ImportKind::Codex => name.starts_with("rollout-") && name.ends_with(".jsonl"),
        }
    }
}

/// Bounds on one scan.
#[derive(Debug, Clone, Copy)]
pub struct ImportLimits {
    pub max_depth: usize,
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_line_bytes: usize,
}

impl Default for ImportLimits {
    fn default() -> Self {
        ImportLimits {
            max_depth: 6,
            max_files: 20_000,
            max_file_bytes: 512 * 1024 * 1024,
            max_line_bytes: 16 * 1024 * 1024,
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
}

/// 64-bit FNV-1a, stable across platforms and releases.
fn fnv(bytes: &[u8]) -> u64 {
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
            } else if file_type.is_file() && kind.wants(&entry.file_name().to_string_lossy()) {
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
/// after each file. Files that disappeared are dropped from the cache.
pub fn scan(
    roots: &[(ImportKind, PathBuf)],
    cache: &mut ImportCache,
    limits: &ImportLimits,
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
    report.files_total = files.len() as u32;
    progress(&report);
    let present: HashSet<String> = files.iter().map(|(_, p)| path_key(p)).collect();
    cache.files.retain(|key, _| present.contains(key));
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
    let fallback_session = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut buckets: HashMap<(u32, String, String), ImportBucket> = state
        .buckets
        .drain(..)
        .map(|b| ((b.hour, b.model.clone(), b.session.clone()), b))
        .collect();
    for line in bytes[..end].split(|b| *b == b'\n') {
        if line.is_empty() || line.len() > limits.max_line_bytes {
            continue;
        }
        let entry = match kind {
            ImportKind::Claude => claude_entry(line, seen, &mut state.keys, report),
            ImportKind::Codex => codex_entry(line, state),
        };
        let Some(entry) = entry else {
            continue;
        };
        report.entries += 1;
        let session = if entry.session.is_empty() {
            if kind == ImportKind::Codex && !state.session.is_empty() {
                state.session.clone()
            } else {
                fallback_session.clone()
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
    state.offset += end as u64 + 1;
    state.len = len;
    Ok(())
}

struct Entry {
    hour: u32,
    model: String,
    session: String,
    tokens: TokenCounts,
    cost_micros: u64,
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

/// The cache as sessions the usage ledger can sum, with local days from
/// `utc_offset_minutes`. Sessions in `tracked` (ids Span recorded itself)
/// are left out so a session is never counted twice.
pub fn imported_sessions(
    cache: &ImportCache,
    utc_offset_minutes: i32,
    tracked: &HashSet<String>,
) -> Vec<SessionMeta> {
    let mut sessions: HashMap<(ImportKind, String), SessionMeta> = HashMap::new();
    for state in cache.files.values() {
        let Some(kind) = state.kind else {
            continue;
        };
        for bucket in &state.buckets {
            if bucket.session.is_empty() || tracked.contains(&bucket.session) {
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
}
