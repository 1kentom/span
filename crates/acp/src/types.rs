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

/// A slash command the agent advertises. Run it by sending `/name args` as prompt text.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    pub input_hint: Option<String>,
}

/// What the agent said it supports during `initialize`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentFeatures {
    pub load_session: bool,
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
    pub can_list_sessions: bool,
    pub can_resume_sessions: bool,
    pub can_close_sessions: bool,
    pub can_delete_sessions: bool,
}

/// An authentication method from `initialize`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `agent` methods run through `authenticate`. `terminal` methods need an
    /// interactive login this client does not implement.
    pub kind: String,
    /// Whether `agent_authenticate` accepts this method.
    pub supported: bool,
}

/// Extra prompt content. Plain text always travels in the prompt text itself.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PromptAttachment {
    /// Needs the agent's `image` prompt capability. `data` is base64.
    Image {
        data: String,
        mime_type: String,
        uri: Option<String>,
    },
    /// Supported by every agent.
    ResourceLink {
        uri: String,
        name: String,
        mime_type: Option<String>,
        description: Option<String>,
    },
    /// Needs the agent's `embeddedContext` prompt capability. Give `text` or base64 `blob`.
    Resource {
        uri: String,
        mime_type: Option<String>,
        text: Option<String>,
        blob: Option<String>,
    },
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
    /// Negotiated agent identity, features and sign-in methods, sent once after initialize.
    Ready {
        agent_name: Option<String>,
        agent_title: Option<String>,
        agent_version: Option<String>,
        features: AgentFeatures,
        auth_methods: Vec<AuthMethodInfo>,
    },
    /// Session creation needs `agent_authenticate` first.
    AuthRequired {
        message: String,
        auth_methods: Vec<AuthMethodInfo>,
    },
    AvailableCommands {
        session_id: String,
        commands: Vec<SlashCommand>,
    },
    CurrentMode {
        session_id: String,
        mode_id: String,
    },
    SessionInfo {
        session_id: String,
        title: Option<String>,
        updated_at: Option<String>,
    },
    Usage {
        session_id: String,
        used: u64,
        size: u64,
        cost_amount: Option<f64>,
        cost_currency: Option<String>,
    },
    Notice {
        session_id: String,
        /// `info`, `warning`, `error`, or an agent specific value.
        severity: String,
        title: String,
        description: Option<String>,
    },
    Compaction {
        session_id: String,
        compaction_id: String,
        /// `in_progress`, `completed`, `failed`, `cancelled` or an agent specific value.
        status: String,
        summary: Option<String>,
        error: Option<String>,
    },
    CompactionSummary {
        session_id: String,
        compaction_id: String,
        text: String,
    },
    /// The agent asks the user for input. Answer with `agent_elicitation`.
    Elicitation {
        request_id: String,
        session_id: Option<String>,
        tool_call_id: Option<String>,
        /// `form` or `url`.
        mode: String,
        message: String,
        /// Form mode: the requested JSON schema, serialized.
        schema_json: Option<String>,
        /// URL mode: show the full URL and ask for consent before opening it.
        url: Option<String>,
        elicitation_id: Option<String>,
    },
    ElicitationResolved {
        request_id: String,
    },
    /// A URL elicitation finished on the agent side.
    ElicitationComplete {
        elicitation_id: String,
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
