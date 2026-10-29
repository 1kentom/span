//! Replays recorded-shape agent scripts (tests/fixtures/<agent>/<name>.ndjson)
//! through the real process client and compares the events the UI receives
//! with tests/fixtures/<agent>/<name>.json.
//!
//! Expected file keys:
//! - `drive`: client actions, in order (see `Step`).
//! - `mcpServers`: offered in every `newSession` and `load` step.
//! - `events`: events that must appear in this order. Objects match as a
//!   subset; `null` also matches an absent key; `$ROOT` is the workspace.
//!   A `{"kind": "_step", "do": ...}` entry marks where a drive step ended.
//! - `absent`: events that must not appear (subset match).
//! - `sent` / `notSent`: client messages recorded by the fixture agent.
//! - `counts`: `{"match": event, "count": n}`, how often an event appears.
//! - `logsExclude`: text that must not appear in any protocol log line.
//! - `debugExclude`: text that must not appear in the `Debug` output of any event.
//! - `userSettings`: the user's settings file content. Without it the user
//!   has no settings file, so every agent starts in the approval mode.
//! - A `newChildSession` step opens a delegated child session.
//! - A `listSessions` step's `expectSessions` lists the session ids the
//!   client returns, in order.
use serde_json::{json, Value};
use span_acp::{AgentCommand, AgentEvent, AgentService, AuthCredential};
use span_core::CoreWorkspace;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

type Events = Arc<Mutex<Vec<Value>>>;

fn subset(expected: &Value, actual: Option<&Value>) -> bool {
    match (expected, actual) {
        (Value::Null, None | Some(Value::Null)) => true,
        (Value::Object(want), Some(Value::Object(have))) => {
            want.iter().all(|(key, value)| subset(value, have.get(key)))
        }
        (Value::Array(want), Some(Value::Array(have))) => {
            want.len() == have.len() && want.iter().zip(have).all(|(w, h)| subset(w, Some(h)))
        }
        (want, Some(have)) => want == have,
        _ => false,
    }
}

/// Replace each `$ROOT` (plus any `/segment` tail up to the closing quote) inside
/// the JSON text with the native path `root.join(segments)`, JSON-escaped. Agents
/// report native absolute paths, so on Windows the fixture agent sends backslash
/// paths and the expected events compare against the same native form; escaping
/// keeps backslashes from turning into invalid JSON escapes.
fn substitute(value: &str, root: &Path) -> String {
    const TOKEN: &str = "$ROOT";
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find(TOKEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + TOKEN.len()..];
        let tail_len = after.find('"').unwrap_or(after.len());
        let mut path = root.to_path_buf();
        for segment in after[..tail_len].split('/').filter(|s| !s.is_empty()) {
            path.push(segment);
        }
        let quoted = serde_json::to_string(&path.to_string_lossy()).unwrap();
        out.push_str(&quoted[1..quoted.len() - 1]);
        rest = &after[tail_len..];
    }
    out.push_str(rest);
    out
}

#[test]
fn substitute_escapes_backslash_roots_and_joins_natively() {
    let root = Path::new(r"C:\Users\me\span");
    let text = r#"{"root": "$ROOT", "file": "$ROOT/src/lib.rs", "other": "keep"}"#;
    let value: Value = serde_json::from_str(&substitute(text, root)).expect("valid JSON");
    assert_eq!(value["root"], root.to_string_lossy().as_ref());
    assert_eq!(
        value["file"],
        root.join("src").join("lib.rs").to_string_lossy().as_ref()
    );
    assert_eq!(value["other"], "keep");
}

fn in_order(label: &str, expected: &[Value], actual: &[Value]) {
    let mut index = 0;
    for want in expected {
        match actual[index..]
            .iter()
            .position(|have| subset(want, Some(have)))
        {
            Some(found) => index += found + 1,
            None => panic!(
                "{label}: expected {want}\nafter position {index} in:\n{}",
                actual
                    .iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
        }
    }
}

fn none_of(label: &str, unwanted: &[Value], actual: &[Value]) {
    for bad in unwanted {
        if let Some(found) = actual.iter().find(|have| subset(bad, Some(have))) {
            panic!("{label}: unexpected {found}");
        }
    }
}

async fn wait_for(events: &Events, matches: impl Fn(&Value) -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            if events.lock().unwrap().iter().any(&matches) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("event did not arrive");
}

fn mark(events: &Events, step: &str, result: &Result<(), String>) {
    events.lock().unwrap().push(json!({
        "kind": "_step",
        "do": step,
        "ok": result.is_ok(),
        "error": result.as_ref().err(),
    }));
}

fn check(step: &Value, result: &Result<(), String>) {
    match step.get("expectError").and_then(Value::as_str) {
        Some(text) => assert!(
            result.as_ref().is_err_and(|e| e.contains(text)),
            "{step}: expected an error containing {text:?}, got {result:?}"
        ),
        None => assert!(result.is_ok(), "{step}: {result:?}"),
    }
}

async fn replay(agent: &str, name: &str) {
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let directory = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(directory.path()).unwrap();
    std::fs::write(root.join("present.txt"), "").unwrap();
    let script_text = std::fs::read_to_string(fixtures.join(agent).join(format!("{name}.ndjson")))
        .expect("fixture script");
    let script = root.join(".script.ndjson");
    std::fs::write(&script, substitute(&script_text, &root)).unwrap();
    let record = root.join(".sent.ndjson");
    let expected_text = std::fs::read_to_string(fixtures.join(agent).join(format!("{name}.json")))
        .expect("expected events");
    let expected: Value = serde_json::from_str(&substitute(&expected_text, &root)).unwrap();

    let user_settings = expected.get("userSettings").map(|settings| {
        let path = root.join(".user-settings.jsonc");
        std::fs::write(&path, settings.to_string()).unwrap();
        path
    });
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(&root)
            .unwrap()
            .with_user_settings(user_settings),
    ));
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let debug: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_debug = debug.clone();
    let service_slot: Arc<OnceLock<AgentService>> = Arc::new(OnceLock::new());
    let policy: Arc<Mutex<String>> = Arc::new(Mutex::new("allow".into()));
    let sink_events = events.clone();
    let sink_service = service_slot.clone();
    let sink_policy = policy.clone();
    let command = AgentCommand {
        command: "node".into(),
        args: vec![
            fixtures.join("replay.mjs").to_string_lossy().into_owned(),
            script.to_string_lossy().into_owned(),
            format!("--record={}", record.to_string_lossy()),
        ],
        env: BTreeMap::new(),
    };
    let service = AgentService::start(
        command,
        root.to_string_lossy().into_owned(),
        workspace,
        Arc::new(move |event: AgentEvent| {
            if let AgentEvent::Permission {
                session_id,
                request_id,
                options,
                ..
            } = &event
            {
                let wanted = sink_policy.lock().unwrap().clone();
                let choice = options
                    .iter()
                    .find(|o| o.kind.starts_with(&wanted) || o.option_id == wanted)
                    .map(|o| o.option_id.clone());
                if let Some(service) = sink_service.get() {
                    let _ =
                        service.respond_permission(session_id.clone(), request_id.clone(), choice);
                }
            }
            sink_debug.lock().unwrap().push(format!("{event:?}"));
            sink_events
                .lock()
                .unwrap()
                .push(serde_json::to_value(&event).unwrap());
        }),
    )
    .await
    .expect("start replay agent");
    let _ = service_slot.set(service.clone());
    let mcp_servers: Vec<Value> = expected
        .get("mcpServers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut session = String::new();
    let empty = Vec::new();
    for step in expected
        .get("drive")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
    {
        let action = step["do"].as_str().unwrap();
        let text = |key: &str| step[key].as_str().unwrap_or_default().to_owned();
        let result: Result<(), String> = match action {
            "newSession" => service
                .new_session_with(mcp_servers.clone())
                .await
                .map(|id| session = id),
            "newChildSession" => service.new_child_session().await.map(|id| session = id),
            "prompt" => {
                *policy.lock().unwrap() = step["permission"].as_str().unwrap_or("allow").into();
                service.prompt(session.clone(), text("text"), vec![]).await
            }
            "promptBusy" => {
                let first = service.clone();
                let first_session = session.clone();
                let first_text = text("text");
                let running =
                    tokio::spawn(
                        async move { first.prompt(first_session, first_text, vec![]).await },
                    );
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                let second = service
                    .prompt(session.clone(), text("second"), vec![])
                    .await;
                mark(&events, "secondPrompt", &second);
                service.cancel(session.clone()).unwrap();
                let _ = running.await.unwrap();
                second.map(|_| ())
            }
            "load" => {
                session = text("session");
                service
                    .load_session_with(session.clone(), mcp_servers.clone())
                    .await
            }
            "promptDuringLoad" => {
                session = text("session");
                let loader = service.clone();
                let load_session = session.clone();
                let loading = tokio::spawn(async move { loader.load_session(load_session).await });
                wait_for(&events, |e| e["kind"] == "user").await;
                let early = service.prompt(session.clone(), text("text"), vec![]).await;
                mark(&events, "earlyPrompt", &early);
                loading.await.unwrap()
            }
            "setConfig" => {
                service
                    .set_config(session.clone(), text("id"), text("value"))
                    .await
            }
            "authenticate" => match step.get("credential") {
                Some(credential) => {
                    let credential: AuthCredential =
                        serde_json::from_value(credential.clone()).unwrap();
                    service.authenticate_with(text("method"), credential).await
                }
                None => service.authenticate(text("method")).await,
            },
            "cancelAfter" => {
                let runner = service.clone();
                let prompt_session = session.clone();
                let prompt_text = text("text");
                let running = tokio::spawn(async move {
                    runner.prompt(prompt_session, prompt_text, vec![]).await
                });
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                service.cancel(session.clone()).unwrap();
                running.await.unwrap()
            }
            "listSessions" => service.list_sessions().await.map(|found| {
                let ids: Vec<Value> = found.iter().map(|s| json!(s.session_id)).collect();
                if let Some(want) = step.get("expectSessions") {
                    assert_eq!(&Value::Array(ids), want, "{step}: listed sessions");
                }
            }),
            "deleteSession" => service.delete_session(text("session")).await,
            other => panic!("unknown drive step {other}"),
        };
        mark(&events, action, &result);
        check(step, &result);
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let _ = service.shutdown();

    let actual = events.lock().unwrap().clone();
    let shown: Vec<Value> = actual
        .iter()
        .filter(|e| e["kind"] != "log")
        .cloned()
        .collect();
    let label = format!("{agent}/{name}");
    in_order(
        &label,
        expected["events"].as_array().unwrap_or(&empty),
        &shown,
    );
    none_of(
        &label,
        expected["absent"].as_array().unwrap_or(&empty),
        &shown,
    );
    for count in expected["counts"].as_array().unwrap_or(&empty) {
        let found = shown
            .iter()
            .filter(|have| subset(&count["match"], Some(have)))
            .count();
        assert_eq!(
            Some(found as u64),
            count["count"].as_u64(),
            "{label}: count of {}",
            count["match"]
        );
    }
    let sent: Vec<Value> = std::fs::read_to_string(&record)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    in_order(&label, expected["sent"].as_array().unwrap_or(&empty), &sent);
    none_of(
        &label,
        expected["notSent"].as_array().unwrap_or(&empty),
        &sent,
    );
    for secret in expected["debugExclude"].as_array().unwrap_or(&empty) {
        let secret = secret.as_str().unwrap();
        for line in debug.lock().unwrap().iter() {
            assert!(
                !line.contains(secret),
                "{label}: secret leaked into Debug output: {line}"
            );
        }
    }
    for secret in expected["logsExclude"].as_array().unwrap_or(&empty) {
        let secret = secret.as_str().unwrap();
        for event in actual.iter().filter(|e| e["kind"] == "log") {
            assert!(
                !event["line"].as_str().unwrap_or_default().contains(secret),
                "{label}: secret leaked into log: {event}"
            );
        }
    }
}

macro_rules! fixture {
    ($test:ident, $agent:literal, $name:literal) => {
        #[tokio::test]
        async fn $test() {
            replay($agent, $name).await;
        }
    };
}

fixture!(
    gemini_mode_update_chunk_becomes_current_mode,
    "gemini",
    "mode-update"
);
fixture!(
    gemini_legacy_modes_and_models_become_config,
    "gemini",
    "legacy-config"
);
fixture!(
    gemini_warning_thought_becomes_notice,
    "gemini",
    "thought-warning"
);
fixture!(
    gemini_subject_thought_starts_new_block,
    "gemini",
    "thought-subject"
);
fixture!(
    gemini_tool_in_progress_after_approval,
    "gemini",
    "pending-after-approval"
);
fixture!(
    gemini_file_resolution_is_internal,
    "gemini",
    "internal-resolution"
);
fixture!(gemini_diff_paths_and_change, "gemini", "diff-paths");
fixture!(gemini_empty_shell_output_hint, "gemini", "shell-empty");
fixture!(gemini_load_waits_for_replay, "gemini", "load-replay");
fixture!(gemini_auth_with_api_key_and_gateway, "gemini", "auth-meta");
fixture!(gemini_turn_limit_or_loop_hint, "gemini", "turn-limit");
fixture!(
    gemini_busy_session_gets_no_second_prompt,
    "gemini",
    "busy-prompt"
);
fixture!(opencode_tool_updates_merge, "opencode", "tool-merge");
fixture!(opencode_auth_failure_on_prompt, "opencode", "auth-prompt");
fixture!(opencode_retry_notice_and_clear, "opencode", "retry-notice");
fixture!(
    opencode_replay_keeps_attachments,
    "opencode",
    "replay-attachments"
);
fixture!(opencode_child_session_parent, "opencode", "child-session");
fixture!(opencode_message_id_starts_bubble, "opencode", "message-id");
fixture!(opencode_mcp_filter, "opencode", "mcp-filter");
fixture!(
    opencode_edits_bypass_review_flag,
    "opencode",
    "capabilities"
);
fixture!(
    opencode_slash_without_output_hint,
    "opencode",
    "slash-no-output"
);
fixture!(
    opencode_stop_deadline_is_eight_seconds,
    "opencode",
    "stop-deadline"
);
fixture!(claude_stdio_mcp_without_type, "claude", "mcp-stdio");
fixture!(claude_subagent_parent, "claude", "subagent-parent");
fixture!(codex_mcp_filter, "codex", "mcp-filter");
fixture!(codex_image_generation, "codex", "image-generation");
fixture!(
    generic_permission_forwards_tool_call,
    "generic",
    "permission-details"
);
fixture!(generic_complete_carries_usage, "generic", "complete-usage");
fixture!(generic_tool_typed_fields, "generic", "tool-fields");
fixture!(generic_changes_nothing, "generic", "unchanged");
fixture!(generic_mcp_gated_by_capabilities, "generic", "mcp-gating");
fixture!(generic_auth_required_from_prompt, "generic", "auth-prompt");
// Live run findings (claude-agent-acp 0.98.0, codex-acp 2.3.0, OpenCode
// 2.0.32, gemini-cli 0.46.0).
fixture!(claude_bypass_mode_warns_until_safe, "claude", "bypass-mode");
fixture!(
    codex_full_access_mode_warns_until_safe,
    "codex",
    "full-access-mode"
);
fixture!(gemini_yolo_mode_warns_until_safe, "gemini", "yolo-mode");
fixture!(
    opencode_rejection_marks_cancelled_turn,
    "opencode",
    "reject-cancelled"
);
fixture!(codex_list_follows_empty_pages, "codex", "list-empty-pages");
fixture!(
    claude_deleted_session_stays_hidden,
    "claude",
    "delete-still-listed"
);
fixture!(claude_mcp_tool_kind_other, "claude", "mcp-tool-kind");
fixture!(
    claude_auth_status_never_logged,
    "claude",
    "auth-status-redacted"
);
fixture!(
    opencode_default_model_auth_hint,
    "opencode",
    "auth-default-model"
);
fixture!(
    gemini_account_message_and_env_method,
    "gemini",
    "unsupported-client"
);
fixture!(
    codex_thread_status_is_not_session_info,
    "codex",
    "thread-status"
);
// Start-mode policy (#81): a bypass mode from the agent's own configuration
// is changed to its approval mode at session start unless the user opted in.
fixture!(
    claude_start_mode_approval_leaves_bypass,
    "claude",
    "start-mode-approval"
);
fixture!(
    codex_start_mode_approval_leaves_full_access,
    "codex",
    "start-mode-approval"
);
fixture!(
    codex_start_mode_agent_default_keeps_full_access,
    "codex",
    "start-mode-agent-default"
);
fixture!(
    gemini_start_mode_approval_leaves_yolo,
    "gemini",
    "start-mode-approval"
);
fixture!(
    opencode_start_mode_changes_nothing,
    "opencode",
    "start-mode"
);
// A delegated child always starts in the approval mode, whatever the user's
// start mode for chats, and asks Claude not to persist it (ADR 0003).
fixture!(
    codex_child_ignores_agent_default_start_mode,
    "codex",
    "child-start-mode"
);
fixture!(
    claude_child_session_meta_and_start_mode,
    "claude",
    "child-session"
);
fixture!(
    generic_start_mode_approval_leaves_bypass,
    "generic",
    "start-mode-approval"
);
fixture!(
    claude_interrupted_replay_is_a_notice,
    "claude",
    "interrupted-replay"
);
