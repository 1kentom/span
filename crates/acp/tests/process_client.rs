use span_acp::{AgentCommand, AgentEvent, AgentService, AuthError};
use span_core::{CoreWorkspace, TextEdit};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

type Events = mpsc::UnboundedReceiver<AgentEvent>;
async fn next(events: &mut Events, matches: impl Fn(&AgentEvent) -> bool) -> AgentEvent {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let event = events.recv().await.expect("event stream closed");
            if matches(&event) {
                return event;
            }
        }
    })
    .await
    .expect("matching event timed out")
}
async fn setup() -> (
    tempfile::TempDir,
    Arc<Mutex<CoreWorkspace>>,
    AgentService,
    Events,
    String,
) {
    let directory = tempfile::tempdir().expect("temporary workspace");
    std::fs::write(directory.path().join("sample.txt"), "disk text\n").expect("fixture file");
    let mut workspace = CoreWorkspace::open(directory.path())
        .expect("workspace")
        .with_user_settings(None);
    let initial = workspace.open_buffer("sample.txt").expect("open fixture");
    workspace
        .edit_buffer(
            "sample.txt",
            initial.revision,
            vec![TextEdit {
                from: 0,
                to: 9,
                insert: "unsaved editor text".into(),
            }],
        )
        .expect("edit fixture");
    let workspace = Arc::new(Mutex::new(workspace));
    let (tx, events) = mpsc::unbounded_channel();
    let config = AgentCommand {
        command: "node".into(),
        args: vec![format!(
            "{}/tests/fixtures/agent.mjs",
            env!("CARGO_MANIFEST_DIR")
        )],
        env: BTreeMap::new(),
    };
    let service = AgentService::start(
        config,
        directory.path().to_string_lossy().into_owned(),
        workspace.clone(),
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .await
    .expect("initialize actual subprocess");
    let session = service.new_session().await.expect("new ACP session");
    (directory, workspace, service, events, session)
}
#[tokio::test]
async fn real_process_stream_permission_unsaved_read_and_review() {
    let (directory, workspace, service, mut events, session) = setup().await;
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "edit".into(), vec![])
            .await
    });
    next(
        &mut events,
        |e| matches!(e, AgentEvent::Thought { text, .. } if text == "Checking buffer"),
    )
    .await;
    next(
        &mut events,
        |e| matches!(e, AgentEvent::Plan { entries, .. } if entries.len() == 1),
    )
    .await;
    next(
        &mut events,
        |e| matches!(e, AgentEvent::Tool { tool_call_id, .. } if tool_call_id == "edit-1"),
    )
    .await;
    let text = next(&mut events, |e| matches!(e, AgentEvent::Text { .. })).await;
    assert!(matches!(text, AgentEvent::Text { text, .. } if text.contains("unsaved editor text")));
    let permission = next(&mut events, |e| matches!(e, AgentEvent::Permission { .. })).await;
    let request_id = match permission {
        AgentEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    assert!(service
        .respond_permission(
            "wrong-session".into(),
            request_id.clone(),
            Some("yes".into())
        )
        .is_err());
    service
        .respond_permission(session, request_id, Some("yes".into()))
        .expect("permission response");
    let proposal = match next(&mut events, |e| matches!(e, AgentEvent::Proposal { .. })).await {
        AgentEvent::Proposal { proposal, .. } => proposal,
        _ => unreachable!(),
    };
    assert_eq!(
        std::fs::read_to_string(directory.path().join("sample.txt")).unwrap(),
        "disk text\n"
    );
    assert!(service
        .review_proposal(proposal.id.clone(), true, proposal.base_revision + 1)
        .is_err());
    let snapshot = service
        .review_proposal(proposal.id, true, proposal.base_revision)
        .expect("accept proposal");
    assert_eq!(snapshot.text, "agent proposal\n");
    assert_ne!(snapshot.revision, snapshot.saved_revision);
    assert_eq!(
        workspace
            .lock()
            .unwrap()
            .agent_read("sample.txt")
            .unwrap()
            .text,
        "agent proposal\n"
    );
    assert_eq!(
        std::fs::read_to_string(directory.path().join("sample.txt")).unwrap(),
        "disk text\n"
    );
    prompt
        .await
        .expect("prompt task")
        .expect("prompt completed");
    service.shutdown().expect("disconnect");
}
#[tokio::test]
async fn stop_resolves_pending_permission_and_rejects_late_decision() {
    let (_directory, _workspace, service, mut events, session) = setup().await;
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "edit".into(), vec![])
            .await
    });
    let request_id = match next(&mut events, |e| matches!(e, AgentEvent::Permission { .. })).await {
        AgentEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    service.cancel(session.clone()).expect("cancel");
    next(&mut events, |e| {
        matches!(e, AgentEvent::PermissionResolved { .. })
    })
    .await;
    assert!(service
        .respond_permission(session, request_id, Some("yes".into()))
        .is_err());
    prompt
        .await
        .expect("prompt task")
        .expect("cancelled prompt response");
    service.shutdown().expect("shutdown");
}
#[tokio::test]
async fn stop_rejects_staged_edit_atomically() {
    let (_directory, workspace, service, mut events, session) = setup().await;
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "edit".into(), vec![])
            .await
    });
    let request_id = match next(&mut events, |e| matches!(e, AgentEvent::Permission { .. })).await {
        AgentEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    service
        .respond_permission(session.clone(), request_id, Some("yes".into()))
        .unwrap();
    let proposal = match next(&mut events, |e| matches!(e, AgentEvent::Proposal { .. })).await {
        AgentEvent::Proposal { proposal, .. } => proposal,
        _ => unreachable!(),
    };
    service.cancel(session).unwrap();
    assert!(service
        .review_proposal_hunks(
            proposal.id.clone(),
            vec![proposal.hunks[0].id.clone()],
            proposal.base_revision
        )
        .is_err());
    assert!(service
        .review_proposal(proposal.id, true, proposal.base_revision)
        .is_err());
    next(&mut events, |e| {
        matches!(
            e,
            AgentEvent::ProposalResolved {
                accepted: false,
                ..
            }
        )
    })
    .await;
    assert!(workspace
        .lock()
        .unwrap()
        .agent_read("sample.txt")
        .unwrap()
        .text
        .contains("unsaved editor text"));
    prompt.await.unwrap().unwrap();
    service.shutdown().unwrap();
}
#[tokio::test]
async fn malformed_and_failed_processes_report_errors() {
    for mode in ["truncated", "crash"] {
        let (_directory, _workspace, service, mut events, session) = setup().await;
        assert!(service.prompt(session, mode.into(), vec![]).await.is_err());
        next(
            &mut events,
            |e| matches!(e, AgentEvent::Status { state, .. } if state == "disconnected"),
        )
        .await;
    }
}

#[tokio::test]
async fn remembered_permission_is_scoped_to_session_and_read_revision_is_enforced() {
    let (_directory, workspace, service, mut events, session) = setup().await;
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "edit".into(), vec![])
            .await
    });
    let request_id = match next(&mut events, |e| matches!(e, AgentEvent::Permission { .. })).await {
        AgentEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    service
        .respond_permission(session.clone(), request_id, Some("always".into()))
        .unwrap();
    let proposal = match next(&mut events, |e| matches!(e, AgentEvent::Proposal { .. })).await {
        AgentEvent::Proposal { proposal, .. } => proposal,
        _ => unreachable!(),
    };
    {
        let mut workspace = workspace.lock().unwrap();
        let snapshot = workspace.agent_read("sample.txt").unwrap();
        workspace
            .edit_buffer(
                "sample.txt",
                snapshot.revision,
                vec![TextEdit {
                    from: 0,
                    to: 0,
                    insert: "typed during review ".into(),
                }],
            )
            .unwrap();
    }
    let rejected = service
        .review_proposal(proposal.id, false, proposal.base_revision)
        .unwrap();
    assert!(rejected.text.starts_with("typed during review "));
    prompt.await.unwrap().unwrap();

    // The same tool and input in the same session reuses the explicit always choice.
    let prompt_service = service.clone();
    let prompt =
        tokio::spawn(async move { prompt_service.prompt(session, "edit".into(), vec![]).await });
    let proposal = match next(&mut events, |e| {
        matches!(
            e,
            AgentEvent::Proposal { .. } | AgentEvent::Permission { .. }
        )
    })
    .await
    {
        AgentEvent::Proposal { proposal, .. } => proposal,
        _ => panic!("same-session permission should be remembered"),
    };
    service
        .review_proposal(proposal.id, false, proposal.base_revision)
        .unwrap();
    prompt.await.unwrap().unwrap();

    // A new session must ask again. An edit after the read invalidates its write base.
    let session = service.new_session().await.unwrap();
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "edit".into(), vec![])
            .await
    });
    let request_id = match next(&mut events, |e| matches!(e, AgentEvent::Permission { .. })).await {
        AgentEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    {
        let mut workspace = workspace.lock().unwrap();
        let snapshot = workspace.agent_read("sample.txt").unwrap();
        workspace
            .edit_buffer(
                "sample.txt",
                snapshot.revision,
                vec![TextEdit {
                    from: 0,
                    to: 0,
                    insert: "concurrent ".into(),
                }],
            )
            .unwrap();
    }
    service
        .respond_permission(session, request_id, Some("yes".into()))
        .unwrap();
    prompt.await.unwrap().unwrap();
    assert!(workspace
        .lock()
        .unwrap()
        .agent_read("sample.txt")
        .unwrap()
        .text
        .starts_with("concurrent "));
    service.shutdown().unwrap();
}

#[tokio::test]
async fn unresponsive_stop_terminates_connection_with_bounded_deadline() {
    let (_directory, _workspace, service, mut events, session) = setup().await;
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "stubborn".into(), vec![])
            .await
    });
    next(&mut events, |e| matches!(e, AgentEvent::Log { direction, line } if direction == "Stdin" && line.contains("stubborn"))).await;
    service.cancel(session).unwrap();
    next(
        &mut events,
        |e| matches!(e, AgentEvent::Status { state, .. } if state == "disconnected"),
    )
    .await;
    assert!(prompt.await.unwrap().is_err());
}

#[tokio::test]
async fn session_creation_timeout_recovers_from_unresponsive_agent() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(None),
    ));
    let (tx, mut events) = mpsc::unbounded_channel();
    let service = AgentService::start(
        AgentCommand {
            command: "node".into(),
            args: vec![
                format!("{}/tests/fixtures/agent.mjs", env!("CARGO_MANIFEST_DIR")),
                "--hang-session".into(),
            ],
            env: BTreeMap::new(),
        },
        directory.path().to_string_lossy().into_owned(),
        workspace,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .await
    .unwrap();
    let error = tokio::time::timeout(std::time::Duration::from_secs(40), service.new_session())
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.contains("timed out"));
    next(
        &mut events,
        |e| matches!(e, AgentEvent::Status { state, .. } if state == "disconnected"),
    )
    .await;
}

#[tokio::test]
async fn selected_hunks_apply_unsaved_and_partial_write_reports_reread() {
    let (directory, workspace, service, mut events, session) = setup().await;
    {
        let mut workspace = workspace.lock().unwrap();
        let snapshot = workspace.agent_read("sample.txt").unwrap();
        workspace
            .edit_buffer(
                "sample.txt",
                snapshot.revision,
                vec![TextEdit {
                    from: 0,
                    to: snapshot.text.encode_utf16().count() as u32,
                    insert: "one\nkeep\nthree\n".into(),
                }],
            )
            .unwrap();
    }
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "multi".into(), vec![])
            .await
    });
    let request_id = match next(&mut events, |event| {
        matches!(event, AgentEvent::Permission { .. })
    })
    .await
    {
        AgentEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    service
        .respond_permission(session, request_id, Some("yes".into()))
        .unwrap();
    let proposal = match next(&mut events, |event| {
        matches!(event, AgentEvent::Proposal { .. })
    })
    .await
    {
        AgentEvent::Proposal { proposal, .. } => proposal,
        _ => unreachable!(),
    };
    assert_eq!(proposal.hunks.len(), 2);
    assert!(service
        .review_proposal_hunks(
            proposal.id.clone(),
            vec!["wrong-hunk".into()],
            proposal.base_revision
        )
        .is_err());
    let snapshot = service
        .review_proposal_hunks(
            proposal.id,
            vec![proposal.hunks[0].id.clone()],
            proposal.base_revision,
        )
        .unwrap();
    assert_eq!(snapshot.text, "ONE\nkeep\nthree\n");
    assert_ne!(snapshot.revision, snapshot.saved_revision);
    next(&mut events, |event| {
        matches!(event, AgentEvent::ProposalResolved { accepted: true, .. })
    })
    .await;
    next(&mut events, |event| matches!(event, AgentEvent::Log { direction, line } if direction == "Stdin" && line.contains("Only selected edit hunks were accepted"))).await;
    prompt.await.unwrap().unwrap();
    assert_eq!(
        std::fs::read_to_string(directory.path().join("sample.txt")).unwrap(),
        "disk text\n"
    );
    service.shutdown().unwrap();
}

#[tokio::test]
async fn identical_write_acknowledges_without_pending_review_or_revision_change() {
    let (_directory, workspace, service, mut events, session) = setup().await;
    let before = workspace.lock().unwrap().agent_read("sample.txt").unwrap();
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "same".into(), vec![])
            .await
    });
    let request_id = match next(&mut events, |event| {
        matches!(event, AgentEvent::Permission { .. })
    })
    .await
    {
        AgentEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    service
        .respond_permission(session, request_id, Some("yes".into()))
        .unwrap();
    let event = next(&mut events, |event| {
        matches!(
            event,
            AgentEvent::Proposal { .. } | AgentEvent::Complete { .. }
        )
    })
    .await;
    assert!(matches!(event, AgentEvent::Complete { stop_reason, .. } if stop_reason == "end_turn"));
    prompt.await.unwrap().unwrap();
    let after = workspace.lock().unwrap().agent_read("sample.txt").unwrap();
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.text, before.text);
    service.shutdown().unwrap();
}

#[tokio::test]
async fn incompatible_session_method_is_actionable_and_closes_process() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(None),
    ));
    let (tx, mut events) = mpsc::unbounded_channel();
    let service = AgentService::start(
        AgentCommand {
            command: "node".into(),
            args: vec![
                format!("{}/tests/fixtures/agent.mjs", env!("CARGO_MANIFEST_DIR")),
                "--missing-session".into(),
            ],
            env: BTreeMap::new(),
        },
        directory.path().to_string_lossy().into_owned(),
        workspace,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .await
    .unwrap();
    let message = service.new_session().await.unwrap_err();
    assert!(message.contains("does not support ACP editor sessions"));
    assert!(!message.contains("-32601"));
    next(
        &mut events,
        |event| matches!(event, AgentEvent::Log { line, .. } if line.contains("-32601")),
    )
    .await;
    service.shutdown_and_wait().await.unwrap();
    assert!(service.new_session().await.is_err());
}

#[tokio::test]
async fn explicit_disconnect_waits_for_pending_review_cleanup() {
    let (_directory, workspace, service, mut events, session) = setup().await;
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "edit".into(), vec![])
            .await
    });
    let request_id = match next(&mut events, |event| {
        matches!(event, AgentEvent::Permission { .. })
    })
    .await
    {
        AgentEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    service
        .respond_permission(session, request_id, Some("yes".into()))
        .unwrap();
    let proposal = match next(&mut events, |event| {
        matches!(event, AgentEvent::Proposal { .. })
    })
    .await
    {
        AgentEvent::Proposal { proposal, .. } => proposal,
        _ => unreachable!(),
    };
    service.shutdown_and_wait().await.unwrap();
    assert!(service
        .review_proposal(proposal.id, true, proposal.base_revision)
        .is_err());
    assert!(workspace
        .lock()
        .unwrap()
        .agent_read("sample.txt")
        .unwrap()
        .text
        .contains("unsaved editor text"));
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), prompt)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn managed_adapter_removal_waits_for_real_process_and_preserves_global_node() {
    let cache = tempfile::tempdir().unwrap();
    let workspace_dir = tempfile::tempdir().unwrap();
    let version = cache.path().join("codex-acp/1.0.0");
    std::fs::create_dir_all(&version).unwrap();
    let script = version.join("agent.mjs");
    std::fs::copy(
        format!("{}/tests/fixtures/agent.mjs", env!("CARGO_MANIFEST_DIR")),
        &script,
    )
    .unwrap();
    let node = span_core::resolve_program("node").unwrap();
    let installed = span_acp::InstalledAgent {
        id: "codex-acp".into(),
        version: "1.0.0".into(),
        launch: AgentCommand {
            command: node.to_string_lossy().into_owned(),
            args: vec![script.to_string_lossy().into_owned()],
            env: BTreeMap::new(),
        },
    };
    std::fs::write(
        version.join("span-agent.json"),
        serde_json::to_vec(&installed).unwrap(),
    )
    .unwrap();
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(workspace_dir.path())
            .unwrap()
            .with_user_settings(None),
    ));
    let service = AgentService::start(
        installed.launch,
        workspace_dir.path().to_string_lossy().into_owned(),
        workspace,
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    service.new_session().await.unwrap();
    let error = span_acp::remove_installed_agent(cache.path(), "codex-acp", true)
        .await
        .unwrap_err();
    assert!(error.contains("Disconnect"));
    assert!(script.exists());
    service.shutdown_and_wait().await.unwrap();
    span_acp::remove_installed_agent(cache.path(), "codex-acp", true)
        .await
        .unwrap();
    assert!(!version.exists());
    assert!(node.exists());
}

#[tokio::test]
async fn incompatible_prompt_method_also_closes_connection() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(None),
    ));
    let service = AgentService::start(
        AgentCommand {
            command: "node".into(),
            args: vec![
                format!("{}/tests/fixtures/agent.mjs", env!("CARGO_MANIFEST_DIR")),
                "--missing-prompt".into(),
            ],
            env: BTreeMap::new(),
        },
        directory.path().to_string_lossy().into_owned(),
        workspace,
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    let session = service.new_session().await.unwrap();
    let message = service
        .prompt(session, "test".into(), vec![])
        .await
        .unwrap_err();
    assert!(message.contains("does not support ACP conversation prompts"));
    assert!(!message.contains("-32601"));
    service.shutdown_and_wait().await.unwrap();
    assert!(service.new_session().await.is_err());
}

#[tokio::test]
async fn lists_and_restores_earlier_sessions_with_replayed_history() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(None),
    ));
    let (tx, mut events) = mpsc::unbounded_channel();
    let service = AgentService::start(
        AgentCommand {
            command: "node".into(),
            args: vec![
                format!("{}/tests/fixtures/agent.mjs", env!("CARGO_MANIFEST_DIR")),
                "--resume".into(),
            ],
            env: BTreeMap::new(),
        },
        directory.path().to_string_lossy().into_owned(),
        workspace,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .await
    .unwrap();
    next(&mut events, |e| {
        matches!(
            e,
            AgentEvent::Capabilities {
                can_load_session: true,
                can_list_sessions: true
            }
        )
    })
    .await;
    service.new_session().await.unwrap();
    let listed = service.list_sessions().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].session_id, "old-1");
    assert_eq!(listed[0].title.as_deref(), Some("Earlier chat"));
    service.load_session("old-1".into()).await.unwrap();
    next(&mut events, |e| {
        matches!(e, AgentEvent::User { session_id, text, .. } if session_id == "old-1" && text == "earlier question")
    })
    .await;
    next(&mut events, |e| {
        matches!(e, AgentEvent::Text { session_id, text, .. } if session_id == "old-1" && text == "earlier answer")
    })
    .await;
    let tool = next(&mut events, |e| matches!(e, AgentEvent::Tool { .. })).await;
    let AgentEvent::Tool {
        parent_tool_call_id,
        tool_kind,
        ..
    } = tool
    else {
        unreachable!()
    };
    assert_eq!(parent_tool_call_id.as_deref(), Some("task-1"));
    assert_eq!(tool_kind.as_deref(), Some("read"));
    service
        .cancel("old-1".into())
        .expect("restored session is tracked");
}

#[tokio::test]
async fn agents_without_resume_support_report_it() {
    let (_directory, _workspace, service, _events, _session) = setup().await;
    assert!(service
        .list_sessions()
        .await
        .unwrap_err()
        .contains("cannot list"));
    assert!(service
        .load_session("x".into())
        .await
        .unwrap_err()
        .contains("cannot restore"));
}

#[tokio::test]
async fn advertised_initial_model_options_and_configuration_round_trip_are_preserved() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(None),
    ));
    let (tx, mut events) = mpsc::unbounded_channel();
    let service = AgentService::start(
        AgentCommand {
            command: "node".into(),
            args: vec![
                format!("{}/tests/fixtures/agent.mjs", env!("CARGO_MANIFEST_DIR")),
                "--config".into(),
            ],
            env: BTreeMap::new(),
        },
        directory.path().to_string_lossy().into_owned(),
        workspace,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .await
    .unwrap();
    let session = service.new_session().await.unwrap();
    let initial = next(
        &mut events,
        |event| matches!(event, AgentEvent::Config { session_id, .. } if session_id == &session),
    )
    .await;
    let AgentEvent::Config { options, .. } = initial else {
        unreachable!()
    };
    assert_eq!(options[0].current_value, "fast");
    assert_eq!(options[0].groups[0].choices.len(), 2);
    service
        .set_config(session.clone(), "model".into(), "deep".into())
        .await
        .unwrap();
    let updated = next(&mut events, |event| matches!(event, AgentEvent::Config { session_id, options } if session_id == &session && options[0].current_value == "deep")).await;
    assert!(matches!(updated, AgentEvent::Config { .. }));
    service.shutdown_and_wait().await.unwrap();
}

async fn start_with(flags: &[&str]) -> (tempfile::TempDir, AgentService, Events) {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())
            .unwrap()
            .with_user_settings(None),
    ));
    let (tx, events) = mpsc::unbounded_channel();
    let mut args = vec![format!(
        "{}/tests/fixtures/agent.mjs",
        env!("CARGO_MANIFEST_DIR")
    )];
    args.extend(flags.iter().map(|flag| flag.to_string()));
    let service = AgentService::start(
        AgentCommand {
            command: "node".into(),
            args,
            env: BTreeMap::new(),
        },
        directory.path().to_string_lossy().into_owned(),
        workspace,
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    )
    .await
    .expect("initialize actual subprocess");
    (directory, service, events)
}

fn echoed(event: AgentEvent) -> serde_json::Value {
    match event {
        AgentEvent::Text { text, .. } => serde_json::from_str(&text).expect("echo is JSON"),
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn ready_event_reports_identity_features_and_auth_methods() {
    let (_directory, _service, mut events) = start_with(&["--rich", "--auth"]).await;
    let AgentEvent::Ready {
        agent_name,
        agent_title,
        agent_version,
        features,
        auth_methods,
    } = next(&mut events, |e| matches!(e, AgentEvent::Ready { .. })).await
    else {
        unreachable!()
    };
    assert_eq!(agent_name.as_deref(), Some("span-test-peer"));
    assert_eq!(agent_title.as_deref(), Some("Span Test Peer"));
    assert_eq!(agent_version.as_deref(), Some("1.0.0"));
    assert!(features.load_session && features.image && features.embedded_context);
    assert!(!features.audio && features.mcp_http && !features.mcp_sse);
    assert!(
        features.can_list_sessions && features.can_resume_sessions && features.can_close_sessions
    );
    assert!(!features.can_delete_sessions);
    assert_eq!(auth_methods.len(), 2);
    assert_eq!(auth_methods[0].id, "token");
    assert!(auth_methods[0].supported && auth_methods[0].kind == "agent");
    assert!(!auth_methods[1].supported && auth_methods[1].kind == "terminal");
}

#[tokio::test]
async fn session_updates_become_events() {
    let (_directory, service, mut events) = start_with(&["--rich"]).await;
    let session = service.new_session().await.unwrap();
    let AgentEvent::AvailableCommands { commands, .. } = next(&mut events, |e| {
        matches!(e, AgentEvent::AvailableCommands { .. })
    })
    .await
    else {
        unreachable!()
    };
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0].name, "web");
    assert_eq!(commands[0].input_hint.as_deref(), Some("query"));
    assert!(commands[1].input_hint.is_none());
    next(&mut events, |e| {
        matches!(e, AgentEvent::CurrentMode { session_id, mode_id } if *session_id == session && mode_id == "architect")
    })
    .await;
    next(&mut events, |e| {
        matches!(e, AgentEvent::SessionInfo { title, updated_at, .. }
            if title.as_deref() == Some("Renamed chat") && updated_at.as_deref() == Some("2026-10-28T10:00:00Z"))
    })
    .await;
    next(&mut events, |e| {
        matches!(e, AgentEvent::Usage { used: 1200, size: 200000, cost_amount: Some(a), cost_currency: Some(c), .. }
            if (*a - 0.25).abs() < f64::EPSILON && c == "USD")
    })
    .await;
    next(&mut events, |e| {
        matches!(e, AgentEvent::Notice { severity, title, description, .. }
            if severity == "warning" && title == "MCP server unavailable" && description.as_deref() == Some("docs offline"))
    })
    .await;
    next(&mut events, |e| {
        matches!(e, AgentEvent::Compaction { compaction_id, status, .. } if compaction_id == "c-1" && status == "in_progress")
    })
    .await;
    next(
        &mut events,
        |e| matches!(e, AgentEvent::CompactionSummary { text, .. } if text == "Summary part"),
    )
    .await;
    next(
        &mut events,
        |e| matches!(e, AgentEvent::Compaction { status, .. } if status == "completed"),
    )
    .await;
}

#[tokio::test]
async fn complete_event_carries_every_stop_reason() {
    let (_directory, service, mut events) = start_with(&[]).await;
    let session = service.new_session().await.unwrap();
    for reason in [
        "end_turn",
        "max_tokens",
        "max_turn_requests",
        "refusal",
        "cancelled",
    ] {
        service
            .prompt(session.clone(), format!("stop:{reason}"), vec![])
            .await
            .unwrap();
        next(
            &mut events,
            |e| matches!(e, AgentEvent::Complete { stop_reason, .. } if stop_reason == reason),
        )
        .await;
    }
}

#[tokio::test]
async fn auth_required_surfaces_methods_then_authenticate_and_retry_succeeds() {
    let (_directory, service, mut events) = start_with(&["--auth"]).await;
    let error = service.new_session().await.unwrap_err();
    assert!(error.contains("Authentication required"), "{error}");
    assert!(service.auth_required());
    let AgentEvent::AuthRequired { auth_methods, .. } = next(&mut events, |e| {
        matches!(e, AgentEvent::AuthRequired { .. })
    })
    .await
    else {
        unreachable!()
    };
    assert_eq!(auth_methods[0].id, "token");
    assert!(service
        .authenticate("nope".into())
        .await
        .unwrap_err()
        .to_string()
        .contains("Unknown"));
    assert!(service
        .authenticate("tui".into())
        .await
        .unwrap_err()
        .to_string()
        .contains("Terminal sign-in"));
    service.authenticate("token".into()).await.unwrap();
    assert!(!service.auth_required());
    let session = service.new_session().await.expect("retry after sign-in");
    assert_eq!(session, "fixture-1");
}

/// Waits until the service reports a sign-in in flight.
async fn signing_in(service: &AgentService) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while !service.auth_in_progress() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("sign-in did not start");
}

/// A connection whose first session/new asked for sign-in.
async fn waiting_for_sign_in(flags: &[&str]) -> (tempfile::TempDir, AgentService, Events) {
    let (directory, service, events) = start_with(flags).await;
    assert!(service.new_session().await.is_err());
    assert!(service.auth_required());
    (directory, service, events)
}

#[tokio::test]
async fn a_second_sign_in_and_new_work_are_refused_while_one_is_in_flight() {
    let (_directory, service, _events) = waiting_for_sign_in(&["--auth", "--slow-auth"]).await;
    let first = tokio::spawn({
        let service = service.clone();
        async move { service.authenticate("token".into()).await }
    });
    signing_in(&service).await;
    let second = service.authenticate("token".into()).await.unwrap_err();
    assert!(
        matches!(second, AuthError::AuthenticationInProgress { .. }),
        "{second:?}"
    );
    // The typed kind the UI matches.
    assert_eq!(
        serde_json::to_value(&second).unwrap()["kind"],
        "authentication_in_progress"
    );
    let refused = service.new_session().await.unwrap_err();
    assert!(refused.contains("Signing in"), "{refused}");
    first.await.unwrap().expect("the first sign-in finishes");
    assert!(!service.auth_in_progress());
    assert!(!service.auth_required());
    assert_eq!(service.new_session().await.unwrap(), "fixture-1");
}

#[tokio::test]
async fn shutdown_cancels_a_pending_sign_in_at_once() {
    let (_directory, service, _events) = waiting_for_sign_in(&["--auth", "--slow-auth"]).await;
    let pending = tokio::spawn({
        let service = service.clone();
        async move { service.authenticate("token".into()).await }
    });
    signing_in(&service).await;
    let started = std::time::Instant::now();
    service.shutdown().unwrap();
    let error = pending.await.unwrap().unwrap_err();
    assert!(matches!(error, AuthError::Cancelled { .. }), "{error:?}");
    // Well before the agent's own answer at 1.5 s.
    assert!(started.elapsed() < std::time::Duration::from_millis(1000));
    assert!(!service.auth_in_progress());
    let after = service.authenticate("token".into()).await.unwrap_err();
    assert!(matches!(after, AuthError::Cancelled { .. }), "{after:?}");
}

#[tokio::test]
async fn shutdown_cancels_a_pending_session_creation_and_records_no_session() {
    let (_directory, service, mut events) = start_with(&["--hang-session"]).await;
    let pending = tokio::spawn({
        let service = service.clone();
        async move { service.new_session().await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let started = std::time::Instant::now();
    service.shutdown().unwrap();
    let error = tokio::time::timeout(std::time::Duration::from_secs(5), pending)
        .await
        .expect("session creation still waiting after shutdown")
        .unwrap()
        .unwrap_err();
    assert!(error.contains("cancelled"), "{error}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while service.is_open() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the connection did not close");
    while let Ok(event) = events.try_recv() {
        assert!(
            !matches!(event, AgentEvent::Session { .. }),
            "a session was recorded on a closed connection"
        );
    }
}

#[tokio::test]
async fn a_cancelled_sign_in_ignores_the_agents_late_answer() {
    let (_directory, service, mut events) = waiting_for_sign_in(&["--auth", "--slow-auth"]).await;
    let pending = tokio::spawn({
        let service = service.clone();
        async move { service.authenticate("token".into()).await }
    });
    signing_in(&service).await;
    assert!(service.cancel_authentication());
    let error = pending.await.unwrap().unwrap_err();
    assert_eq!(
        error,
        AuthError::Cancelled {
            message: "Sign-in was cancelled".into()
        }
    );
    assert!(!service.auth_in_progress());
    // The agent answers the dropped request at 1.5 s; Span keeps waiting for sign-in.
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    assert!(service.auth_required());
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, AgentEvent::Session { .. }), "{event:?}");
    }
    assert!(!service.cancel_authentication());
    // A new sign-in can start and applies normally.
    service.authenticate("token".into()).await.unwrap();
    assert!(!service.auth_required());
}

#[tokio::test]
async fn attachments_are_gated_by_advertised_capabilities() {
    let image = || span_acp::PromptAttachment::Image {
        data: "aGk=".into(),
        mime_type: "image/png".into(),
        uri: None,
    };
    let link = || span_acp::PromptAttachment::ResourceLink {
        uri: "file:///a.txt".into(),
        name: "a.txt".into(),
        mime_type: Some("text/plain".into()),
        description: None,
    };
    let resource = || span_acp::PromptAttachment::Resource {
        uri: "file:///a.txt".into(),
        mime_type: Some("text/plain".into()),
        text: Some("hello".into()),
        blob: None,
    };
    // Agent without image or embeddedContext support.
    let (_directory, plain, _events) = start_with(&[]).await;
    let session = plain.new_session().await.unwrap();
    assert!(plain
        .prompt(session.clone(), "hi".into(), vec![image()])
        .await
        .unwrap_err()
        .contains("image"));
    assert!(plain
        .prompt(session, "hi".into(), vec![resource()])
        .await
        .unwrap_err()
        .contains("embedded"));
    // Agent that advertises both.
    let (_directory, rich, mut events) = start_with(&["--rich"]).await;
    let session = rich.new_session().await.unwrap();
    assert!(rich
        .prompt(
            session.clone(),
            "hi".into(),
            vec![span_acp::PromptAttachment::Image {
                data: "aGk=".into(),
                mime_type: "text/plain".into(),
                uri: None,
            }]
        )
        .await
        .unwrap_err()
        .contains("MIME"));
    rich.prompt(
        session.clone(),
        "look".into(),
        vec![image(), link(), resource()],
    )
    .await
    .unwrap();
    let blocks = echoed(next(&mut events, |e| matches!(e, AgentEvent::Text { .. })).await);
    let kinds: Vec<&str> = blocks
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["text", "image", "resource_link", "resource"]);
    assert_eq!(blocks[1]["mimeType"], "image/png");
    assert_eq!(blocks[3]["resource"]["text"], "hello");
    // Resource links need no capability.
    plain_link_works(link()).await;
}

async fn plain_link_works(link: span_acp::PromptAttachment) {
    let (_directory, plain, mut events) = start_with(&[]).await;
    let session = plain.new_session().await.unwrap();
    plain
        .prompt(session, String::new(), vec![link])
        .await
        .unwrap();
    let blocks = echoed(next(&mut events, |e| matches!(e, AgentEvent::Text { .. })).await);
    assert_eq!(blocks[0]["type"], "resource_link");
}

#[tokio::test]
async fn slash_commands_travel_as_plain_prompt_text() {
    let (_directory, service, mut events) = start_with(&["--rich"]).await;
    let session = service.new_session().await.unwrap();
    service
        .prompt(session, "/web agent client protocol".into(), vec![])
        .await
        .unwrap();
    let blocks = echoed(next(&mut events, |e| matches!(e, AgentEvent::Text { .. })).await);
    assert_eq!(blocks.as_array().unwrap().len(), 1);
    assert_eq!(blocks[0]["type"], "text");
    assert_eq!(blocks[0]["text"], "/web agent client protocol");
}

#[tokio::test]
async fn form_elicitation_validates_and_returns_answers() {
    let (_directory, service, mut events) = start_with(&["--rich"]).await;
    let session = service.new_session().await.unwrap();
    let prompt_service = service.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(session, "elicit-form".into(), vec![])
            .await
    });
    let AgentEvent::Elicitation {
        request_id,
        mode,
        message,
        schema_json,
        url,
        session_id,
        ..
    } = next(&mut events, |e| matches!(e, AgentEvent::Elicitation { .. })).await
    else {
        unreachable!()
    };
    assert_eq!(mode, "form");
    assert_eq!(message, "Pick a name");
    assert!(url.is_none() && session_id.is_some());
    assert!(schema_json.unwrap().contains("\"name\""));
    // Missing required field, unknown field, bad action are rejected and stay pending.
    assert!(service
        .respond_elicitation(request_id.clone(), "accept".into(), Some("{}".into()))
        .unwrap_err()
        .contains("Missing required"));
    assert!(service
        .respond_elicitation(
            request_id.clone(),
            "accept".into(),
            Some("{\"name\":\"a\",\"x\":1}".into())
        )
        .unwrap_err()
        .contains("Unknown field"));
    assert!(service
        .respond_elicitation(request_id.clone(), "maybe".into(), None)
        .is_err());
    service
        .respond_elicitation(
            request_id.clone(),
            "accept".into(),
            Some("{\"name\":\"Ada\",\"count\":3}".into()),
        )
        .unwrap();
    next(
        &mut events,
        |e| matches!(e, AgentEvent::ElicitationResolved { request_id: id } if *id == request_id),
    )
    .await;
    let answer = echoed(next(&mut events, |e| matches!(e, AgentEvent::Text { .. })).await);
    assert_eq!(answer["action"], "accept");
    assert_eq!(answer["content"]["name"], "Ada");
    assert_eq!(answer["content"]["count"], 3);
    prompt.await.unwrap().unwrap();
    assert!(service
        .respond_elicitation(request_id, "cancel".into(), None)
        .is_err());
}

#[tokio::test]
async fn url_elicitation_completes_and_unsafe_urls_are_declined() {
    let (_directory, service, mut events) = start_with(&["--rich"]).await;
    let session = service.new_session().await.unwrap();
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "elicit-url".into(), vec![])
            .await
    });
    let AgentEvent::Elicitation {
        request_id,
        mode,
        url,
        elicitation_id,
        schema_json,
        ..
    } = next(&mut events, |e| matches!(e, AgentEvent::Elicitation { .. })).await
    else {
        unreachable!()
    };
    assert_eq!(mode, "url");
    assert_eq!(url.as_deref(), Some("https://example.com/auth"));
    assert_eq!(elicitation_id.as_deref(), Some("e-1"));
    assert!(schema_json.is_none());
    service
        .respond_elicitation(request_id, "accept".into(), None)
        .unwrap();
    next(&mut events, |e| matches!(e, AgentEvent::ElicitationComplete { elicitation_id } if elicitation_id == "e-1")).await;
    let answer = echoed(next(&mut events, |e| matches!(e, AgentEvent::Text { .. })).await);
    assert_eq!(answer["action"], "accept");
    prompt.await.unwrap().unwrap();
    // A non-http(s) URL is never shown to the user and is declined automatically.
    service
        .prompt(session, "elicit-badurl".into(), vec![])
        .await
        .unwrap();
    let answer = echoed(next(&mut events, |e| matches!(e, AgentEvent::Text { .. })).await);
    assert_eq!(answer["action"], "decline");
}

#[tokio::test]
async fn stop_cancels_pending_elicitation() {
    let (_directory, service, mut events) = start_with(&["--rich"]).await;
    let session = service.new_session().await.unwrap();
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "elicit-form".into(), vec![])
            .await
    });
    next(&mut events, |e| matches!(e, AgentEvent::Elicitation { .. })).await;
    service.cancel(session).unwrap();
    next(&mut events, |e| {
        matches!(e, AgentEvent::ElicitationResolved { .. })
    })
    .await;
    let answer = echoed(next(&mut events, |e| matches!(e, AgentEvent::Text { .. })).await);
    assert_eq!(answer["action"], "cancel");
    let _ = prompt.await;
}

#[tokio::test]
async fn close_session_succeeds_and_forgets_the_session() {
    let (_directory, service, _events) = start_with(&["--close"]).await;
    let session = service.new_session().await.expect("session");
    service.close_session(session.clone()).await.expect("close");
    let error = service.close_session(session).await.unwrap_err();
    assert!(error.contains("Unknown session"), "{error}");
    service.shutdown().expect("shutdown");
}

#[tokio::test]
async fn close_session_treats_resource_not_found_as_success() {
    let (_directory, service, _events) = start_with(&["--close-gone"]).await;
    let session = service.new_session().await.expect("session");
    service
        .close_session(session)
        .await
        .expect("-32002 means already closed");
    service.shutdown().expect("shutdown");
}

#[tokio::test]
async fn close_and_delete_are_rejected_when_not_advertised() {
    let (_directory, service, _events) = start_with(&[]).await;
    let session = service.new_session().await.expect("session");
    let close = service.close_session(session.clone()).await.unwrap_err();
    assert!(close.contains("cannot close"), "{close}");
    let delete = service.delete_session(session).await.unwrap_err();
    assert!(delete.contains("cannot delete"), "{delete}");
    service.shutdown().expect("shutdown");
}

#[tokio::test]
async fn delete_session_succeeds_for_a_history_entry() {
    let (_directory, service, _events) = start_with(&["--delete"]).await;
    service.new_session().await.expect("session");
    service
        .delete_session("old-1".into())
        .await
        .expect("delete listed session");
    service.shutdown().expect("shutdown");
}

#[tokio::test]
async fn delete_of_the_active_session_cancels_the_turn_first() {
    let (_directory, service, mut events) = start_with(&["--delete"]).await;
    let session = service.new_session().await.expect("session");
    let prompt_service = service.clone();
    let prompt_session = session.clone();
    let prompt = tokio::spawn(async move {
        prompt_service
            .prompt(prompt_session, "wait".into(), vec![])
            .await
    });
    // The fixture rejects session/delete while a prompt is unanswered, so
    // success proves the cancel reached it first.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    service
        .delete_session(session.clone())
        .await
        .expect("delete cancels first");
    prompt.await.expect("prompt task").expect("cancelled turn");
    next(
        &mut events,
        |e| matches!(e, AgentEvent::Complete { stop_reason, .. } if stop_reason == "cancelled"),
    )
    .await;
    service.shutdown().expect("shutdown");
}
