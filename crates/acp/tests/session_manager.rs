//! Process level tests for several concurrent agent connections.
use span_acp::{
    AgentCommand, AgentEvent, PendingKind, SessionEvent, SessionKey, SessionManager, SessionOrigin,
};
use span_core::CoreWorkspace;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

type Events = mpsc::UnboundedReceiver<SessionEvent>;

struct Harness {
    directory: tempfile::TempDir,
    workspace: Arc<Mutex<CoreWorkspace>>,
    manager: SessionManager,
    events: Events,
}

fn harness() -> Harness {
    let directory = tempfile::tempdir().expect("temporary workspace");
    std::fs::write(directory.path().join("sample.txt"), "disk text\n").expect("fixture file");
    let workspace = Arc::new(Mutex::new(
        CoreWorkspace::open(directory.path())
            .expect("workspace")
            .with_user_settings(None),
    ));
    let (tx, events) = mpsc::unbounded_channel();
    let manager = SessionManager::new(Arc::new(move |event| {
        let _ = tx.send(event);
    }));
    Harness {
        directory,
        workspace,
        manager,
        events,
    }
}

fn fixture(flags: &[&str]) -> AgentCommand {
    let mut args = vec![format!(
        "{}/tests/fixtures/agent.mjs",
        env!("CARGO_MANIFEST_DIR")
    )];
    args.extend(flags.iter().map(|flag| flag.to_string()));
    AgentCommand {
        command: "node".into(),
        args,
        env: BTreeMap::new(),
    }
}

impl Harness {
    async fn connect(&self, flags: &[&str]) -> String {
        self.manager
            .connect(
                fixture(flags),
                self.directory.path().to_string_lossy().into_owned(),
                self.workspace.clone(),
                None,
            )
            .await
            .expect("initialize actual subprocess")
    }

    async fn root(&self, connection: &str) -> SessionKey {
        self.manager
            .open_session(connection, None, SessionOrigin::User)
            .await
            .expect("root session")
    }

    async fn next(&mut self, matches: impl Fn(&SessionEvent) -> bool) -> SessionEvent {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let event = self.events.recv().await.expect("event stream closed");
                if matches(&event) {
                    return event;
                }
            }
        })
        .await
        .expect("matching event timed out")
    }

    /// Wait until the fixture has received a `session/prompt` with this text
    /// for each of `keys`.
    async fn prompts_delivered(&mut self, text: &str, keys: &[&SessionKey]) {
        let mut waiting: HashSet<(String, String)> = keys
            .iter()
            .map(|k| (k.connection_id.clone(), k.session_id.clone()))
            .collect();
        let needle = format!("\"text\":\"{text}\"");
        while !waiting.is_empty() {
            let event = self
                .next(|e| matches!(&e.event, AgentEvent::Log { direction, line } if direction == "Stdin" && line.contains("session/prompt") && line.contains(&needle)))
                .await;
            let AgentEvent::Log { line, .. } = &event.event else {
                unreachable!()
            };
            waiting.retain(|(connection, session)| {
                !(event.connection_id == *connection
                    && line.contains(&format!("\"sessionId\":\"{session}\"")))
            });
        }
    }
}

async fn eventually(what: &str, condition: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

fn is_complete(event: &SessionEvent, key: &SessionKey, reason: &str) -> bool {
    event.connection_id == key.connection_id
        && matches!(&event.event, AgentEvent::Complete { session_id, stop_reason, .. }
            if *session_id == key.session_id && stop_reason == reason)
}

#[tokio::test]
async fn two_agents_run_concurrent_turns_without_events_crossing() {
    let mut h = harness();
    let (raw_tx, mut raw) = mpsc::unbounded_channel();
    let alpha = h
        .manager
        .connect(
            fixture(&["--name=alpha"]),
            h.directory.path().to_string_lossy().into_owned(),
            h.workspace.clone(),
            Some(Arc::new(move |event| {
                let _ = raw_tx.send(event);
            })),
        )
        .await
        .unwrap();
    let beta = h.connect(&["--name=beta"]).await;
    let a1 = h.root(&alpha).await;
    let a2 = h.root(&alpha).await;
    let b1 = h.root(&beta).await;
    // Session ids only differ by connection: both processes number from 1.
    assert_eq!(a1.session_id, b1.session_id);
    let names = HashMap::from([(alpha.clone(), "alpha"), (beta.clone(), "beta")]);

    let turns: Vec<_> = [&a1, &a2, &b1]
        .into_iter()
        .map(|key| {
            let (manager, key) = (h.manager.clone(), key.clone());
            tokio::spawn(async move { manager.prompt(&key, "stream:20".into(), vec![]).await })
        })
        .collect();
    let mut chunks: Vec<SessionKey> = Vec::new();
    let mut first_complete_at = None;
    let mut done = 0;
    while done < 3 {
        let event = h
            .next(|e| {
                matches!(
                    e.event,
                    AgentEvent::Text { .. } | AgentEvent::Complete { .. }
                )
            })
            .await;
        let key = SessionKey::new(
            event.connection_id.clone(),
            event
                .session_id
                .clone()
                .expect("session event carries its id"),
        );
        assert_eq!(event.agent_name, names[&event.connection_id]);
        match &event.event {
            AgentEvent::Text {
                session_id, text, ..
            } => {
                assert_eq!(*session_id, key.session_id);
                assert!(
                    text.starts_with(&format!("{}:{}:", event.agent_name, key.session_id)),
                    "chunk {text} arrived tagged {key:?}"
                );
                chunks.push(key);
            }
            AgentEvent::Complete { .. } => {
                first_complete_at.get_or_insert(chunks.len());
                done += 1;
            }
            _ => unreachable!(),
        }
    }
    for turn in turns {
        turn.await.unwrap().expect("turn finished");
    }
    for key in [&a1, &a2, &b1] {
        assert_eq!(chunks.iter().filter(|k| k == &key).count(), 20);
    }
    // All three sessions were streaming before any of them finished.
    let before_first_complete: HashSet<_> = chunks[..first_complete_at.unwrap()].iter().collect();
    assert_eq!(before_first_complete.len(), 3, "turns did not overlap");
    // The direct channel carries the unchanged events of its own connection only.
    let mut raw_texts = 0;
    while let Ok(event) = raw.try_recv() {
        if let AgentEvent::Text { text, .. } = event {
            assert!(text.starts_with("alpha:"), "{text}");
            raw_texts += 1;
        }
    }
    assert_eq!(raw_texts, 40);
    h.manager.disconnect(&alpha).unwrap();
    h.manager.disconnect(&beta).unwrap();
}

#[tokio::test]
async fn follow_up_to_a_busy_session_queues_and_runs_after() {
    let mut h = harness();
    let connection = h.connect(&["--rich"]).await;
    let key = h.root(&connection).await;
    let (manager, turn_key) = (h.manager.clone(), key.clone());
    let first = tokio::spawn(async move {
        manager
            .prompt(&turn_key, "elicit-form".into(), vec![])
            .await
    });
    let request_id = match h
        .next(|e| matches!(e.event, AgentEvent::Elicitation { .. }))
        .await
        .event
    {
        AgentEvent::Elicitation { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    let (manager, turn_key) = (h.manager.clone(), key.clone());
    let second =
        tokio::spawn(async move { manager.prompt(&turn_key, "echo".into(), vec![]).await });
    eventually("the follow-up to queue", || {
        h.manager
            .session(&key)
            .is_some_and(|s| s.busy && s.queued == 1)
    })
    .await;
    h.manager
        .respond_elicitation(
            &connection,
            request_id,
            "accept".into(),
            Some("{\"name\":\"Ada\"}".into()),
        )
        .unwrap();
    // The queued prompt reaches the agent only after the first turn completes.
    let mut order = Vec::new();
    while order.len() < 4 {
        let event = h
            .next(|e| {
                matches!(&e.event, AgentEvent::Complete { .. })
                    || matches!(&e.event, AgentEvent::Log { direction, line } if direction == "Stdin" && line.contains("session/prompt") && line.contains("\"text\":\"echo\""))
                    || matches!(&e.event, AgentEvent::Text { .. })
            })
            .await;
        order.push(match event.event {
            AgentEvent::Complete { .. } => "complete",
            AgentEvent::Log { .. } => "echo sent",
            AgentEvent::Text { text, .. } if text.contains("\"accept\"") => "answer",
            AgentEvent::Text { .. } => "echo reply",
            _ => unreachable!(),
        });
    }
    assert_eq!(order, ["answer", "complete", "echo sent", "echo reply"]);
    first.await.unwrap().expect("first turn");
    second.await.unwrap().expect("queued turn");
    let info = h.manager.session(&key).unwrap();
    assert!(!info.busy && info.queued == 0);
    h.manager.disconnect(&connection).unwrap();
}

#[tokio::test]
async fn cancelling_the_lead_cascades_to_every_child() {
    let mut h = harness();
    let lead = h.connect(&["--name=lead"]).await;
    let worker = h.connect(&["--name=worker"]).await;
    let root = h.root(&lead).await;
    let control = h.manager.agent_control(root.clone()).unwrap();
    let child = control.delegate(&worker).await.unwrap();
    let sibling = control.delegate(&lead).await.unwrap();
    let grandchild = h
        .manager
        .agent_control(child.clone())
        .unwrap()
        .delegate(&worker)
        .await
        .unwrap();
    let unrelated = h.root(&worker).await;

    let info = h.manager.session(&grandchild).unwrap();
    assert_eq!(info.parent.as_ref(), Some(&child));
    assert_eq!(info.depth, 2);
    assert_eq!(info.origin, SessionOrigin::Delegated);
    assert_eq!(info.agent_name, "worker");
    assert_eq!(control.children().len(), 3);

    let keys = [&root, &child, &sibling, &grandchild, &unrelated];
    let turns: Vec<_> = keys
        .iter()
        .map(|key| {
            let (manager, key) = (h.manager.clone(), (*key).clone());
            tokio::spawn(async move { manager.prompt(&key, "wait".into(), vec![]).await })
        })
        .collect();
    h.prompts_delivered("wait", &keys).await;
    let (manager, key) = (h.manager.clone(), grandchild.clone());
    let queued = tokio::spawn(async move { manager.prompt(&key, "echo".into(), vec![]).await });
    eventually("the follow-up to queue", || {
        h.manager
            .session(&grandchild)
            .is_some_and(|s| s.queued == 1)
    })
    .await;

    h.manager.cancel(&root).expect("cancel lead");
    let mut cancelled = HashSet::new();
    while cancelled.len() < 4 {
        let event = h
            .next(|e| matches!(&e.event, AgentEvent::Complete { stop_reason, .. } if stop_reason == "cancelled"))
            .await;
        cancelled.insert(SessionKey::new(
            event.connection_id,
            event.session_id.unwrap(),
        ));
    }
    assert_eq!(
        cancelled,
        HashSet::from([
            root.clone(),
            child.clone(),
            sibling.clone(),
            grandchild.clone()
        ])
    );
    let error = queued.await.unwrap().unwrap_err();
    assert!(error.contains("Cancelled before"), "{error}");
    let mut turns = turns.into_iter();
    for _ in 0..4 {
        turns
            .next()
            .unwrap()
            .await
            .unwrap()
            .expect("cancelled turn");
    }
    // A session outside the tree keeps running.
    assert!(h.manager.session(&unrelated).unwrap().busy);
    h.manager.cancel(&unrelated).unwrap();
    turns.next().unwrap().await.unwrap().unwrap();
    // Cancel stops turns; the tree stays open for the next prompt.
    assert_eq!(control.children().len(), 3);
    h.manager.disconnect(&lead).unwrap();
    h.manager.disconnect(&worker).unwrap();
}

#[tokio::test]
async fn closing_the_lead_closes_and_forgets_children() {
    let mut h = harness();
    let lead = h.connect(&["--close"]).await;
    let worker = h.connect(&["--close"]).await;
    let root = h.root(&lead).await;
    let child = h
        .manager
        .agent_control(root.clone())
        .unwrap()
        .delegate(&worker)
        .await
        .unwrap();
    let (manager, key) = (h.manager.clone(), child.clone());
    let turn = tokio::spawn(async move { manager.prompt(&key, "wait".into(), vec![]).await });
    h.prompts_delivered("wait", &[&child]).await;
    h.manager.close(&root).await.expect("close lead");
    // The child's cancelled Complete and its session/close can arrive in
    // either order under load, so wait for both.
    let (mut completed, mut closed) = (false, false);
    while !(completed && closed) {
        let event = h
            .next(|e| {
                is_complete(e, &child, "cancelled")
                    || (e.connection_id == worker
                        && matches!(&e.event, AgentEvent::Log { direction, line } if direction == "Stdin" && line.contains("session/close")))
            })
            .await;
        if matches!(event.event, AgentEvent::Complete { .. }) {
            completed = true;
        } else {
            closed = true;
        }
    }
    turn.await.unwrap().expect("cancelled turn");
    assert!(h.manager.session(&root).is_none());
    assert!(h.manager.session(&child).is_none());
    h.manager.disconnect(&lead).unwrap();
    h.manager.disconnect(&worker).unwrap();
}

#[tokio::test]
async fn disconnect_cancels_its_sessions_and_their_children() {
    let mut h = harness();
    let lead = h.connect(&[]).await;
    let worker = h.connect(&[]).await;
    let root = h.root(&lead).await;
    let child = h
        .manager
        .agent_control(root.clone())
        .unwrap()
        .delegate(&worker)
        .await
        .unwrap();
    let unrelated = h.root(&worker).await;
    let turns: Vec<_> = [&root, &child, &unrelated]
        .iter()
        .map(|key| {
            let (manager, key) = (h.manager.clone(), (*key).clone());
            tokio::spawn(async move { manager.prompt(&key, "wait".into(), vec![]).await })
        })
        .collect();
    h.prompts_delivered("wait", &[&root, &child, &unrelated])
        .await;
    let (manager, key) = (h.manager.clone(), root.clone());
    let queued = tokio::spawn(async move { manager.prompt(&key, "echo".into(), vec![]).await });
    eventually("the follow-up to queue", || {
        h.manager.session(&root).is_some_and(|s| s.queued == 1)
    })
    .await;

    h.manager.disconnect(&lead).expect("disconnect lead");
    h.next(|e| {
        e.connection_id == lead
            && matches!(&e.event, AgentEvent::Status { state, .. } if state == "disconnected")
    })
    .await;
    h.next(|e| is_complete(e, &child, "cancelled")).await;
    let mut turns = turns.into_iter();
    assert!(
        turns.next().unwrap().await.unwrap().is_err(),
        "lead turn ends with its process"
    );
    turns
        .next()
        .unwrap()
        .await
        .unwrap()
        .expect("child cancelled");
    assert!(queued.await.unwrap().is_err());
    assert!(h.manager.session(&root).is_none());
    assert!(h.manager.session(&child).is_none());
    assert!(h.manager.session(&unrelated).unwrap().busy);
    assert!(h.manager.disconnect(&lead).unwrap_err().contains("Unknown"));
    h.manager.cancel(&unrelated).unwrap();
    turns.next().unwrap().await.unwrap().unwrap();
    h.manager.disconnect(&worker).unwrap();
}

#[tokio::test]
async fn children_never_outlive_a_lead_whose_process_exits() {
    let mut h = harness();
    let lead = h.connect(&[]).await;
    let worker = h.connect(&[]).await;
    let root = h.root(&lead).await;
    let child = h
        .manager
        .agent_control(root.clone())
        .unwrap()
        .delegate(&worker)
        .await
        .unwrap();
    let (manager, key) = (h.manager.clone(), child.clone());
    let turn = tokio::spawn(async move { manager.prompt(&key, "wait".into(), vec![]).await });
    h.prompts_delivered("wait", &[&child]).await;
    assert!(h
        .manager
        .prompt(&root, "crash".into(), vec![])
        .await
        .is_err());
    h.next(|e| is_complete(e, &child, "cancelled")).await;
    turn.await.unwrap().expect("child cancelled");
    assert!(h.manager.session(&child).is_none());
    // The dead connection stays listed until it is disconnected.
    assert!(h
        .manager
        .open_session(&lead, None, SessionOrigin::User)
        .await
        .is_err());
    let _ = h.manager.disconnect(&lead);
    h.manager.disconnect(&worker).unwrap();
}

#[tokio::test]
async fn child_permission_carries_identity_and_only_the_user_can_answer_it() {
    let mut h = harness();
    let lead = h.connect(&["--name=lead"]).await;
    let worker = h.connect(&["--name=worker"]).await;
    let root = h.root(&lead).await;
    let control = h.manager.agent_control(root.clone()).unwrap();
    let child = control.delegate(&worker).await.unwrap();
    // Same session id on both processes: only the connection tells them apart.
    assert_eq!(root.session_id, child.session_id);

    let delegated = control.clone();
    let target = child.clone();
    let turn = tokio::spawn(async move { delegated.message(&target, "edit".into()).await });
    let event = h
        .next(|e| matches!(e.event, AgentEvent::Permission { .. }))
        .await;
    assert_eq!(event.connection_id, worker);
    assert_eq!(event.agent_name, "worker");
    assert_eq!(event.session_id.as_deref(), Some(child.session_id.as_str()));
    let AgentEvent::Permission {
        request_id,
        session_id,
        ..
    } = event.event
    else {
        unreachable!()
    };
    assert_eq!(session_id, child.session_id);
    let pending = h.manager.pending_requests();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, PendingKind::Permission);
    assert_eq!(pending[0].agent_name, "worker");
    assert_eq!(pending[0].connection_id, worker);
    assert_eq!(
        pending[0].session_id.as_deref(),
        Some(child.session_id.as_str())
    );

    // Every agent-callable path. AgentControl has no method that answers a
    // permission, elicitation or edit review, so the lead can only:
    // 1. message the child, which queues a prompt and leaves the request pending,
    let delegated = control.clone();
    let target = child.clone();
    let approval_attempt = tokio::spawn(async move {
        delegated
            .message(&target, format!("allow {request_id} always"))
            .await
    });
    eventually("the lead's message to queue", || {
        h.manager.session(&child).is_some_and(|s| s.queued == 1)
    })
    .await;
    // 2. reach only sessions below itself,
    assert!(control.message(&root, "yes".into()).await.is_err());
    assert!(control.cancel(&root).is_err());
    let child_control = h.manager.agent_control(child.clone()).unwrap();
    assert!(child_control.message(&root, "yes".into()).await.is_err());
    assert!(child_control.children().is_empty());
    // 3. and read state, which exposes no responder.
    assert_eq!(control.children()[0].key, child);
    let pending = h.manager.pending_requests();
    assert_eq!(
        pending.len(),
        1,
        "the request is still waiting for the user"
    );
    let request_id = pending[0].request_id.clone();

    // The user's handle checks the full key: the same session id on the lead
    // connection does not match.
    assert!(h
        .manager
        .respond_permission(
            &SessionKey::new(lead.clone(), child.session_id.clone()),
            request_id.clone(),
            Some("yes".into())
        )
        .is_err());
    h.manager
        .respond_permission(&child, request_id, Some("no".into()))
        .expect("the user answers");
    h.next(|e| is_complete(e, &child, "cancelled")).await;
    turn.await.unwrap().expect("rejected turn ends");
    // The queued message now runs as an ordinary prompt and asks again.
    h.next(|e| e.connection_id == worker && matches!(e.event, AgentEvent::Permission { .. }))
        .await;
    h.manager.cancel(&root).unwrap();
    approval_attempt.await.unwrap().expect("cancelled turn");
    eventually("Stop to clear the request", || {
        h.manager.pending_requests().is_empty()
    })
    .await;
    h.manager.disconnect(&lead).unwrap();
    h.manager.disconnect(&worker).unwrap();
}

// Runtime state of user sessions: what the UI shows in the session list and
// the activity bar. The manager is the source of truth, so the UI never has to
// infer whether a session it is not showing still runs.

type States = mpsc::UnboundedReceiver<span_acp::SessionStates>;

fn watch(manager: &SessionManager) -> (States, span_acp::Subscription) {
    let (tx, rx) = mpsc::unbounded_channel();
    let subscription = manager.watch_states(Arc::new(move |states| {
        let _ = tx.send(states);
    }));
    (rx, subscription)
}

/// The next published state of `key` that satisfies `matches`.
async fn state_where(
    states: &mut States,
    key: &SessionKey,
    matches: impl Fn(&span_acp::SessionRuntimeState) -> bool,
) -> span_acp::SessionRuntimeState {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let snapshot = states.recv().await.expect("state stream closed");
            if snapshot.connection_id.as_deref() != Some(key.connection_id.as_str()) {
                continue;
            }
            if let Some(found) = snapshot
                .sessions
                .into_iter()
                .find(|s| s.session_id == key.session_id && matches(s))
            {
                return found;
            }
        }
    })
    .await
    .expect("matching session state timed out")
}

#[tokio::test]
async fn session_states_follow_turns_tools_and_requests() {
    use span_acp::SessionActivity;
    let mut h = harness();
    let connection = h.connect(&["--rich"]).await;
    let (mut states, _watch) = watch(&h.manager);
    let key = h.root(&connection).await;
    let idle = state_where(&mut states, &key, |_| true).await;
    assert_eq!(idle.state, SessionActivity::Idle);
    assert_eq!(idle.started_at_ms, None);

    // The default fixture turn opens a tool call, then asks permission for it.
    let done = h
        .manager
        .start_turn(&key, "edit".into(), vec![])
        .expect("idle session starts");
    let running = state_where(&mut states, &key, |s| s.state == SessionActivity::Running).await;
    assert!(running.started_at_ms.is_some_and(|ms| ms > 0));
    let asking = state_where(&mut states, &key, |s| {
        s.state == SessionActivity::WaitingForApproval
    })
    .await;
    assert_eq!(asking.current_tool.as_deref(), Some("Edit sample"));
    assert_eq!(asking.started_at_ms, running.started_at_ms);
    // The snapshot command agrees with the event.
    let snapshot = h.manager.session_states(&connection);
    assert_eq!(snapshot.connection_id.as_deref(), Some(connection.as_str()));
    assert_eq!(
        snapshot.sessions[0].state,
        SessionActivity::WaitingForApproval
    );
    let request = h.manager.pending_requests()[0].request_id.clone();
    h.manager
        .respond_permission(&key, request, Some("no".into()))
        .unwrap();
    let ended = state_where(&mut states, &key, |s| s.state == SessionActivity::Idle).await;
    assert_eq!(ended.current_tool, None);
    assert_eq!(ended.started_at_ms, None);
    done.await.unwrap().expect("rejected turn ends");

    // An elicitation is a question for the user, not an approval.
    let answer = h
        .manager
        .start_turn(&key, "elicit-form".into(), vec![])
        .unwrap();
    state_where(&mut states, &key, |s| {
        s.state == SessionActivity::WaitingForAnswer
    })
    .await;
    let request = h.manager.pending_requests()[0].request_id.clone();
    h.manager
        .respond_elicitation(&connection, request, "decline".into(), None)
        .unwrap();
    state_where(&mut states, &key, |s| s.state == SessionActivity::Idle).await;
    answer.await.unwrap().expect("answered turn ends");

    // Disconnecting publishes an empty list for the connection.
    h.manager.disconnect(&connection).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = states.recv().await.expect("state stream closed");
            if snapshot.connection_id.as_deref() == Some(connection.as_str())
                && snapshot.sessions.is_empty()
            {
                return;
            }
        }
    })
    .await
    .expect("the ended connection was published empty");
    let _ = h.events.try_recv();
}

#[tokio::test]
async fn a_second_user_prompt_to_a_running_session_gets_a_typed_busy_error() {
    use span_acp::{PromptError, SessionActivity};
    let mut h = harness();
    let connection = h.connect(&[]).await;
    let key = h.root(&connection).await;
    let (mut states, _watch) = watch(&h.manager);
    let first = h.manager.start_turn(&key, "wait".into(), vec![]).unwrap();
    h.prompts_delivered("wait", &[&key]).await;
    match h.manager.start_turn(&key, "echo".into(), vec![]) {
        Err(PromptError::Busy { message, state }) => {
            assert_eq!(message, "A prompt is already running in this session");
            let state = state.expect("the refusal carries the session state");
            assert_eq!(state.state, SessionActivity::Running);
            assert_eq!(state.queued, 0);
        }
        other => panic!("expected a typed busy error, got {other:?}"),
    }
    // Refused, not queued: the running turn is untouched.
    let info = h.manager.session(&key).unwrap();
    assert!(info.busy && info.queued == 0);
    h.manager.cancel(&key).unwrap();
    h.next(|e| is_complete(e, &key, "cancelled")).await;
    first.await.unwrap().expect("cancelled turn ends");
    state_where(&mut states, &key, |s| s.state == SessionActivity::Idle).await;
    // An unknown session is a plain failure, not busy.
    assert!(matches!(
        h.manager.start_turn(
            &SessionKey::new(connection.clone(), "nope"),
            "echo".into(),
            vec![]
        ),
        Err(PromptError::Failed { .. })
    ));
    h.manager.disconnect(&connection).unwrap();
}

#[tokio::test]
async fn a_turn_the_agent_still_runs_outside_the_manager_counts_as_busy() {
    use span_acp::PromptError;
    let mut h = harness();
    let connection = h.connect(&[]).await;
    let key = h.root(&connection).await;
    // A turn started on the service directly, as after a session was closed
    // and loaded again while the agent kept working.
    let service = h.manager.service(&connection).unwrap();
    let stray = service
        .start_prompt(key.session_id.clone(), "wait".into(), vec![])
        .unwrap();
    h.prompts_delivered("wait", &[&key]).await;
    assert!(matches!(
        h.manager.start_turn(&key, "echo".into(), vec![]),
        Err(PromptError::Busy { .. })
    ));
    service.cancel(key.session_id.clone()).unwrap();
    stray.await.unwrap().expect("cancelled");
    h.manager.disconnect(&connection).unwrap();
}

#[tokio::test]
async fn a_prompt_sent_as_soon_as_a_turn_completes_is_never_refused() {
    let mut h = harness();
    let connection = h.connect(&[]).await;
    let key = h.root(&connection).await;
    for round in 0..5 {
        let first = h
            .manager
            .start_turn(&key, "stop:end_turn".into(), vec![])
            .unwrap_or_else(|error| panic!("round {round}: {error:?}"));
        // The UI sends its next prompt the moment it sees Complete.
        h.next(|e| is_complete(e, &key, "end_turn")).await;
        let second = h
            .manager
            .start_turn(&key, "echo".into(), vec![])
            .unwrap_or_else(|error| {
                panic!("round {round}: refused right after Complete: {error:?}")
            });
        first.await.unwrap().expect("first turn");
        second.await.unwrap().expect("follow-up turn");
        // Consume the follow-up's own Complete so the next round waits for its own.
        h.next(|e| is_complete(e, &key, "end_turn")).await;
    }
    h.manager.disconnect(&connection).unwrap();
}

#[tokio::test]
async fn closing_a_running_session_stops_its_turn_first() {
    use span_acp::SessionActivity;
    let mut h = harness();
    let connection = h.connect(&["--close"]).await;
    let key = h.root(&connection).await;
    let (mut states, _watch) = watch(&h.manager);
    let turn = h.manager.start_turn(&key, "wait".into(), vec![]).unwrap();
    state_where(&mut states, &key, |s| s.state == SessionActivity::Running).await;
    h.prompts_delivered("wait", &[&key]).await;
    h.manager.close(&key).await.unwrap();
    h.next(|e| is_complete(e, &key, "cancelled")).await;
    turn.await.unwrap().expect("the turn ended as cancelled");
    assert!(h.manager.session(&key).is_none());
    assert!(h.manager.session_states(&connection).sessions.is_empty());
    h.manager.disconnect(&connection).unwrap();
}

#[test]
fn prompt_errors_serialise_as_a_tagged_union_the_ui_matches_on() {
    let busy = span_acp::PromptError::Busy {
        message: span_acp::PROMPT_ALREADY_RUNNING.into(),
        state: None,
    };
    let json = serde_json::to_value(&busy).unwrap();
    assert_eq!(json["kind"], "busy");
    assert_eq!(
        json["message"],
        "A prompt is already running in this session"
    );
    let failed = serde_json::to_value(span_acp::PromptError::Failed {
        message: "x".into(),
    })
    .unwrap();
    assert_eq!(failed["kind"], "failed");
}
