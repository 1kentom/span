//! Local, per-workspace metadata about agent sessions (ADR 0005).
//!
//! ACP `session/list` only reports id, cwd, title and updatedAt. This store
//! keeps what Span itself observed: the agents and models a session used, file
//! statistics, a user chosen title and an archived flag. A zero, empty or
//! absent field means unknown, and the UI never shows an unknown field.
//!
//! The store never holds prompt text, file contents or credentials.
use crate::{
    io_error, permission_mode::ThreadPermissionMode, usage::TokenCounts, workspace::atomic_write,
    CoreError, EditProposal, Result,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// Version of the JSON file layout. A file with a higher version is refused,
/// never moved aside, so an older Span cannot destroy a newer one's history.
pub const SESSION_META_SCHEMA_VERSION: u32 = 1;
/// At most this many sessions are kept per workspace.
pub const SESSION_META_MAX_SESSIONS: usize = 2000;
/// The written file never exceeds this many bytes.
pub const SESSION_META_MAX_BYTES: usize = 512 * 1024;
/// Files up to this size are still read (and shrunk on the next write).
/// Anything larger is treated as corrupt.
const READ_LIMIT_BYTES: usize = 4 * SESSION_META_MAX_BYTES;
const MAX_ID_BYTES: usize = 256;
const MAX_TITLE_CHARS: usize = 200;
const MAX_LABEL_CHARS: usize = 128;
const MAX_MODELS: usize = 16;
const MAX_AGENTS: usize = 32;
/// Day and model buckets kept per session. Older ones are folded in.
pub const MAX_USAGE_BUCKETS: usize = 32;

/// One model a session used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelUse {
    /// The model as the agent names it, for example its config option value.
    pub name: String,
    /// Reasoning effort or thought level, when the agent exposes one.
    pub effort: Option<String>,
    /// Unix milliseconds of the last turn or selection with this model.
    pub used_ms: u64,
    /// Prompt turns sent while this model was selected.
    pub turns: u32,
    /// True when a delegated child session ran this model for the session,
    /// shown as `model · subagent`. Kept apart from the lead's own use of the
    /// same model.
    #[serde(default, skip_serializing_if = "is_false")]
    pub subagent: bool,
}

/// One agent that took part in a session, for example a delegated child.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUse {
    pub agent_id: String,
    pub name: String,
    /// `delegated` for a child started through span-agents.
    pub role: Option<String>,
    /// True when the agent itself reported the work as a subagent.
    pub subagent: bool,
}

/// The lead session that started a delegated session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionParent {
    pub agent_id: String,
    pub session_id: String,
}

/// The earlier segment of the same chat that a session continues: the
/// session the user switched agent from (ADR 0005, thread links). `title` is
/// the chat title shown when the switch happened, so the thread keeps its
/// name even when the earlier agent is not connected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub agent_id: String,
    pub session_id: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// What Span knows about one agent session. Sessions are keyed by
/// `(agentId, sessionId)` because two agents may reuse a session id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    /// The UI's agent catalog entry id: the ACP registry id for registry
    /// agents, the preset id for presets, and `custom:<executable name>` for
    /// a custom command line (the UI gives those no catalog id).
    pub agent_id: String,
    /// The agent's display name when the session was last active.
    pub connection_name: String,
    pub session_id: String,
    /// A title the user chose, shown instead of the agent's title.
    pub title_override: Option<String>,
    pub archived: bool,
    pub first_seen_ms: u64,
    pub last_active_ms: u64,
    pub models: Vec<ModelUse>,
    pub agents: Vec<AgentUse>,
    pub files_changed: u32,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub stop_reason_last: Option<String>,
    pub parent: Option<SessionParent>,
    /// The earlier segment of the same chat, set when the user switched agent.
    /// Following these links from the newest segment gives the whole thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continues: Option<SessionLink>,
    /// True when Span saw every file change of the session go through review,
    /// so zero counters mean "no changes" rather than "unknown".
    #[serde(default, skip_serializing_if = "is_false")]
    pub changes_tracked: bool,
    /// Token and cost counters Span observed over ACP (ADR 0012). Counters
    /// only: no prompt text, replies or file contents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SessionUsage>,
    /// The thread's permission mode (ADR 0015), by name only, restored with
    /// the thread. An unknown name reads as absent.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_mode"
    )]
    pub permission_mode: Option<ThreadPermissionMode>,
}

/// Reads a stored mode name; anything unknown (a newer Span's mode, a typo)
/// is `None` instead of failing the whole file.
fn lenient_mode<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<ThreadPermissionMode>, D::Error> {
    let name = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(name
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .and_then(ThreadPermissionMode::from_name))
}

/// Usage counters of one session (ADR 0012), bucketed by local day and model
/// so totals over any range of days are plain sums.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionUsage {
    pub buckets: Vec<UsageBucket>,
    /// The last cumulative session cost the agent reported, kept so the next
    /// report adds only its growth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_seen: Option<ReportedCost>,
    /// Peak context window occupancy (`usage_update.used`). Not consumption.
    #[serde(skip_serializing_if = "is_zero")]
    pub context_peak: u64,
    /// The last reported context window size.
    #[serde(skip_serializing_if = "is_zero")]
    pub context_size: u64,
}

/// A cost as the agent reported it, in millionths of `currency`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReportedCost {
    pub micros: u64,
    /// ISO 4217 code, for example `USD`.
    pub currency: String,
}

/// What one model did on one day of a session. Zero means not reported.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct UsageBucket {
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    /// The model as the agent names it. Empty when unknown.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(skip_serializing_if = "is_zero32")]
    pub turns: u32,
    /// Turns that came with token counts.
    #[serde(skip_serializing_if = "is_zero32")]
    pub turns_with_tokens: u32,
    #[serde(skip_serializing_if = "is_zero")]
    pub input: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub output: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub cache_read: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub cache_write: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub thought: u64,
    #[serde(skip_serializing_if = "is_zero")]
    pub total: u64,
    /// Growth of the agent's reported session cost, in millionths.
    #[serde(skip_serializing_if = "is_zero")]
    pub cost_micros: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

impl UsageBucket {
    pub fn tokens(&self) -> TokenCounts {
        TokenCounts {
            input: self.input,
            output: self.output,
            cache_read: self.cache_read,
            cache_write: self.cache_write,
            thought: self.thought,
            total: self.total,
        }
    }
    pub(crate) fn add(&mut self, other: &UsageBucket) {
        let mut tokens = self.tokens();
        tokens.add(&other.tokens());
        self.input = tokens.input;
        self.output = tokens.output;
        self.cache_read = tokens.cache_read;
        self.cache_write = tokens.cache_write;
        self.thought = tokens.thought;
        self.total = tokens.total;
        self.turns = self.turns.saturating_add(other.turns);
        self.turns_with_tokens = self
            .turns_with_tokens
            .saturating_add(other.turns_with_tokens);
        if other.cost_micros > 0 {
            match (&self.currency, &other.currency) {
                (None, _) => {
                    self.currency = other.currency.clone();
                    self.cost_micros = self.cost_micros.saturating_add(other.cost_micros);
                }
                (Some(a), Some(b)) if a == b => {
                    self.cost_micros = self.cost_micros.saturating_add(other.cost_micros);
                }
                // A cost in a second currency is dropped rather than summed.
                _ => {}
            }
        }
    }
}

/// What a finished turn reported, merged into the session's usage (ADR
/// 0012). Token counts are one turn's and are added; `costTotal` is the
/// agent's cumulative session cost and only its growth is added; `context`
/// updates the peak.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsagePatch {
    /// Local calendar day of the turn, `YYYY-MM-DD`. Absent or invalid: the
    /// UTC day of the update.
    #[serde(default)]
    #[specta(optional)]
    pub day: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub model: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub tokens: Option<TokenCounts>,
    #[serde(default)]
    #[specta(optional)]
    pub cost_total: Option<ReportedCost>,
    #[serde(default)]
    #[specta(optional)]
    pub context: Option<ContextReading>,
    /// Turns this patch stands for. Absent means one.
    #[serde(default)]
    #[specta(optional)]
    pub turns: Option<u32>,
}

/// A `usage_update` reading: tokens in the context window and its size.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextReading {
    pub used: u64,
    pub size: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

fn is_zero32(value: &u32) -> bool {
    *value == 0
}

/// Fields that default to false are left out of the file, so the new fields
/// cost nothing for sessions that never set them (the byte cap is unchanged).
fn is_false(value: &bool) -> bool {
    !*value
}

/// A model use to merge into a session: merged by `name`, `turns` is added
/// (absent means one turn, zero records a selection without a turn) and
/// `usedMs` becomes the update time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsePatch {
    pub name: String,
    #[serde(default)]
    #[specta(optional)]
    pub effort: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub turns: Option<u32>,
    /// Records a delegated child's model (merged apart from the lead's own).
    #[serde(default)]
    #[specta(optional)]
    pub subagent: Option<bool>,
}

/// A merge patch for one session. Absent fields leave the stored value as it
/// is. `models` and `agents` are merged (model by name, agent by agent id);
/// the counters and `stopReasonLast` replace the stored value, so the caller
/// sends session totals, not deltas. The session is created when missing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaPatch {
    pub agent_id: String,
    pub session_id: String,
    #[serde(default)]
    #[specta(optional)]
    pub connection_name: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub models: Vec<ModelUsePatch>,
    #[serde(default)]
    #[specta(optional)]
    pub agents: Vec<AgentUse>,
    #[serde(default)]
    #[specta(optional)]
    pub files_changed: Option<u32>,
    #[serde(default)]
    #[specta(optional)]
    pub lines_added: Option<u32>,
    #[serde(default)]
    #[specta(optional)]
    pub lines_removed: Option<u32>,
    #[serde(default)]
    #[specta(optional)]
    pub stop_reason_last: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub parent: Option<SessionParent>,
    /// Set, not merged. A link to the session itself or with an invalid id is
    /// ignored.
    #[serde(default)]
    #[specta(optional)]
    pub continues: Option<SessionLink>,
    #[serde(default)]
    #[specta(optional)]
    pub changes_tracked: Option<bool>,
    /// A finished turn's usage (ADR 0012).
    #[serde(default)]
    #[specta(optional)]
    pub usage: Option<UsagePatch>,
    /// The thread's permission mode (ADR 0015). Set, not merged.
    #[serde(default, deserialize_with = "lenient_mode")]
    #[specta(optional)]
    pub permission_mode: Option<ThreadPermissionMode>,
}

impl SessionMetaPatch {
    pub fn new(agent_id: impl Into<String>, session_id: impl Into<String>) -> Self {
        Self {
            agent_id: agent_id.into(),
            session_id: session_id.into(),
            ..Self::default()
        }
    }
}

/// Distinct files and changed lines, for the session's file counters.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileChangeStats {
    paths: HashSet<String>,
    pub lines_added: u32,
    pub lines_removed: u32,
}

impl FileChangeStats {
    pub fn files_changed(&self) -> u32 {
        u32::try_from(self.paths.len()).unwrap_or(u32::MAX)
    }
    /// Adds one change of `path` from `old` (absent for a new file) to `new`.
    pub fn add_text_change(&mut self, path: &str, old: Option<&str>, new: &str) {
        let (added, removed) = line_delta(old.unwrap_or(""), new);
        if added > 0 || removed > 0 || old.is_none() {
            self.paths.insert(path.to_owned());
        }
        self.lines_added = self.lines_added.saturating_add(added);
        self.lines_removed = self.lines_removed.saturating_add(removed);
    }
    /// Adds an accepted edit proposal (each hunk's before and after text).
    pub fn add_proposal(&mut self, proposal: &EditProposal) {
        for hunk in &proposal.hunks {
            self.add_text_change(&proposal.path, Some(&hunk.before), &hunk.after);
        }
    }
}

fn line_delta(old: &str, new: &str) -> (u32, u32) {
    use similar::{ChangeTag, TextDiff};
    let mut added = 0u32;
    let mut removed = 0u32;
    for change in TextDiff::from_lines(old, new).iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added = added.saturating_add(1),
            ChangeTag::Delete => removed = removed.saturating_add(1),
            ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

/// Turn start: one turn with the selected model.
pub fn patch_for_turn_start(
    agent_id: &str,
    session_id: &str,
    connection_name: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> SessionMetaPatch {
    let mut patch = SessionMetaPatch::new(agent_id, session_id);
    patch.connection_name = connection_name.map(str::to_owned);
    if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
        patch.models.push(ModelUsePatch {
            name: model.to_owned(),
            effort: effort.map(str::to_owned),
            turns: Some(1),
            subagent: None,
        });
    }
    patch
}

/// Model selection without a turn (a config change), recorded with zero turns.
pub fn patch_for_model_selected(
    agent_id: &str,
    session_id: &str,
    model: &str,
    effort: Option<&str>,
) -> SessionMetaPatch {
    let mut patch = SessionMetaPatch::new(agent_id, session_id);
    if !model.trim().is_empty() {
        patch.models.push(ModelUsePatch {
            name: model.to_owned(),
            effort: effort.map(str::to_owned),
            turns: Some(0),
            subagent: None,
        });
    }
    patch
}

/// Turn complete: the ACP stop reason (`end_turn`, `cancelled`, ...).
pub fn patch_for_turn_complete(
    agent_id: &str,
    session_id: &str,
    stop_reason: &str,
) -> SessionMetaPatch {
    let mut patch = SessionMetaPatch::new(agent_id, session_id);
    patch.stop_reason_last = Some(stop_reason.to_owned());
    patch
}

/// File counters from the session's accumulated statistics (totals, set).
pub fn patch_for_file_stats(
    agent_id: &str,
    session_id: &str,
    stats: &FileChangeStats,
) -> SessionMetaPatch {
    let mut patch = SessionMetaPatch::new(agent_id, session_id);
    patch.files_changed = Some(stats.files_changed());
    patch.lines_added = Some(stats.lines_added);
    patch.lines_removed = Some(stats.lines_removed);
    patch
}

/// A delegated child session: the lead gains an agent use, the child gains
/// its parent. Returns `[lead_patch, child_patch]`.
pub fn patches_for_delegation(
    lead_agent_id: &str,
    lead_session_id: &str,
    child_agent_id: &str,
    child_agent_name: &str,
    child_session_id: &str,
) -> [SessionMetaPatch; 2] {
    let mut lead = SessionMetaPatch::new(lead_agent_id, lead_session_id);
    lead.agents.push(AgentUse {
        agent_id: child_agent_id.to_owned(),
        name: child_agent_name.to_owned(),
        role: Some("delegated".to_owned()),
        subagent: false,
    });
    let mut child = SessionMetaPatch::new(child_agent_id, child_session_id);
    child.connection_name = Some(child_agent_name.to_owned());
    child.parent = Some(SessionParent {
        agent_id: lead_agent_id.to_owned(),
        session_id: lead_session_id.to_owned(),
    });
    [lead, child]
}

/// Canonical text of a workspace root, used only to derive the store's file
/// name. Callers pass an already canonicalised root (`fs::canonicalize`).
///
/// Rules: Windows style roots (a drive letter, `\\server\share`, or a
/// `\\?\` verbatim prefix) drop the verbatim prefix, use `/` separators and
/// are lowercased, because Windows paths are case insensitive. Unix roots keep
/// their case and their backslashes (a legal file name character there).
/// Repeated separators collapse and a trailing separator is removed, except
/// for a filesystem root.
pub fn workspace_key(root: &str) -> String {
    let mut text = root.trim().to_owned();
    let windows = is_windows_style(&text);
    if windows {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            text = format!(r"\\{rest}");
        } else if let Some(rest) = text.strip_prefix(r"\\?\") {
            text = rest.to_owned();
        }
        text = text.replace('\\', "/").to_lowercase();
    }
    let unc = windows && text.starts_with("//");
    let mut out = String::with_capacity(text.len());
    if unc {
        out.push('/');
    }
    let mut previous_slash = false;
    for ch in text.chars() {
        if ch == '/' {
            if !previous_slash {
                out.push('/');
            }
            previous_slash = true;
        } else {
            out.push(ch);
            previous_slash = false;
        }
    }
    let minimum = if windows && out.len() >= 3 && out.as_bytes()[1] == b':' {
        3
    } else {
        1
    };
    while out.len() > minimum && out.ends_with('/') {
        out.pop();
    }
    out
}

fn is_windows_style(root: &str) -> bool {
    let bytes = root.as_bytes();
    root.starts_with(r"\\")
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

/// 64-bit FNV-1a of the canonical key, as 16 lowercase hex digits. Stable
/// across Rust releases and platforms (unlike `DefaultHasher`).
pub fn workspace_hash(root: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let hash = workspace_key(root).bytes().fold(OFFSET, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(PRIME)
    });
    format!("{hash:016x}")
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    sessions: Vec<SessionMeta>,
}

/// One workspace's session metadata file with an exclusive lock file beside it.
pub struct SessionMetaStore {
    path: PathBuf,
    max_sessions: usize,
    max_bytes: usize,
}

impl SessionMetaStore {
    /// The store for `workspace_root` inside `directory`.
    pub fn in_directory(directory: impl AsRef<Path>, workspace_root: &str) -> Self {
        Self {
            path: directory
                .as_ref()
                .join(format!("{}.json", workspace_hash(workspace_root))),
            max_sessions: SESSION_META_MAX_SESSIONS,
            max_bytes: SESSION_META_MAX_BYTES,
        }
    }
    /// The store in the user profile, beside `session.json` and
    /// `recent-projects.json`: `<home>/.config/span/session-meta/<hash>.json`.
    pub fn for_workspace(workspace_root: &str) -> Result<Self> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| {
                CoreError::Settings("Cannot locate user profile for session history".into())
            })?;
        Ok(Self::in_directory(
            PathBuf::from(home).join(".config/span/session-meta"),
            workspace_root,
        ))
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// The profile folder that holds every workspace's store.
    pub fn profile_directory() -> Result<PathBuf> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| {
                CoreError::Settings("Cannot locate user profile for session history".into())
            })?;
        Ok(PathBuf::from(home).join(".config/span/session-meta"))
    }
    /// Every session of every workspace store in `directory` (ADR 0012, the
    /// usage page spans all folders). Only regular `<16 hex>.json` files are
    /// read, never symlinks, at most `max_files` of them. A store that cannot
    /// be read is skipped.
    pub fn list_all_in(directory: &Path, max_files: usize) -> Result<Vec<SessionMeta>> {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(io_error("Read session history folder", directory, e)),
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let stem = name.strip_suffix(".json").unwrap_or("");
                stem.len() == 16
                    && stem.bytes().all(|b| b.is_ascii_hexdigit())
                    && entry.file_type().is_ok_and(|kind| kind.is_file())
            })
            .map(|entry| entry.path())
            .collect();
        files.sort();
        files.truncate(max_files);
        let mut sessions = vec![];
        for path in files {
            let store = Self {
                path,
                max_sessions: SESSION_META_MAX_SESSIONS,
                max_bytes: SESSION_META_MAX_BYTES,
            };
            if let Ok(mut found) = store.list() {
                sessions.append(&mut found);
            }
        }
        Ok(sessions)
    }
    #[cfg(test)]
    fn with_limits(mut self, max_sessions: usize, max_bytes: usize) -> Self {
        self.max_sessions = max_sessions;
        self.max_bytes = max_bytes;
        self
    }

    /// Every session, most recently active first.
    pub fn list(&self) -> Result<Vec<SessionMeta>> {
        let _lock = self.lock()?;
        let mut sessions = self.read()?;
        sessions.sort_by_key(|s| std::cmp::Reverse(s.last_active_ms));
        Ok(sessions)
    }
    pub fn get(&self, agent_id: &str, session_id: &str) -> Result<Option<SessionMeta>> {
        let _lock = self.lock()?;
        Ok(self
            .read()?
            .into_iter()
            .find(|s| s.agent_id == agent_id && s.session_id == session_id))
    }
    pub fn upsert(&self, patch: SessionMetaPatch) -> Result<SessionMeta> {
        self.upsert_at(patch, now_ms())
    }
    pub fn upsert_at(&self, patch: SessionMetaPatch, now: u64) -> Result<SessionMeta> {
        self.modify(&patch.agent_id, &patch.session_id, now, |meta| {
            apply_patch(meta, &patch, now);
            meta.last_active_ms = meta.last_active_ms.max(now);
        })
    }
    /// `None` or a blank title clears the override. Not counted as activity.
    pub fn set_title(
        &self,
        agent_id: &str,
        session_id: &str,
        title: Option<String>,
    ) -> Result<SessionMeta> {
        self.modify(agent_id, session_id, now_ms(), |meta| {
            meta.title_override = title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(|t| clip(t, MAX_TITLE_CHARS));
        })
    }
    /// Archived sessions are evicted last. Not counted as activity.
    pub fn set_archived(
        &self,
        agent_id: &str,
        session_id: &str,
        archived: bool,
    ) -> Result<SessionMeta> {
        self.modify(agent_id, session_id, now_ms(), |meta| {
            meta.archived = archived;
        })
    }
    /// Returns whether a session was removed.
    pub fn delete(&self, agent_id: &str, session_id: &str) -> Result<bool> {
        let _lock = self.lock()?;
        let mut sessions = self.read()?;
        let before = sessions.len();
        sessions.retain(|s| !(s.agent_id == agent_id && s.session_id == session_id));
        if sessions.len() == before {
            return Ok(false);
        }
        self.write(&mut sessions)?;
        Ok(true)
    }
    /// Removes this agent's sessions that are not in `known`. Never called
    /// automatically: an agent may not list every session it can restore.
    pub fn prune_missing(&self, agent_id: &str, known: &[String]) -> Result<usize> {
        let known: HashSet<&str> = known.iter().map(String::as_str).collect();
        let _lock = self.lock()?;
        let mut sessions = self.read()?;
        let before = sessions.len();
        sessions.retain(|s| s.agent_id != agent_id || known.contains(s.session_id.as_str()));
        let removed = before - sessions.len();
        if removed > 0 {
            self.write(&mut sessions)?;
        }
        Ok(removed)
    }

    fn modify(
        &self,
        agent_id: &str,
        session_id: &str,
        now: u64,
        change: impl FnOnce(&mut SessionMeta),
    ) -> Result<SessionMeta> {
        validate_id("agent id", agent_id)?;
        validate_id("session id", session_id)?;
        let _lock = self.lock()?;
        let mut sessions = self.read()?;
        let index = match sessions
            .iter()
            .position(|s| s.agent_id == agent_id && s.session_id == session_id)
        {
            Some(index) => index,
            None => {
                sessions.push(new_meta(agent_id, session_id, now));
                sessions.len() - 1
            }
        };
        change(&mut sessions[index]);
        let updated = sessions[index].clone();
        self.write(&mut sessions)?;
        Ok(updated)
    }

    fn lock(&self) -> Result<File> {
        let parent = self.parent()?;
        fs::create_dir_all(parent)
            .map_err(|e| io_error("Create session history directory", parent, e))?;
        let lock_path = self.path.with_extension("json.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|e| io_error("Open session history lock", &lock_path, e))?;
        file.lock()
            .map_err(|e| io_error("Lock session history", &lock_path, e))?;
        Ok(file)
    }
    fn parent(&self) -> Result<&Path> {
        self.path
            .parent()
            .ok_or_else(|| CoreError::Settings("Invalid session history path".into()))
    }

    /// Missing file: empty. Unreadable content: moved aside, empty. A newer
    /// schema version: an error, the file is left alone.
    fn read(&self) -> Result<Vec<SessionMeta>> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(io_error("Read session history", &self.path, e)),
        };
        let mut bytes = Vec::new();
        file.take(READ_LIMIT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| io_error("Read session history", &self.path, e))?;
        if bytes.len() > READ_LIMIT_BYTES {
            self.move_aside()?;
            return Ok(vec![]);
        }
        let value: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                self.move_aside()?;
                return Ok(vec![]);
            }
        };
        let version = value.get("version").and_then(serde_json::Value::as_u64);
        if let Some(version) = version.filter(|v| *v > u64::from(SESSION_META_SCHEMA_VERSION)) {
            return Err(CoreError::Settings(format!(
                "Session history uses schema version {version}, written by a newer Span"
            )));
        }
        let parsed = match serde_json::from_value::<StoreFile>(value) {
            Ok(file) if file.version == SESSION_META_SCHEMA_VERSION => file,
            _ => {
                self.move_aside()?;
                return Ok(vec![]);
            }
        };
        Ok(sanitize_all(parsed.sessions))
    }

    /// Renames the unreadable file to `<name>.corrupt` (or `<name>.<n>.corrupt`
    /// when that exists). Never overwrites an earlier corrupt copy.
    fn move_aside(&self) -> Result<PathBuf> {
        let parent = self.parent()?;
        let name = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        for attempt in 0..1000u32 {
            let candidate = if attempt == 0 {
                parent.join(format!("{name}.corrupt"))
            } else {
                parent.join(format!("{name}.{attempt}.corrupt"))
            };
            if candidate.exists() {
                continue;
            }
            fs::rename(&self.path, &candidate)
                .map_err(|e| io_error("Move unreadable session history aside", &candidate, e))?;
            eprintln!(
                "Session history was unreadable and was moved aside to {}",
                candidate
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            );
            return Ok(candidate);
        }
        Err(CoreError::Settings(
            "Too many unreadable session history copies; remove old .corrupt files".into(),
        ))
    }

    fn write(&self, sessions: &mut Vec<SessionMeta>) -> Result<()> {
        enforce_caps(sessions, self.max_sessions, self.max_bytes)?;
        let bytes = serde_json::to_vec(&StoreFile {
            version: SESSION_META_SCHEMA_VERSION,
            sessions: std::mem::take(sessions),
        })
        .map_err(|e| CoreError::Settings(e.to_string()))?;
        atomic_write(&self.path, &bytes)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn validate_id(label: &str, id: &str) -> Result<()> {
    if id.trim().is_empty() || id.len() > MAX_ID_BYTES {
        return Err(CoreError::Settings(format!(
            "Session history {label} must be 1 to {MAX_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

fn clip(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

fn clip_label(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| clip(t, MAX_LABEL_CHARS))
}

fn new_meta(agent_id: &str, session_id: &str, now: u64) -> SessionMeta {
    SessionMeta {
        agent_id: agent_id.to_owned(),
        connection_name: String::new(),
        session_id: session_id.to_owned(),
        title_override: None,
        archived: false,
        first_seen_ms: now,
        last_active_ms: now,
        models: vec![],
        agents: vec![],
        files_changed: 0,
        lines_added: 0,
        lines_removed: 0,
        stop_reason_last: None,
        parent: None,
        continues: None,
        changes_tracked: false,
        usage: None,
        permission_mode: None,
    }
}

fn apply_patch(meta: &mut SessionMeta, patch: &SessionMetaPatch, now: u64) {
    if let Some(name) = clip_label(patch.connection_name.as_deref()) {
        meta.connection_name = name;
    }
    for model in &patch.models {
        let Some(name) = clip_label(Some(&model.name)) else {
            continue;
        };
        let turns = model.turns.unwrap_or(1);
        let effort = clip_label(model.effort.as_deref());
        let subagent = model.subagent.unwrap_or(false);
        match meta
            .models
            .iter_mut()
            .find(|m| m.name == name && m.subagent == subagent)
        {
            Some(existing) => {
                existing.turns = existing.turns.saturating_add(turns);
                existing.used_ms = existing.used_ms.max(now);
                if effort.is_some() {
                    existing.effort = effort;
                }
            }
            None => meta.models.push(ModelUse {
                name,
                effort,
                used_ms: now,
                turns,
                subagent,
            }),
        }
    }
    if meta.models.len() > MAX_MODELS {
        meta.models.sort_by_key(|m| std::cmp::Reverse(m.used_ms));
        meta.models.truncate(MAX_MODELS);
    }
    for agent in &patch.agents {
        let Some(agent_id) = clip_label(Some(&agent.agent_id)) else {
            continue;
        };
        let incoming = AgentUse {
            name: clip_label(Some(&agent.name)).unwrap_or_else(|| agent_id.clone()),
            role: clip_label(agent.role.as_deref()),
            subagent: agent.subagent,
            agent_id,
        };
        match meta
            .agents
            .iter_mut()
            .find(|a| a.agent_id == incoming.agent_id)
        {
            Some(existing) => {
                existing.name = incoming.name;
                if incoming.role.is_some() {
                    existing.role = incoming.role;
                }
                existing.subagent |= incoming.subagent;
            }
            None => meta.agents.push(incoming),
        }
    }
    if meta.agents.len() > MAX_AGENTS {
        let excess = meta.agents.len() - MAX_AGENTS;
        meta.agents.drain(..excess);
    }
    if let Some(value) = patch.files_changed {
        meta.files_changed = value;
    }
    if let Some(value) = patch.lines_added {
        meta.lines_added = value;
    }
    if let Some(value) = patch.lines_removed {
        meta.lines_removed = value;
    }
    if let Some(reason) = clip_label(patch.stop_reason_last.as_deref()) {
        meta.stop_reason_last = Some(reason);
    }
    if let Some(parent) = &patch.parent {
        if validate_id("parent agent id", &parent.agent_id).is_ok()
            && validate_id("parent session id", &parent.session_id).is_ok()
        {
            meta.parent = Some(parent.clone());
        }
    }
    if let Some(link) = patch
        .continues
        .as_ref()
        .and_then(|link| valid_link(meta, link))
    {
        meta.continues = Some(link);
    }
    if let Some(tracked) = patch.changes_tracked {
        meta.changes_tracked = tracked;
    }
    if let Some(usage) = &patch.usage {
        apply_usage(meta, usage, now);
    }
    if let Some(mode) = patch.permission_mode {
        meta.permission_mode = Some(mode);
    }
}

/// A three letter upper case code, as ACP's `cost.currency` should be.
fn valid_currency(code: &str) -> bool {
    code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())
}

/// Merges one turn's usage. Token counts add up; a reported cumulative cost
/// adds only its growth since the last report (a lower figure in the same
/// currency means the agent's counter restarted, so the whole figure is new);
/// the context reading updates the peak.
fn apply_usage(meta: &mut SessionMeta, patch: &UsagePatch, now: u64) {
    let usage = meta.usage.get_or_insert_with(SessionUsage::default);
    if let Some(context) = patch.context {
        usage.context_peak = usage.context_peak.max(context.used);
        if context.size > 0 {
            usage.context_size = context.size;
        }
    }
    let mut cost = None;
    if let Some(total) = patch
        .cost_total
        .as_ref()
        .filter(|c| valid_currency(&c.currency))
    {
        let growth = match &usage.cost_seen {
            Some(seen) if seen.currency == total.currency && total.micros >= seen.micros => {
                total.micros - seen.micros
            }
            _ => total.micros,
        };
        usage.cost_seen = Some(total.clone());
        cost = Some((growth, total.currency.clone()));
    }
    let tokens = patch.tokens.unwrap_or_default();
    let turns = patch.turns.unwrap_or(1);
    if turns == 0 && tokens.is_empty() && cost.as_ref().is_none_or(|c| c.0 == 0) {
        if usage.buckets.is_empty() && usage.cost_seen.is_none() && usage.context_peak == 0 {
            meta.usage = None;
        }
        return;
    }
    let day = patch
        .day
        .as_deref()
        .filter(|day| crate::usage::parse_day(day).is_some())
        .map(str::to_owned)
        .unwrap_or_else(|| crate::usage::utc_day(now));
    let model = clip_label(patch.model.as_deref()).unwrap_or_default();
    let (cost_micros, currency) = match cost {
        Some((micros, currency)) if micros > 0 => (micros, Some(currency)),
        _ => (0, None),
    };
    let incoming = UsageBucket {
        day,
        model,
        turns,
        turns_with_tokens: if tokens.is_empty() { 0 } else { turns },
        input: tokens.input,
        output: tokens.output,
        cache_read: tokens.cache_read,
        cache_write: tokens.cache_write,
        thought: tokens.thought,
        total: tokens.effective_total(),
        cost_micros,
        currency,
    };
    match usage
        .buckets
        .iter_mut()
        .find(|b| b.day == incoming.day && b.model == incoming.model)
    {
        Some(existing) => existing.add(&incoming),
        None => usage.buckets.push(incoming),
    }
    fold_usage_buckets(&mut usage.buckets, MAX_USAGE_BUCKETS);
}

/// Keeps at most `max` buckets without losing any count: the oldest bucket
/// is folded into the next oldest one of the same model (so totals per model
/// stay right and only its day moves later), or into the next oldest bucket
/// when its model has no other.
fn fold_usage_buckets(buckets: &mut Vec<UsageBucket>, max: usize) {
    buckets.sort_by(|a, b| a.day.cmp(&b.day).then(a.model.cmp(&b.model)));
    while buckets.len() > max.max(1) {
        let oldest = buckets.remove(0);
        let target = buckets
            .iter()
            .position(|b| b.model == oldest.model)
            .unwrap_or(0);
        buckets[target].add(&oldest);
    }
}

/// A thread link `meta` may store: valid ids, not the session itself, title
/// trimmed and clipped like a user title.
fn valid_link(meta: &SessionMeta, link: &SessionLink) -> Option<SessionLink> {
    if validate_id("linked agent id", &link.agent_id).is_err()
        || validate_id("linked session id", &link.session_id).is_err()
        || (link.agent_id == meta.agent_id && link.session_id == meta.session_id)
    {
        return None;
    }
    Some(SessionLink {
        agent_id: link.agent_id.clone(),
        session_id: link.session_id.clone(),
        title: link
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| clip(t, MAX_TITLE_CHARS)),
    })
}

/// Drops entries this store could never have written and keeps one entry per
/// key (the most recently active).
fn sanitize_all(sessions: Vec<SessionMeta>) -> Vec<SessionMeta> {
    let mut out: Vec<SessionMeta> = Vec::with_capacity(sessions.len());
    for mut meta in sessions {
        if validate_id("agent id", &meta.agent_id).is_err()
            || validate_id("session id", &meta.session_id).is_err()
        {
            continue;
        }
        meta.title_override = meta
            .title_override
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| clip(t, MAX_TITLE_CHARS));
        meta.connection_name = clip(&meta.connection_name, MAX_LABEL_CHARS);
        meta.models.truncate(MAX_MODELS);
        meta.agents.truncate(MAX_AGENTS);
        if let Some(usage) = meta.usage.as_mut() {
            usage
                .buckets
                .retain(|b| crate::usage::parse_day(&b.day).is_some());
            fold_usage_buckets(&mut usage.buckets, MAX_USAGE_BUCKETS);
        }
        meta.continues = meta
            .continues
            .take()
            .and_then(|link| valid_link(&meta, &link));
        match out
            .iter_mut()
            .find(|s| s.agent_id == meta.agent_id && s.session_id == meta.session_id)
        {
            Some(existing) if existing.last_active_ms < meta.last_active_ms => *existing = meta,
            Some(_) => {}
            None => out.push(meta),
        }
    }
    out
}

/// Evicts until at most `max_sessions` remain and the compact JSON file fits
/// in `max_bytes`. Order: non-archived sessions, least recently active first;
/// archived sessions only once no non-archived session is left.
fn enforce_caps(
    sessions: &mut Vec<SessionMeta>,
    max_sessions: usize,
    max_bytes: usize,
) -> Result<()> {
    let header = serde_json::to_vec(&StoreFile {
        version: SESSION_META_SCHEMA_VERSION,
        sessions: vec![],
    })
    .map_err(|e| CoreError::Settings(e.to_string()))?
    .len();
    let mut sizes = Vec::with_capacity(sessions.len());
    for meta in sessions.iter() {
        sizes.push(
            serde_json::to_vec(meta)
                .map_err(|e| CoreError::Settings(e.to_string()))?
                .len(),
        );
    }
    let total = |count: usize, sum: usize| header + sum + count.saturating_sub(1);
    let mut count = sessions.len();
    let mut sum: usize = sizes.iter().sum();
    if count <= max_sessions && total(count, sum) <= max_bytes {
        return Ok(());
    }
    let mut order: Vec<usize> = (0..sessions.len()).collect();
    order.sort_by_key(|&i| {
        (
            sessions[i].archived,
            sessions[i].last_active_ms,
            sessions[i].first_seen_ms,
        )
    });
    let mut evict = vec![false; sessions.len()];
    for index in order {
        if count <= max_sessions && total(count, sum) <= max_bytes {
            break;
        }
        evict[index] = true;
        count -= 1;
        sum -= sizes[index];
    }
    let mut position = 0;
    sessions.retain(|_| {
        let keep = !evict[position];
        position += 1;
        keep
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProposalHunk;
    use std::sync::Arc;

    fn store(dir: &tempfile::TempDir) -> SessionMetaStore {
        SessionMetaStore::in_directory(dir.path(), "/work/project")
    }

    fn turn(agent: &str, session: &str, model: &str) -> SessionMetaPatch {
        patch_for_turn_start(agent, session, Some("Agent"), Some(model), Some("high"))
    }

    #[test]
    fn permission_mode_round_trips_by_name_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let mut patch = SessionMetaPatch::new("claude", "s1");
        patch.permission_mode = Some(ThreadPermissionMode::Plan);
        store.upsert_at(patch, 1_000).unwrap();
        let text = fs::read_to_string(store.path()).unwrap();
        assert!(text.contains("\"permissionMode\":\"plan\""), "{text}");
        // A later patch without a mode keeps it; a new mode replaces it.
        store
            .upsert_at(turn("claude", "s1", "opus"), 2_000)
            .unwrap();
        let meta = store.get("claude", "s1").unwrap().unwrap();
        assert_eq!(meta.permission_mode, Some(ThreadPermissionMode::Plan));
        let mut full = SessionMetaPatch::new("claude", "s1");
        full.permission_mode = Some(ThreadPermissionMode::Full);
        store.upsert_at(full, 3_000).unwrap();
        let meta = store.get("claude", "s1").unwrap().unwrap();
        assert_eq!(meta.permission_mode, Some(ThreadPermissionMode::Full));
        // Only the name is stored: no prompt, no agent mode value.
        let text = fs::read_to_string(store.path()).unwrap();
        assert!(text.contains("\"permissionMode\":\"full\""));
        assert!(!text.contains("bypassPermissions"));
        // An unknown name (a newer Span, a hand edit) reads as absent and
        // never fails the file.
        let edited = text.replace("\"permissionMode\":\"full\"", "\"permissionMode\":\"yolo\"");
        fs::write(store.path(), edited).unwrap();
        let meta = store.get("claude", "s1").unwrap().unwrap();
        assert_eq!(meta.permission_mode, None);
        assert_eq!(meta.models.len(), 1);
        let patch: SessionMetaPatch = serde_json::from_str(
            r#"{"agentId":"a","sessionId":"s","permissionMode":"bypassPermissions"}"#,
        )
        .unwrap();
        assert_eq!(patch.permission_mode, None);
    }

    #[test]
    fn empty_store_lists_nothing_and_creates_no_data_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        assert!(store.list().unwrap().is_empty());
        assert!(store.get("a", "s").unwrap().is_none());
        assert!(!store.path().exists());
    }

    #[test]
    fn upsert_creates_then_get_and_list_return_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let created = store
            .upsert_at(turn("claude", "s1", "opus"), 1_000)
            .unwrap();
        assert_eq!(created.first_seen_ms, 1_000);
        assert_eq!(created.last_active_ms, 1_000);
        assert_eq!(created.connection_name, "Agent");
        assert_eq!(created.models.len(), 1);
        assert_eq!(store.get("claude", "s1").unwrap(), Some(created.clone()));
        assert_eq!(store.list().unwrap(), vec![created]);
        // Same session id under another agent is a separate session.
        store.upsert_at(turn("codex", "s1", "gpt"), 2_000).unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].agent_id, "codex", "most recently active first");
    }

    #[test]
    fn model_and_agent_uses_merge_while_counters_are_set() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        store.upsert_at(turn("a", "s", "opus"), 10).unwrap();
        store.upsert_at(turn("a", "s", "opus"), 20).unwrap();
        let mut sonnet = turn("a", "s", "sonnet");
        sonnet.models[0].effort = None;
        store.upsert_at(sonnet, 30).unwrap();
        store
            .upsert_at(patch_for_model_selected("a", "s", "opus", Some("low")), 40)
            .unwrap();
        let meta = store.get("a", "s").unwrap().unwrap();
        let opus = meta.models.iter().find(|m| m.name == "opus").unwrap();
        assert_eq!((opus.turns, opus.used_ms), (2, 40));
        assert_eq!(opus.effort.as_deref(), Some("low"));
        let sonnet = meta.models.iter().find(|m| m.name == "sonnet").unwrap();
        assert_eq!((sonnet.turns, sonnet.effort.as_deref()), (1, None));
        assert_eq!(meta.first_seen_ms, 10);
        assert_eq!(meta.last_active_ms, 40);

        let [lead, _] = patches_for_delegation("a", "s", "codex", "Codex", "c1");
        store.upsert_at(lead.clone(), 50).unwrap();
        store.upsert_at(lead, 60).unwrap();
        let meta = store.get("a", "s").unwrap().unwrap();
        assert_eq!(meta.agents.len(), 1, "agents merge by id");
        assert_eq!(meta.agents[0].role.as_deref(), Some("delegated"));

        let mut stats = FileChangeStats::default();
        stats.add_text_change("a.rs", Some("1\n2\n"), "1\n3\n4\n");
        stats.add_text_change("b.rs", None, "x\n");
        store
            .upsert_at(patch_for_file_stats("a", "s", &stats), 70)
            .unwrap();
        store
            .upsert_at(patch_for_file_stats("a", "s", &stats), 80)
            .unwrap();
        let meta = store.get("a", "s").unwrap().unwrap();
        assert_eq!(
            (meta.files_changed, meta.lines_added, meta.lines_removed),
            (2, 3, 1),
            "counters are set, not added"
        );
        store
            .upsert_at(patch_for_turn_complete("a", "s", "end_turn"), 90)
            .unwrap();
        store
            .upsert_at(SessionMetaPatch::new("a", "s"), 100)
            .unwrap();
        let meta = store.get("a", "s").unwrap().unwrap();
        assert_eq!(meta.stop_reason_last.as_deref(), Some("end_turn"));
        assert_eq!(meta.files_changed, 2, "absent fields keep stored values");
    }

    #[test]
    fn delegation_sets_parent_on_child() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let [_, child] = patches_for_delegation("lead", "ls", "codex", "Codex", "cs");
        let meta = store.upsert_at(child, 5).unwrap();
        assert_eq!(
            meta.parent,
            Some(SessionParent {
                agent_id: "lead".into(),
                session_id: "ls".into()
            })
        );
        assert_eq!(meta.connection_name, "Codex");
    }

    #[test]
    fn set_title_set_archived_delete_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        store.upsert_at(turn("a", "s1", "m"), 10).unwrap();
        let titled = store
            .set_title("a", "s1", Some("  Fix the parser  ".into()))
            .unwrap();
        assert_eq!(titled.title_override.as_deref(), Some("Fix the parser"));
        assert_eq!(titled.last_active_ms, 10, "renaming is not activity");
        let cleared = store.set_title("a", "s1", Some("   ".into())).unwrap();
        assert_eq!(cleared.title_override, None);
        let long = store.set_title("a", "s1", Some("x".repeat(500))).unwrap();
        assert_eq!(
            long.title_override.unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
        assert!(store.set_archived("a", "s1", true).unwrap().archived);
        // Titling an unknown session creates it.
        assert!(store.set_title("a", "s2", Some("New".into())).is_ok());
        assert_eq!(store.list().unwrap().len(), 2);
        assert!(store.delete("a", "s2").unwrap());
        assert!(!store.delete("a", "s2").unwrap());
        store.upsert_at(turn("a", "s3", "m"), 20).unwrap();
        store.upsert_at(turn("b", "s9", "m"), 20).unwrap();
        assert_eq!(store.prune_missing("a", &["s1".into()]).unwrap(), 1);
        let mut left: Vec<_> = store
            .list()
            .unwrap()
            .into_iter()
            .map(|m| m.session_id)
            .collect();
        left.sort();
        assert_eq!(left, vec!["s1", "s9"], "other agents are untouched");
    }

    #[test]
    fn invalid_ids_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        assert!(store.upsert(SessionMetaPatch::new("", "s")).is_err());
        assert!(store.upsert(SessionMetaPatch::new("a", " ")).is_err());
        assert!(store
            .set_title("a", &"s".repeat(MAX_ID_BYTES + 1), None)
            .is_err());
    }

    #[test]
    fn eviction_by_count_drops_least_recent_non_archived_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir).with_limits(3, SESSION_META_MAX_BYTES);
        store.upsert_at(turn("a", "old-archived", "m"), 1).unwrap();
        store.set_archived("a", "old-archived", true).unwrap();
        store.upsert_at(turn("a", "s2", "m"), 2).unwrap();
        store.upsert_at(turn("a", "s3", "m"), 3).unwrap();
        store.upsert_at(turn("a", "s4", "m"), 4).unwrap();
        let ids: Vec<_> = store
            .list()
            .unwrap()
            .into_iter()
            .map(|m| m.session_id)
            .collect();
        assert_eq!(ids, vec!["s4", "s3", "old-archived"]);
    }

    #[test]
    fn eviction_by_size_keeps_the_file_under_the_byte_cap() {
        let dir = tempfile::tempdir().unwrap();
        let cap = 4 * 1024;
        let store = store(&dir).with_limits(SESSION_META_MAX_SESSIONS, cap);
        for i in 0..200u64 {
            store
                .upsert_at(turn("agent", &format!("session-{i}"), "model"), i)
                .unwrap();
            let size = fs::metadata(store.path()).unwrap().len() as usize;
            assert!(size <= cap, "file is {size} bytes after {i}");
        }
        let listed = store.list().unwrap();
        assert!(listed.len() < 200 && !listed.is_empty());
        assert_eq!(listed[0].session_id, "session-199");
    }

    #[test]
    fn default_caps_hold_at_two_thousand_sessions() {
        let mut sessions: Vec<_> = (0..2_100u64)
            .map(|i| new_meta("a", &format!("s{i}"), i))
            .collect();
        enforce_caps(
            &mut sessions,
            SESSION_META_MAX_SESSIONS,
            SESSION_META_MAX_BYTES,
        )
        .unwrap();
        assert_eq!(sessions.len(), SESSION_META_MAX_SESSIONS);
        assert!(sessions.iter().all(|s| s.last_active_ms >= 100));
        let bytes = serde_json::to_vec(&StoreFile {
            version: 1,
            sessions,
        })
        .unwrap();
        assert!(bytes.len() <= SESSION_META_MAX_BYTES);
    }

    #[test]
    fn corrupt_file_is_moved_aside_and_store_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        fs::write(store.path(), b"{not json").unwrap();
        assert!(store.list().unwrap().is_empty());
        let aside = dir.path().join(format!(
            "{}.corrupt",
            store.path().file_name().unwrap().to_string_lossy()
        ));
        assert_eq!(fs::read(&aside).unwrap(), b"{not json");
        assert!(!store.path().exists());
        // A second corrupt file never overwrites the first copy.
        fs::write(store.path(), br#"{"version":1,"sessions":"nope"}"#).unwrap();
        store.upsert_at(turn("a", "s", "m"), 1).unwrap();
        assert_eq!(fs::read(&aside).unwrap(), b"{not json");
        let second = dir.path().join(format!(
            "{}.1.corrupt",
            store.path().file_name().unwrap().to_string_lossy()
        ));
        assert!(second.exists());
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn newer_schema_is_refused_and_left_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        let newer = br#"{"version":99,"sessions":[]}"#;
        fs::write(store.path(), newer).unwrap();
        assert!(store.list().is_err());
        assert!(store.upsert(turn("a", "s", "m")).is_err());
        assert_eq!(fs::read(store.path()).unwrap(), newer);
    }

    #[test]
    fn oversized_file_is_treated_as_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        fs::write(store.path(), vec![b' '; READ_LIMIT_BYTES + 10]).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(!store.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn failed_atomic_write_leaves_the_old_file_intact() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        let store = SessionMetaStore::in_directory(&data, "/work/project");
        store.upsert_at(turn("a", "s1", "m"), 1).unwrap();
        let before = fs::read(store.path()).unwrap();
        // Keep the lock file writable, forbid creating the temp file.
        fs::set_permissions(&data, fs::Permissions::from_mode(0o555)).unwrap();
        let result = store.upsert_at(turn("a", "s2", "m"), 2);
        fs::set_permissions(&data, fs::Permissions::from_mode(0o755)).unwrap();
        if nix_is_root() {
            return; // root ignores directory permissions
        }
        assert!(result.is_err());
        assert_eq!(fs::read(store.path()).unwrap(), before);
        assert_eq!(store.list().unwrap().len(), 1);
        let stray = fs::read_dir(&data)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".span-"))
            .count();
        assert_eq!(stray, 0, "no temp file left behind");
    }

    #[cfg(unix)]
    fn nix_is_root() -> bool {
        std::env::var("USER").map(|u| u == "root").unwrap_or(false)
    }

    #[test]
    fn hash_is_stable_and_file_name_has_no_path() {
        assert_eq!(workspace_hash(""), "cbf29ce484222325");
        assert_eq!(workspace_hash("a"), "af63dc4c8601ec8c");
        let hash = workspace_hash("/work/project");
        assert_eq!(hash.len(), 16);
        assert_eq!(hash, workspace_hash("/work/project/"));
        assert_eq!(hash, workspace_hash("/work//project"));
        assert_ne!(hash, workspace_hash("/work/Project"), "unix keeps case");
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetaStore::in_directory(dir.path(), "/work/project");
        let name = store
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(name, format!("{hash}.json"));
        assert!(!name.contains("work") && !name.contains("project"));
    }

    #[test]
    fn windows_roots_canonicalise_to_one_key() {
        let key = workspace_key(r"C:\Users\Dev\Project");
        assert_eq!(key, "c:/users/dev/project");
        for variant in [
            r"c:\users\dev\project\",
            r"\\?\C:\Users\Dev\Project",
            "C:/Users/Dev/Project",
            r"C:\Users\\Dev\Project",
        ] {
            assert_eq!(workspace_key(variant), key, "{variant}");
            assert_eq!(
                workspace_hash(variant),
                workspace_hash(r"C:\Users\Dev\Project")
            );
        }
        assert_eq!(workspace_key(r"C:\"), "c:/");
        assert_eq!(workspace_key("/"), "/");
        let unc = workspace_key(r"\\Server\Share\Repo");
        assert_eq!(unc, "//server/share/repo");
        assert_eq!(workspace_key(r"\\?\UNC\server\share\repo\"), unc);
        // A backslash is an ordinary character in a unix path.
        assert_eq!(workspace_key(r"/work/a\b"), r"/work/a\b");
        assert_ne!(workspace_key(r"/work/a\b"), workspace_key("/work/a/b"));
    }

    #[test]
    fn concurrent_updates_from_two_threads_are_all_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().to_path_buf());
        let threads: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|name| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    let store = SessionMetaStore::in_directory(path.as_path(), "/work/project");
                    for i in 0..25u64 {
                        store
                            .upsert_at(turn("a", &format!("{name}-{i}"), "m"), i)
                            .unwrap();
                        store.upsert_at(turn("a", "shared", name), i).unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let store = SessionMetaStore::in_directory(path.as_path(), "/work/project");
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 51);
        let shared = store.get("a", "shared").unwrap().unwrap();
        let turns: Vec<_> = shared
            .models
            .iter()
            .map(|m| (m.name.as_str(), m.turns))
            .collect();
        assert!(
            turns.contains(&("one", 25)) && turns.contains(&("two", 25)),
            "{turns:?}"
        );
    }

    #[test]
    fn file_stats_from_proposals_count_distinct_paths() {
        let proposal = EditProposal {
            id: "p".into(),
            path: "src/lib.rs".into(),
            base_revision: 0,
            hunks: vec![
                ProposalHunk {
                    id: "h1".into(),
                    from: 0,
                    to: 2,
                    before: "a\n".into(),
                    after: "b\nc\n".into(),
                },
                ProposalHunk {
                    id: "h2".into(),
                    from: 4,
                    to: 6,
                    before: "x\ny\n".into(),
                    after: "".into(),
                },
            ],
        };
        let mut stats = FileChangeStats::default();
        stats.add_proposal(&proposal);
        assert_eq!(stats.files_changed(), 1);
        assert_eq!((stats.lines_added, stats.lines_removed), (2, 3));
    }

    #[test]
    fn stored_file_contains_no_prompt_text_fields() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(&dir);
        store.upsert_at(turn("a", "s", "m"), 1).unwrap();
        let text = fs::read_to_string(store.path()).unwrap();
        assert!(text.starts_with(r#"{"version":1,"sessions":["#));
        for forbidden in ["prompt", "content", "text"] {
            assert!(!text.contains(forbidden), "{forbidden} in {text}");
        }
    }
}
