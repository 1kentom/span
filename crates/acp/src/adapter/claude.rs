//! Claude Code (claude-agent-acp 0.98.0, read from source, not run live).
use super::Quirks;
use serde_json::Value;

pub(crate) struct Claude;

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
}
