use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub priority: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigGroup {
    /// Empty for options the agent did not group.
    pub name: String,
    pub choices: Vec<ConfigChoice>,
}

/// A select-style session option such as the model or the mode.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Agent supplied category, for example `model` or `mode`.
    pub category: Option<String>,
    pub current_value: String,
    pub groups: Vec<ConfigGroup>,
}

/// A past conversation the agent can restore.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Status {
        state: String,
        message: String,
    },
    Session {
        session_id: String,
    },
    Text {
        session_id: String,
        text: String,
    },
    Thought {
        session_id: String,
        text: String,
    },
    /// A user turn replayed while an earlier session is restored.
    User {
        session_id: String,
        text: String,
    },
    Capabilities {
        can_load_session: bool,
        can_list_sessions: bool,
    },
    Plan {
        session_id: String,
        entries: Vec<PlanEntry>,
    },
    Config {
        session_id: String,
        options: Vec<ConfigOption>,
    },
    Tool {
        session_id: String,
        tool_call_id: String,
        title: Option<String>,
        status: Option<String>,
        /// ACP tool kind such as `read`, `edit` or `execute`.
        tool_kind: Option<String>,
        /// Set when an agent reports the call as made by a subagent.
        parent_tool_call_id: Option<String>,
        content_json: String,
    },
    Permission {
        session_id: String,
        request_id: String,
        tool_call_id: String,
        title: String,
        options: Vec<PermissionOption>,
    },
    PermissionResolved {
        session_id: String,
        request_id: String,
    },
    Proposal {
        session_id: String,
        proposal: span_core::EditProposal,
    },
    ProposalResolved {
        session_id: String,
        proposal_id: String,
        accepted: bool,
    },
    Log {
        direction: String,
        line: String,
    },
    Complete {
        session_id: String,
        stop_reason: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub icon: Option<String>,
    /// Phase 0.1 installs pinned npm distributions. Other transports remain visible.
    pub installable: bool,
    pub package: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgent {
    pub id: String,
    pub version: String,
    pub launch: AgentCommand,
}
