use span_acp::{AgentCommand, AgentEvent, AgentService};
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
    let prompt =
        tokio::spawn(async move { prompt_service.prompt(prompt_session, "edit".into()).await });
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
    let prompt =
        tokio::spawn(async move { prompt_service.prompt(prompt_session, "edit".into()).await });
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
    let prompt =
        tokio::spawn(async move { prompt_service.prompt(prompt_session, "edit".into()).await });
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
        assert!(service.prompt(session, mode.into()).await.is_err());
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
    let prompt =
        tokio::spawn(async move { prompt_service.prompt(prompt_session, "edit".into()).await });
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
    let prompt = tokio::spawn(async move { prompt_service.prompt(session, "edit".into()).await });
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
    let prompt =
        tokio::spawn(async move { prompt_service.prompt(prompt_session, "edit".into()).await });
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
            .prompt(prompt_session, "stubborn".into())
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
    let prompt =
        tokio::spawn(async move { prompt_service.prompt(prompt_session, "multi".into()).await });
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
    let prompt =
        tokio::spawn(async move { prompt_service.prompt(prompt_session, "same".into()).await });
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
        matches!(e, AgentEvent::User { session_id, text } if session_id == "old-1" && text == "earlier question")
    })
    .await;
    next(&mut events, |e| {
        matches!(e, AgentEvent::Text { session_id, text } if session_id == "old-1" && text == "earlier answer")
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
