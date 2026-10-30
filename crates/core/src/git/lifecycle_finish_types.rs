use super::GitOperationResult;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitSelectedRemoteResult {
    pub operation: GitOperationResult,
    pub remote_succeeded: bool,
    pub upstream_configured: bool,
    pub warning: Option<String>,
}
