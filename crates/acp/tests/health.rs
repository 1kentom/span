//! Process level tests for the agent health check (ADR 0010). Agents are
//! real Node subprocesses (tests/fixtures/worker.mjs).
//!
//! Time scaling: the policy is scaled down like the tool server tests scale
//! `ToolPolicy::second`: the five minute interval becomes a few hundred
//! milliseconds and the thirty second timeout a fraction of a second.
//!
//! Kept in a test binary of its own: hidden session ids are recorded in a
//! process wide set, and fixture session ids repeat across processes.
use serde_json::Value;
use span_acp::{
    AgentCommand, AgentEvent, AgentHealth, BackgroundAgents, BackgroundState, HealthMonitor,
    HealthPolicy, HealthState, HealthTarget, InstalledAgent, LaunchFn, SessionEvent, SessionKey,
    SessionManager, SessionOrigin, HEALTH_PROMPT,
};
use span_core::CoreWorkspace;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

struct Harness {
    directory: tempfile::TempDir,
    workspace: Arc<Mutex<CoreWorkspace>>,
    manager: SessionManager,
    events: mpsc::UnboundedReceiver<SessionEvent>,
}

fn harness() -> Harness {
    let directory = tempfile::tempdir().expect("temporary workspace");
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

fn worker(flags: &[&str]) -> AgentCommand {
    let mut args = vec![format!(
        "{}/tests/fixtures/worker.mjs",
        env!("CARGO_MANIFEST_DIR")
    )];
    args.extend(flags.iter().map(|f| f.to_string()));
    AgentCommand {
        command: "node".into(),
        args,
        env: BTreeMap::new(),
    }
}

/// Five minutes become 400 ms, thirty seconds 2 s (fixture processes are
/// slow to answer under a parallel test run), twenty seconds 50 ms.
fn scaled() -> HealthPolicy {
    HealthPolicy {
        interval: Duration::from_millis(400),
        first_check: Duration::ZERO,
        timeout: Duration::from_secs(2),
        slow: Duration::from_secs(8),
        retry_after: Duration::from_millis(50),
        tick: Duration::from_millis(20),
        settle: Duration::from_millis(500),
    }
}

impl Harness {
    async fn connect(&self, flags: &[&str]) -> String {
        self.manager
            .connect(
                worker(flags),
                self.directory.path().to_string_lossy().into_owned(),
                self.workspace.clone(),
                None,
            )
            .await
            .expect("start fixture agent")
    }

    /// A monitor over fixed targets, checks on unless `enabled` says otherwise.
    fn monitor(
        &self,
        policy: HealthPolicy,
        targets: Vec<HealthTarget>,
        enabled: Arc<AtomicBool>,
    ) -> HealthMonitor {
        HealthMonitor::new(
            self.manager.clone(),
            policy,
            Arc::new(move || targets.clone()),
            Arc::new(move || enabled.load(Ordering::SeqCst)),
        )
    }

    /// A user session on `connection` answering `prompt`, returning its text.
    async fn ask(&mut self, connection: &str, prompt: &str) -> (SessionKey, String) {
        let key = self
            .manager
            .open_session(connection, None, SessionOrigin::User)
            .await
            .expect("user session");
        let answer = self.answer(&key, prompt).await;
        (key, answer)
    }

    async fn answer(&mut self, key: &SessionKey, prompt: &str) -> String {
        let manager = self.manager.clone();
        let turn_key = key.clone();
        let text = prompt.to_owned();
        let turn = tokio::spawn(async move { manager.prompt(&turn_key, text, vec![]).await });
        let session = key.session_id.clone();
        let event = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = self.events.recv().await.expect("event stream closed");
                if event.session_id.as_deref() == Some(session.as_str())
                    && matches!(&event.event, AgentEvent::Text { .. })
                {
                    return event;
                }
            }
        })
        .await
        .expect("answer timed out");
        turn.await.unwrap().expect("user turn");
        match event.event {
            AgentEvent::Text { text, .. } => text,
            _ => unreachable!(),
        }
    }

    fn drain(&mut self) -> Vec<SessionEvent> {
        let mut found = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            found.push(event);
        }
        found
    }
}

fn target(agent: &str, connection: &str) -> HealthTarget {
    HealthTarget {
        agent_id: agent.into(),
        connection_id: connection.into(),
    }
}

fn on() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(true))
}

fn only(results: &[AgentHealth], agent: &str) -> AgentHealth {
    assert_eq!(results.len(), 1, "one result expected: {results:?}");
    assert_eq!(results[0].agent_id, agent);
    results[0].clone()
}

/// Nothing of a hidden check session reaches the manager's sink (the chat):
/// no `Session` event, no reply text, no sign-in card.
fn assert_quiet(events: &[SessionEvent]) {
    for event in events {
        match &event.event {
            AgentEvent::Session { .. } | AgentEvent::AuthRequired { .. } => {
                panic!("check event reached the chat: {event:?}")
            }
            AgentEvent::Text { text, .. } if text == "OK" => {
                panic!("check reply reached the chat: {event:?}")
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn a_live_agent_replies_and_is_live_with_latency() {
    let mut h = harness();
    let connection = h.connect(&["--name=live"]).await;
    let monitor = h.monitor(scaled(), vec![target("live-agent", &connection)], on());
    let published: Arc<Mutex<Vec<Vec<AgentHealth>>>> = Arc::default();
    let seen = published.clone();
    monitor.set_sink(Some(Arc::new(move |all| seen.lock().unwrap().push(all))));
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let results = monitor.check_now().await;
    let health = only(&results, "live-agent");
    assert_eq!(health.state, HealthState::Live);
    let latency = health.latency_ms.expect("latency");
    assert!(latency < 2000, "latency {latency}");
    assert!(health.checked_at_ms >= before);
    assert_eq!(health.detail, None);
    assert_eq!(published.lock().unwrap().last().unwrap(), &results);
    // The check is not a session of the manager and never reached the chat.
    assert!(h.manager.sessions().is_empty());
    assert!(h.manager.session_states(&connection).sessions.is_empty());
    assert_quiet(&h.drain());
}

#[tokio::test]
async fn a_slow_reply_is_slow_and_any_reply_counts() {
    let h = harness();
    let connection = h.connect(&["--name=slow", "--slow-health=200"]).await;
    let policy = HealthPolicy {
        slow: Duration::from_millis(100),
        ..scaled()
    };
    let monitor = h.monitor(policy, vec![target("slow", &connection)], on());
    let health = only(&monitor.check_now().await, "slow");
    assert_eq!(health.state, HealthState::Slow);
    assert!(health.latency_ms.unwrap() >= 200);
}

#[tokio::test]
async fn a_silent_agent_times_out_and_is_unreachable_after_one_retry() {
    let mut h = harness();
    let connection = h.connect(&["--name=silent", "--silent-health"]).await;
    let policy = HealthPolicy {
        timeout: Duration::from_millis(300),
        ..scaled()
    };
    let monitor = h.monitor(policy, vec![target("silent", &connection)], on());
    let health = only(&monitor.check_now().await, "silent");
    assert_eq!(health.state, HealthState::Unreachable);
    assert_eq!(health.latency_ms, None);
    assert!(health.detail.as_deref().unwrap().contains("No reply"));
    // Two check prompts (the first and its one retry), then this one. Both
    // check turns were cancelled, so the connection is still usable.
    let (_, count) = h.ask(&connection, "prompts").await;
    assert_eq!(count, "3");
}

#[tokio::test]
async fn auth_required_maps_to_signed_out_without_a_sign_in_card() {
    let mut h = harness();
    let connection = h.connect(&["--name=signed-out", "--auth-required"]).await;
    let monitor = h.monitor(scaled(), vec![target("signed-out", &connection)], on());
    let health = only(&monitor.check_now().await, "signed-out");
    assert_eq!(health.state, HealthState::SignedOut);
    assert!(health
        .detail
        .unwrap()
        .to_ascii_lowercase()
        .contains("authentication required"));
    // The user's own connection state is untouched.
    assert!(!h.manager.service(&connection).unwrap().auth_required());
    assert_quiet(&h.drain());
}

#[tokio::test]
async fn agents_with_a_running_turn_or_a_recent_chat_are_skipped_and_postponed() {
    let mut h = harness();
    let working = h.connect(&["--name=working"]).await;
    let chatted = h.connect(&["--name=chatted"]).await;
    let quiet = h.connect(&["--name=quiet"]).await;
    // A turn in flight on `working`.
    let busy = h
        .manager
        .open_session(&working, None, SessionOrigin::User)
        .await
        .unwrap();
    let _waiting = h.manager.enqueue(&busy, "wait".into(), vec![]).unwrap();
    // A finished chat turn on `chatted`.
    let (_, answer) = h.ask(&chatted, "reply:hello").await;
    assert_eq!(answer, "hello");
    let monitor = h.monitor(
        scaled(),
        vec![
            target("working", &working),
            target("chatted", &chatted),
            target("quiet", &quiet),
        ],
        on(),
    );
    let results = monitor.check_now().await;
    let checked: Vec<&str> = results.iter().map(|r| r.agent_id.as_str()).collect();
    assert_eq!(checked, vec!["quiet"]);
    // After one quiet interval the chatted agent is due; the working one
    // still runs its turn and is still skipped.
    tokio::time::sleep(scaled().interval + Duration::from_millis(100)).await;
    let results = monitor.check_now().await;
    let checked: Vec<&str> = results.iter().map(|r| r.agent_id.as_str()).collect();
    assert_eq!(checked, vec!["chatted", "quiet"]);
    // A new chat turn postpones the next check by one interval.
    h.ask(&chatted, "reply:again").await;
    monitor.note_activity(&quiet);
    let first = results.clone();
    let results = monitor.check_now().await;
    assert_eq!(results, first, "nothing was checked again");
    let _ = h.manager.cancel(&busy);
}

#[tokio::test]
async fn the_hidden_session_never_shows_in_list_sessions_and_is_reused() {
    let mut h = harness();
    let connection = h.connect(&["--name=lister", "--list"]).await;
    let monitor = h.monitor(scaled(), vec![target("lister", &connection)], on());
    assert_eq!(
        only(&monitor.check_now().await, "lister").state,
        HealthState::Live
    );
    // Neither close nor delete is advertised: the one hidden session is kept.
    let hidden = monitor.hidden_session(&connection).expect("kept");
    let (user, _) = h.ask(&connection, "reply:mine").await;
    let service = h.manager.service(&connection).unwrap();
    let listed: Vec<String> = service
        .list_sessions()
        .await
        .unwrap()
        .into_iter()
        .map(|s| s.session_id)
        .collect();
    assert_eq!(listed, vec![user.session_id.clone()]);
    let all: Vec<String> = service
        .list_sessions_in(true)
        .await
        .unwrap()
        .into_iter()
        .map(|s| s.session_id)
        .collect();
    assert!(!all.contains(&hidden));
    // The next check reuses it instead of opening another.
    tokio::time::sleep(scaled().interval + Duration::from_millis(100)).await;
    monitor.check_now().await;
    assert_eq!(monitor.hidden_session(&connection), Some(hidden.clone()));
    // A session from an earlier run is recognised by its title.
    assert!(span_acp::is_hidden_session("other", Some(HEALTH_PROMPT)));
    assert!(!span_acp::is_hidden_session("other", Some("Fix the build")));
}

async fn ended_after_check(flags: &[&str], agent: &str) {
    let mut h = harness();
    let connection = h.connect(flags).await;
    let monitor = h.monitor(scaled(), vec![target(agent, &connection)], on());
    assert_eq!(
        only(&monitor.check_now().await, agent).state,
        HealthState::Live
    );
    assert_eq!(monitor.hidden_session(&connection), None);
    let (user, ended) = h.ask(&connection, "ended").await;
    let ended: Vec<String> = serde_json::from_str::<Value>(&ended)
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ended.len(), 1, "one hidden session ended: {ended:?}");
    assert_ne!(ended[0], user.session_id);
    let listed = h
        .manager
        .service(&connection)
        .unwrap()
        .list_sessions()
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].session_id, user.session_id);
}

#[tokio::test]
async fn the_hidden_session_is_closed_after_the_check_when_supported() {
    ended_after_check(&["--name=closer", "--close", "--list"], "closer").await;
}

#[tokio::test]
async fn the_hidden_session_is_deleted_when_only_delete_is_supported() {
    ended_after_check(&["--name=deleter", "--delete", "--list"], "deleter").await;
}

#[tokio::test]
async fn every_permission_request_of_a_check_is_rejected() {
    // The fixture exits if the permission is allowed.
    let mut h = harness();
    let connection = h.connect(&["--name=asker", "--permission-health"]).await;
    let monitor = h.monitor(scaled(), vec![target("asker", &connection)], on());
    assert_eq!(
        only(&monitor.check_now().await, "asker").state,
        HealthState::Live
    );
    assert!(h.manager.pending_requests().is_empty());
    let events = h.drain();
    assert!(!events
        .iter()
        .any(|e| matches!(e.event, AgentEvent::Permission { .. })));
    assert_quiet(&events);
}

#[tokio::test]
async fn nothing_is_started_just_for_a_check() {
    let h = harness();
    let starts = Arc::new(AtomicUsize::new(0));
    let counter = starts.clone();
    let launch: LaunchFn = Arc::new(move |_agent: InstalledAgent, _sink| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err("not expected".to_string()) })
    });
    let background = BackgroundAgents::new(h.manager.clone(), launch);
    let monitor = HealthMonitor::for_background(
        h.manager.clone(),
        background.clone(),
        scaled(),
        Arc::new(|| true),
    );
    assert!(monitor.check_now().await.is_empty());
    monitor.start();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert_eq!(background.state("codex-acp"), BackgroundState::Idle);
    assert!(monitor.results().is_empty());
}

#[tokio::test]
async fn a_warm_agent_is_checked_on_schedule_by_the_running_monitor() {
    let h = harness();
    let manager = h.manager.clone();
    let workspace = h.workspace.clone();
    let cwd = h.directory.path().to_string_lossy().into_owned();
    let launch: LaunchFn = Arc::new(move |agent: InstalledAgent, sink| {
        let (manager, workspace, cwd) = (manager.clone(), workspace.clone(), cwd.clone());
        Box::pin(async move {
            manager
                .connect(agent.launch, cwd, workspace, Some(sink))
                .await
        })
    });
    let background = BackgroundAgents::new(h.manager.clone(), launch);
    let agent = InstalledAgent {
        id: "codex-acp".into(),
        version: "1.0.0".into(),
        launch: worker(&["--name=codex"]),
    };
    background
        .ensure(&agent, Duration::from_secs(10))
        .await
        .unwrap();
    let policy = HealthPolicy {
        first_check: Duration::from_millis(100),
        ..scaled()
    };
    let monitor =
        HealthMonitor::for_background(h.manager.clone(), background, policy, Arc::new(|| true));
    let (tx, mut rx) = mpsc::unbounded_channel();
    monitor.set_sink(Some(Arc::new(move |all| {
        let _ = tx.send(all);
    })));
    monitor.start();
    let first = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let all: Vec<AgentHealth> = rx.recv().await.unwrap();
            if !all.is_empty() {
                return all;
            }
        }
    })
    .await
    .expect("first scheduled check");
    assert_eq!(only(&first, "codex-acp").state, HealthState::Live);
    // The next one follows one interval later, not before.
    let second = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let all: Vec<AgentHealth> = rx.recv().await.unwrap();
            if all.first().map(|h| h.checked_at_ms) != first.first().map(|h| h.checked_at_ms) {
                return all;
            }
        }
    })
    .await
    .expect("second scheduled check");
    let gap = second[0].checked_at_ms - first[0].checked_at_ms;
    assert!(gap >= 350, "checked again after {gap} ms");
    monitor.shutdown().await;
}

#[tokio::test]
async fn with_the_setting_off_nothing_is_checked() {
    let mut h = harness();
    let connection = h.connect(&["--name=off"]).await;
    let enabled = Arc::new(AtomicBool::new(false));
    let monitor = h.monitor(scaled(), vec![target("off", &connection)], enabled.clone());
    assert!(monitor.check_now().await.is_empty());
    monitor.start();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (_, count) = h.ask(&connection, "prompts").await;
    assert_eq!(count, "1", "no check prompt was sent");
    assert!(monitor.results().is_empty());
    monitor.shutdown().await;
}
