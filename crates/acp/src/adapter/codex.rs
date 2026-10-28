//! Codex (codex-acp 2.3.0, read from source, not run live).
use super::{annotate, Quirks, SessionState};
use serde_json::{json, Value};

pub(crate) struct Codex;

impl Quirks for Codex {
    /// An SSE or ACP MCP server makes the whole `session/new` fail, even
    /// when advertised, so neither is ever sent.
    fn mcp_server(&self, server: Value) -> Option<Value> {
        match server.get("type").and_then(Value::as_str) {
            Some("sse" | "acp") => None,
            _ => Some(server),
        }
    }

    /// Image generation reports the saved file as `rawOutput.savedPath`
    /// (the only reference when no image data is sent). It is surfaced as
    /// `savedPath`; the UI decides whether it may open it.
    fn update(&self, _state: &mut SessionState, mut update: Value) -> Vec<Value> {
        if let Some(path) = update
            .pointer("/rawOutput/savedPath")
            .and_then(Value::as_str)
            .map(str::to_owned)
        {
            annotate(&mut update, "savedPath", json!(path));
        }
        vec![update]
    }
}
