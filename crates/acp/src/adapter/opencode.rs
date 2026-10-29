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
        description: "Runs `opencode acp`. Sign in first with `opencode auth login`.".into(),
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

/// The title OpenCode gives a child session created without one: "Child
/// session - " and an ISO time with milliseconds (`withTimestampedFallback`
/// in `packages/util/src/session-title-fallback.ts`, 2.2.1; the same
/// prefix in 1.x `session/session.ts`). Matched exactly.
fn is_child_fallback_title(title: &str) -> bool {
    let Some(time) = title.strip_prefix("Child session - ") else {
        return false;
    };
    // YYYY-MM-DDTHH:MM:SS.mmmZ
    const SHAPE: &[u8] = b"0000-00-00T00:00:00.000Z";
    time.len() == SHAPE.len()
        && time.bytes().zip(SHAPE).all(|(have, want)| match want {
            b'0' => have.is_ascii_digit(),
            other => have == *other,
        })
}

/// The title OpenCode 1.x gave a `task` child: the description, then
/// " (@<agent> subagent)" (`packages/opencode/src/tool/task.ts`, 1.19.5).
/// 1.x listed only root sessions, but 2.x lists children migrated from 1.x
/// storage under these titles. The agent name has no spaces or parentheses.
fn is_v1_subagent_title(title: &str) -> bool {
    let Some(head) = title.strip_suffix(" subagent)") else {
        return false;
    };
    let Some(at) = head.rfind(" (@") else {
        return false;
    };
    let name = &head[at + 3..];
    at > 0
        && !name.is_empty()
        && !name
            .chars()
            .any(|c| c.is_whitespace() || c == '(' || c == ')' || c == '@')
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

    /// OpenCode 2.x lists its own subagent sessions beside the user's chats
    /// and gives a list item no parent field, so children are learned from
    /// the parent's stream: a projected child update's
    /// `_meta["opencode/child-session"]` (`id`, `parentID`), or the
    /// `subagent` tool's result `rawOutput.metadata.sessionID` (its tool
    /// kind is `think`). A replayed session whose first user message starts
    /// with the subagent preamble is a child whose parent is unknown.
    fn native_child(
        &self,
        state: &mut SessionState,
        session: &str,
        update: &Value,
    ) -> Option<(String, Option<String>)> {
        if let Some(child) = update.get("_meta").and_then(|meta| meta.get(CHILD_KEY)) {
            if let Some(id) = text(child, "id").filter(|id| id != session) {
                let parent = text(child, "parentID").unwrap_or_else(|| session.to_owned());
                return Some((id, Some(parent)));
            }
        }
        match text(update, "sessionUpdate").as_deref() {
            Some("tool_call" | "tool_call_update") => {
                let child = update
                    .pointer("/rawOutput/metadata/sessionID")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty() && *id != session)?;
                let kind = text(update, "kind").or_else(|| {
                    let id = text(update, "toolCallId")?;
                    state.tools.get(&id).and_then(|tool| text(tool, "kind"))
                });
                (kind.as_deref() == Some("think")).then(|| (child.to_owned(), Some(session.to_owned())))
            }
            Some("user_message_chunk") => {
                let first = !state.user_seen;
                state.user_seen = true;
                let text = update.pointer("/content/text").and_then(Value::as_str)?;
                (first && crate::native_subagents::starts_with_subagent_preamble(text))
                    .then(|| (session.to_owned(), None))
            }
            _ => None,
        }
    }

    /// A list item carries no parent today. `_meta["opencode/child-session"]`
    /// is read if a later release adds it (UNVERIFIED for list items), else
    /// only the exact child title shapes count.
    fn listed_subagent(&self, title: Option<&str>, meta: Option<&Value>) -> Option<Option<String>> {
        if let Some(child) = meta.and_then(|meta| meta.get(CHILD_KEY)) {
            return Some(text(child, "parentID"));
        }
        let title = title?.trim();
        (is_child_fallback_title(title) || is_v1_subagent_title(title)).then_some(None)
    }

    /// `opencode-login` is a no-op over ACP: the user signs in from a terminal.
    fn auth_method(&self, method: &mut AuthMethodInfo, _meta: Option<&Value>) {
        if method.id == LOGIN_METHOD {
            method.supported = false;
            method.hint = Some(AgentHint::RunOpencodeAuthLogin);
        }
    }

    /// A live run (2.0.32) showed the default model's provider can lack
    /// credentials while other models work, so when the model option offers
    /// another model the hint says so too.
    fn auth_hint(&self, state: Option<&SessionState>) -> Option<AgentHint> {
        let other_models = state.is_some_and(|state| {
            state
                .config
                .iter()
                .filter(|option| option.category.as_deref() == Some("model"))
                .any(|option| option.groups.iter().map(|g| g.choices.len()).sum::<usize>() > 1)
        });
        Some(if other_models {
            AgentHint::RunOpencodeAuthLoginOrSwitchModel
        } else {
            AgentHint::RunOpencodeAuthLogin
        })
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

#[cfg(test)]
mod native_subagent_tests {
    use super::*;

    #[test]
    fn child_titles_match_only_the_exact_agent_shapes() {
        assert!(is_child_fallback_title("Child session - 2026-10-28T10:00:00.000Z"));
        assert!(is_v1_subagent_title("Generate BMW M2 PNG image (@general subagent)"));
        assert!(is_v1_subagent_title("Find callers (@explore subagent)"));
        // Near misses stay ordinary chats.
        for title in [
            "Child session ideas",
            "Child session - notes",
            "Child session - 2026-10-28",
            "Child session - 2026-10-28T10:00:00Z",
            "New session - 2026-10-28T10:00:00.000Z",
            "child session - 2026-10-28T10:00:00.000Z",
            "Generate BMW M2 PNG image",
            "How do I spawn a subagent",
            "Explain (@general subagent) usage",
            "(@general subagent)",
            "Review (@my agent subagent)",
            "Review (@ subagent)",
            "You are a subagent spawned by another session",
        ] {
            assert!(!is_child_fallback_title(title) && !is_v1_subagent_title(title), "{title}");
        }
    }

    #[test]
    fn listed_items_are_marked_from_title_or_meta_only() {
        let quirks = OpenCode;
        assert_eq!(quirks.listed_subagent(Some("Generate BMW M2 PNG image"), None), None);
        assert_eq!(
            quirks.listed_subagent(Some("Child session - 2026-10-28T10:00:00.000Z"), None),
            Some(None)
        );
        let meta = json!({"opencode/child-session": {"id": "ses_c", "parentID": "ses_p", "depth": 1}});
        assert_eq!(
            quirks.listed_subagent(Some("anything"), Some(&meta)),
            Some(Some("ses_p".into()))
        );
    }

    #[test]
    fn children_come_from_projected_updates_tool_results_and_the_preamble() {
        let quirks = OpenCode;
        let mut state = SessionState::default();
        // Shape of ACPChild.project (packages/cli/src/acp/child.ts, 2.2.1).
        let projected = json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"},
            "_meta": {"opencode/child-session": {"id": "ses_child", "parentID": "ses_parent", "depth": 1, "title": "Generate BMW M2 PNG image"}}});
        assert_eq!(
            quirks.native_child(&mut state, "ses_parent", &projected),
            Some(("ses_child".into(), Some("ses_parent".into())))
        );
        // The subagent tool (kind think) and its completed result.
        let call = json!({"sessionUpdate": "tool_call", "toolCallId": "prt_1", "title": "Generate BMW M2 PNG image", "kind": "think", "status": "pending"});
        assert_eq!(quirks.native_child(&mut state, "ses_parent", &call), None);
        state.tools.insert("prt_1".into(), call);
        let done = json!({"sessionUpdate": "tool_call_update", "toolCallId": "prt_1", "status": "completed",
            "rawOutput": {"metadata": {"sessionID": "ses_child2", "status": "completed"}}});
        assert_eq!(
            quirks.native_child(&mut state, "ses_parent", &done),
            Some(("ses_child2".into(), Some("ses_parent".into())))
        );
        // Another tool's metadata with a sessionID is not a subagent.
        state.tools.insert("prt_2".into(), json!({"toolCallId": "prt_2", "kind": "read"}));
        let other = json!({"sessionUpdate": "tool_call_update", "toolCallId": "prt_2", "status": "completed",
            "rawOutput": {"metadata": {"sessionID": "ses_x"}}});
        assert_eq!(quirks.native_child(&mut state, "ses_parent", &other), None);
        // The preamble counts on the first user message only.
        let mut child = SessionState::default();
        let first = json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text",
            "text": "You are a subagent spawned by another session.\nCreate a high-resolution PNG image"}});
        assert_eq!(quirks.native_child(&mut child, "ses_c3", &first), Some(("ses_c3".into(), None)));
        let mut chat = SessionState::default();
        let ordinary = json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "Explain subagents"}});
        assert_eq!(quirks.native_child(&mut chat, "ses_u", &ordinary), None);
        assert_eq!(quirks.native_child(&mut chat, "ses_u", &first), None);
    }
}
