//! Per-agent adapters. Each known agent (Claude Code, Codex, Gemini CLI,
//! OpenCode) has quirks in what it sends over ACP; its adapter rewrites them
//! into the shape every other agent uses before events reach the UI. Unknown
//! agents get [`generic::Generic`], which rewrites nothing.
//!
//! Adapters annotate an update with a private `_span` object (internal, hint,
//! newBlock, noticeId, parentToolCallId, savedPath, placeholder). The mapper in
//! [`map`] reads it into typed event fields and strips it from `contentJson`.
//!
//! See docs/decisions/0002-adapter-normalisation.md.
mod claude;
mod codex;
mod gemini;
mod generic;
pub(crate) mod map;
mod opencode;

use crate::{AgentCommand, AgentEvent, AgentHint, AuthMethodInfo, ConfigOption, PermissionOption};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub use opencode::agent_presets;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentKind {
    Claude,
    Codex,
    Gemini,
    OpenCode,
    Generic,
}

impl AgentKind {
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::OpenCode => "opencode",
            Self::Generic => "generic",
        }
    }

    /// The `initialize` agent name decides. Without one, the launch command
    /// and its arguments are checked, so `opencode acp` or an npx package
    /// such as `@zed-industries/codex-acp` is still recognised.
    pub(crate) fn detect(agent_name: Option<&str>, command: &AgentCommand) -> Self {
        if let Some(kind) = agent_name.and_then(Self::from_text) {
            return kind;
        }
        std::iter::once(&command.command)
            .chain(&command.args)
            .flat_map(|part| {
                Path::new(part)
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
            .find_map(|part| Self::from_text(&part))
            .unwrap_or(Self::Generic)
    }

    fn from_text(text: &str) -> Option<Self> {
        let text = text.to_ascii_lowercase();
        if text.contains("claude") {
            Some(Self::Claude)
        } else if text.contains("codex") {
            Some(Self::Codex)
        } else if text.contains("gemini") {
            Some(Self::Gemini)
        } else if text.contains("opencode") {
            Some(Self::OpenCode)
        } else {
            None
        }
    }
}

/// Fixed behaviour of an agent, separate from per-update rewriting.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Profile {
    /// How long Stop may take before the connection is terminated.
    pub stop_deadline: Duration,
    /// The agent answers `session/load` before its replay ends. Hold the
    /// load result (and refuse prompts) until updates are quiet this long.
    pub replay_quiet: Option<Duration>,
    pub edits_bypass_review: bool,
    pub double_approval: bool,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            stop_deadline: Duration::from_secs(5),
            replay_quiet: None,
            edits_bypass_review: false,
            double_approval: false,
        }
    }
}

/// Which request applies a config change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfigRoute {
    /// `session/set_config_option`.
    Option,
    /// `session/set_mode`, for options synthesised from legacy `modes`.
    Mode,
    /// Unstable `session/set_model`, for options synthesised from legacy `models`.
    Model,
}

/// What an adapter remembers about one session.
#[derive(Debug, Default)]
pub(crate) struct SessionState {
    /// Every tool call so far, merged field by field (last non-null wins).
    pub tools: HashMap<String, Value>,
    /// Tool calls that have been reported `in_progress` at least once.
    pub started: std::collections::HashSet<String>,
    /// Last `messageId` per chunk kind.
    pub message_ids: HashMap<String, String>,
    /// The agent streamed message or thought text in the current turn.
    pub output: bool,
    /// The current turn's prompt starts with `/`.
    pub slash: bool,
    /// Options synthesised from legacy `modes` and `models`. Non-empty means
    /// changes are routed to `set_mode` and `set_model`.
    pub legacy: Vec<ConfigOption>,
    /// The last config options the UI was sent, with mode changes applied.
    pub config: Vec<ConfigOption>,
    /// The current mode value that lets the agent run tools without asking,
    /// while the permission bypass notice is raised.
    pub bypass: Option<String>,
}

/// Mode and option values under which the agent runs tools without asking,
/// as seen in live runs and adapter source: Claude `bypassPermissions`,
/// Codex `agent-full-access` (and its `never` approval policy), Gemini
/// `yolo`. Other values are not guessed.
const BYPASS_VALUES: &[&str] = &["bypassPermissions", "agent-full-access", "yolo", "never"];
/// The `noticeId` of the permission bypass notice.
pub(crate) const BYPASS_NOTICE: &str = "span/permission-bypass";

fn is_mode_option(option: &ConfigOption) -> bool {
    option.category.as_deref() == Some("mode") || option.id == "mode"
}

/// The display name of `value` among the options, else the value itself.
fn choice_name(options: &[ConfigOption], value: &str) -> String {
    options
        .iter()
        .flat_map(|option| option.groups.iter().flat_map(|group| &group.choices))
        .find(|choice| choice.value == value)
        .map(|choice| choice.name.clone())
        .unwrap_or_else(|| value.to_owned())
}

/// `option` offers `value` as a choice.
fn has_choice(option: &ConfigOption, value: &str) -> bool {
    option
        .groups
        .iter()
        .any(|group| group.choices.iter().any(|choice| choice.value == value))
}

/// Agent specific rewriting. Every method defaults to changing nothing.
pub(crate) trait Quirks: Send + Sync {
    fn profile(&self) -> Profile {
        Profile::default()
    }
    /// Rewrite one `session/update`. Returns the updates to map, in order.
    fn update(&self, _state: &mut SessionState, update: Value) -> Vec<Value> {
        vec![update]
    }
    /// Config options for an agent that returns legacy `modes` and `models`
    /// and no `configOptions` from `session/new` and `session/load`.
    fn legacy_config(&self, _response: &Value) -> Vec<ConfigOption> {
        Vec::new()
    }
    /// Return `None` to leave an MCP server out of `session/new`. Servers
    /// the agent did not advertise a transport for are already removed.
    fn mcp_server(&self, server: Value) -> Option<Value> {
        Some(server)
    }
    /// Updates to synthesise once the user answered a permission request.
    fn after_permission(
        &self,
        _state: &mut SessionState,
        _tool_call_id: &str,
        _allowed: bool,
    ) -> Vec<Value> {
        Vec::new()
    }
    /// Adjust an advertised sign-in method. `meta` is the method's `_meta`.
    fn auth_method(&self, _method: &mut AuthMethodInfo, _meta: Option<&Value>) {}
    /// Shown with an `AuthRequired` from this agent. `state` is the session
    /// whose request failed, when there is one.
    fn auth_hint(&self, _state: Option<&SessionState>) -> Option<AgentHint> {
        None
    }
    fn complete_hint(&self, _state: &SessionState, _stop_reason: &str) -> Option<AgentHint> {
        None
    }
    fn internal_permission(&self, _tool_call_id: &str) -> bool {
        false
    }
    /// The mode value that asks before running tools, used in place of a
    /// bypass mode when a session starts under the approval start mode.
    /// `None` leaves the mode as the agent started it.
    fn approval_mode(&self, option: &ConfigOption) -> Option<String> {
        has_choice(option, "default").then(|| "default".into())
    }
    /// `_meta` for `session/new` under the approval start mode, for example
    /// to leave out tools that reach other sessions on the machine.
    fn approval_session_meta(&self) -> Option<Value> {
        None
    }
    /// `_meta` for the `session/new` of a session Span opens for itself (a
    /// delegated child, the health check) that should stay out of the
    /// agent's own resume list. `None` when the agent has no such option.
    fn ephemeral_session_meta(&self) -> Option<Value> {
        None
    }
}

/// MCP transports the agent advertised in `initialize`.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct McpCaps {
    pub http: bool,
    pub sse: bool,
    pub acp: bool,
}

/// One connection's adapter and per-session state.
pub(crate) struct Adapter {
    kind: AgentKind,
    quirks: Box<dyn Quirks>,
    root: PathBuf,
    sessions: Mutex<HashMap<String, SessionState>>,
}

impl Default for Adapter {
    fn default() -> Self {
        Self::new(AgentKind::Generic, PathBuf::new())
    }
}

impl Adapter {
    /// `root` is the canonical workspace root, used to resolve relative diff paths.
    pub(crate) fn new(kind: AgentKind, root: PathBuf) -> Self {
        let quirks: Box<dyn Quirks> = match kind {
            AgentKind::Claude => Box::new(claude::Claude),
            AgentKind::Codex => Box::new(codex::Codex),
            AgentKind::Gemini => Box::new(gemini::Gemini),
            AgentKind::OpenCode => Box::new(opencode::OpenCode),
            AgentKind::Generic => Box::new(generic::Generic),
        };
        Self {
            kind,
            quirks,
            root,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn kind(&self) -> AgentKind {
        self.kind
    }

    pub(crate) fn profile(&self) -> Profile {
        self.quirks.profile()
    }

    fn with<R>(&self, session: &str, f: impl FnOnce(&mut SessionState) -> R) -> R {
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        f(sessions.entry(session.to_owned()).or_default())
    }

    pub(crate) fn forget(&self, session: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(session);
    }

    /// Normalise one `session/update` into the events the UI receives.
    pub(crate) fn normalise(&self, session: &str, mut update: Value) -> Vec<AgentEvent> {
        // A new tool call without a status is pending; the typed schema drops
        // the default when it re-serializes, so it is restored here.
        // The same holds for kind `other` (an MCP tool call, for example).
        if text(&update, "sessionUpdate").as_deref() == Some("tool_call") {
            if update.get("status").is_none() {
                update["status"] = json!("pending");
            }
            if update.get("kind").is_none() {
                update["kind"] = json!("other");
            }
        }
        let updates = self.with(session, |state| {
            let mut updates = self.quirks.update(state, update);
            for update in &mut updates {
                track(state, update);
            }
            updates
        });
        let mut events = Vec::new();
        for event in updates
            .into_iter()
            .filter_map(|update| map::event(session, update, &self.root))
        {
            let extra = self.observe(session, &event);
            events.push(event);
            events.extend(extra);
        }
        events
    }

    /// Bookkeeping for a `Config` or `CurrentMode` event the UI is sent:
    /// remembers the options and returns the permission bypass notice when
    /// the mode starts letting the agent run tools without asking, or its
    /// clearing when the mode becomes a safe one again. Other events return
    /// nothing.
    pub(crate) fn observe(&self, session: &str, event: &AgentEvent) -> Vec<AgentEvent> {
        self.with(session, |state| {
            let current = match event {
                // An empty list (an agent answering a change with `{}`)
                // says nothing about the mode.
                AgentEvent::Config { options, .. } if options.is_empty() => return Vec::new(),
                AgentEvent::Config { options, .. } => {
                    state.config = options.clone();
                    state
                        .config
                        .iter()
                        .filter(|option| is_mode_option(option))
                        .map(|option| option.current_value.clone())
                        .find(|value| BYPASS_VALUES.contains(&value.as_str()))
                }
                AgentEvent::CurrentMode { mode_id, .. } => {
                    for option in state.config.iter_mut().filter(|o| {
                        is_mode_option(o)
                            && o.groups
                                .iter()
                                .any(|g| g.choices.iter().any(|c| &c.value == mode_id))
                    }) {
                        option.current_value = mode_id.clone();
                    }
                    BYPASS_VALUES
                        .contains(&mode_id.as_str())
                        .then(|| mode_id.clone())
                }
                _ => return Vec::new(),
            };
            if current == state.bypass {
                return Vec::new();
            }
            state.bypass = current.clone();
            vec![match current {
                Some(value) => AgentEvent::Notice {
                    session_id: session.to_owned(),
                    severity: "warning".into(),
                    title: choice_name(&state.config, &value),
                    description: None,
                    notice_id: Some(BYPASS_NOTICE.into()),
                    hint: Some(AgentHint::PermissionsBypassed),
                },
                None => AgentEvent::NoticeCleared {
                    session_id: session.to_owned(),
                    notice_id: BYPASS_NOTICE.into(),
                },
            }]
        })
    }

    /// Under the approval start mode: the mode option to change, and the
    /// value to change it to, when `options` start in a bypass mode.
    pub(crate) fn approval_change(&self, options: &[ConfigOption]) -> Option<(String, String)> {
        options
            .iter()
            .filter(|option| {
                is_mode_option(option) && BYPASS_VALUES.contains(&option.current_value.as_str())
            })
            .find_map(|option| {
                self.quirks
                    .approval_mode(option)
                    .filter(|value| value != &option.current_value && has_choice(option, value))
                    .map(|value| (option.id.clone(), value))
            })
    }

    /// `_meta` for `session/new` under the approval start mode.
    pub(crate) fn ephemeral_session_meta(&self) -> Option<Value> {
        self.quirks.ephemeral_session_meta()
    }
    pub(crate) fn approval_session_meta(&self) -> Option<Value> {
        self.quirks.approval_session_meta()
    }

    pub(crate) fn begin_turn(&self, session: &str, slash: bool) {
        self.with(session, |state| {
            state.output = false;
            state.slash = slash;
        });
    }

    /// The `Complete` event for a prompt response.
    pub(crate) fn complete(&self, session: &str, response: &Value) -> AgentEvent {
        let stop_reason = response
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let hint = self.with(session, |state| {
            self.quirks.complete_hint(state, &stop_reason)
        });
        AgentEvent::Complete {
            session_id: session.to_owned(),
            usage: response.get("usage").filter(|v| !v.is_null()).cloned(),
            meta: response.get("_meta").filter(|v| !v.is_null()).cloned(),
            stop_reason,
            hint,
        }
    }

    /// Config options from a `session/new` or `session/load` response. When
    /// the agent sent none, legacy `modes` and `models` are converted.
    pub(crate) fn session_config(&self, session: &str, response: &Value) -> Vec<ConfigOption> {
        let options = map::config_options_value(response.get("configOptions"));
        if !options.is_empty() {
            self.with(session, |state| state.legacy.clear());
            return options;
        }
        let legacy = self.quirks.legacy_config(response);
        self.with(session, |state| state.legacy = legacy.clone());
        legacy
    }

    pub(crate) fn route(&self, session: &str, config_id: &str) -> ConfigRoute {
        self.with(session, |state| {
            match state
                .legacy
                .iter()
                .find(|option| option.id == config_id)
                .and_then(|option| option.category.as_deref())
            {
                Some("mode") => ConfigRoute::Mode,
                Some("model") => ConfigRoute::Model,
                _ => ConfigRoute::Option,
            }
        })
    }

    /// Record a legacy mode or model change the agent accepted. Returns the
    /// updated options to send to the UI.
    pub(crate) fn legacy_applied(
        &self,
        session: &str,
        config_id: &str,
        value: &str,
    ) -> Vec<ConfigOption> {
        self.with(session, |state| {
            for option in state.legacy.iter_mut().filter(|o| o.id == config_id) {
                option.current_value = value.to_owned();
            }
            state.legacy.clone()
        })
    }

    /// The MCP servers to send in `session/new` and `session/load`: only
    /// transports the agent advertised (stdio always), then agent rules.
    pub(crate) fn mcp_servers(&self, caps: McpCaps, servers: &[Value]) -> Vec<Value> {
        servers
            .iter()
            .filter(|server| match mcp_transport(server) {
                "stdio" => true,
                "http" => caps.http,
                "sse" => caps.sse,
                "acp" => caps.acp,
                _ => false,
            })
            .filter_map(|server| self.quirks.mcp_server(server.clone()))
            .collect()
    }

    pub(crate) fn after_permission(
        &self,
        session: &str,
        tool_call_id: &str,
        allowed: bool,
    ) -> Vec<AgentEvent> {
        let updates = self.with(session, |state| {
            let mut updates = self.quirks.after_permission(state, tool_call_id, allowed);
            for update in &mut updates {
                track(state, update);
            }
            updates
        });
        updates
            .into_iter()
            .filter_map(|update| map::event(session, update, &self.root))
            .collect()
    }

    /// The `Permission` event, forwarding everything the agent sent about the tool call.
    pub(crate) fn permission(
        &self,
        session: &str,
        request_id: &str,
        request: &Value,
        options: Vec<PermissionOption>,
    ) -> AgentEvent {
        let tool = request.get("toolCall").cloned().unwrap_or(Value::Null);
        let tool_call_id = text(&tool, "toolCallId").unwrap_or_default();
        let internal = self.quirks.internal_permission(&tool_call_id)
            || self.with(session, |state| {
                state
                    .tools
                    .get(&tool_call_id)
                    .and_then(|t| t.pointer("/_span/internal"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            });
        let locations = map::locations(&tool);
        AgentEvent::Permission {
            session_id: session.to_owned(),
            request_id: request_id.to_owned(),
            title: text(&tool, "title").unwrap_or_else(|| "Agent operation".into()),
            options,
            tool_kind: text(&tool, "kind"),
            raw_input: tool.get("rawInput").filter(|v| !v.is_null()).cloned(),
            content: tool
                .get("content")
                .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
                .cloned(),
            diffs: map::diffs(&tool, &locations, &self.root),
            locations,
            meta: tool.get("_meta").filter(|v| !v.is_null()).cloned(),
            internal: internal.then_some(true),
            tool_call_id,
        }
    }

    /// Fill agent specific details into the advertised sign-in methods.
    pub(crate) fn auth_method(&self, method: &mut AuthMethodInfo, meta: Option<&Value>) {
        self.quirks.auth_method(method, meta);
    }

    /// The hint for an `AuthRequired` raised by a request on `session`, or
    /// by a connection level request when `None`.
    pub(crate) fn auth_hint(&self, session: Option<&str>) -> Option<AgentHint> {
        match session {
            Some(session) => self.with(session, |state| self.quirks.auth_hint(Some(state))),
            None => self.quirks.auth_hint(None),
        }
    }
}

/// Bookkeeping every adapter relies on, applied to each update it produced.
fn track(state: &mut SessionState, update: &mut Value) {
    let kind = text(update, "sessionUpdate").unwrap_or_default();
    match kind.as_str() {
        "agent_message_chunk" | "agent_thought_chunk" => {
            state.output = true;
            if let Some(id) = text(update, "messageId") {
                if state.message_ids.get(&kind) != Some(&id) {
                    annotate(update, "newBlock", json!(true));
                    state.message_ids.insert(kind, id);
                }
            }
        }
        "tool_call" | "tool_call_update" => {
            let Some(id) = text(update, "toolCallId") else {
                return;
            };
            if text(update, "status").as_deref() == Some("in_progress") {
                state.started.insert(id.clone());
            }
            let merged = merge_tool(state.tools.get(&id), update);
            state.tools.insert(id, merged);
        }
        "current_mode_update" => {
            if let Some(mode) = text(update, "currentModeId") {
                for option in state
                    .legacy
                    .iter_mut()
                    .filter(|o| o.category.as_deref() == Some("mode"))
                {
                    option.current_value = mode.clone();
                }
            }
        }
        _ => {}
    }
}

/// Merge a tool call update onto what is known: each field keeps its last
/// non-null value. `_span` annotations merge key by key.
pub(crate) fn merge_tool(previous: Option<&Value>, update: &Value) -> Value {
    let mut merged = previous.cloned().unwrap_or_else(|| json!({}));
    if let (Some(target), Some(source)) = (merged.as_object_mut(), update.as_object()) {
        for (key, value) in source {
            if value.is_null() {
                continue;
            }
            if key == "_span" {
                let span = target
                    .entry("_span")
                    .or_insert_with(|| Value::Object(Map::new()));
                if let (Some(span), Some(source)) = (span.as_object_mut(), value.as_object()) {
                    span.extend(source.clone());
                }
                continue;
            }
            target.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// Set one `_span` annotation on an update.
pub(crate) fn annotate(update: &mut Value, key: &str, value: Value) {
    if let Some(object) = update.as_object_mut() {
        let span = object
            .entry("_span")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(span) = span.as_object_mut() {
            span.insert(key.to_owned(), value);
        }
    }
}

pub(crate) fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn mcp_transport(server: &Value) -> &str {
    server
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("stdio")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn command(command: &str, args: &[&str]) -> AgentCommand {
        AgentCommand {
            command: command.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: BTreeMap::new(),
        }
    }

    #[test]
    fn detects_from_agent_name_then_command() {
        let node = command("node", &["/tmp/fixture.mjs"]);
        assert_eq!(
            AgentKind::detect(Some("gemini-cli"), &node),
            AgentKind::Gemini
        );
        assert_eq!(
            AgentKind::detect(Some("@zed-industries/claude-agent-acp"), &node),
            AgentKind::Claude
        );
        assert_eq!(
            AgentKind::detect(Some("OpenCode"), &node),
            AgentKind::OpenCode
        );
        assert_eq!(
            AgentKind::detect(Some("codex-acp"), &node),
            AgentKind::Codex
        );
        assert_eq!(
            AgentKind::detect(Some("span-test-peer"), &node),
            AgentKind::Generic
        );
        assert_eq!(
            AgentKind::detect(None, &command("/usr/local/bin/opencode", &["acp"])),
            AgentKind::OpenCode
        );
        assert_eq!(
            AgentKind::detect(
                None,
                &command(
                    "node",
                    &["/cache/agents/codex/node_modules/@zed-industries/codex-acp/bin.js"]
                )
            ),
            AgentKind::Codex
        );
        assert_eq!(AgentKind::detect(None, &node), AgentKind::Generic);
    }

    #[test]
    fn merge_keeps_last_non_null_field() {
        let first = json!({"toolCallId": "t", "title": "bash", "kind": "execute", "rawInput": {}});
        let second = json!({"toolCallId": "t", "status": "completed", "title": null});
        let merged = merge_tool(Some(&first), &second);
        assert_eq!(merged["title"], "bash");
        assert_eq!(merged["status"], "completed");
        assert_eq!(merged["kind"], "execute");
    }

    #[test]
    fn mcp_servers_are_gated_by_advertised_transport() {
        let servers = vec![
            json!({"name": "local", "command": "x", "args": [], "env": []}),
            json!({"type": "http", "name": "remote", "url": "https://a", "headers": []}),
            json!({"type": "sse", "name": "events", "url": "https://b", "headers": []}),
            json!({"type": "acp", "name": "inline", "id": "c"}),
        ];
        let generic = Adapter::default();
        let none = generic.mcp_servers(McpCaps::default(), &servers);
        assert_eq!(none.len(), 1);
        let all = generic.mcp_servers(
            McpCaps {
                http: true,
                sse: true,
                acp: true,
            },
            &servers,
        );
        assert_eq!(all.len(), 4);
    }
}
