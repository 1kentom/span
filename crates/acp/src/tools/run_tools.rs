//! Backend seam for MCP workspace run tools. The desktop adapter owns all
//! authorization and process lifecycle behavior through the shared RunService.
use crate::SessionKey;
use serde_json::Value;
use span_core::RunConfiguration;
use std::{future::Future, pin::Pin, sync::Arc};

/// Future returned by a host-owned run tool backend.
pub type RunToolFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
/// Optional MCP progress notification callback for a long-running approved action.
pub type RunToolProgress = Arc<dyn Fn(String) + Send + Sync>;

/// One saved or detected configuration. The full config remains host-side;
/// the MCP server removes environment values before returning it to an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunConfigurationEntry {
    pub configuration: RunConfiguration,
    /// Revision of the persisted configurations and detected manifests.
    pub revision: String,
    /// Detected tasks are readable but cannot be edited or run until saved.
    pub detected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunToolCatalog {
    pub configurations: Vec<RunConfigurationEntry>,
    pub revision: String,
}

/// Workspace-scoped adapter supplied by the desktop. Implementations must
/// validate the active workspace and lead session on each call. Mutating
/// operations must obtain explicit host approval and recheck the revision
/// after approval before changing state or starting a process.
pub trait RunToolBackend: Send + Sync {
    fn list_configurations<'a>(&'a self, lead: &'a SessionKey)
        -> RunToolFuture<'a, RunToolCatalog>;

    fn read_configuration<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
    ) -> RunToolFuture<'a, Option<RunConfigurationEntry>>;

    fn save_configuration<'a>(
        &'a self,
        lead: &'a SessionKey,
        configuration: RunConfiguration,
        expected_revision: String,
        progress: Option<RunToolProgress>,
    ) -> RunToolFuture<'a, RunConfigurationEntry>;

    fn delete_configuration<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
        expected_revision: String,
        progress: Option<RunToolProgress>,
    ) -> RunToolFuture<'a, Value>;

    fn start_run<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
        expected_revision: String,
        progress: Option<RunToolProgress>,
    ) -> RunToolFuture<'a, Value>;

    fn stop_run<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
        progress: Option<RunToolProgress>,
    ) -> RunToolFuture<'a, Value>;

    fn restart_run<'a>(
        &'a self,
        lead: &'a SessionKey,
        id: &'a str,
        progress: Option<RunToolProgress>,
    ) -> RunToolFuture<'a, Value>;

    fn list_runs<'a>(&'a self, lead: &'a SessionKey) -> RunToolFuture<'a, Value>;

    fn read_run_output<'a>(&'a self, lead: &'a SessionKey, id: &'a str)
        -> RunToolFuture<'a, Value>;
}
