//! `span-agents`: the MCP tool server that lets a lead agent delegate to
//! other agents through Span (#52) under the guardrails of #53.
//!
//! ACP has no agent-to-agent messaging, so Span brokers. One server runs per
//! lead session, in process, as MCP Streamable HTTP on 127.0.0.1 with a
//! random port and a per-session bearer token. It only holds an
//! [`AgentControl`](crate::AgentControl) for the lead, so no tool can answer
//! a permission, an elicitation or an edit review: those stay with the user.
//! See docs/decisions/0003-span-agents-tool-server.md.
mod budget;
mod host;
mod result;
mod server;
mod tasks;

pub use budget::{Budget, BudgetRequest, Meter};
pub use host::{LeadDelegation, LeadServers};
pub use result::{
    base64, file_uri, inside_workspace, mime_type, sha256_hex, Artifact, FailureReason, UsageReport,
};
pub use server::{tool_definitions, ToolServer, MCP_PROTOCOL_VERSIONS, SERVER_NAME};
pub use tasks::DecisionRecord;

use crate::{AgentFeatures, InstalledAgent, SessionKey};
use serde::{Deserialize, Serialize};
use span_core::CoreWorkspace;
use specta::Type;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Guardrails and limits for one server.
#[derive(Debug, Clone)]
pub struct ToolPolicy {
    /// Deepest session that may exist below a user session. 1 (default):
    /// the lead may delegate, its children may not.
    pub max_depth: u32,
    /// Budget ceiling for each delegation. A lead can only lower it.
    pub budget: Budget,
    /// Longest `get_result` wait, in policy seconds. Default 30.
    pub max_wait_seconds: u64,
    /// Seconds between progress notifications while waiting. Default 5.
    pub progress_interval_seconds: u64,
    /// Largest image sent inline to a lead that accepts images. Default 256 KiB.
    pub image_preview_bytes: usize,
    /// Length of one policy second. One real second in production; tests
    /// shorten it to run a minutes long child in seconds.
    pub second: Duration,
}

impl Default for ToolPolicy {
    fn default() -> Self {
        Self {
            max_depth: 1,
            budget: Budget::default(),
            max_wait_seconds: 30,
            progress_interval_seconds: 5,
            image_preview_bytes: 256 * 1024,
            second: Duration::from_secs(1),
        }
    }
}

/// Delegation events for the UI. The desktop forwards them on the agent
/// event channel as `AgentEvent::Delegation`. Named so it does not clash
/// with the UI's own `ToolEvent` (an ACP tool call).
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DelegationEvent {
    /// The lead recorded a decision (`record_decision`, #54).
    Decision {
        lead: SessionKey,
        decision: DecisionRecord,
    },
    /// The lead started a child.
    Delegated {
        lead: SessionKey,
        child: SessionKey,
        task_id: String,
        agent_name: String,
    },
    /// A task finished, successfully or not.
    TaskFinished {
        lead: SessionKey,
        child: SessionKey,
        task_id: String,
        status: String,
        reason: Option<FailureReason>,
    },
    /// A delegated child session asked the user for a permission or an
    /// elicitation. Carries everything the UI needs to show and answer it
    /// (through `agent_child_permission` or `agent_elicitation`, user only)
    /// without matching by session. The plain `Permission` or `Elicitation`
    /// agent event is still sent as well.
    ChildPermission {
        lead: SessionKey,
        child: SessionKey,
        /// The task running in the child when the request arrived.
        task_id: Option<String>,
        agent_name: String,
        connection_id: String,
        session_id: String,
        request_id: String,
        /// `permission` or `elicitation`.
        request_kind: String,
    },
    /// The delegation tools were offered to this lead session.
    Attached {
        lead: SessionKey,
        agent_name: String,
    },
    /// The lead's server stopped (the session ended or delegation was
    /// turned off); its children were cancelled.
    Detached { lead: SessionKey },
    /// Delegation is enabled but this connection's sessions do not get the
    /// tools, with the reason to show the user.
    Unavailable {
        connection_id: String,
        agent_name: String,
        reason: String,
    },
}

/// Delegation state of the active connection and lead session, for the UI.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationStatus {
    /// The `agents.delegation.enabled` setting.
    pub enabled: bool,
    /// The connected agent advertises MCP over HTTP.
    pub available: bool,
    /// Why the tools are not offered, when they are not.
    pub reason: Option<String>,
    pub lead: Option<SessionKey>,
    /// The lead session has a running span-agents server.
    pub attached: bool,
    pub tasks: Vec<DelegationTask>,
    pub decisions: Vec<DecisionRecord>,
}

/// One delegated task, for listing.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationTask {
    pub task_id: String,
    pub lead: SessionKey,
    pub child: SessionKey,
    pub agent_name: String,
    /// `queued`, `running`, `completed` or `failed`.
    pub status: String,
    pub stop_reason: Option<String>,
    pub reason: Option<FailureReason>,
    pub detail: Option<String>,
    /// Milliseconds since the Unix epoch when the task was registered.
    pub started_at_ms: u64,
    /// Set once the task finished.
    pub finished_at_ms: Option<u64>,
    /// The child's last reported activity (what its latest event was), only
    /// when the child reported any.
    pub progress_text: Option<String>,
    /// The start of the text the child wrote, bounded; finished tasks only.
    pub result_summary: Option<String>,
    /// Files the task changed or was asked to save; finished tasks only.
    pub artifacts: Vec<Artifact>,
    /// Usage of the whole delegation (all its prompts) so far. `tokens` is
    /// only set when the agent reports it.
    pub budget_used: UsageReport,
}

pub type DelegationEventSink = Arc<dyn Fn(DelegationEvent) + Send + Sync>;

/// What a server needs besides the session manager.
#[derive(Clone)]
pub struct ToolServerConfig {
    pub workspace: Arc<Mutex<CoreWorkspace>>,
    pub policy: ToolPolicy,
    /// Installed but not connected agents, listed for the lead. Starting
    /// them stays a user action.
    pub installed: Vec<InstalledAgent>,
    pub events: Option<DelegationEventSink>,
}

/// How the server would reach the lead agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Http,
}

/// Pick the transport from the lead's `mcpCapabilities`. Only Streamable
/// HTTP is served: agents that advertise neither, or only the deprecated
/// HTTP+SSE transport, do not get the server.
pub fn transport_for(features: &AgentFeatures) -> Result<Transport, String> {
    if features.mcp_http {
        Ok(Transport::Http)
    } else if features.mcp_sse {
        Err("The agent advertises only the deprecated MCP HTTP+SSE transport. span-agents serves Streamable HTTP, so delegation tools were not attached.".into())
    } else {
        Err("The agent does not advertise mcpCapabilities.http, so delegation tools were not attached.".into())
    }
}

/// Capabilities Span knows about that ACP does not advertise. These are
/// hints Span maintains, never reported by the agent.
pub const CAPABILITY_HINTS: &[(&str, &[&str])] = &[("codex", &["image_generation"])];

pub fn hints_for(agent_name: &str) -> Vec<String> {
    let name = agent_name.to_lowercase();
    CAPABILITY_HINTS
        .iter()
        .filter(|(needle, _)| name.contains(needle))
        .flat_map(|(_, hints)| hints.iter().map(|h| (*h).to_owned()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_capable_agents_get_the_server() {
        let mut features = AgentFeatures::default();
        assert!(transport_for(&features).is_err());
        features.mcp_sse = true;
        assert!(transport_for(&features).unwrap_err().contains("HTTP+SSE"));
        features.mcp_http = true;
        assert_eq!(transport_for(&features), Ok(Transport::Http));
    }

    #[test]
    fn hints_are_matched_by_agent_name() {
        assert_eq!(hints_for("codex-acp"), vec!["image_generation"]);
        assert!(hints_for("gemini").is_empty());
    }
}
