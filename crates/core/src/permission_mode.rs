//! Span's own permission modes per agent thread (ADR 0015).
//!
//! A thread runs in one [`ThreadPermissionMode`]. The mode is Span's, not the
//! agent's: [`map_to_agent`] says which agent mode (an ACP config option value
//! or legacy mode id) has to be set so the agent asks Span before it acts, and
//! `crate::permission_policy` decides how Span answers each request the agent
//! then sends. Pure data and functions; the ACP adapter applies them.
//!
//! Rules kept here so they are tested in one place:
//! - every thread starts in [`ThreadPermissionMode::Ask`] unless the user chose
//!   the agent's own default in their settings (`agents.startMode`);
//! - an unsupported mode falls back to Ask, never to a looser mode
//!   ([`downgrade`]);
//! - a delegated child is never looser than Ask ([`allowed_for_child`]).
use serde::{Deserialize, Serialize};
use specta::Type;

/// The permission mode of one thread. Stored by name only (`ask`,
/// `acceptEdits`, `plan`, `auto`, `full`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThreadPermissionMode {
    /// Ask every time: every write or command request prompts the user.
    #[default]
    Ask,
    /// Accept edits: edits inside the workspace are allowed, commands prompt.
    AcceptEdits,
    /// Plan (read only): writes and commands are refused without prompting.
    Plan,
    /// Auto (safe commands): workspace edits and a small allowlist of
    /// read-only or test commands are allowed, everything else prompts.
    Auto,
    /// Full access: nothing prompts; every request is still logged.
    Full,
}

impl ThreadPermissionMode {
    pub const ALL: [ThreadPermissionMode; 5] = [
        ThreadPermissionMode::Ask,
        ThreadPermissionMode::AcceptEdits,
        ThreadPermissionMode::Plan,
        ThreadPermissionMode::Auto,
        ThreadPermissionMode::Full,
    ];

    /// The stored name, as serialized.
    pub fn name(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }

    /// Parse a stored name. Unknown names are `None`, never a guess.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.name() == name)
    }

    /// The label the UI shows.
    pub fn label(self) -> &'static str {
        match self {
            Self::Ask => "Ask every time",
            Self::AcceptEdits => "Accept edits",
            Self::Plan => "Plan (read only)",
            Self::Auto => "Auto (safe commands)",
            Self::Full => "Full access",
        }
    }

    /// How much the mode lets through without the user, for "never looser"
    /// checks. Plan lets the least through, Full the most.
    pub fn looseness(self) -> u8 {
        match self {
            Self::Plan => 0,
            Self::Ask => 1,
            Self::AcceptEdits => 2,
            Self::Auto => 3,
            Self::Full => 4,
        }
    }

    /// True when `self` lets more through without asking than `other`.
    pub fn looser_than(self, other: Self) -> bool {
        self.looseness() > other.looseness()
    }
}

/// One agent setting: an ACP session config option id (or, for agents that
/// only report legacy `modes`, the synthesised `mode` option) and its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetting {
    pub config_id: String,
    pub value: String,
}

impl AgentSetting {
    fn new(config_id: &str, value: &str) -> Self {
        Self {
            config_id: config_id.to_owned(),
            value: value.to_owned(),
        }
    }
}

/// What to set on the agent for a Span mode. The first setting is the agent's
/// mode option; later ones are companions (Codex's collaboration mode). An
/// empty list means Span enforces the mode alone and changes nothing on the
/// agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentModeChoice {
    pub settings: Vec<AgentSetting>,
}

/// Agent kinds as the ACP adapter names them (`AgentKind::id`).
fn kind(agent: &str) -> &str {
    match agent {
        "claude" | "codex" | "gemini" | "opencode" => agent,
        _ => "generic",
    }
}

/// The modes Span can enforce on `agent` (an adapter kind id such as
/// `claude`; anything unknown is the generic agent). Ask is always present.
pub fn supported_modes(agent: &str) -> Vec<ThreadPermissionMode> {
    use ThreadPermissionMode::*;
    match kind(agent) {
        "claude" | "codex" | "opencode" => vec![Ask, AcceptEdits, Plan, Auto, Full],
        // Gemini CLI reports default, autoEdit and yolo over ACP; no plan.
        "gemini" => vec![Ask, AcceptEdits, Auto, Full],
        // An unknown agent may write without asking, so Span cannot promise
        // read only. The other modes only change how Span answers.
        _ => vec![Ask, AcceptEdits, Auto, Full],
    }
}

/// Why a mode is not offered for `agent`, for the disabled row in the UI.
pub fn unsupported_reason(agent: &str, mode: ThreadPermissionMode) -> Option<&'static str> {
    if supported_modes(agent).contains(&mode) {
        return None;
    }
    Some(match mode {
        ThreadPermissionMode::Plan => {
            "This agent has no plan mode over ACP, so Span cannot keep it read only"
        }
        _ => "This agent cannot run in this mode",
    })
}

/// Which agent settings make `agent` behave as `mode` needs: the agent keeps
/// asking Span (its approval mode) for every mode Span answers itself, enters
/// its own plan mode for Plan and its own bypass mode for Full. `None` when
/// the mode is not supported.
pub fn map_to_agent(agent: &str, mode: ThreadPermissionMode) -> Option<AgentModeChoice> {
    use ThreadPermissionMode::*;
    if !supported_modes(agent).contains(&mode) {
        return None;
    }
    let settings = match (kind(agent), mode) {
        ("claude", Plan) => vec![AgentSetting::new("mode", "plan")],
        ("claude", Full) => vec![AgentSetting::new("mode", "bypassPermissions")],
        ("claude", _) => vec![AgentSetting::new("mode", "default")],
        // `agent` (Auto review) is the approval mode chosen for Codex in
        // PR #129; Plan is the read-only sandbox plus the plan collaboration
        // mode.
        ("codex", Plan) => vec![
            AgentSetting::new("mode", "read-only"),
            AgentSetting::new("collaboration_mode", "plan"),
        ],
        ("codex", Full) => vec![
            AgentSetting::new("mode", "agent-full-access"),
            AgentSetting::new("collaboration_mode", "default"),
        ],
        ("codex", _) => vec![
            AgentSetting::new("mode", "agent"),
            AgentSetting::new("collaboration_mode", "default"),
        ],
        ("gemini", Full) => vec![AgentSetting::new("mode", "yolo")],
        ("gemini", _) => vec![AgentSetting::new("mode", "default")],
        // OpenCode has no bypass mode: Full keeps the build agent and Span
        // allows what it asks.
        ("opencode", Plan) => vec![AgentSetting::new("mode", "plan")],
        ("opencode", _) => vec![AgentSetting::new("mode", "build")],
        _ => Vec::new(),
    };
    Some(AgentModeChoice { settings })
}

/// The Span mode an agent setting stands for, used when a session keeps the
/// agent's own start mode (`agents.startMode = agentDefault`) and to read what
/// mode the agent switched itself to. `None` for values with no Span mode.
pub fn from_agent(agent: &str, config_id: &str, value: &str) -> Option<ThreadPermissionMode> {
    use ThreadPermissionMode::*;
    if config_id == "collaboration_mode" {
        return (value == "plan").then_some(Plan);
    }
    match (kind(agent), value) {
        ("claude", "default") => Some(Ask),
        ("claude", "acceptEdits") => Some(AcceptEdits),
        ("claude", "plan") => Some(Plan),
        ("claude", "auto") => Some(Auto),
        ("claude", "bypassPermissions" | "dontAsk") => Some(Full),
        ("codex", "agent") => Some(Ask),
        ("codex", "read-only") => Some(Plan),
        ("codex", "workspace-write") => Some(AcceptEdits),
        ("codex", "agent-full-access" | "never") => Some(Full),
        ("gemini", "default") => Some(Ask),
        ("gemini", "autoEdit") => Some(AcceptEdits),
        ("gemini", "plan") => Some(Plan),
        ("gemini", "yolo") => Some(Full),
        ("opencode", "build") => Some(Ask),
        ("opencode", "plan") => Some(Plan),
        ("generic", "plan") => Some(Plan),
        ("generic", "bypassPermissions" | "agent-full-access" | "yolo" | "never") => Some(Full),
        _ => None,
    }
}

/// `mode` when supported, else Ask. Never a looser mode than asked for.
pub fn downgrade(
    mode: ThreadPermissionMode,
    supported: &[ThreadPermissionMode],
) -> ThreadPermissionMode {
    if supported.contains(&mode) {
        mode
    } else {
        ThreadPermissionMode::Ask
    }
}

/// A delegated child may run in Ask or in a narrower mode, never looser.
pub fn allowed_for_child(mode: ThreadPermissionMode) -> bool {
    !mode.looser_than(ThreadPermissionMode::Ask)
}

/// The mode a new thread starts in: Ask, or under the user's `agentDefault`
/// start mode, the Span mode the agent's own current setting stands for
/// (still Ask for anything unknown). A delegated child always starts in Ask.
pub fn initial_mode(
    agent: &str,
    agent_default: bool,
    child: bool,
    current: &[AgentSetting],
) -> ThreadPermissionMode {
    if child || !agent_default {
        return ThreadPermissionMode::Ask;
    }
    current
        .iter()
        .filter_map(|setting| from_agent(agent, &setting.config_id, &setting.value))
        .max_by_key(|mode| mode.looseness())
        .unwrap_or(ThreadPermissionMode::Ask)
}

/// The cycle of the composer shortcut (Shift+Tab): Ask, Accept edits, Plan,
/// then Ask again, skipping unsupported modes. Never cycles into Auto or Full;
/// from those it goes back to Ask.
pub fn cycle_next(
    mode: ThreadPermissionMode,
    supported: &[ThreadPermissionMode],
) -> ThreadPermissionMode {
    use ThreadPermissionMode::*;
    let order = [Ask, AcceptEdits, Plan];
    let start = order.iter().position(|m| *m == mode);
    let Some(start) = start else { return Ask };
    (1..=order.len())
        .map(|step| order[(start + step) % order.len()])
        .find(|m| supported.contains(m))
        .unwrap_or(Ask)
}

#[cfg(test)]
mod tests {
    use super::ThreadPermissionMode::*;
    use super::*;

    const AGENTS: [&str; 5] = ["claude", "codex", "gemini", "opencode", "generic"];

    #[test]
    fn names_round_trip_and_unknown_names_are_refused() {
        for mode in ThreadPermissionMode::ALL {
            assert_eq!(ThreadPermissionMode::from_name(mode.name()), Some(mode));
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(json, format!("\"{}\"", mode.name()));
        }
        assert_eq!(ThreadPermissionMode::from_name("bypassPermissions"), None);
        assert_eq!(ThreadPermissionMode::from_name("Full"), None);
        assert_eq!(ThreadPermissionMode::default(), Ask);
    }

    #[test]
    fn ask_is_supported_everywhere_and_maps_for_every_agent() {
        for agent in AGENTS.into_iter().chain(["something-new"]) {
            assert!(supported_modes(agent).contains(&Ask), "{agent}");
            assert!(map_to_agent(agent, Ask).is_some(), "{agent}");
        }
    }

    #[test]
    fn every_supported_mode_maps_and_unsupported_ones_do_not() {
        for agent in AGENTS {
            let supported = supported_modes(agent);
            for mode in ThreadPermissionMode::ALL {
                assert_eq!(
                    map_to_agent(agent, mode).is_some(),
                    supported.contains(&mode),
                    "{agent} {mode:?}"
                );
                assert_eq!(
                    unsupported_reason(agent, mode).is_none(),
                    supported.contains(&mode)
                );
            }
        }
    }

    #[test]
    fn modes_span_answers_itself_keep_the_agent_asking() {
        let first = |agent: &str, mode| map_to_agent(agent, mode).unwrap().settings[0].clone();
        for mode in [Ask, AcceptEdits, Auto] {
            assert_eq!(first("claude", mode).value, "default");
            assert_eq!(first("codex", mode).value, "agent");
            assert_eq!(first("gemini", mode).value, "default");
            assert_eq!(first("opencode", mode).value, "build");
            assert!(map_to_agent("generic", mode).unwrap().settings.is_empty());
        }
        assert_eq!(first("claude", Plan).value, "plan");
        assert_eq!(first("codex", Plan).value, "read-only");
        assert_eq!(
            map_to_agent("codex", Plan).unwrap().settings[1],
            AgentSetting::new("collaboration_mode", "plan")
        );
        assert_eq!(first("opencode", Plan).value, "plan");
        assert_eq!(first("claude", Full).value, "bypassPermissions");
        assert_eq!(first("codex", Full).value, "agent-full-access");
        assert_eq!(first("gemini", Full).value, "yolo");
        assert_eq!(first("opencode", Full).value, "build");
    }

    #[test]
    fn mapping_and_reverse_mapping_agree() {
        for agent in ["claude", "codex", "gemini", "opencode"] {
            for mode in supported_modes(agent) {
                let choice = map_to_agent(agent, mode).unwrap();
                let first = &choice.settings[0];
                let back = from_agent(agent, &first.config_id, &first.value).unwrap();
                // Ask, Accept edits and Auto share the agent's approval mode,
                // and so does Full on OpenCode, which has no bypass mode.
                let expected = if matches!(mode, AcceptEdits | Auto)
                    || (agent == "opencode" && mode == Full)
                {
                    Ask
                } else {
                    mode
                };
                assert_eq!(back, expected, "{agent} {mode:?}");
            }
        }
    }

    #[test]
    fn downgrade_falls_back_to_ask_never_looser() {
        let gemini = supported_modes("gemini");
        assert_eq!(downgrade(Plan, &gemini), Ask);
        assert_eq!(downgrade(Full, &gemini), Full);
        assert_eq!(downgrade(Full, &[Ask]), Ask);
        assert_eq!(downgrade(Auto, &[Ask, Full]), Ask);
        for mode in ThreadPermissionMode::ALL {
            let result = downgrade(mode, &[Ask]);
            assert_eq!(result, Ask);
        }
    }

    #[test]
    fn children_are_never_looser_than_ask() {
        assert!(allowed_for_child(Ask));
        assert!(allowed_for_child(Plan));
        assert!(!allowed_for_child(AcceptEdits));
        assert!(!allowed_for_child(Auto));
        assert!(!allowed_for_child(Full));
        let bypass = [AgentSetting::new("mode", "bypassPermissions")];
        assert_eq!(initial_mode("claude", true, true, &bypass), Ask);
    }

    #[test]
    fn initial_mode_is_ask_unless_the_user_kept_the_agent_default() {
        let bypass = [AgentSetting::new("mode", "bypassPermissions")];
        assert_eq!(initial_mode("claude", false, false, &bypass), Ask);
        assert_eq!(initial_mode("claude", true, false, &bypass), Full);
        let plan = [
            AgentSetting::new("mode", "agent"),
            AgentSetting::new("collaboration_mode", "plan"),
        ];
        // The loosest reading wins, so the chip never claims less than runs.
        assert_eq!(initial_mode("codex", true, false, &plan), Ask);
        let unknown = [AgentSetting::new("mode", "something")];
        assert_eq!(initial_mode("claude", true, false, &unknown), Ask);
    }

    #[test]
    fn the_shortcut_cycles_ask_accept_edits_plan_and_never_into_full() {
        let all = ThreadPermissionMode::ALL;
        assert_eq!(cycle_next(Ask, &all), AcceptEdits);
        assert_eq!(cycle_next(AcceptEdits, &all), Plan);
        assert_eq!(cycle_next(Plan, &all), Ask);
        assert_eq!(cycle_next(Full, &all), Ask);
        assert_eq!(cycle_next(Auto, &all), Ask);
        let gemini = supported_modes("gemini");
        assert_eq!(cycle_next(AcceptEdits, &gemini), Ask);
        let mut mode = Ask;
        for _ in 0..12 {
            mode = cycle_next(mode, &all);
            assert_ne!(mode, Full);
            assert_ne!(mode, Auto);
        }
    }

    #[test]
    fn looseness_orders_plan_below_ask_and_full_on_top() {
        assert!(Ask.looser_than(Plan));
        assert!(Full.looser_than(Auto));
        assert!(Auto.looser_than(AcceptEdits));
        assert!(!Plan.looser_than(Ask));
    }
}
