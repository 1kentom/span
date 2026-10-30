use super::GitDiff;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewLine {
    /// Opaque review identity. Only changed rows have selectable identities.
    pub id: String,
    pub kind: String,
    /// Exact index-normalized UTF-8, including its final LF if present.
    pub text: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitLineHunk {
    pub id: String,
    pub header: String,
    pub lines: Vec<GitReviewLine>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitLineReview {
    pub diff: GitDiff,
    pub worktree_snapshot: String,
    pub hunks: Vec<GitLineHunk>,
    /// Metadata is applied only when the caller explicitly selects includeMetadata.
    pub metadata: Vec<String>,
}
