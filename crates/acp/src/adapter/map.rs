//! Map a normalised `session/update` to an [`AgentEvent`]. Applies to every
//! agent; adapter specific rewriting happens before this.
use crate::{
    AgentEvent, AgentHint, ConfigChoice, ConfigGroup, ConfigOption, PlanEntry, SlashCommand,
    ToolDiff, ToolImage, ToolLocation, UserAttachment,
};
use agent_client_protocol::schema::v1::SessionConfigOption;
use serde_json::Value;
use std::path::Path;

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn present(value: &Value, key: &str) -> Option<Value> {
    value.get(key).filter(|v| !v.is_null()).cloned()
}

fn blocks_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("")
}

fn hint(span: &Value) -> Option<AgentHint> {
    span.get("hint")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
}

fn flag(span: &Value, key: &str) -> Option<bool> {
    span.get(key).and_then(Value::as_bool).filter(|set| *set)
}

/// Reduce the agent's select options to the shape the panel renders.
/// Other option kinds are dropped: the panel has no control for them.
pub(crate) fn config_options(options: &[SessionConfigOption]) -> Vec<ConfigOption> {
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let choice = |value: &Value| {
        Some(ConfigChoice {
            value: text(value, "value")?,
            name: text(value, "name").or_else(|| text(value, "value"))?,
            description: text(value, "description"),
        })
    };
    options
        .iter()
        .filter_map(|option| {
            let value = serde_json::to_value(option).ok()?;
            let current_value = text(&value, "currentValue")?;
            let entries = value.get("options")?.as_array()?;
            let mut groups: Vec<ConfigGroup> = Vec::new();
            let mut loose: Vec<ConfigChoice> = Vec::new();
            for entry in entries {
                if let Some(members) = entry.get("options").and_then(Value::as_array) {
                    groups.push(ConfigGroup {
                        name: text(entry, "name").unwrap_or_default(),
                        choices: members.iter().filter_map(choice).collect(),
                    });
                } else if let Some(found) = choice(entry) {
                    loose.push(found);
                }
            }
            if !loose.is_empty() {
                groups.insert(
                    0,
                    ConfigGroup {
                        name: String::new(),
                        choices: loose,
                    },
                );
            }
            Some(ConfigOption {
                id: text(&value, "id")?,
                name: text(&value, "name")?,
                description: text(&value, "description"),
                category: text(&value, "category"),
                current_value,
                groups,
            })
        })
        .collect()
}

/// [`config_options`] from raw JSON, skipping entries that do not parse.
pub(crate) fn config_options_value(value: Option<&Value>) -> Vec<ConfigOption> {
    let parsed: Vec<SessionConfigOption> = value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    config_options(&parsed)
}

pub(crate) fn locations(tool: &Value) -> Vec<ToolLocation> {
    tool.get("locations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(ToolLocation {
                        path: text(item, "path")?,
                        line: item
                            .get("line")
                            .and_then(Value::as_u64)
                            .and_then(|n| u32::try_from(n).ok()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Diff blocks with a usable path. A relative path (Gemini sends basenames)
/// is resolved against the workspace root when the file exists there, else
/// against a location with the same file name, else marked unresolved.
/// `change` comes from `oldText` alone: absent is an add, anything else
/// (including "") a modify.
pub(crate) fn diffs(tool: &Value, locations: &[ToolLocation], root: &Path) -> Vec<ToolDiff> {
    let Some(content) = tool.get("content").and_then(Value::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("diff"))
        .filter_map(|block| {
            let raw = text(block, "path")?;
            let old_text = text(block, "oldText");
            let (path, resolved) = resolve(&raw, locations, root);
            Some(ToolDiff {
                path,
                resolved,
                change: if old_text.is_none() { "add" } else { "modify" }.into(),
                old_text,
                new_text: text(block, "newText").unwrap_or_default(),
            })
        })
        .collect()
}

fn resolve(raw: &str, locations: &[ToolLocation], root: &Path) -> (String, bool) {
    let path = Path::new(raw);
    if path.is_absolute() {
        return (raw.to_owned(), true);
    }
    if !root.as_os_str().is_empty() {
        if let Ok(found) = std::fs::canonicalize(root.join(path)) {
            if found.starts_with(root) {
                return (found.to_string_lossy().into_owned(), true);
            }
        }
    }
    if let Some(location) = locations.iter().find(|l| {
        Path::new(&l.path).file_name().is_some()
            && Path::new(&l.path).file_name() == path.file_name()
    }) {
        return (location.path.clone(), true);
    }
    (raw.to_owned(), false)
}

fn images(tool: &Value) -> Vec<ToolImage> {
    tool.get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let block = item.get("content").unwrap_or(item);
                    (block.get("type").and_then(Value::as_str) == Some("image")).then(|| {
                        ToolImage {
                            mime_type: text(block, "mimeType"),
                            data: text(block, "data").filter(|d| !d.is_empty()),
                            uri: text(block, "uri"),
                        }
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn user_attachment(content: &Value) -> Option<UserAttachment> {
    let kind = content.get("type").and_then(Value::as_str)?;
    match kind {
        "resource_link" => Some(UserAttachment {
            kind: "resourceLink".into(),
            uri: text(content, "uri"),
            name: text(content, "name"),
            mime_type: text(content, "mimeType"),
        }),
        "image" => Some(UserAttachment {
            kind: "image".into(),
            uri: text(content, "uri"),
            name: None,
            mime_type: text(content, "mimeType"),
        }),
        "resource" => {
            let resource = content.get("resource").unwrap_or(&Value::Null);
            Some(UserAttachment {
                kind: "resource".into(),
                uri: text(resource, "uri"),
                name: None,
                mime_type: text(resource, "mimeType"),
            })
        }
        _ => None,
    }
}

/// The parent tool call of a subagent's tool call. Claude Code sends
/// `_meta.claudeCode.parentToolUseId`; adapters set `_span.parentToolCallId`
/// for other forms.
fn parent(update: &Value, span: &Value) -> Option<String> {
    update
        .pointer("/_meta/claudeCode/parentToolUseId")
        .or_else(|| span.get("parentToolCallId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(crate) fn event(session: &str, mut update: Value, root: &Path) -> Option<AgentEvent> {
    let span = update
        .as_object_mut()
        .and_then(|object| object.remove("_span"))
        .unwrap_or(Value::Null);
    let session_id = session.to_owned();
    let string = |key: &str| text(&update, key).unwrap_or_default();
    let event = match string("sessionUpdate").as_str() {
        kind @ ("agent_message_chunk" | "agent_thought_chunk") => {
            let text = update
                .pointer("/content/text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let message_id = update
                .get("messageId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let new_block = flag(&span, "newBlock");
            if kind == "agent_message_chunk" {
                AgentEvent::Text {
                    session_id,
                    text,
                    message_id,
                    new_block,
                }
            } else {
                AgentEvent::Thought {
                    session_id,
                    text,
                    message_id,
                    new_block,
                }
            }
        }
        "user_message_chunk" => {
            let content = update.get("content").unwrap_or(&Value::Null);
            let text = content
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let attachments: Vec<UserAttachment> = user_attachment(content).into_iter().collect();
            if text.is_empty() && attachments.is_empty() {
                return None;
            }
            AgentEvent::User {
                session_id,
                text,
                attachments,
            }
        }
        "available_commands_update" => AgentEvent::AvailableCommands {
            session_id,
            commands: update
                .get("availableCommands")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            Some(SlashCommand {
                                name: item.get("name")?.as_str()?.to_owned(),
                                description: text(item, "description").unwrap_or_default(),
                                input_hint: item
                                    .pointer("/input/hint")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "current_mode_update" => AgentEvent::CurrentMode {
            session_id,
            mode_id: text(&update, "currentModeId")?,
        },
        "session_info_update" => AgentEvent::SessionInfo {
            session_id,
            title: text(&update, "title"),
            updated_at: text(&update, "updatedAt"),
        },
        "usage_update" => AgentEvent::Usage {
            session_id,
            used: update.get("used").and_then(Value::as_u64)?,
            size: update.get("size").and_then(Value::as_u64)?,
            cost_amount: update.pointer("/cost/amount").and_then(Value::as_f64),
            cost_currency: update
                .pointer("/cost/currency")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        "notice" => AgentEvent::Notice {
            session_id,
            severity: string("severity"),
            title: text(&update, "title")?,
            description: text(&update, "description"),
            notice_id: text(&span, "noticeId"),
            hint: hint(&span),
        },
        // Synthesised by adapters only; never sent by an agent.
        "span_notice_cleared" => AgentEvent::NoticeCleared {
            session_id,
            notice_id: text(&span, "noticeId")?,
        },
        "compaction_update" => AgentEvent::Compaction {
            session_id,
            compaction_id: string("compactionId"),
            status: string("status"),
            summary: update
                .get("summary")
                .and_then(Value::as_array)
                .map(|blocks| blocks_text(blocks))
                .filter(|text| !text.is_empty()),
            error: text(&update, "error"),
        },
        "compaction_summary_chunk" => {
            let text = blocks_text(std::slice::from_ref(
                update.get("content").unwrap_or(&Value::Null),
            ));
            if text.is_empty() {
                return None;
            }
            AgentEvent::CompactionSummary {
                session_id,
                compaction_id: string("compactionId"),
                text,
            }
        }
        "config_option_update" => {
            let options = config_options_value(update.get("configOptions"));
            if options.is_empty() {
                return None;
            }
            AgentEvent::Config {
                session_id,
                options,
            }
        }
        "plan" => AgentEvent::Plan {
            session_id,
            entries: update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| PlanEntry {
                            content: entry["content"].as_str().unwrap_or_default().into(),
                            priority: entry["priority"].as_str().unwrap_or_default().into(),
                            status: entry["status"].as_str().unwrap_or_default().into(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        },
        "tool_call" | "tool_call_update" => {
            let locations = locations(&update);
            AgentEvent::Tool {
                session_id,
                tool_call_id: string("toolCallId"),
                title: if flag(&span, "placeholder").is_some() {
                    None
                } else {
                    text(&update, "title")
                },
                status: text(&update, "status"),
                tool_kind: text(&update, "kind"),
                parent_tool_call_id: parent(&update, &span),
                raw_input: present(&update, "rawInput"),
                raw_output: present(&update, "rawOutput"),
                diffs: diffs(&update, &locations, root),
                images: images(&update),
                locations,
                saved_path: text(&span, "savedPath"),
                internal: flag(&span, "internal"),
                hint: hint(&span),
                content_json: update.to_string(),
            }
        }
        _ => return None,
    };
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn options(json: Value) -> Vec<ConfigOption> {
        config_options(&serde_json::from_value::<Vec<SessionConfigOption>>(json).unwrap())
    }

    #[test]
    fn flat_and_grouped_select_options_are_reduced() {
        let parsed = options(json!([
            {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "fast",
             "options": [{"value": "fast", "name": "Fast"}, {"value": "deep", "name": "Deep", "description": "Slower"}]},
            {"id": "mode", "name": "Mode", "type": "select", "currentValue": "b",
             "options": [{"group": "g", "name": "Group", "options": [{"value": "b", "name": "B"}]}]}
        ]));
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].category.as_deref(), Some("model"));
        assert_eq!(parsed[0].current_value, "fast");
        assert_eq!(parsed[0].groups[0].choices.len(), 2);
        assert_eq!(
            parsed[0].groups[0].choices[1].description.as_deref(),
            Some("Slower")
        );
        assert_eq!(parsed[1].groups[0].name, "Group");
        assert_eq!(parsed[1].groups[0].choices[0].value, "b");
    }

    #[test]
    fn diff_paths_resolve_or_are_marked_unresolved() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("present.txt"), "").unwrap();
        let root = std::fs::canonicalize(root.path()).unwrap();
        let tool = json!({"content": [
            {"type": "diff", "path": "present.txt", "oldText": "", "newText": "a", "_meta": {"kind": "add"}},
            {"type": "diff", "path": "nested.rs", "newText": "b"},
            {"type": "diff", "path": "missing.rs", "newText": "c"},
            {"type": "diff", "path": "../escape.txt", "newText": "d"}
        ]});
        let locations = vec![ToolLocation {
            path: "/abs/src/nested.rs".into(),
            line: None,
        }];
        let found = diffs(&tool, &locations, &root);
        assert_eq!(found[0].path, root.join("present.txt").to_string_lossy());
        assert!(found[0].resolved);
        assert_eq!(found[0].change, "modify");
        assert_eq!(found[1].path, "/abs/src/nested.rs");
        assert_eq!(found[1].change, "add");
        assert!(!found[2].resolved);
        assert!(!found[3].resolved);
    }
}
