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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigChoice {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigGroup {
    /// Empty for options the agent did not group.
    pub name: String,
    pub choices: Vec<ConfigChoice>,
}

/// A select-style session option such as the model or the mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
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
    /// The folder the session belongs to, as the agent reported it. Lets the
    /// History scope chips tell this workspace from other folders.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The session that spawned this one with the agent's own subagent tool,
    /// when the agent named it. Set only together with `native_subagent`.
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// True for a session the agent created with its own subagent tool (not
    /// a Span delegation). History hides these by default and nests them
    /// under `parent_session_id`. Derived at list time; nothing is stored
    /// but the session ids (ADR 0005, amendment of 2026-10-29).
    #[serde(default)]
    pub native_subagent: bool,
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
    /// Which adapter normalises this agent: `claude`, `codex`, `gemini`, `opencode` or `generic`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub adapter: Option<String>,
    /// The agent writes files itself and ignores the client file system, so Span review cannot gate its edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub edits_bypass_review: Option<bool>,
    /// The agent asks permission and then also sends a write for review, so the user approves an edit twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub double_approval: Option<bool>,
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
    /// Set when the method needs a value from the user: use
    /// `agent_authenticate_with` and an [`AuthCredential`] of the same kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub input: Option<AuthInput>,
    /// For a gateway method, the wire protocol the agent expects from the
    /// gateway (`_meta.gateway.protocol`), for example `anthropic`,
    /// `bedrock` or `openai`. The UI offers provider presets by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub gateway_protocol: Option<String>,
    /// Set when the method cannot run from Span and the user must act instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub hint: Option<AgentHint>,
}

/// What an `agent` sign-in method asks the user for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AuthInput {
    /// An API key.
    ApiKey,
    /// A gateway base URL and request headers.
    Gateway,
}

/// A secret the user typed for an `agent` sign-in method. It is passed to the
/// agent in `authenticate` `_meta` and never logged or stored by Span.
#[derive(Clone, Deserialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AuthCredential {
    ApiKey {
        key: String,
    },
    Gateway {
        base_url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

/// Why a sign-in did not finish. Callers match `kind`, never the message.
/// No variant carries a credential: messages are Span's own text or the
/// agent's error, never the key, token or gateway headers that were sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthError {
    /// Another sign-in is already in flight on this connection. Nothing was sent.
    AuthenticationInProgress { message: String },
    /// The user cancelled the sign-in, or the connection closed or was
    /// replaced before it finished. Its result, if any, was dropped.
    Cancelled { message: String },
    /// Any other failure, with the message for the user.
    Failed { message: String },
}

impl AuthError {
    pub fn message(&self) -> &str {
        match self {
            Self::AuthenticationInProgress { message }
            | Self::Cancelled { message }
            | Self::Failed { message } => message,
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl From<String> for AuthError {
    fn from(message: String) -> Self {
        Self::Failed { message }
    }
}

impl From<&str> for AuthError {
    fn from(message: &str) -> Self {
        Self::Failed {
            message: message.to_owned(),
        }
    }
}

impl std::fmt::Debug for AuthCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ApiKey { .. } => f.write_str("ApiKey { key: [redacted] }"),
            Self::Gateway { headers, .. } => write!(
                f,
                "Gateway {{ base_url: [redacted], headers: {} [redacted] }}",
                headers.len()
            ),
        }
    }
}

/// A condition the UI words itself. The backend never sends display text for
/// these; the suggested English is in each variant's comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentHint {
    /// "Turn limit or loop detected". Gemini returns `max_turn_requests` for both.
    TurnLimitOrLoop,
    /// "Command ran, no output streamed". A slash command ended the turn silently.
    NoOutputStreamed,
    /// "Output not available from agent". A finished command reported no content.
    OutputUnavailable,
    /// "Run `opencode auth login` in a terminal, then retry".
    RunOpencodeAuthLogin,
    /// "Retrying". The agent is retrying a failed model request.
    Retrying,
    /// "Compacting conversation".
    Compacting,
    /// "Preparing tool". The agent has not named the tool call yet.
    ToolPending,
    /// "it will not ask before running tools, and Span's approval prompts
    /// will not appear". The session's mode lets the
    /// agent run tools without asking (bypassPermissions, agent-full-access,
    /// yolo, never); the notice title is the mode's name.
    PermissionsBypassed,
    /// "Stopped after you rejected a request". The turn ended `cancelled`
    /// after the user rejected a permission or an edit in it.
    RejectedByUser,
    /// "The agent still lists a conversation you deleted. Span hides it until
    /// you reconnect." The agent answered `session/delete` but kept the session.
    DeletedStillListed,
    /// "Run `opencode auth login` in a terminal, or choose another model,
    /// then retry". The current model's provider lacks credentials and the
    /// model option offers others.
    RunOpencodeAuthLoginOrSwitchModel,
    /// "needs setup in a terminal or environment variables, which Span does
    /// not do. Set it up, then reconnect." A sign-in method with no input
    /// Span can collect.
    NeedsEnvironmentSetup,
    /// "Request interrupted by user". A restored session replays an
    /// interrupted turn.
    InterruptedByUser,
}

/// A file a tool call touches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocation {
    pub path: String,
    pub line: Option<u32>,
}

/// A diff from tool call content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolDiff {
    /// Absolute when `resolved`; otherwise the path exactly as the agent sent it.
    pub path: String,
    pub resolved: bool,
    /// `add` when the agent sent no old text, otherwise `modify`. The agent's
    /// own `_meta.kind` is ignored because it is unreliable.
    pub change: String,
    pub old_text: Option<String>,
    pub new_text: String,
}

/// An image a tool call produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolImage {
    pub mime_type: Option<String>,
    /// Base64 data when the agent sent it.
    pub data: Option<String>,
    pub uri: Option<String>,
}

/// A non-text block in a replayed user turn, kept as a marker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserAttachment {
    /// `resourceLink`, `image` or `resource`.
    pub kind: String,
    pub uri: Option<String>,
    pub name: Option<String>,
    pub mime_type: Option<String>,
}

/// A launch command for an agent that is not installed from the registry.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreset {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The executable must already be on the user's PATH.
    pub launch: AgentCommand,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        message_id: Option<String>,
        /// Start a new bubble instead of appending to the previous one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        new_block: Option<bool>,
    },
    Thought {
        session_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        message_id: Option<String>,
        /// Start a new thought block instead of appending to the previous one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        new_block: Option<bool>,
    },
    /// A user turn replayed while an earlier session is restored.
    User {
        session_id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[specta(optional)]
        attachments: Vec<UserAttachment>,
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
        /// Set when the user must sign in outside Span.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        hint: Option<AgentHint>,
        /// The agent's own error text, set when it does not read as a
        /// sign-in request (for example an account or plan notice). Show it
        /// first; the sign-in methods are secondary.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        agent_message: Option<String>,
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
        /// Set for a notice the agent later clears with `noticeCleared`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        notice_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        hint: Option<AgentHint>,
    },
    /// A notice with this id no longer applies.
    NoticeCleared {
        session_id: String,
        notice_id: String,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        raw_input: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        raw_output: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[specta(optional)]
        locations: Vec<ToolLocation>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[specta(optional)]
        diffs: Vec<ToolDiff>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[specta(optional)]
        images: Vec<ToolImage>,
        /// A file the agent saved, such as a generated image. Reported only; Span does not open it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        saved_path: Option<String>,
        /// Agent bookkeeping rather than work the user asked for; show it collapsed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        internal: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        hint: Option<AgentHint>,
    },
    Permission {
        session_id: String,
        request_id: String,
        tool_call_id: String,
        title: String,
        options: Vec<PermissionOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        tool_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        raw_input: Option<serde_json::Value>,
        /// The tool call content blocks as sent, for example diff previews.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        content: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[specta(optional)]
        locations: Vec<ToolLocation>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[specta(optional)]
        diffs: Vec<ToolDiff>,
        /// The tool call `_meta` as sent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        meta: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        internal: Option<bool>,
    },
    PermissionResolved {
        session_id: String,
        request_id: String,
    },
    /// The thread's Span permission mode (ADR 0015), sent when a session
    /// starts or is restored and after every change. `supported` lists the
    /// modes this session can run in; `child` is true for a delegated child,
    /// which can never be looser than Ask.
    PermissionMode {
        session_id: String,
        mode: span_core::ThreadPermissionMode,
        supported: Vec<span_core::ThreadPermissionMode>,
        child: bool,
        /// Agent option ids the mode sets (the agent's mode option, Codex's
        /// collaboration mode). The UI shows the Span modes in their place.
        managed: Vec<String>,
    },
    /// Span answered a permission request itself under the thread's mode,
    /// without prompting (ADR 0015): `rejected` in Plan mode, `allowed` in
    /// Accept edits, Auto and Full. Logged in the feed.
    PermissionAuto {
        session_id: String,
        tool_call_id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        tool_kind: Option<String>,
        /// `allowed` or `rejected`.
        decision: String,
        reason: span_core::PolicyReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        raw_input: Option<serde_json::Value>,
    },
    /// The agent reports a mode other than the one the thread's Span mode
    /// needs (it switched itself, or reset a setting). `resolved` false: the
    /// mismatch was seen, Span keeps enforcing the thread's mode and tries
    /// once to set the agent back; `resolved` true: the agent is back.
    ModeMismatch {
        session_id: String,
        mode: span_core::ThreadPermissionMode,
        /// The agent option id that differs.
        config_id: String,
        expected: String,
        actual: String,
        resolved: bool,
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
        /// Token usage from the prompt response, when the agent sent it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        usage: Option<serde_json::Value>,
        /// The prompt response `_meta`, when the agent sent it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        meta: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        hint: Option<AgentHint>,
    },
    Error {
        /// The session whose turn failed. Absent for connection level errors.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[specta(optional)]
        session_id: Option<String>,
        message: String,
    },
    /// span-agents delegation activity (tool server attached or not, tasks
    /// started and finished, decisions). Session identity is inside `event`.
    Delegation {
        event: crate::tools::DelegationEvent,
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
