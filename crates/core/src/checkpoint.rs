//! Per-turn checkpoints of the working tree (ADR 0013).
//!
//! A checkpoint is a commit on a hidden ref under `refs/span/checkpoints/`,
//! built from a private index, so the user's index, branches, stash and HEAD
//! never change. The logic here is pure apart from the working-tree writes of
//! revert and restore; Git plumbing sits behind [`CheckpointGit`] so tests run
//! it against real temporary repositories.
//!
//! Every revert or restore first captures a "before restore" snapshot and,
//! once the files are written, an "after" snapshot whose parent is the first.
//! Undo writes the "before" content back, path by path, only where the file
//! still holds what the restore wrote.
use crate::{CancellationToken, CoreError, GitService, ProposalHunk, Result};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

/// Turns kept per session; older turns lose their refs.
pub const CHECKPOINT_KEEP_TURNS: usize = 50;
/// Restore and revert snapshots kept per session (each one is an undo point).
pub const CHECKPOINT_KEEP_RESTORES: usize = 20;
/// More files than this and the workspace is not checkpointed.
pub const CHECKPOINT_MAX_FILES: usize = 20_000;
/// Larger files are left out of snapshots and never written by a restore.
pub const CHECKPOINT_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// More bytes than this in total and the workspace is not checkpointed.
pub const CHECKPOINT_MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// Files larger than this are listed without line hunks.
const MAX_DIFF_TEXT: usize = 1024 * 1024;
const REF_ROOT: &str = "refs/span/checkpoints";

/// Where a repository and the opened workspace sit. `prefix` is the
/// workspace folder relative to the repository root, empty or ending in `/`.
#[derive(Debug, Clone)]
pub(crate) struct CpRepo {
    pub root: PathBuf,
    pub prefix: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CpEntry {
    pub mode: String,
    pub oid: String,
    pub path: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CpRef {
    pub name: String,
    pub commit: String,
    pub tree: String,
    pub parent: Option<String>,
    pub time: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct CpDiff {
    pub old_oid: Option<String>,
    pub new_oid: Option<String>,
    #[allow(dead_code)]
    pub old_mode: String,
    pub new_mode: String,
    pub path: String,
}

/// The Git plumbing checkpoints need. Implemented by [`GitService`] on the
/// shared guarded runner; nothing here runs hooks, filters or helpers.
#[allow(async_fn_in_trait)]
pub(crate) trait CheckpointGit {
    async fn repo(&self, token: &CancellationToken) -> Result<Option<CpRepo>>;
    async fn list_files(&self, repo: &CpRepo, token: &CancellationToken) -> Result<Vec<String>>;
    async fn hash_files(
        &self,
        repo: &CpRepo,
        paths: &[String],
        token: &CancellationToken,
    ) -> Result<Vec<String>>;
    async fn write_tree(
        &self,
        repo: &CpRepo,
        entries: &[CpEntry],
        token: &CancellationToken,
    ) -> Result<String>;
    async fn commit_tree(
        &self,
        repo: &CpRepo,
        tree: &str,
        message: &str,
        parent: Option<&str>,
        token: &CancellationToken,
    ) -> Result<String>;
    async fn update_refs(
        &self,
        repo: &CpRepo,
        updates: &[(String, Option<String>)],
        token: &CancellationToken,
    ) -> Result<()>;
    async fn list_refs(
        &self,
        repo: &CpRepo,
        prefix: &str,
        token: &CancellationToken,
    ) -> Result<Vec<CpRef>>;
    async fn diff_trees(
        &self,
        repo: &CpRepo,
        from: &str,
        to: &str,
        token: &CancellationToken,
    ) -> Result<Vec<CpDiff>>;
    async fn read_blobs(
        &self,
        repo: &CpRepo,
        oids: &[String],
        token: &CancellationToken,
    ) -> Result<HashMap<String, Vec<u8>>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckpointPhase {
    /// Before the prompt is sent.
    Start,
    /// After the turn completes.
    End,
}

impl CheckpointPhase {
    fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::End => "end",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CaptureOutcome {
    #[serde(rename_all = "camelCase")]
    Captured {
        commit: String,
        files: u32,
        /// Files left out because they exceed the per-file cap.
        skipped: Vec<String>,
        /// The same state was already checkpointed, so its commit was reused.
        reused: bool,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatus {
    pub available: bool,
    /// Why checkpoints are off (for example, not a Git repository).
    pub reason: Option<String>,
    /// The folder is not in a Git repository, so "Enable checkpoints" (git init) may be offered.
    pub can_init: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointTurn {
    pub turn: u32,
    /// Unix seconds of the newest snapshot of this turn.
    pub captured_at: i64,
    pub has_start: bool,
    pub has_end: bool,
    /// Files that differ between the turn's start and end; 0 while running.
    pub changed_files: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckpointFileKind {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFileChange {
    /// Relative to the workspace folder.
    pub path: String,
    pub kind: CheckpointFileKind,
    pub additions: u32,
    pub deletions: u32,
    /// Binary or too large for line hunks; only whole-file revert applies.
    pub binary: bool,
    /// Line hunks in the pre-turn file's UTF-16 coordinates, as in edit proposals.
    pub hunks: Vec<ProposalHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointChanges {
    pub session_id: String,
    /// `None` for all turns of the session.
    pub turn: Option<u32>,
    /// Identifies the two snapshots compared; pass it back to revert.
    pub revision: Option<String>,
    pub files: Vec<CheckpointFileChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointHunkRef {
    pub path: String,
    pub hunk_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointConflict {
    pub path: String,
    pub hunk_id: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRevertReport {
    pub reverted: Vec<CheckpointHunkRef>,
    pub reverted_files: Vec<String>,
    pub conflicts: Vec<CheckpointConflict>,
    /// Pass to `undo_restore`; `None` when nothing was written.
    pub undo_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRestoreReport {
    pub restored: Vec<String>,
    /// Left alone: symlinks, files over the size cap, or (on undo) files changed since.
    pub skipped: Vec<CheckpointConflict>,
    /// Pass to `undo_restore`; `None` when nothing was written.
    pub undo_id: Option<String>,
}

/// Checkpoint operations for one workspace on the shared Git runner.
#[derive(Clone)]
pub struct Checkpoints {
    git: GitService,
}

impl Checkpoints {
    pub fn new(git: GitService) -> Self {
        Self { git }
    }

    pub async fn status(&self, token: CancellationToken) -> CheckpointStatus {
        status(&self.git, &token).await
    }
    pub async fn next_turn(&self, session: &str, token: CancellationToken) -> Result<u32> {
        let repo = need_repo(&self.git, &token).await?;
        next_turn(&self.git, &repo, session, &token).await
    }
    pub async fn capture(
        &self,
        session: &str,
        turn: u32,
        phase: CheckpointPhase,
        token: CancellationToken,
    ) -> Result<CaptureOutcome> {
        capture(&self.git, session, turn, phase, &token).await
    }
    /// Point a turn's snapshot at an existing one (a start right after the previous end).
    pub async fn alias(
        &self,
        session: &str,
        turn: u32,
        phase: CheckpointPhase,
        from_turn: u32,
        from_phase: CheckpointPhase,
        token: CancellationToken,
    ) -> Result<bool> {
        alias(
            &self.git, session, turn, phase, from_turn, from_phase, &token,
        )
        .await
    }
    /// Drop one snapshot (a start whose prompt never went out).
    pub async fn forget(
        &self,
        session: &str,
        turn: u32,
        phase: CheckpointPhase,
        token: CancellationToken,
    ) -> Result<()> {
        let repo = need_repo(&self.git, &token).await?;
        let name = turn_ref(session, turn, phase);
        self.git.update_refs(&repo, &[(name, None)], &token).await
    }
    pub async fn list(
        &self,
        session: &str,
        token: CancellationToken,
    ) -> Result<Vec<CheckpointTurn>> {
        list(&self.git, session, &token).await
    }
    pub async fn changes(
        &self,
        session: &str,
        turn: Option<u32>,
        token: CancellationToken,
    ) -> Result<CheckpointChanges> {
        changes(&self.git, session, turn, &token).await
    }
    pub async fn revert_hunks(
        &self,
        session: &str,
        revision: &str,
        hunks: Vec<CheckpointHunkRef>,
        token: CancellationToken,
    ) -> Result<CheckpointRevertReport> {
        revert(
            &self.git,
            session,
            revision,
            Selection::Hunks(hunks),
            &token,
        )
        .await
    }
    pub async fn revert_files(
        &self,
        session: &str,
        revision: &str,
        paths: Vec<String>,
        token: CancellationToken,
    ) -> Result<CheckpointRevertReport> {
        revert(
            &self.git,
            session,
            revision,
            Selection::Files(paths),
            &token,
        )
        .await
    }
    pub async fn restore(
        &self,
        session: &str,
        turn: u32,
        token: CancellationToken,
    ) -> Result<CheckpointRestoreReport> {
        restore(&self.git, session, turn, &token).await
    }
    pub async fn undo_restore(
        &self,
        session: &str,
        undo_id: &str,
        token: CancellationToken,
    ) -> Result<CheckpointRestoreReport> {
        undo_restore(&self.git, session, undo_id, &token).await
    }
    pub async fn prune(&self, session: &str, token: CancellationToken) -> Result<()> {
        let repo = need_repo(&self.git, &token).await?;
        prune(&self.git, &repo, session, CHECKPOINT_KEEP_TURNS, &token).await
    }
    pub async fn delete_session(&self, session: &str, token: CancellationToken) -> Result<()> {
        delete_session(&self.git, session, &token).await
    }
}

fn error(message: impl Into<String>) -> CoreError {
    CoreError::Git(message.into())
}

const NOT_A_REPO: &str = "This folder is not a Git repository, so Span cannot keep checkpoints.";

async fn need_repo<G: CheckpointGit>(git: &G, token: &CancellationToken) -> Result<CpRepo> {
    git.repo(token).await?.ok_or_else(|| error(NOT_A_REPO))
}

pub(crate) async fn status<G: CheckpointGit>(
    git: &G,
    token: &CancellationToken,
) -> CheckpointStatus {
    match git.repo(token).await {
        Ok(Some(_)) => CheckpointStatus {
            available: true,
            reason: None,
            can_init: false,
        },
        Ok(None) => CheckpointStatus {
            available: false,
            reason: Some(NOT_A_REPO.into()),
            can_init: true,
        },
        Err(error) => CheckpointStatus {
            available: false,
            reason: Some(error.to_string()),
            can_init: false,
        },
    }
}

/// A ref-safe, stable name for a session id.
pub(crate) fn session_component(session: &str) -> String {
    let plain = !session.is_empty()
        && session.len() <= 100
        && !session.starts_with('-')
        && session
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if plain {
        return session.to_owned();
    }
    // FNV-1a keeps long or unusual ids to one short, valid component.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in session.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("h{hash:016x}")
}

fn session_prefix(session: &str) -> String {
    format!("{REF_ROOT}/{}/", session_component(session))
}

fn turn_ref(session: &str, turn: u32, phase: CheckpointPhase) -> String {
    format!(
        "{}turns/{turn:06}/{}",
        session_prefix(session),
        phase.name()
    )
}

fn restore_ref(session: &str, seq: u32) -> String {
    format!("{}restores/{seq:06}", session_prefix(session))
}

fn message(session: &str, label: &str) -> String {
    format!("span checkpoint {} {label}\n", session_component(session))
}

#[derive(Default)]
struct SessionRefs {
    turns: std::collections::BTreeMap<u32, (Option<CpRef>, Option<CpRef>)>,
    restores: std::collections::BTreeMap<u32, CpRef>,
}

impl SessionRefs {
    fn all_commits(&self) -> BTreeSet<&str> {
        let mut set = BTreeSet::new();
        for (start, end) in self.turns.values() {
            for item in [start, end].into_iter().flatten() {
                set.insert(item.commit.as_str());
            }
        }
        set
    }
    fn latest(&self) -> Option<&CpRef> {
        let mut best: Option<&CpRef> = None;
        for (start, end) in self.turns.values() {
            for item in [start, end].into_iter().flatten() {
                best = Some(item);
            }
        }
        best
    }
    /// The snapshot a turn started from: its start, else the previous end.
    fn base(&self, turn: u32) -> Option<&CpRef> {
        if let Some((Some(start), _)) = self.turns.get(&turn) {
            return Some(start);
        }
        self.turns
            .range(..turn)
            .rev()
            .find_map(|(_, (_, end))| end.as_ref())
    }
}

async fn session_refs<G: CheckpointGit>(
    git: &G,
    repo: &CpRepo,
    session: &str,
    token: &CancellationToken,
) -> Result<SessionRefs> {
    let prefix = session_prefix(session);
    let mut refs = SessionRefs::default();
    for item in git.list_refs(repo, &prefix, token).await? {
        let Some(rest) = item.name.strip_prefix(&prefix) else {
            continue;
        };
        let parts: Vec<&str> = rest.split('/').collect();
        match parts.as_slice() {
            ["turns", turn, phase] => {
                let Ok(turn) = turn.parse::<u32>() else {
                    continue;
                };
                let slot = refs.turns.entry(turn).or_default();
                match *phase {
                    "start" => slot.0 = Some(item),
                    "end" => slot.1 = Some(item),
                    _ => {}
                }
            }
            ["restores", seq] => {
                if let Ok(seq) = seq.parse::<u32>() {
                    refs.restores.insert(seq, item);
                }
            }
            _ => {}
        }
    }
    Ok(refs)
}

pub(crate) async fn next_turn<G: CheckpointGit>(
    git: &G,
    repo: &CpRepo,
    session: &str,
    token: &CancellationToken,
) -> Result<u32> {
    let refs = session_refs(git, repo, session, token).await?;
    Ok(refs.turns.keys().next_back().map_or(1, |turn| turn + 1))
}

struct Snapshot {
    tree: String,
    entries: Vec<CpEntry>,
    skipped: Vec<String>,
}

fn excluded(repo: &CpRepo, path: &str) -> bool {
    let Some(rest) = path.strip_prefix(&repo.prefix) else {
        return true;
    };
    rest.is_empty()
        || path.ends_with('/')
        || path.contains('\n')
        || rest == ".span"
        || rest.starts_with(".span/")
        || path.split('/').any(|part| part == ".git")
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Build a tree of the workspace as it is on disk. `Err(Ok(reason))` means
/// the workspace is over a cap, not a failure.
async fn snapshot<G: CheckpointGit>(
    git: &G,
    repo: &CpRepo,
    token: &CancellationToken,
) -> Result<std::result::Result<Snapshot, String>> {
    let files: Vec<String> = git
        .list_files(repo, token)
        .await?
        .into_iter()
        .filter(|path| !excluded(repo, path))
        .collect();
    if files.len() > CHECKPOINT_MAX_FILES {
        return Ok(Err(format!(
            "This folder has more than {CHECKPOINT_MAX_FILES} files, so Span does not keep checkpoints for it."
        )));
    }
    let mut regular = Vec::new();
    let mut modes = Vec::new();
    let mut skipped = Vec::new();
    let mut total = 0u64;
    for path in files {
        let Ok(meta) = std::fs::symlink_metadata(repo.root.join(&path)) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if meta.len() > CHECKPOINT_MAX_FILE_BYTES {
            skipped.push(path);
            continue;
        }
        total += meta.len();
        if total > CHECKPOINT_MAX_TOTAL_BYTES {
            return Ok(Err(format!(
                "This folder holds more than {} MiB of files, so Span does not keep checkpoints for it.",
                CHECKPOINT_MAX_TOTAL_BYTES / (1024 * 1024)
            )));
        }
        modes.push(if executable(&meta) {
            "100755"
        } else {
            "100644"
        });
        regular.push(path);
    }
    let oids = git.hash_files(repo, &regular, token).await?;
    let entries: Vec<CpEntry> = regular
        .into_iter()
        .zip(oids)
        .zip(modes)
        .map(|((path, oid), mode)| CpEntry {
            mode: mode.into(),
            oid,
            path,
        })
        .collect();
    let tree = git.write_tree(repo, &entries, token).await?;
    Ok(Ok(Snapshot {
        tree,
        entries,
        skipped,
    }))
}

pub(crate) async fn capture<G: CheckpointGit>(
    git: &G,
    session: &str,
    turn: u32,
    phase: CheckpointPhase,
    token: &CancellationToken,
) -> Result<CaptureOutcome> {
    let Some(repo) = git.repo(token).await? else {
        return Ok(CaptureOutcome::Unavailable {
            reason: NOT_A_REPO.into(),
        });
    };
    let snap = match snapshot(git, &repo, token).await? {
        Ok(snap) => snap,
        Err(reason) => return Ok(CaptureOutcome::Unavailable { reason }),
    };
    let refs = session_refs(git, &repo, session, token).await?;
    let (commit, reused) = match refs.latest().filter(|item| item.tree == snap.tree) {
        Some(existing) => (existing.commit.clone(), true),
        None => (
            git.commit_tree(
                &repo,
                &snap.tree,
                &message(session, &turn.to_string()),
                None,
                token,
            )
            .await?,
            false,
        ),
    };
    git.update_refs(
        &repo,
        &[(turn_ref(session, turn, phase), Some(commit.clone()))],
        token,
    )
    .await?;
    if phase == CheckpointPhase::End {
        prune(git, &repo, session, CHECKPOINT_KEEP_TURNS, token).await?;
    }
    Ok(CaptureOutcome::Captured {
        commit,
        files: u32::try_from(snap.entries.len()).unwrap_or(u32::MAX),
        skipped: snap.skipped,
        reused,
    })
}

pub(crate) async fn alias<G: CheckpointGit>(
    git: &G,
    session: &str,
    turn: u32,
    phase: CheckpointPhase,
    from_turn: u32,
    from_phase: CheckpointPhase,
    token: &CancellationToken,
) -> Result<bool> {
    let repo = need_repo(git, token).await?;
    let refs = session_refs(git, &repo, session, token).await?;
    let source = refs
        .turns
        .get(&from_turn)
        .and_then(|(start, end)| match from_phase {
            CheckpointPhase::Start => start.clone(),
            CheckpointPhase::End => end.clone(),
        });
    let Some(source) = source else {
        return Ok(false);
    };
    git.update_refs(
        &repo,
        &[(turn_ref(session, turn, phase), Some(source.commit))],
        token,
    )
    .await?;
    Ok(true)
}

pub(crate) async fn prune<G: CheckpointGit>(
    git: &G,
    repo: &CpRepo,
    session: &str,
    keep: usize,
    token: &CancellationToken,
) -> Result<()> {
    let refs = session_refs(git, repo, session, token).await?;
    let mut drop = Vec::new();
    let excess = refs.turns.len().saturating_sub(keep);
    for (turn, _) in refs.turns.iter().take(excess) {
        for phase in [CheckpointPhase::Start, CheckpointPhase::End] {
            if let Some(slot) = refs.turns.get(turn) {
                let present = match phase {
                    CheckpointPhase::Start => slot.0.is_some(),
                    CheckpointPhase::End => slot.1.is_some(),
                };
                if present {
                    drop.push((turn_ref(session, *turn, phase), None));
                }
            }
        }
    }
    let excess = refs.restores.len().saturating_sub(CHECKPOINT_KEEP_RESTORES);
    for seq in refs.restores.keys().take(excess) {
        drop.push((restore_ref(session, *seq), None));
    }
    git.update_refs(repo, &drop, token).await
}

pub(crate) async fn delete_session<G: CheckpointGit>(
    git: &G,
    session: &str,
    token: &CancellationToken,
) -> Result<()> {
    let Some(repo) = git.repo(token).await? else {
        return Ok(());
    };
    let prefix = session_prefix(session);
    let drop: Vec<(String, Option<String>)> = git
        .list_refs(&repo, &prefix, token)
        .await?
        .into_iter()
        .map(|item| (item.name, None))
        .collect();
    git.update_refs(&repo, &drop, token).await
}

pub(crate) async fn list<G: CheckpointGit>(
    git: &G,
    session: &str,
    token: &CancellationToken,
) -> Result<Vec<CheckpointTurn>> {
    let Some(repo) = git.repo(token).await? else {
        return Ok(Vec::new());
    };
    let refs = session_refs(git, &repo, session, token).await?;
    let mut turns = Vec::new();
    for (turn, (start, end)) in &refs.turns {
        let changed = match (refs.base(*turn), end) {
            (Some(base), Some(end)) if base.tree != end.tree => git
                .diff_trees(&repo, &base.tree, &end.tree, token)
                .await?
                .len(),
            _ => 0,
        };
        let captured_at = [start, end]
            .into_iter()
            .flatten()
            .map(|item| item.time)
            .max()
            .unwrap_or_default();
        turns.push(CheckpointTurn {
            turn: *turn,
            captured_at,
            has_start: start.is_some(),
            has_end: end.is_some(),
            changed_files: u32::try_from(changed).unwrap_or(u32::MAX),
        });
    }
    Ok(turns)
}

/// The two snapshots a view compares, `None` when there is nothing to compare yet.
fn range(refs: &SessionRefs, turn: Option<u32>) -> Option<(CpRef, CpRef)> {
    match turn {
        Some(turn) => {
            let end = refs.turns.get(&turn)?.1.clone()?;
            Some((refs.base(turn)?.clone(), end))
        }
        None => {
            let first = *refs.turns.keys().next()?;
            let end = refs.turns.values().rev().find_map(|(_, end)| end.clone())?;
            Some((refs.base(first)?.clone(), end))
        }
    }
}

fn revision_of(base: &CpRef, head: &CpRef) -> String {
    format!("{}..{}", base.commit, head.commit)
}

/// One file's change between two snapshots, with hunks in both coordinate spaces.
struct FileDiff {
    path: String,
    base: Option<Vec<u8>>,
    head: Option<Vec<u8>>,
    head_mode: String,
    hunks: Vec<LineHunk>,
    text: bool,
}

/// A line hunk: base bytes `base_from..base_to` became head bytes `head_from..head_to`.
#[derive(Debug, Clone)]
struct LineHunk {
    base_from: usize,
    base_to: usize,
    head_from: usize,
    head_to: usize,
    utf16_from: u32,
    utf16_to: u32,
}

fn text_of(bytes: Option<&Vec<u8>>) -> Option<&str> {
    match bytes {
        None => Some(""),
        Some(bytes) if bytes.len() <= MAX_DIFF_TEXT && !bytes.contains(&0) => {
            std::str::from_utf8(bytes).ok()
        }
        Some(_) => None,
    }
}

fn byte_offset(text: &str, utf16: u32) -> usize {
    let mut units = 0u32;
    for (index, ch) in text.char_indices() {
        if units >= utf16 {
            return index;
        }
        units += ch.len_utf16() as u32;
    }
    text.len()
}

fn line_hunks(base: &str, head: &str) -> Result<Vec<LineHunk>> {
    let edits = crate::proposal_diff::line_edits(base, head)?;
    let mut hunks = Vec::new();
    let mut delta: isize = 0;
    for edit in edits {
        let base_from = byte_offset(base, edit.from);
        let base_to = byte_offset(base, edit.to);
        let head_from = (base_from as isize + delta) as usize;
        let head_to = head_from + edit.insert.len();
        delta += edit.insert.len() as isize - (base_to - base_from) as isize;
        hunks.push(LineHunk {
            base_from,
            base_to,
            head_from,
            head_to,
            utf16_from: edit.from,
            utf16_to: edit.to,
        });
    }
    Ok(hunks)
}

async fn file_diffs<G: CheckpointGit>(
    git: &G,
    repo: &CpRepo,
    base: &CpRef,
    head: &CpRef,
    only: Option<&BTreeSet<String>>,
    token: &CancellationToken,
) -> Result<Vec<FileDiff>> {
    if base.tree == head.tree {
        return Ok(Vec::new());
    }
    let diffs: Vec<CpDiff> = git
        .diff_trees(repo, &base.tree, &head.tree, token)
        .await?
        .into_iter()
        .filter(|diff| only.is_none_or(|set| set.contains(&workspace_path(repo, &diff.path))))
        .collect();
    let oids: Vec<String> = diffs
        .iter()
        .flat_map(|diff| [diff.old_oid.clone(), diff.new_oid.clone()])
        .flatten()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let blobs = git.read_blobs(repo, &oids, token).await?;
    let mut files = Vec::new();
    for diff in diffs {
        let base = diff
            .old_oid
            .as_ref()
            .and_then(|oid| blobs.get(oid))
            .cloned();
        let head = diff
            .new_oid
            .as_ref()
            .and_then(|oid| blobs.get(oid))
            .cloned();
        let (hunks, text) = match (text_of(base.as_ref()), text_of(head.as_ref())) {
            (Some(before), Some(after)) => (line_hunks(before, after)?, true),
            _ => (Vec::new(), false),
        };
        files.push(FileDiff {
            path: diff.path,
            base,
            head,
            head_mode: diff.new_mode,
            hunks,
            text,
        });
    }
    Ok(files)
}

fn workspace_path(repo: &CpRepo, path: &str) -> String {
    path.strip_prefix(&repo.prefix).unwrap_or(path).to_owned()
}

fn count_lines(text: &str) -> u32 {
    u32::try_from(text.lines().count()).unwrap_or(u32::MAX)
}

pub(crate) async fn changes<G: CheckpointGit>(
    git: &G,
    session: &str,
    turn: Option<u32>,
    token: &CancellationToken,
) -> Result<CheckpointChanges> {
    let empty = CheckpointChanges {
        session_id: session.to_owned(),
        turn,
        revision: None,
        files: Vec::new(),
    };
    let Some(repo) = git.repo(token).await? else {
        return Ok(empty);
    };
    let refs = session_refs(git, &repo, session, token).await?;
    let Some((base, head)) = range(&refs, turn) else {
        return Ok(empty);
    };
    let diffs = file_diffs(git, &repo, &base, &head, None, token).await?;
    let mut files = Vec::new();
    for diff in diffs {
        let kind = match (&diff.base, &diff.head) {
            (None, _) => CheckpointFileKind::Added,
            (_, None) => CheckpointFileKind::Deleted,
            _ => CheckpointFileKind::Modified,
        };
        let mut change = CheckpointFileChange {
            path: workspace_path(&repo, &diff.path),
            kind,
            additions: 0,
            deletions: 0,
            binary: !diff.text,
            hunks: Vec::new(),
        };
        if diff.text {
            let before = text_of(diff.base.as_ref()).unwrap_or_default();
            let after = text_of(diff.head.as_ref()).unwrap_or_default();
            for (index, hunk) in diff.hunks.iter().enumerate() {
                let removed = &before[hunk.base_from..hunk.base_to];
                let added = &after[hunk.head_from..hunk.head_to];
                change.deletions += count_lines(removed);
                change.additions += count_lines(added);
                change.hunks.push(ProposalHunk {
                    id: format!("h{index}"),
                    from: hunk.utf16_from,
                    to: hunk.utf16_to,
                    before: removed.to_owned(),
                    after: added.to_owned(),
                });
            }
        }
        files.push(change);
    }
    Ok(CheckpointChanges {
        session_id: session.to_owned(),
        turn,
        revision: Some(revision_of(&base, &head)),
        files,
    })
}

enum Selection {
    Hunks(Vec<CheckpointHunkRef>),
    Files(Vec<String>),
}

/// Resolve a revision string to two snapshots that belong to this session.
fn resolve_revision(refs: &SessionRefs, revision: &str) -> Result<(CpRef, CpRef)> {
    let (base, head) = revision
        .split_once("..")
        .ok_or_else(|| error("Unknown checkpoint revision"))?;
    let known = refs.all_commits();
    if !known.contains(base) || !known.contains(head) {
        return Err(error(
            "These changes are no longer in the session's checkpoints. Refresh the list.",
        ));
    }
    let find = |commit: &str| {
        refs.turns
            .values()
            .flat_map(|(start, end)| [start, end])
            .flatten()
            .find(|item| item.commit == commit)
            .cloned()
    };
    Ok((
        find(base).ok_or_else(|| error("Unknown checkpoint revision"))?,
        find(head).ok_or_else(|| error("Unknown checkpoint revision"))?,
    ))
}

/// The working-tree write a revert or restore performs.
#[derive(Debug, Clone)]
struct Write {
    path: String,
    content: Option<Vec<u8>>,
    /// Only applied where file modes exist (unix).
    #[cfg_attr(not(unix), allow(dead_code))]
    executable: bool,
}

fn read_current(root: &Path, path: &str) -> Result<Option<Vec<u8>>> {
    match std::fs::read(root.join(path)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error(format!("Read {path}: {e}"))),
    }
}

fn line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0];
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' && index + 1 < text.len() {
            starts.push(index + 1);
        }
    }
    starts
}

/// Up to `k` whole lines at the end of `region` (byte range of `text`).
fn tail_lines(text: &str, from: usize, to: usize, k: usize) -> usize {
    if k == 0 || from >= to {
        return to;
    }
    let region = &text[from..to];
    let starts = line_starts(region);
    let take = k.min(starts.len());
    from + starts[starts.len() - take]
}

/// Up to `k` whole lines at the start of `region`.
fn head_lines(text: &str, from: usize, to: usize, k: usize) -> usize {
    if k == 0 || from >= to {
        return from;
    }
    let region = &text[from..to];
    let starts = line_starts(region);
    if k >= starts.len() {
        to
    } else {
        from + starts[k]
    }
}

/// Undo one hunk in `current`: find the post-turn text with surrounding
/// unchanged lines and put the pre-turn text back. `None` when it no longer
/// matches in exactly one place.
fn revert_in(
    current: &str,
    base: &str,
    head: &str,
    hunks: &[LineHunk],
    index: usize,
) -> Option<String> {
    let hunk = &hunks[index];
    let prev_end = if index == 0 {
        0
    } else {
        hunks[index - 1].head_to
    };
    let next_start = hunks
        .get(index + 1)
        .map_or(head.len(), |next| next.head_from);
    for k in [3usize, 2, 1, 0] {
        let ctx_from = tail_lines(head, prev_end, hunk.head_from, k);
        let ctx_to = head_lines(head, hunk.head_to, next_start, k);
        let at_start = index == 0 && ctx_from == 0;
        let at_end = index + 1 == hunks.len() && ctx_to == head.len();
        let needle = &head[ctx_from..ctx_to];
        if needle.is_empty() && !(at_start && at_end) {
            continue;
        }
        let mut found = Vec::new();
        let mut search = 0;
        while let Some(position) = current.get(search..).and_then(|rest| rest.find(needle)) {
            let position = search + position;
            let start_ok = !at_start || position == 0;
            let end_ok = !at_end || position + needle.len() == current.len();
            if start_ok && end_ok {
                found.push(position);
            }
            if needle.is_empty() {
                break;
            }
            search = position + 1;
            if found.len() > 1 {
                break;
            }
        }
        if found.len() == 1 {
            let position = found[0];
            let mut replacement = String::new();
            replacement.push_str(&head[ctx_from..hunk.head_from]);
            replacement.push_str(&base[hunk.base_from..hunk.base_to]);
            replacement.push_str(&head[hunk.head_to..ctx_to]);
            let mut result = String::with_capacity(current.len());
            result.push_str(&current[..position]);
            result.push_str(&replacement);
            result.push_str(&current[position + needle.len()..]);
            return Some(result);
        }
        if found.len() > 1 {
            continue;
        }
    }
    None
}

const CHANGED_SINCE: &str = "The file changed after this turn, so this change no longer applies.";

async fn revert<G: CheckpointGit>(
    git: &G,
    session: &str,
    revision: &str,
    selection: Selection,
    token: &CancellationToken,
) -> Result<CheckpointRevertReport> {
    let repo = need_repo(git, token).await?;
    let refs = session_refs(git, &repo, session, token).await?;
    let (base, head) = resolve_revision(&refs, revision)?;
    let wanted: BTreeSet<String> = match &selection {
        Selection::Hunks(hunks) => hunks.iter().map(|hunk| hunk.path.clone()).collect(),
        Selection::Files(paths) => paths.iter().cloned().collect(),
    };
    let diffs = file_diffs(git, &repo, &base, &head, Some(&wanted), token).await?;
    let mut report = CheckpointRevertReport {
        reverted: Vec::new(),
        reverted_files: Vec::new(),
        conflicts: Vec::new(),
        undo_id: None,
    };
    let mut writes = Vec::new();
    for path in &wanted {
        let Some(diff) = diffs
            .iter()
            .find(|diff| &workspace_path(&repo, &diff.path) == path)
        else {
            report.conflicts.push(CheckpointConflict {
                path: path.clone(),
                hunk_id: None,
                reason: "This file has no changes in these checkpoints.".into(),
            });
            continue;
        };
        let current = read_current(&repo.root, &diff.path)?;
        let ids: Vec<String> = match &selection {
            Selection::Hunks(hunks) => hunks
                .iter()
                .filter(|hunk| &hunk.path == path)
                .map(|hunk| hunk.hunk_id.clone())
                .collect(),
            Selection::Files(_) => Vec::new(),
        };
        let whole_file = matches!(selection, Selection::Files(_))
            || !diff.text
            || diff.base.is_none()
            || diff.head.is_none();
        if whole_file {
            if current == diff.head {
                writes.push(Write {
                    path: diff.path.clone(),
                    content: diff.base.clone(),
                    executable: diff.head_mode == "100755",
                });
                report.reverted_files.push(path.clone());
                for id in ids {
                    report.reverted.push(CheckpointHunkRef {
                        path: path.clone(),
                        hunk_id: id,
                    });
                }
            } else {
                report.conflicts.push(CheckpointConflict {
                    path: path.clone(),
                    hunk_id: ids.first().cloned(),
                    reason: CHANGED_SINCE.into(),
                });
            }
            continue;
        }
        let before = text_of(diff.base.as_ref()).unwrap_or_default();
        let after = text_of(diff.head.as_ref()).unwrap_or_default();
        let Some(mut text) = current
            .as_ref()
            .and_then(|bytes| String::from_utf8(bytes.clone()).ok())
        else {
            for id in ids {
                report.conflicts.push(CheckpointConflict {
                    path: path.clone(),
                    hunk_id: Some(id),
                    reason: CHANGED_SINCE.into(),
                });
            }
            continue;
        };
        let mut changed = false;
        for id in ids {
            let index = id
                .strip_prefix('h')
                .and_then(|n| n.parse::<usize>().ok())
                .filter(|n| *n < diff.hunks.len());
            match index.and_then(|n| revert_in(&text, before, after, &diff.hunks, n)) {
                Some(next) => {
                    text = next;
                    changed = true;
                    report.reverted.push(CheckpointHunkRef {
                        path: path.clone(),
                        hunk_id: id,
                    });
                }
                None => report.conflicts.push(CheckpointConflict {
                    path: path.clone(),
                    hunk_id: Some(id),
                    reason: CHANGED_SINCE.into(),
                }),
            }
        }
        if changed {
            writes.push(Write {
                path: diff.path.clone(),
                content: Some(text.into_bytes()),
                executable: diff.head_mode == "100755",
            });
        }
    }
    if writes.is_empty() {
        return Ok(report);
    }
    report.undo_id =
        Some(guarded_apply(git, &repo, session, &refs, writes, "revert", token).await?);
    Ok(report)
}

/// Snapshot, write, snapshot again, and record the pair as an undo point.
/// A failed write puts every touched file back before returning the error.
async fn guarded_apply<G: CheckpointGit>(
    git: &G,
    repo: &CpRepo,
    session: &str,
    refs: &SessionRefs,
    writes: Vec<Write>,
    label: &str,
    token: &CancellationToken,
) -> Result<String> {
    let before = snapshot(git, repo, token).await?.map_err(|reason| {
        error(format!(
            "Span could not take the snapshot it needs before restoring: {reason}"
        ))
    })?;
    let before_commit = git
        .commit_tree(
            repo,
            &before.tree,
            &message(session, &format!("before-{label}")),
            None,
            token,
        )
        .await?;
    apply_writes(repo, &writes)?;
    let after = snapshot(git, repo, token).await?.map_err(|reason| {
        error(format!(
            "Files were written but the undo point failed: {reason}"
        ))
    })?;
    let after_commit = git
        .commit_tree(
            repo,
            &after.tree,
            &message(session, &format!("after-{label}")),
            Some(&before_commit),
            token,
        )
        .await?;
    let seq = refs.restores.keys().next_back().map_or(1, |seq| seq + 1);
    let name = restore_ref(session, seq);
    git.update_refs(repo, &[(name.clone(), Some(after_commit))], token)
        .await?;
    prune(git, repo, session, CHECKPOINT_KEEP_TURNS, token).await?;
    Ok(format!("{seq}"))
}

fn checked_path(repo: &CpRepo, path: &str) -> Result<PathBuf> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            ) || part.as_os_str() == ".git"
        })
        || !path.starts_with(&repo.prefix)
    {
        return Err(error(format!(
            "Refusing to write outside the workspace: {path}"
        )));
    }
    Ok(repo.root.join(relative))
}

fn write_one(repo: &CpRepo, write: &Write) -> Result<()> {
    let full = checked_path(repo, &write.path)?;
    match &write.content {
        None => match std::fs::remove_file(&full) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(error(format!("Remove {}: {e}", write.path))),
        },
        Some(bytes) => {
            let parent = full
                .parent()
                .ok_or_else(|| error(format!("No parent folder for {}", write.path)))?;
            std::fs::create_dir_all(parent)
                .map_err(|e| error(format!("Create folder for {}: {e}", write.path)))?;
            let real = parent
                .canonicalize()
                .map_err(|e| error(format!("Resolve folder for {}: {e}", write.path)))?;
            if !real.starts_with(repo.root.join(&repo.prefix)) {
                return Err(error(format!(
                    "Refusing to write through a link: {}",
                    write.path
                )));
            }
            std::fs::write(&full, bytes)
                .map_err(|e| error(format!("Write {}: {e}", write.path)))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&full) {
                    let mut permissions = meta.permissions();
                    let mode = permissions.mode();
                    let next = if write.executable {
                        mode | ((mode & 0o444) >> 2)
                    } else {
                        mode & !0o111
                    };
                    if next != mode {
                        permissions.set_mode(next);
                        let _ = std::fs::set_permissions(&full, permissions);
                    }
                }
            }
            Ok(())
        }
    }
}

fn apply_writes(repo: &CpRepo, writes: &[Write]) -> Result<()> {
    let mut originals = Vec::new();
    for write in writes {
        let original = read_current(&repo.root, &write.path)?;
        originals.push(Write {
            path: write.path.clone(),
            content: original,
            executable: std::fs::metadata(repo.root.join(&write.path))
                .map(|meta| executable(&meta))
                .unwrap_or(false),
        });
    }
    for (index, write) in writes.iter().enumerate() {
        if let Err(failure) = write_one(repo, write) {
            for original in originals.iter().take(index + 1) {
                let _ = write_one(repo, original);
            }
            return Err(failure);
        }
    }
    Ok(())
}

/// Files a restore must not touch: links and anything over the size cap.
fn untouchable(repo: &CpRepo, path: &str) -> Option<&'static str> {
    let meta = std::fs::symlink_metadata(repo.root.join(path)).ok()?;
    if meta.file_type().is_symlink() {
        Some("Span does not restore symbolic links.")
    } else if meta.is_dir() {
        Some("A folder is in the way.")
    } else if meta.len() > CHECKPOINT_MAX_FILE_BYTES {
        Some("The file is over the checkpoint size limit.")
    } else {
        None
    }
}

pub(crate) async fn restore<G: CheckpointGit>(
    git: &G,
    session: &str,
    turn: u32,
    token: &CancellationToken,
) -> Result<CheckpointRestoreReport> {
    let repo = need_repo(git, token).await?;
    let refs = session_refs(git, &repo, session, token).await?;
    let target = refs
        .base(turn)
        .cloned()
        .ok_or_else(|| error("This turn has no checkpoint to restore."))?;
    let now = snapshot(git, &repo, token).await?.map_err(|reason| {
        error(format!(
            "Span could not take the snapshot it needs before restoring: {reason}"
        ))
    })?;
    let mut report = CheckpointRestoreReport {
        restored: Vec::new(),
        skipped: Vec::new(),
        undo_id: None,
    };
    if now.tree == target.tree {
        return Ok(report);
    }
    let diffs = git
        .diff_trees(&repo, &now.tree, &target.tree, token)
        .await?;
    let oids: Vec<String> = diffs
        .iter()
        .filter_map(|diff| diff.new_oid.clone())
        .collect();
    let blobs = git.read_blobs(&repo, &oids, token).await?;
    let mut writes = Vec::new();
    for diff in diffs {
        let shown = workspace_path(&repo, &diff.path);
        if let Some(reason) = untouchable(&repo, &diff.path) {
            report.skipped.push(CheckpointConflict {
                path: shown,
                hunk_id: None,
                reason: reason.into(),
            });
            continue;
        }
        let content = match &diff.new_oid {
            Some(oid) => Some(
                blobs
                    .get(oid)
                    .cloned()
                    .ok_or_else(|| error(format!("Checkpoint content is missing for {shown}")))?,
            ),
            None => None,
        };
        writes.push(Write {
            path: diff.path,
            content,
            executable: diff.new_mode == "100755",
        });
        report.restored.push(shown);
    }
    if writes.is_empty() {
        return Ok(report);
    }
    report.undo_id =
        Some(guarded_apply(git, &repo, session, &refs, writes, "restore", token).await?);
    Ok(report)
}

pub(crate) async fn undo_restore<G: CheckpointGit>(
    git: &G,
    session: &str,
    undo_id: &str,
    token: &CancellationToken,
) -> Result<CheckpointRestoreReport> {
    let repo = need_repo(git, token).await?;
    let refs = session_refs(git, &repo, session, token).await?;
    let seq: u32 = undo_id.parse().map_err(|_| error("Unknown undo point"))?;
    let point = refs
        .restores
        .get(&seq)
        .cloned()
        .ok_or_else(|| error("This undo point is no longer available."))?;
    let before_commit = point
        .parent
        .clone()
        .ok_or_else(|| error("This undo point is incomplete."))?;
    // The "before" snapshot is the parent commit; find its tree through a ref-free diff.
    let diffs = git
        .diff_trees(&repo, &point.commit, &before_commit, token)
        .await?;
    let oids: Vec<String> = diffs
        .iter()
        .flat_map(|diff| [diff.old_oid.clone(), diff.new_oid.clone()])
        .flatten()
        .collect();
    let blobs = git.read_blobs(&repo, &oids, token).await?;
    let mut report = CheckpointRestoreReport {
        restored: Vec::new(),
        skipped: Vec::new(),
        undo_id: None,
    };
    let mut writes = Vec::new();
    for diff in diffs {
        let shown = workspace_path(&repo, &diff.path);
        let written = diff
            .old_oid
            .as_ref()
            .and_then(|oid| blobs.get(oid))
            .cloned();
        let current = read_current(&repo.root, &diff.path)?;
        if current != written {
            report.skipped.push(CheckpointConflict {
                path: shown,
                hunk_id: None,
                reason: "The file changed after the restore, so Span left it as it is.".into(),
            });
            continue;
        }
        let content = diff
            .new_oid
            .as_ref()
            .and_then(|oid| blobs.get(oid))
            .cloned();
        writes.push(Write {
            path: diff.path,
            content,
            executable: diff.new_mode == "100755",
        });
        report.restored.push(shown);
    }
    if writes.is_empty() {
        return Ok(report);
    }
    report.undo_id = Some(guarded_apply(git, &repo, session, &refs, writes, "undo", token).await?);
    Ok(report)
}

#[cfg(test)]
#[path = "checkpoint_tests.rs"]
mod tests;
