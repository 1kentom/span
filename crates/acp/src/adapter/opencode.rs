//! OpenCode (anomalyco/opencode 2.2.0, a binary launched as `opencode acp`;
//! read from source, not run live). It is not in the ACP registry, so it is
//! offered as a custom command preset.
use super::{annotate, merge_tool, text, Profile, Quirks, SessionState};
use crate::{AgentCommand, AgentHint, AgentPreset, AuthMethodInfo};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

pub(crate) struct OpenCode;

const LOGIN_METHOD: &str = "opencode-login";
const RETRY_KEY: &str = "opencode/retry";
const COMPACTION_KEY: &str = "opencode/compaction";
const CHILD_KEY: &str = "opencode/child-session";

/// Agents Span can launch that are not installed from the registry.
pub fn agent_presets() -> Vec<AgentPreset> {
    vec![AgentPreset {
        id: "opencode".into(),
        name: "OpenCode".into(),
        description: "Runs `opencode acp`. Install OpenCode and sign in with `opencode auth login` first. OpenCode writes files itself, so Span review does not gate its edits.".into(),
        launch: AgentCommand {
            command: "opencode".into(),
            args: vec!["acp".into()],
            env: BTreeMap::new(),
        },
    }]
}

/// The parent tool call of a child session update, from
/// `_meta["opencode/child-session"]`. The field shape is UNVERIFIED: a
/// string or an object naming the parent tool call is accepted.
fn child_parent(update: &Value) -> Option<String> {
    let child = update.get("_meta")?.get(CHILD_KEY)?;
    if let Some(id) = child.as_str() {
        return Some(id.to_owned());
    }
    ["parentToolCallId", "toolCallId", "parentId"]
        .iter()
        .find_map(|key| text(child, key))
}

fn without_session_update(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(object) = value.as_object_mut() {
        object.remove("sessionUpdate");
        object.remove("_span");
    }
    value
}

/// A notice for one `_meta` key of `session_info_update`: an object raises
/// it, `null` clears it, absent leaves it alone.
fn meta_notice(
    update: &Value,
    key: &str,
    severity: &str,
    title: &str,
    hint: AgentHint,
) -> Option<Value> {
    let value = update.get("_meta")?.get(key)?;
    let mut notice = if value.is_null() {
        json!({"sessionUpdate": "span_notice_cleared"})
    } else {
        let description = text(value, "error")
            .or_else(|| text(value, "message"))
            .map(|error| match value.get("attempt").and_then(Value::as_u64) {
                Some(attempt) => format!("Attempt {attempt}: {error}"),
                None => error,
            });
        let mut notice = json!({"sessionUpdate": "notice", "severity": severity, "title": title});
        if let Some(description) = description {
            notice["description"] = json!(description);
        }
        annotate(&mut notice, "hint", json!(hint));
        notice
    };
    annotate(&mut notice, "noticeId", json!(key));
    Some(notice)
}

impl Quirks for OpenCode {
    /// OpenCode drains for up to five seconds after `session/cancel`, so the
    /// Stop deadline is raised to eight.
    fn profile(&self) -> Profile {
        Profile {
            stop_deadline: Duration::from_secs(8),
            edits_bypass_review: true,
            ..Profile::default()
        }
    }

    fn update(&self, state: &mut SessionState, mut update: Value) -> Vec<Value> {
        // A child session's tool call id also contains ':', but that alone
        // does not name the parent, so only the meta link is used.
        if let Some(parent) = child_parent(&update) {
            annotate(&mut update, "parentToolCallId", json!(parent));
        }
        match text(&update, "sessionUpdate").as_deref() {
            Some(kind @ ("tool_call" | "tool_call_update")) => {
                let Some(id) = text(&update, "toolCallId") else {
                    return vec![update];
                };
                // Completed and failed updates omit title, kind and rawInput,
                // and in_progress repeats unchanged: merge, then drop repeats.
                let previous = state.tools.get(&id);
                let mut merged = merge_tool(previous, &update);
                merged["sessionUpdate"] = json!(kind);
                if let Some(span) = merged.get_mut("_span").and_then(Value::as_object_mut) {
                    span.remove("placeholder");
                    span.remove("hint");
                }
                if previous
                    .is_some_and(|p| without_session_update(p) == without_session_update(&merged))
                {
                    return Vec::new();
                }
                let running = text(&merged, "status").as_deref() != Some("pending")
                    || state.started.contains(&id);
                if !running {
                    // The first title is the raw tool name, until in_progress names it.
                    annotate(&mut merged, "placeholder", json!(true));
                    annotate(&mut merged, "hint", json!(AgentHint::ToolPending));
                }
                vec![merged]
            }
            Some("session_info_update") => {
                let mut out = Vec::new();
                if update.get("title").is_some() || update.get("updatedAt").is_some() {
                    out.push(update.clone());
                }
                out.extend(meta_notice(
                    &update,
                    RETRY_KEY,
                    "warning",
                    "Retrying",
                    AgentHint::Retrying,
                ));
                out.extend(meta_notice(
                    &update,
                    COMPACTION_KEY,
                    "info",
                    "Compacting",
                    AgentHint::Compacting,
                ));
                if out.is_empty() {
                    out.push(update);
                }
                out
            }
            _ => vec![update],
        }
    }

    /// `opencode-login` is a no-op over ACP: the user signs in from a terminal.
    fn auth_method(&self, method: &mut AuthMethodInfo, _meta: Option<&Value>) {
        if method.id == LOGIN_METHOD {
            method.supported = false;
            method.hint = Some(AgentHint::RunOpencodeAuthLogin);
        }
    }

    fn auth_hint(&self) -> Option<AgentHint> {
        Some(AgentHint::RunOpencodeAuthLogin)
    }

    /// Slash commands return `end_turn` at once and stream nothing.
    fn complete_hint(&self, state: &SessionState, stop_reason: &str) -> Option<AgentHint> {
        (stop_reason == "end_turn" && state.slash && !state.output)
            .then_some(AgentHint::NoOutputStreamed)
    }

    /// `mcpCapabilities.sse` is false and one SSE server fails the whole
    /// `session/new`. Already removed by capability gating; kept explicit.
    fn mcp_server(&self, server: Value) -> Option<Value> {
        (server.get("type").and_then(Value::as_str) != Some("sse")).then_some(server)
    }
}
