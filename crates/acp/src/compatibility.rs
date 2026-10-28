use crate::{AgentEvent, EventSink};
use agent_client_protocol::schema::v1::{Error, ErrorCode};

pub(crate) fn user_error(method: &str, error: &Error, emit: &EventSink) -> String {
    emit(AgentEvent::Log {
        direction: "Client".into(),
        line: format!("ACP {method} failed: {error}"),
    });
    if matches!(error.code, ErrorCode::MethodNotFound) {
        let operation = match method {
            "session/new" => "editor sessions",
            "session/prompt" => "conversation prompts",
            _ => "the ACP handshake",
        };
        return format!("This program does not support ACP {operation}. Update its ACP adapter or choose another agent. See Protocol logs for details.");
    }
    format!("Agent could not complete {method}: {}", error.message)
}
