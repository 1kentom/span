//! Claude Code (claude-agent-acp 0.98.0, read from source; the interruption
//! marker was seen in a live capture).
use super::{annotate, text, Profile, Quirks, SessionState};
use crate::AgentHint;
use serde_json::{json, Value};

pub(crate) struct Claude;

/// The text Claude Code stores for a turn the user interrupted, replayed as
/// a user chunk when the session is restored (live capture, 0.98.0).
const INTERRUPTED: &str = "[Request interrupted by user]";

/// Claude Code tools that reach sessions outside this one.
const PEER_SESSION_TOOLS: &[&str] = &["ListAgents"];

impl Quirks for Claude {
    /// Since 0.18.0 Claude uses built-in filesystem tools rather than client
    /// filesystem callbacks. Its permission prompt does not stage a Span buffer.
    fn profile(&self) -> Profile {
        Profile {
            edits_bypass_review: true,
            ..Profile::default()
        }
    }

    /// claude-agent-acp merges `_meta.claudeCode.options.disallowedTools`
    /// into the SDK options (0.98.0 source). `ListAgents` lists the other
    /// Claude Code sessions on the machine. `SendMessage` stays: Claude also
    /// uses it to continue its own subagents.
    fn approval_session_meta(&self) -> Option<Value> {
        Some(json!({ "claudeCode": { "options": { "disallowedTools": PEER_SESSION_TOOLS } } }))
    }
    /// Claude drops a stdio MCP server that carries an explicit
    /// `type: "stdio"`, so stdio servers are sent without a `type` field.
    fn mcp_server(&self, mut server: Value) -> Option<Value> {
        if server.get("type").and_then(Value::as_str) == Some("stdio") {
            if let Some(object) = server.as_object_mut() {
                object.remove("type");
            }
        }
        Some(server)
    }

    /// A replayed interruption marker is not something the user typed: it
    /// becomes an info notice with the `interruptedByUser` hint.
    fn update(&self, _state: &mut SessionState, update: Value) -> Vec<Value> {
        let interrupted = text(&update, "sessionUpdate").as_deref() == Some("user_message_chunk")
            && update.pointer("/content/text").and_then(Value::as_str) == Some(INTERRUPTED);
        if !interrupted {
            return vec![update];
        }
        let mut notice = json!({"sessionUpdate": "notice", "severity": "info", "title": ""});
        annotate(&mut notice, "hint", json!(AgentHint::InterruptedByUser));
        vec![notice]
    }
}
