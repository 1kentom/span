use super::{GitDiff, GitStatus};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHunk {
    pub id: String,
    pub header: String,
    pub patch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitHunkDiff {
    pub diff: GitDiff,
    /// The disk snapshot is checked for both staging and unstaging.
    pub worktree_snapshot: String,
    pub hunks: Vec<GitHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    pub name: String,
    pub object_id: String,
    pub target_id: String,
    pub annotated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitIntegrationState {
    pub status: GitStatus,
    pub worktree_snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitIntegrationResult {
    pub state: GitIntegrationState,
    pub output: String,
    /// False retains the actual in-progress operation and conflicts for review.
    pub completed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitRebaseAction {
    Continue,
    Abort,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitDiscardResult {
    pub state: GitIntegrationState,
    /// Local recovery copy of the discarded working bytes. Never staged by this action.
    pub recovery_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GitIntegrationKind {
    Merge,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictResource {
    pub path: String,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub working: String,
    pub state: GitIntegrationState,
}
