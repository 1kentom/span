//! One explicit, expiring decision per agent mutation or run action.
use crate::DesktopState;
use serde::{Deserialize, Serialize};
use span_core::{CoreWorkspace, RunConfiguration};
use specta::Type;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use tauri_specta::Event;
use tokio::sync::oneshot;

static NEXT_APPROVAL: AtomicU64 = AtomicU64::new(1);
const EXPIRY: Duration = Duration::from_secs(120);
#[derive(Clone)]
pub(crate) enum RunApprovalAction {
    Save { configuration: RunConfiguration },
    Delete { id: String },
    Run { configuration: RunConfiguration },
    Stop { id: String },
    Restart { id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RunApprovalRequest {
    pub id: String,
    pub action: String,
    pub lead: span_acp::SessionKey,
    pub agent_name: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env_keys: Vec<String>,
    pub env_references: BTreeMap<String, String>,
    pub env_changes: BTreeMap<String, Option<String>>,
    pub config_revision: String,
    pub expires_at: u64,
    pub execution_resolved: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct RunApprovalsChanged {
    pub pending: Vec<RunApprovalRequest>,
}
pub(crate) type ApprovalSink = Arc<dyn Fn(RunApprovalsChanged) -> bool + Send + Sync>;
struct Pending {
    request: RunApprovalRequest,
    answer: oneshot::Sender<bool>,
    sink: ApprovalSink,
}
#[derive(Clone, Default)]
pub(crate) struct RunApprovalState {
    pending: Arc<Mutex<BTreeMap<String, Pending>>>,
}
impl RunApprovalState {
    pub(crate) fn list(&self) -> Result<Vec<RunApprovalRequest>, String> {
        Ok(self
            .pending
            .lock()
            .map_err(|_| "Run approval state is unavailable".to_owned())?
            .values()
            .map(|pending| pending.request.clone())
            .collect())
    }
    fn broadcast(&self, extra: Option<&ApprovalSink>) {
        let (snapshot, mut sinks) = match self.pending.lock() {
            Ok(pending) => (
                RunApprovalsChanged {
                    pending: pending
                        .values()
                        .map(|entry| entry.request.clone())
                        .collect(),
                },
                pending
                    .values()
                    .map(|entry| entry.sink.clone())
                    .collect::<Vec<_>>(),
            ),
            Err(_) => return,
        };
        if let Some(sink) = extra {
            sinks.push(sink.clone());
        }
        for sink in sinks {
            let _ = sink(snapshot.clone());
        }
    }
    pub(crate) fn resolve(&self, id: &str, allow: bool) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Run approval state is unavailable".to_owned())?
            .remove(id)
            .ok_or_else(|| "Run approval expired or is no longer pending".to_owned())?;
        let valid = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |time| time.as_secs())
            < pending.request.expires_at;
        let _ = pending.answer.send(allow && valid);
        self.broadcast(Some(&pending.sink));
        Ok(())
    }
    pub(crate) fn cancel_lead(&self, lead: &span_acp::SessionKey) {
        let ids = self
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|request| &request.lead == lead)
            .map(|request| request.id)
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.resolve(&id, false);
        }
    }
    pub(crate) fn cancel_connection(&self, connection_id: &str) {
        let ids = self
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|request| request.lead.connection_id == connection_id)
            .map(|request| request.id)
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.resolve(&id, false);
        }
    }
    pub(crate) fn cancel_all(&self) {
        let pending = match self.pending.lock() {
            Ok(mut pending) => std::mem::take(&mut *pending),
            Err(_) => return,
        };
        for entry in pending.into_values() {
            let _ = entry.answer.send(false);
            let _ = (entry.sink)(RunApprovalsChanged {
                pending: Vec::new(),
            });
        }
    }
}
pub(crate) struct ApprovedRunAction {
    workspace: Arc<Mutex<CoreWorkspace>>,
    snapshot: String,
    prepared: Option<span_core::PreparedRun>,
    lead: span_acp::SessionKey,
}
impl ApprovedRunAction {
    pub(crate) fn take_prepared(&mut self) -> Result<span_core::PreparedRun, String> {
        self.prepared
            .take()
            .ok_or_else(|| "This approval has no prepared execution plan".into())
    }
    /// The caller holds connection_gate; validation and mutation/preparation share one lock.
    pub(crate) fn with_workspace<T>(
        &self,
        state: &DesktopState,
        operation: impl FnOnce(&mut CoreWorkspace) -> Result<T, String>,
    ) -> Result<T, String> {
        if !lead_alive(state, &self.lead) {
            return Err("Agent session closed while awaiting approval".into());
        }
        let current = state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Workspace closed while awaiting approval".to_owned())?;
        if !Arc::ptr_eq(&current, &self.workspace) {
            return Err(
                "Workspace changed while awaiting approval. Request this action again.".into(),
            );
        }
        let mut workspace = current
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        if !workspace
            .run_tools_enabled()
            .map_err(|error| error.to_string())?
        {
            return Err(
                "Agent run tools were disabled. Request permission again after enabling them."
                    .into(),
            );
        }
        if workspace
            .run_configuration_snapshot()
            .map_err(|error| error.to_string())?
            != self.snapshot
        {
            return Err("Run configuration or manifest changed while awaiting approval. Request this action again.".into());
        }
        operation(&mut workspace)
    }
}
pub(crate) async fn authorize(
    state: &DesktopState,
    expected_workspace: &Arc<Mutex<CoreWorkspace>>,
    action: RunApprovalAction,
    lead: span_acp::SessionKey,
    sink: ApprovalSink,
) -> Result<ApprovedRunAction, String> {
    if !lead_alive(state, &lead) {
        return Err("Agent session is no longer live".into());
    }
    let agent_name = state
        .sessions
        .session(&lead)
        .map(|session| session.agent_name)
        .unwrap_or_else(|| "Agent".into());
    let (snapshot, revision, configuration, kind, prepared, env_changes) = {
        let _gate = state.connection_gate.lock().await;
        let current = state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Open a workspace first".to_owned())?;
        if !Arc::ptr_eq(&current, expected_workspace) {
            return Err("Agent workspace is no longer active".into());
        }
        let workspace = current
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?;
        if !workspace
            .run_tools_enabled()
            .map_err(|error| error.to_string())?
        {
            return Err("Agent run tools are disabled in user settings".into());
        }
        let (configuration, kind) = match &action {
            RunApprovalAction::Save { configuration } => (configuration.clone(), "save"),
            RunApprovalAction::Run { configuration } => {
                let catalog = workspace
                    .run_configurations()
                    .map_err(|error| error.to_string())?;
                let actual = catalog
                    .configurations
                    .into_iter()
                    .chain(catalog.detected.into_iter().map(|task| task.configuration))
                    .find(|entry| entry.id == configuration.id)
                    .ok_or_else(|| "Configuration no longer exists".to_owned())?;
                if actual != *configuration {
                    return Err("Configuration changed before approval was requested".into());
                }
                (configuration.clone(), "run")
            }
            RunApprovalAction::Delete { id } => {
                let actual = workspace
                    .run_configurations()
                    .map_err(|error| error.to_string())?
                    .configurations
                    .into_iter()
                    .find(|entry| &entry.id == id)
                    .ok_or_else(|| "Saved configuration no longer exists".to_owned())?;
                (actual, "delete")
            }
            RunApprovalAction::Stop { id } | RunApprovalAction::Restart { id } => {
                let (configuration, root) = state.runs.approval_configuration(id)?;
                if std::path::Path::new(&workspace.workspace().root) != root {
                    return Err("Run belongs to a different workspace".into());
                }
                (
                    configuration,
                    if matches!(&action, RunApprovalAction::Stop { .. }) {
                        "stop"
                    } else {
                        "restart"
                    },
                )
            }
        };
        let env_changes = if matches!(&action, RunApprovalAction::Save { .. }) {
            let existing = workspace
                .run_configurations()
                .map_err(|error| error.to_string())?
                .configurations
                .into_iter()
                .find(|entry| entry.id == configuration.id)
                .map(|entry| entry.env)
                .unwrap_or_default();
            existing
                .keys()
                .chain(configuration.env.keys())
                .filter_map(|key| {
                    if existing.get(key) == configuration.env.get(key) {
                        None
                    } else {
                        Some((key.clone(), configuration.env.get(key).cloned()))
                    }
                })
                .collect()
        } else {
            BTreeMap::new()
        };
        let prepared = if matches!(
            &action,
            RunApprovalAction::Run { .. } | RunApprovalAction::Restart { .. }
        ) {
            Some(
                workspace
                    .prepare_run(configuration.clone())
                    .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };
        (
            workspace
                .run_configuration_snapshot()
                .map_err(|error| error.to_string())?,
            workspace
                .run_configuration_revision()
                .map_err(|error| error.to_string())?,
            configuration,
            kind,
            prepared,
            env_changes,
        )
    };
    let id = format!(
        "run-approval-{}",
        NEXT_APPROVAL.fetch_add(1, Ordering::Relaxed)
    );
    let execution_resolved = prepared.is_some();
    let (executable, args, cwd) = match &prepared {
        Some(plan) => (
            plan.executable.display().to_string(),
            plan.args.clone(),
            plan.cwd.display().to_string(),
        ),
        None => (
            configuration.executable.clone(),
            configuration.args.clone(),
            configuration.cwd.clone(),
        ),
    };
    let request = RunApprovalRequest {
        id: id.clone(),
        action: kind.into(),
        lead: lead.clone(),
        agent_name,
        name: configuration.name,
        executable,
        args,
        cwd,
        execution_resolved,
        env_changes,
        env_keys: configuration.env.keys().cloned().collect(),
        env_references: configuration
            .env
            .into_iter()
            .filter(|(_, value)| {
                value
                    .strip_prefix("${env:")
                    .and_then(|name| name.strip_suffix('}'))
                    .is_some_and(|name| {
                        !name.is_empty()
                            && name
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    })
            })
            .collect(),
        config_revision: revision,
        expires_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |time| time.as_secs())
            + EXPIRY.as_secs(),
    };
    let (answer, response) = oneshot::channel();
    {
        let _gate = state.connection_gate.lock().await;
        let current = state
            .workspace
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Workspace closed".to_owned())?;
        if !Arc::ptr_eq(&current, expected_workspace) || !lead_alive(state, &lead) {
            return Err("Workspace or agent session changed before approval".into());
        }
        if current
            .lock()
            .map_err(|_| "Workspace state is unavailable".to_owned())?
            .run_configuration_snapshot()
            .map_err(|error| error.to_string())?
            != snapshot
        {
            return Err("Configuration changed before approval".into());
        }
        let mut pending = state
            .run_approvals
            .pending
            .lock()
            .map_err(|_| "Run approval state is unavailable".to_owned())?;
        if pending.len() >= 16 {
            return Err("Too many pending run approvals".into());
        }
        pending.insert(
            id.clone(),
            Pending {
                request,
                answer,
                sink: sink.clone(),
            },
        );
    }
    state.run_approvals.broadcast(Some(&sink));
    let _cleanup = PendingGuard {
        state: state.run_approvals.clone(),
        id: id.clone(),
        sink: sink.clone(),
    };
    let connection_closed = async {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if !lead_alive(state, &lead) {
                return;
            }
        }
    };
    let allowed = tokio::select! {
        answer = tokio::time::timeout(EXPIRY, response) => answer.ok().and_then(Result::ok).unwrap_or(false),
        _ = connection_closed => false,
    };
    if !allowed {
        return Err("User rejected the run action, or its approval expired".into());
    }
    let approved = ApprovedRunAction {
        workspace: expected_workspace.clone(),
        snapshot,
        prepared,
        lead,
    };
    {
        let _gate = state.connection_gate.lock().await;
        approved.with_workspace(state, |_| Ok(()))?;
    }
    Ok(approved)
}
fn lead_alive(state: &DesktopState, lead: &span_acp::SessionKey) -> bool {
    state.sessions.session(lead).is_some()
        && state
            .sessions
            .connection(&lead.connection_id)
            .is_some_and(|connection| connection.open)
}
struct PendingGuard {
    state: RunApprovalState,
    id: String,
    sink: ApprovalSink,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.state.pending.lock() {
            pending.remove(&self.id);
        }
        self.state.broadcast(Some(&self.sink));
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn pending_run_approvals(
    state: State<'_, DesktopState>,
) -> Result<Vec<RunApprovalRequest>, String> {
    state.run_approvals.list()
}
#[tauri::command]
#[specta::specta]
pub(crate) fn resolve_run_approval(
    state: State<'_, DesktopState>,
    id: String,
    allow: bool,
) -> Result<(), String> {
    state.run_approvals.resolve(&id, allow)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pending(
        state: &RunApprovalState,
        id: &str,
        lead: span_acp::SessionKey,
        expires_at: u64,
    ) -> oneshot::Receiver<bool> {
        let (answer, response) = oneshot::channel();
        state.pending.lock().unwrap().insert(
            id.into(),
            Pending {
                request: RunApprovalRequest {
                    id: id.into(),
                    action: "run".into(),
                    lead,
                    agent_name: "Fixture agent".into(),
                    name: "Fixture".into(),
                    executable: "tool".into(),
                    args: vec!["${env:TOKEN}".into()],
                    cwd: ".".into(),
                    env_keys: vec!["TOKEN".into()],
                    env_changes: BTreeMap::new(),
                    env_references: BTreeMap::from([("TOKEN".into(), "${env:TOKEN}".into())]),
                    config_revision: "opaque".into(),
                    expires_at,
                    execution_resolved: false,
                },
                answer,
                sink: Arc::new(|_| true),
            },
        );
        response
    }
    #[tokio::test]
    async fn canceled_wait_removes_pending_approval_and_stale_response_cannot_approve_new_one() {
        let state = RunApprovalState::default();
        let lead = span_acp::SessionKey::new("connection", "session");
        let response = pending(&state, "first", lead.clone(), u64::MAX);
        {
            let _guard = PendingGuard {
                state: state.clone(),
                id: "first".into(),
                sink: Arc::new(|_| true),
            };
        }
        assert!(response.await.is_err());
        assert!(state.list().unwrap().is_empty());
        let next = pending(&state, "next", lead, u64::MAX);
        assert!(state.resolve("first", true).is_err());
        assert_eq!(state.list().unwrap().len(), 1);
        state.resolve("next", false).unwrap();
        assert!(!next.await.unwrap());
    }
    #[tokio::test]
    async fn expiry_and_connection_cancel_reject_approvals_without_affecting_other_leads() {
        let state = RunApprovalState::default();
        let expired = pending(&state, "expired", span_acp::SessionKey::new("a", "s"), 0);
        state.resolve("expired", true).unwrap();
        assert!(!expired.await.unwrap());
        let first = pending(&state, "a", span_acp::SessionKey::new("a", "s"), u64::MAX);
        let second = pending(&state, "b", span_acp::SessionKey::new("b", "s"), u64::MAX);
        state.cancel_connection("a");
        assert!(!first.await.unwrap());
        assert_eq!(state.list().unwrap().len(), 1);
        state.cancel_all();
        assert!(!second.await.unwrap());
    }
    #[test]
    fn snapshot_changes_on_config_or_manifest_edits_and_public_approval_omits_env_values() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = CoreWorkspace::open(directory.path()).unwrap();
        let before = workspace.run_configuration_snapshot().unwrap();
        workspace
            .save_run_configuration(RunConfiguration {
                id: String::new(),
                name: "test".into(),
                executable: "tool".into(),
                args: vec![],
                cwd: ".".into(),
                env: BTreeMap::from([("TOKEN".into(), "literal-private-value".into())]),
            })
            .unwrap();
        let after = workspace.run_configuration_snapshot().unwrap();
        assert_ne!(before, after);
        std::fs::write(
            directory.path().join("package.json"),
            r#"{"scripts":{"test":"a"}}"#,
        )
        .unwrap();
        assert_ne!(after, workspace.run_configuration_snapshot().unwrap());
        let state = RunApprovalState::default();
        let _response = pending(&state, "id", span_acp::SessionKey::new("a", "s"), u64::MAX);
        let public = serde_json::to_string(&state.list().unwrap()).unwrap();
        assert!(!public.contains("literal-private-value"));
        assert!(!public.contains("env\""));
        assert!(public.contains("envKeys"));
    }
}
