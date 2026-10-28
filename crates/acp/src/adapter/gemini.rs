//! Gemini CLI (0.67 nightly read from source; the registry pins 0.66.0, which
//! was not compared). Nothing here was observed on a live agent.
use super::{annotate, text, Profile, Quirks, SessionState};
use crate::{AgentHint, AuthInput, AuthMethodInfo, ConfigChoice, ConfigGroup, ConfigOption};
use serde_json::{json, Value};
use std::time::Duration;

pub(crate) struct Gemini;

const MODE_PREFIX: &str = "[MODE_UPDATE]";
const WARNING_PREFIX: &str = "Warning: ";
/// Synthetic ids Gemini uses while it resolves `@file` references.
const RESOLVE_PREFIX: &str = "resolve-prompt-";

fn chunk_text(update: &Value) -> Option<&str> {
    update.pointer("/content/text").and_then(Value::as_str)
}

/// `**subject**\ndescription`: Gemini sends each thought whole.
fn is_subject_thought(text: &str) -> bool {
    text.strip_prefix("**")
        .and_then(|rest| rest.split_once("**"))
        .is_some_and(|(subject, rest)| {
            !subject.is_empty() && (rest.is_empty() || rest.starts_with('\n'))
        })
}

fn is_read_many_files(update: &Value) -> bool {
    ["title", "name"].iter().any(|key| {
        text(update, key).is_some_and(|value| {
            value
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase()
                .starts_with("readmanyfiles")
        })
    })
}

fn choice(
    id: Option<String>,
    name: Option<String>,
    description: Option<String>,
) -> Option<ConfigChoice> {
    let value = id?;
    Some(ConfigChoice {
        name: name.unwrap_or_else(|| value.clone()),
        value,
        description,
    })
}

impl Quirks for Gemini {
    fn profile(&self) -> Profile {
        Profile {
            replay_quiet: Some(Duration::from_millis(750)),
            double_approval: true,
            ..Profile::default()
        }
    }

    fn update(&self, state: &mut SessionState, mut update: Value) -> Vec<Value> {
        match text(&update, "sessionUpdate").as_deref() {
            Some("agent_message_chunk") => {
                if let Some(mode) =
                    chunk_text(&update).and_then(|t| t.trim_start().strip_prefix(MODE_PREFIX))
                {
                    let mode = mode.trim();
                    if mode.is_empty() {
                        return Vec::new();
                    }
                    return vec![
                        json!({"sessionUpdate": "current_mode_update", "currentModeId": mode}),
                    ];
                }
            }
            Some("agent_thought_chunk") => {
                if let Some(warning) =
                    chunk_text(&update).and_then(|t| t.strip_prefix(WARNING_PREFIX))
                {
                    return vec![
                        json!({"sessionUpdate": "notice", "severity": "warning", "title": warning.trim()}),
                    ];
                }
                if chunk_text(&update).is_some_and(is_subject_thought) {
                    annotate(&mut update, "newBlock", json!(true));
                }
            }
            Some(kind @ ("tool_call" | "tool_call_update")) => {
                let id = text(&update, "toolCallId").unwrap_or_default();
                let fresh = kind == "tool_call" && !state.tools.contains_key(&id);
                if id.starts_with(RESOLVE_PREFIX)
                    || (fresh && !state.output && is_read_many_files(&update))
                {
                    annotate(&mut update, "internal", json!(true));
                }
                let known_kind = text(&update, "kind")
                    .or_else(|| state.tools.get(&id).and_then(|t| text(t, "kind")));
                let finished = text(&update, "status").as_deref() == Some("completed");
                let empty = update
                    .get("content")
                    .is_none_or(|c| c.as_array().is_some_and(|a| a.is_empty()));
                if finished && empty && known_kind.as_deref() == Some("execute") {
                    annotate(&mut update, "hint", json!(AgentHint::OutputUnavailable));
                }
            }
            _ => {}
        }
        vec![update]
    }

    /// `session/new` and `session/load` return `modes` and `models` and no
    /// `configOptions`. They become options `mode` and `model`.
    fn legacy_config(&self, response: &Value) -> Vec<ConfigOption> {
        let mut options = Vec::new();
        if let Some(modes) = response.get("modes") {
            let choices: Vec<ConfigChoice> = modes
                .get("availableModes")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|m| {
                            choice(text(m, "id"), text(m, "name"), text(m, "description"))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let (Some(current), false) = (text(modes, "currentModeId"), choices.is_empty()) {
                options.push(ConfigOption {
                    id: "mode".into(),
                    name: "Mode".into(),
                    description: None,
                    category: Some("mode".into()),
                    current_value: current,
                    groups: vec![ConfigGroup {
                        name: String::new(),
                        choices,
                    }],
                });
            }
        }
        if let Some(models) = response.get("models") {
            let choices: Vec<ConfigChoice> = models
                .get("availableModels")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|m| {
                            choice(text(m, "modelId"), text(m, "name"), text(m, "description"))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let (Some(current), false) = (text(models, "currentModelId"), choices.is_empty()) {
                options.push(ConfigOption {
                    id: "model".into(),
                    name: "Model".into(),
                    description: None,
                    category: Some("model".into()),
                    current_value: current,
                    groups: vec![ConfigGroup {
                        name: String::new(),
                        choices,
                    }],
                });
            }
        }
        options
    }

    /// The tool stays `pending` after approval and never reports
    /// `in_progress`, so it is synthesised once the user allowed it.
    fn after_permission(
        &self,
        state: &mut SessionState,
        tool_call_id: &str,
        allowed: bool,
    ) -> Vec<Value> {
        let pending = state
            .tools
            .get(tool_call_id)
            .is_some_and(|tool| text(tool, "status").is_none_or(|s| s == "pending"));
        if !allowed || !pending {
            return Vec::new();
        }
        let mut update = json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id, "status": "in_progress"});
        if tool_call_id.starts_with(RESOLVE_PREFIX) {
            annotate(&mut update, "internal", json!(true));
        }
        vec![update]
    }

    /// API key and gateway methods mark themselves with `_meta["api-key"]`
    /// and `_meta.gateway`.
    fn auth_method(&self, method: &mut AuthMethodInfo, meta: Option<&Value>) {
        let Some(meta) = meta else { return };
        if meta.get("api-key").is_some() {
            method.input = Some(AuthInput::ApiKey);
        } else if meta.get("gateway").is_some() {
            method.input = Some(AuthInput::Gateway);
        }
    }

    /// `max_turn_requests` is also how loop detection ends a turn.
    fn complete_hint(&self, _state: &SessionState, stop_reason: &str) -> Option<AgentHint> {
        (stop_reason == "max_turn_requests").then_some(AgentHint::TurnLimitOrLoop)
    }

    fn internal_permission(&self, tool_call_id: &str) -> bool {
        tool_call_id.starts_with(RESOLVE_PREFIX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_thoughts_are_recognised() {
        assert!(is_subject_thought("**Planning**\nLooking at files"));
        assert!(is_subject_thought("**Planning**"));
        assert!(!is_subject_thought("**bold** inline text"));
        assert!(!is_subject_thought("plain"));
    }
}
