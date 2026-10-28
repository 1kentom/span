//! Workspace trust: decided once when a folder is opened and kept outside the settings
//! file, in `~/.config/span/trusted-workspaces.json` beside `recent-projects.json` and
//! `session.json`.
//!
//! ```json
//! { "version": 1, "folders": { "/abs/folder": { "decision": "trusted", "decidedAt": "2026-01-02T03:04:05Z" } } }
//! ```
//!
//! - Keys are canonical absolute paths in the normalised spelling of `paths` (no verbatim
//!   prefix, upper case drive letter), compared case insensitively for Windows style paths.
//! - A `trusted` entry covers the folder and everything below it (VS Code semantics). A
//!   `restricted` entry covers exactly its folder, and the deepest matching entry wins, so an
//!   explicit `restricted` on a subfolder beats a trusted parent.
//! - Reading is tolerant: a missing file means no decisions; a corrupt one is renamed to
//!   `.corrupt-<unix seconds>` once and a fresh store starts. Unknown fields and unknown
//!   decisions written by a newer build are preserved on rewrite.
//! - Writes are atomic (temp file and rename) under an advisory lock, and the store keeps at
//!   most [`MAX_ENTRIES`] entries (the oldest decisions are dropped first).

use super::intel::{workspace_build_files, workspace_trust_reason};
use super::paths::{is_inside_text, normalize_path, normalize_path_text};
use super::{lock, LanguageServers, Op, ServerId, PROJECT_CODE_SERVERS};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_specta::Event;

pub const MAX_ENTRIES: usize = 500;
const MAX_BYTES: u64 = 1024 * 1024;
const FILE_NAME: &str = "trusted-workspaces.json";

/// What the user chose for a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TrustChoice {
    Trusted,
    Restricted,
}

/// Where a decision is stored: the open folder, or its parent (covering its siblings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TrustScope {
    Folder,
    Parent,
}

/// The decision for the current workspace, including "not decided yet".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceTrustDecision {
    Trusted,
    Restricted,
    Undecided,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTrustStateDto {
    pub decision: WorkspaceTrustDecision,
    /// The decision comes from a parent folder (or the global override), not from this folder.
    pub inherited: bool,
    /// The folder that decided. Absent when undecided or when the global override applies.
    pub source: Option<String>,
    /// Undecided and the folder holds files that make language servers run project code.
    pub needs_prompt: bool,
    pub reason: Option<String>,
    pub build_files: Vec<String>,
}

/// A decision was stored for `root` (the open workspace folder).
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTrustChanged {
    pub root: String,
    pub decision: WorkspaceTrustDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustEntry {
    /// Kept as text so a decision a newer build invents is preserved, and read as undecided.
    pub decision: String,
    pub decided_at: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl TrustEntry {
    fn new(choice: TrustChoice, decided_at: String) -> Self {
        Self {
            decision: match choice {
                TrustChoice::Trusted => "trusted",
                TrustChoice::Restricted => "restricted",
            }
            .into(),
            decided_at,
            extra: BTreeMap::new(),
        }
    }

    pub fn choice(&self) -> Option<TrustChoice> {
        match self.decision.as_str() {
            "trusted" => Some(TrustChoice::Trusted),
            "restricted" => Some(TrustChoice::Restricted),
            _ => None,
        }
    }
}

pub type Entries = BTreeMap<String, TrustEntry>;

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    #[serde(default)]
    folders: Entries,
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

/// The outcome of looking a folder up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    pub choice: Option<TrustChoice>,
    pub inherited: bool,
    pub source: Option<String>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Canonical (when the folder exists) and normalised key text, without a trailing separator.
pub fn key_for(path: &Path) -> String {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = normalize_path(&canonical).to_string_lossy().into_owned();
    trim_key(&normalize_path_text(&text))
}

fn trim_key(text: &str) -> String {
    let trimmed = text.trim_end_matches(['/', '\\']);
    // Keep a filesystem root (`/`, `C:\`) readable.
    if trimmed.is_empty() {
        text.chars().take(1).collect()
    } else if trimmed.len() == 2 && trimmed.as_bytes()[1] == b':' {
        format!("{trimmed}\\")
    } else {
        trimmed.to_owned()
    }
}

/// Absolute on any OS, judged from the text: `/x`, `C:\x`, `C:/x` or `\\server\share`.
fn is_absolute_text(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with('/')
        || path.starts_with("\\\\")
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'\\' | b'/'))
}

fn windows_style(text: &str) -> bool {
    let b = text.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || text.starts_with("\\\\")
}

/// Comparison form: Windows style paths ignore case.
fn fold(key: &str) -> String {
    if windows_style(key) {
        key.to_lowercase()
    } else {
        key.to_owned()
    }
}

fn find_key(entries: &Entries, key: &str) -> Option<String> {
    let want = fold(key);
    entries.keys().find(|k| fold(k) == want).cloned()
}

/// Looks `folder` (a key from [`key_for`]) up: the deepest entry that is the folder itself
/// (any decision) or an ancestor that trusts it.
pub fn resolve(entries: &Entries, folder: &str) -> Resolution {
    let mut best: Option<(&String, TrustChoice)> = None;
    for (key, entry) in entries {
        let Some(choice) = entry.choice() else {
            continue;
        };
        let exact = fold(key) == fold(folder);
        let covers = exact || (choice == TrustChoice::Trusted && is_inside_text(key, folder));
        if covers && best.is_none_or(|(b, _)| key.len() > b.len()) {
            best = Some((key, choice));
        }
    }
    match best {
        Some((key, choice)) => Resolution {
            choice: Some(choice),
            inherited: fold(key) != fold(folder),
            source: Some(key.clone()),
        },
        None => Resolution {
            choice: None,
            inherited: false,
            source: None,
        },
    }
}

/// The folder a "trust everything in the parent" decision is stored on. Refused for a
/// filesystem root, the user's home directory itself, or fewer than two path components.
pub fn parent_for(folder: &Path, home: Option<&Path>) -> Result<PathBuf, String> {
    let key = key_for(folder);
    let parent = Path::new(&key)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "This folder has no parent folder to trust".to_string())?;
    let parent_key = key_for(&parent);
    let components = Path::new(&parent_key)
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    let is_home = home.is_some_and(|h| fold(&key_for(h)) == fold(&parent_key));
    if components < 2 || is_home {
        return Err(
            "The parent folder is too broad to trust as a whole. Trust this folder instead."
                .to_string(),
        );
    }
    Ok(PathBuf::from(parent_key))
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/// `1970-01-01T00:00:00Z` style text for `secs` since the Unix epoch (UTC).
pub fn rfc3339_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct TrustStore {
    path: PathBuf,
}

impl TrustStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `<home>/.config/span/trusted-workspaces.json`, the directory of `session.json`.
    pub fn for_current_user() -> Option<Self> {
        Some(Self::new(home_dir()?.join(".config/span").join(FILE_NAME)))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Every stored decision. Never fails: an unreadable store means no decisions.
    pub fn load(&self) -> Entries {
        let _lock = self.lock().ok();
        self.read().folders
    }

    /// Stores `choice` for `folder`. Returns whether anything changed (false when the same
    /// decision is already stored, which keeps the original `decidedAt`).
    pub fn decide(&self, folder: &Path, choice: TrustChoice) -> Result<bool, String> {
        self.decide_at(folder, choice, now_secs())
    }

    fn decide_at(&self, folder: &Path, choice: TrustChoice, secs: u64) -> Result<bool, String> {
        let _lock = self.lock()?;
        let mut file = self.read();
        let key = key_for(folder);
        let existing = find_key(&file.folders, &key);
        if let Some(entry) = existing.as_ref().and_then(|k| file.folders.get(k)) {
            if entry.choice() == Some(choice) {
                return Ok(false);
            }
        }
        let slot = existing.unwrap_or_else(|| key.clone());
        let extra = file
            .folders
            .get(&slot)
            .map(|e| e.extra.clone())
            .unwrap_or_default();
        let mut entry = TrustEntry::new(choice, rfc3339_utc(secs));
        entry.extra = extra;
        file.folders.insert(slot.clone(), entry);
        cap(&mut file.folders, &slot);
        self.write(&file)?;
        Ok(true)
    }

    /// Imports the roots a preview build kept in `languageServers.trustedWorkspaces` as
    /// `trusted`. A folder that already has any decision keeps it, so running this again
    /// (or after the user restricted a folder) changes nothing. Returns how many were added.
    pub fn import_legacy(&self, roots: &[String]) -> Result<usize, String> {
        let candidates: Vec<String> = roots
            .iter()
            .filter(|r| {
                let r = r.trim();
                !r.is_empty()
                    && r.len() <= 4096
                    && !r.chars().any(char::is_control)
                    && is_absolute_text(r)
            })
            .map(|r| key_for(Path::new(r.trim())))
            .collect();
        if candidates.is_empty() {
            return Ok(0);
        }
        let _lock = self.lock()?;
        let mut file = self.read();
        let at = rfc3339_utc(now_secs());
        let mut added = 0;
        for key in candidates {
            if find_key(&file.folders, &key).is_some() {
                continue;
            }
            file.folders.insert(
                key.clone(),
                TrustEntry::new(TrustChoice::Trusted, at.clone()),
            );
            cap(&mut file.folders, &key);
            added += 1;
        }
        if added > 0 {
            self.write(&file)?;
        }
        Ok(added)
    }

    fn lock(&self) -> Result<File, String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "Invalid trust storage path".to_string())?;
        fs::create_dir_all(parent).map_err(|e| format!("Create trust profile: {e}"))?;
        let lock_path = self.path.with_extension("json.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|e| format!("Open trust lock: {e}"))?;
        file.lock().map_err(|e| format!("Lock trust store: {e}"))?;
        Ok(file)
    }

    fn read(&self) -> StoreFile {
        let empty = || StoreFile {
            version: 1,
            folders: Entries::new(),
            extra: BTreeMap::new(),
        };
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(_) => return empty(),
        };
        let mut text = String::new();
        let read = file.take(MAX_BYTES + 1).read_to_string(&mut text);
        let parsed = match read {
            Ok(_) if text.len() as u64 <= MAX_BYTES => {
                serde_json::from_str::<StoreFile>(&text).ok()
            }
            _ => None,
        };
        match parsed {
            Some(mut parsed) => {
                // Keys a hand edit left in another spelling are normalised on the way in.
                let mut normalised = Entries::new();
                for (key, entry) in std::mem::take(&mut parsed.folders) {
                    let key = trim_key(&normalize_path_text(&key));
                    if find_key(&normalised, &key).is_none() {
                        normalised.insert(key, entry);
                    }
                }
                parsed.folders = normalised;
                parsed
            }
            None => {
                self.quarantine();
                empty()
            }
        }
    }

    /// Moves a corrupt store aside so the next write starts a fresh one.
    fn quarantine(&self) {
        let name = format!("{FILE_NAME}.corrupt-{}", now_secs());
        let target = self.path.with_file_name(name);
        let _ = fs::rename(&self.path, target);
    }

    fn write(&self, file: &StoreFile) -> Result<(), String> {
        let mut out = StoreFile {
            version: 1,
            folders: file.folders.clone(),
            extra: file.extra.clone(),
        };
        out.extra.remove("version");
        out.extra.remove("folders");
        let mut text =
            serde_json::to_string_pretty(&out).map_err(|e| format!("Write trust store: {e}"))?;
        text.push('\n');
        span_core::atomic_write(&self.path, text.as_bytes())
            .map_err(|e| format!("Write trust store: {e}"))
    }
}

/// Drops the oldest decisions until at most [`MAX_ENTRIES`] remain, never `keep`.
fn cap(entries: &mut Entries, keep: &str) {
    while entries.len() > MAX_ENTRIES {
        let oldest = entries
            .iter()
            .filter(|(k, _)| k.as_str() != keep)
            .min_by(|a, b| (&a.1.decided_at, a.0).cmp(&(&b.1.decided_at, b.0)))
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => {
                entries.remove(&k);
            }
            None => break,
        }
    }
}

/// Is `root` covered by the global override or by a trusted entry?
pub fn is_trusted(global: bool, entries: &Entries, root: &Path) -> bool {
    global || resolve(entries, &key_for(root)).choice == Some(TrustChoice::Trusted)
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

impl LanguageServers {
    /// Use `store` for the decisions from now on (loads them immediately).
    pub fn use_trust_store(&self, store: Arc<TrustStore>) {
        let entries = store.load();
        let mut t = self.trust.write().unwrap_or_else(|e| e.into_inner());
        t.entries = entries;
        t.store = Some(store);
    }

    pub fn has_trust_store(&self) -> bool {
        self.trust
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .store
            .is_some()
    }

    fn reload_trust(&self) {
        let store = self
            .trust
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .store
            .clone();
        if let Some(store) = store {
            let entries = store.load();
            self.trust
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .entries = entries;
        }
    }

    /// Imports `languageServers.trustedWorkspaces` of a preview build, once. Returns whether
    /// the setting held anything, so the caller can clean it out of the settings file.
    pub fn import_legacy_trust(&self, legacy: &[String]) -> bool {
        if legacy.is_empty() {
            return false;
        }
        let store = self
            .trust
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .store
            .clone();
        let Some(store) = store else {
            return false;
        };
        if let Err(error) = store.import_legacy(legacy) {
            eprintln!("Could not import workspace trust: {error}");
            return false;
        }
        self.reload_trust();
        true
    }

    /// The trust state of the open workspace, with what a prompt needs to know.
    pub fn trust_state(&self) -> WorkspaceTrustStateDto {
        let Some(root) = self.workspace_root() else {
            return WorkspaceTrustStateDto {
                decision: WorkspaceTrustDecision::Undecided,
                inherited: false,
                source: None,
                needs_prompt: false,
                reason: None,
                build_files: vec![],
            };
        };
        let (everything, resolution) = {
            let t = self.trust.read().unwrap_or_else(|e| e.into_inner());
            (t.everything, resolve(&t.entries, &key_for(&root)))
        };
        let build_files: Vec<String> = workspace_build_files(&root)
            .into_iter()
            .map(str::to_owned)
            .collect();
        let (decision, inherited, source) = if everything {
            (WorkspaceTrustDecision::Trusted, true, None)
        } else {
            match resolution.choice {
                Some(TrustChoice::Trusted) => (
                    WorkspaceTrustDecision::Trusted,
                    resolution.inherited,
                    resolution.source,
                ),
                Some(TrustChoice::Restricted) => (
                    WorkspaceTrustDecision::Restricted,
                    resolution.inherited,
                    resolution.source,
                ),
                None => (WorkspaceTrustDecision::Undecided, false, None),
            }
        };
        let undecided = decision == WorkspaceTrustDecision::Undecided;
        WorkspaceTrustStateDto {
            decision,
            inherited,
            source,
            needs_prompt: undecided && !build_files.is_empty(),
            reason: workspace_trust_reason(&root),
            build_files,
        }
    }

    /// Stores a decision for the open workspace (or its parent) and restarts the running
    /// servers that execute project code when the trust of one of their roots changed.
    /// Idempotent. Returns the workspace root and the new state.
    pub fn decide_trust(
        &self,
        choice: TrustChoice,
        scope: TrustScope,
    ) -> Result<(String, WorkspaceTrustStateDto), String> {
        let root = self
            .workspace_root()
            .ok_or_else(|| "open a folder first".to_string())?;
        let store = self
            .trust
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .store
            .clone()
            .ok_or_else(|| "Workspace trust cannot be saved on this profile".to_string())?;
        let target = match scope {
            TrustScope::Folder => root.clone(),
            TrustScope::Parent => parent_for(&root, home_dir().as_deref())?,
        };
        let running = self.running_project_roots();
        let before: Vec<bool> = running.iter().map(|(_, r)| self.trusted(r)).collect();
        store.decide(&target, choice)?;
        self.reload_trust();
        let mut restart: Vec<ServerId> = Vec::new();
        for ((server, root), was) in running.iter().zip(before) {
            if self.trusted(root) != was && !restart.contains(server) {
                restart.push(*server);
            }
        }
        if !restart.is_empty() {
            let mut st = lock(&self.state);
            for server in restart {
                if st.settings.disabled.contains(&server) {
                    continue;
                }
                Self::bump_epoch(&mut st, server);
                self.push(&mut st, Op::Restart { server });
            }
        }
        Ok((root.to_string_lossy().into_owned(), self.trust_state()))
    }

    /// Roots of the build executing servers that are running or have open documents.
    fn running_project_roots(&self) -> Vec<(ServerId, PathBuf)> {
        let st = lock(&self.state);
        let mut keys: Vec<(ServerId, PathBuf)> = st
            .states
            .keys()
            .filter(|(s, _)| PROJECT_CODE_SERVERS.contains(s))
            .cloned()
            .collect();
        keys.extend(
            st.docs
                .values()
                .filter(|d| PROJECT_CODE_SERVERS.contains(&d.r.server))
                .map(|d| (d.r.server, d.r.root.clone())),
        );
        let mut unique: Vec<(ServerId, PathBuf)> = Vec::new();
        for key in keys {
            if !unique.contains(&key) {
                unique.push(key);
            }
        }
        unique
    }
}

#[cfg(test)]
mod tests;
