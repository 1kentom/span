//! Claude Code (claude-agent-acp 0.98.0, read from source; the interruption
//! marker was seen in a live capture).
use super::{annotate, text, Quirks, SessionState};
use crate::AgentHint;
use serde_json::{json, Value};

pub(crate) struct Claude;

/// The text Claude Code stores for a turn the user interrupted, replayed as
/// a user chunk when the session is restored (live capture, 0.98.0).
const INTERRUPTED: &str = "[Request interrupted by user]";

impl Quirks for Claude {
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
