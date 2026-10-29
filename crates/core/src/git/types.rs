use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitContext {
    pub workspace_root: String,
    pub repository: Option<GitRepository>,
    pub unavailable_reason: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitRepository {
    /// Opaque identity for this workspace session and discovered repository.
    pub id: String,
    pub root: String,
    pub workspace_prefix: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub detached: bool,
    pub unborn: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repository: GitRepository,
    pub index_revision: String,
    pub staged_snapshot: String,
    pub entries: Vec<GitChange>,
    pub operation: Option<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub id: String,
    /// Invalid UTF-8 filenames remain visible but cannot be passed back as paths.
    pub path: Option<String>,
    pub display_path: String,
    pub old_path: Option<String>,
    pub display_old_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub untracked: bool,
    pub conflicted: bool,
    pub submodule: bool,
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitDiffSide {
    Working,
    Staged,
    Commit,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub repository_id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub side: GitDiffSide,
    pub index_revision: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub patch: String,
    pub binary: bool,
    pub truncated: bool,
    pub summary: Option<String>,
    pub commit_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryQuery {
    pub anchor: Option<String>,
    pub skip: u32,
    pub limit: u32,
    pub path: Option<String>,
}

impl Default for GitHistoryQuery {
    fn default() -> Self {
        Self {
            anchor: None,
            skip: 0,
            limit: 50,
            path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryPage {
    pub repository_id: String,
    pub anchor: Option<String>,
    pub commits: Vec<GitCommit>,
    pub next_skip: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub id: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_id: String,
    pub commit: Option<GitCommit>,
    pub status: Option<GitStatus>,
    /// A commit can succeed before a post-commit hook times out or fails.
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitFileBaseline {
    pub repository_id: String,
    pub path: String,
    pub index_revision: String,
    pub head_text: Option<String>,
    pub index_text: Option<String>,
    pub binary: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub commit_id: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitRemoteAction {
    Fetch,
    Pull,
    Push,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitStashAction {
    Save,
    Apply,
    Pop,
    Drop,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    pub status: GitStatus,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    pub id: String,
    pub selector: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    /// The main worktree, reported first by Git regardless of the open workspace.
    pub main: bool,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub commit: GitCommit,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBlame {
    pub repository_id: String,
    pub path: String,
    pub head: Option<String>,
    pub lines: Vec<GitBlameLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line: u32,
    pub original_line: u32,
    pub commit_id: String,
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitRemotes {
    pub remotes: Vec<GitRemote>,
    pub config_fingerprint: String,
}
