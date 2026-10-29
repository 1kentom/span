//! Agent health check (ADR 0010). Every five minutes Span sends one tiny
//! prompt to each running agent it is not chatting with, over a hidden
//! session of its own, and records whether a reply arrived and how fast.
//!
//! - Only agents that are already running are checked. Nothing is started
//!   for a check: warm start and on-demand start own starting.
//! - An agent with a turn in flight, or with a chat turn in the last
//!   interval, is skipped; a chat turn postpones its next check by one
//!   interval.
//! - One hidden session per connection ([`AgentService::new_hidden_session`])
//!   is created on the first check and prompted again by every later check;
//!   a check never opens a session of its own. Only when the agent rejects
//!   the kept session is it replaced, once. Agents keep every session in
//!   their own history, so opening one per check flooded History.
//! - Hidden sessions never reach the user's chat, the session manager or the
//!   History list. Their ids are remembered across runs (the ledger, see
//!   [`HealthMonitor::set_ledger`]), and once per agent per run a background
//!   cleanup deletes leftover health sessions where the agent advertises
//!   `session/delete`, at most [`HealthPolicy::cleanup_max`] per run.
//! - Any reply counts as Live; only the reply arriving matters. The turn is
//!   cancelled as soon as the first text arrives, every permission request
//!   is rejected and every input request cancelled.
use crate::{AgentEvent, AgentService, BackgroundAgents, EventSink, SessionManager};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::Instant;

pub use crate::service::{HEALTH_PROMPT, HEALTH_TITLE_PREFIX};

/// Time between two checks of one agent, and how long a chat turn on an
/// agent postpones its next check.
pub const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The outcome of the latest check of one agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HealthState {
    /// The agent replied within the slow threshold.
    Live,
    /// The agent replied, but slower than the slow threshold.
    Slow,
    /// The agent answered that it needs the user to sign in.
    SignedOut,
    /// No reply: the process exited, the check timed out (twice) or the
    /// protocol failed.
    Unreachable,
}

/// The latest health check result of one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealth {
    /// The installed agent id, lowercase.
    pub agent_id: String,
    pub state: HealthState,
    /// Milliseconds from sending the prompt to the first reply. `None` when
    /// no reply arrived.
    pub latency_ms: Option<u64>,
    /// Unix time in milliseconds when the check finished.
    pub checked_at_ms: u64,
    /// Why the check failed, for the tooltip. `None` on success.
    pub detail: Option<String>,
}

/// Timing of the health check. Tests scale it down.
#[derive(Debug, Clone, Copy)]
pub struct HealthPolicy {
    /// Between two checks of one agent, and the quiet period after a chat turn.
    pub interval: Duration,
    /// Delay before the first check of an agent that just appeared.
    pub first_check: Duration,
    /// How long one attempt waits for the reply.
    pub timeout: Duration,
    /// A reply slower than this is `Slow`.
    pub slow: Duration,
    /// Wait before the one retry of a failed attempt.
    pub retry_after: Duration,
    /// How often the monitor looks for due agents.
    pub tick: Duration,
    /// How long to wait for a cancelled check turn to end.
    pub settle: Duration,
    /// Leftover health sessions the cleanup deletes per agent per run.
    pub cleanup_max: usize,
    /// Pause between two deletes of the cleanup.
    pub cleanup_gap: Duration,
}

impl Default for HealthPolicy {
    fn default() -> Self {
        Self {
            interval: HEALTH_CHECK_INTERVAL,
            first_check: Duration::from_secs(30),
            timeout: Duration::from_secs(30),
            slow: Duration::from_secs(8),
            retry_after: Duration::from_secs(20),
            tick: Duration::from_secs(5),
            settle: Duration::from_secs(5),
            cleanup_max: 20,
            cleanup_gap: Duration::from_secs(2),
        }
    }
}

/// One running agent the monitor may check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthTarget {
    pub agent_id: String,
    pub connection_id: String,
}

/// The agents that are running right now. Must never start one.
pub type HealthTargets = Arc<dyn Fn() -> Vec<HealthTarget> + Send + Sync>;
/// Whether checks are on (the user setting). Called off the async workers.
pub type HealthEnabled = Arc<dyn Fn() -> bool + Send + Sync>;
/// Receives the full set of results whenever one changes.
pub type HealthSink = Arc<dyn Fn(Vec<AgentHealth>) + Send + Sync>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

const AUTH_PREFIX: &str = "authentication required";

fn is_auth(message: &str) -> bool {
    message.to_ascii_lowercase().starts_with(AUTH_PREFIX)
}

/// Health sessions remembered for one agent across runs of Span.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LedgerAgent {
    /// Health sessions Span created on this agent, oldest first.
    #[serde(default)]
    sessions: Vec<String>,
    /// Health sessions the cleanup already deleted (or the agent refused),
    /// so a later run never asks again.
    #[serde(default)]
    cleaned: Vec<String>,
}

/// Ids kept per list in the ledger.
const LEDGER_KEEP: usize = 500;

fn push_capped(list: &mut Vec<String>, id: &str) -> bool {
    if list.iter().any(|known| known == id) {
        return false;
    }
    list.push(id.to_owned());
    if list.len() > LEDGER_KEEP {
        let extra = list.len() - LEDGER_KEEP;
        list.drain(..extra);
    }
    true
}

struct Tracked {
    connection: String,
    due: Instant,
    checking: bool,
    last: Option<AgentHealth>,
}

/// Waits for the first reply text of one hidden check turn.
struct Waiter {
    text: Option<oneshot::Sender<()>>,
}

struct Inner {
    manager: SessionManager,
    policy: HealthPolicy,
    targets: HealthTargets,
    enabled: HealthEnabled,
    sink: Mutex<Option<HealthSink>>,
    agents: Mutex<HashMap<String, Tracked>>,
    /// Chat activity reported with [`HealthMonitor::note_activity`].
    activity: Mutex<HashMap<String, Instant>>,
    /// The one hidden session kept per connection, reused by every check.
    hidden: Mutex<HashMap<String, String>>,
    /// Health sessions remembered per agent, and the file they persist to.
    ledger: Mutex<BTreeMap<String, LedgerAgent>>,
    ledger_path: Mutex<Option<PathBuf>>,
    /// Agents whose cleanup already ran (or started) in this process.
    cleaned_agents: Mutex<HashSet<String>>,
    /// Connections whose hidden sink is installed.
    sinks: Mutex<HashSet<String>>,
    waiters: Arc<Mutex<HashMap<(String, String), Waiter>>>,
    running: Mutex<bool>,
}

/// Checks running agents in the background. Cheap to clone.
#[derive(Clone)]
pub struct HealthMonitor {
    inner: Arc<Inner>,
}

enum Failure {
    SignedOut(String),
    /// The agent answered the prompt with an error: it may no longer know
    /// the kept session.
    Rejected(String),
    Other(String),
}

impl HealthMonitor {
    pub fn new(
        manager: SessionManager,
        policy: HealthPolicy,
        targets: HealthTargets,
        enabled: HealthEnabled,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                manager,
                policy,
                targets,
                enabled,
                sink: Mutex::default(),
                agents: Mutex::default(),
                activity: Mutex::default(),
                hidden: Mutex::default(),
                ledger: Mutex::default(),
                ledger_path: Mutex::default(),
                cleaned_agents: Mutex::default(),
                sinks: Mutex::default(),
                waiters: Arc::default(),
                running: Mutex::new(false),
            }),
        }
    }

    /// Check the installed agents running in `background`.
    pub fn for_background(
        manager: SessionManager,
        background: BackgroundAgents,
        policy: HealthPolicy,
        enabled: HealthEnabled,
    ) -> Self {
        let targets: HealthTargets = Arc::new(move || {
            background
                .connected()
                .into_iter()
                .map(|(agent_id, connection_id)| HealthTarget {
                    agent_id,
                    connection_id,
                })
                .collect()
        });
        Self::new(manager, policy, targets, enabled)
    }

    pub fn set_sink(&self, sink: Option<HealthSink>) {
        *lock(&self.inner.sink) = sink;
    }

    /// Remember health session ids across runs in the JSON file at `path`.
    /// The ids already in it join the process wide hidden set at once, so
    /// listings drop them even when the agent titles them differently. A
    /// missing or unreadable file starts empty.
    pub fn set_ledger(&self, path: PathBuf) {
        let loaded: BTreeMap<String, LedgerAgent> = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        crate::remember_hidden_sessions(
            loaded
                .values()
                .flat_map(|agent| agent.sessions.iter().chain(&agent.cleaned).cloned()),
        );
        *lock(&self.inner.ledger) = loaded;
        *lock(&self.inner.ledger_path) = Some(path);
    }

    /// Health sessions remembered for `agent_id`, oldest first.
    pub fn remembered_sessions(&self, agent_id: &str) -> Vec<String> {
        lock(&self.inner.ledger)
            .get(agent_id)
            .map(|agent| agent.sessions.clone())
            .unwrap_or_default()
    }

    fn remember(&self, agent_id: &str, session: &str) {
        let changed = push_capped(
            &mut lock(&self.inner.ledger)
                .entry(agent_id.to_owned())
                .or_default()
                .sessions,
            session,
        );
        if changed {
            self.save_ledger();
        }
    }

    fn mark_cleaned(&self, agent_id: &str, session: &str) {
        let changed = push_capped(
            &mut lock(&self.inner.ledger)
                .entry(agent_id.to_owned())
                .or_default()
                .cleaned,
            session,
        );
        if changed {
            self.save_ledger();
        }
    }

    /// Write the ledger (a small file) through a temporary file, so a crash
    /// never leaves half of it. Failures only cost the memory across runs.
    fn save_ledger(&self) {
        let Some(path) = lock(&self.inner.ledger_path).clone() else {
            return;
        };
        let Ok(bytes) = serde_json::to_vec_pretty(&*lock(&self.inner.ledger)) else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temporary = path.with_extension("json.tmp");
        if std::fs::write(&temporary, bytes).is_ok() {
            let _ = std::fs::rename(&temporary, &path);
        }
    }

    /// Record chat activity on a connection: its next check moves to one
    /// interval from now. Turns run through the session manager count
    /// without this.
    pub fn note_activity(&self, connection_id: &str) {
        lock(&self.inner.activity).insert(connection_id.to_owned(), Instant::now());
    }

    /// The latest chat activity on `connection`: any change of its session
    /// states in the manager (a turn started or ended, a request raised or
    /// answered, a session opened), or a noted one. Hidden check sessions
    /// are not in the manager, so they never count.
    fn last_activity(&self, connection: &str) -> Option<Instant> {
        let managed = self
            .inner
            .manager
            .last_activity(connection)
            .map(Instant::from_std);
        let noted = lock(&self.inner.activity).get(connection).copied();
        managed.max(noted)
    }

    /// The latest result per agent, sorted by agent id. Empty while checks
    /// are off.
    pub fn results(&self) -> Vec<AgentHealth> {
        if !(self.inner.enabled)() {
            return Vec::new();
        }
        self.snapshot()
    }

    fn snapshot(&self) -> Vec<AgentHealth> {
        let mut found: Vec<AgentHealth> = lock(&self.inner.agents)
            .values()
            .filter_map(|t| t.last.clone())
            .collect();
        found.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
        found
    }

    fn publish(&self) {
        let sink = lock(&self.inner.sink).clone();
        if let Some(sink) = sink {
            sink(self.snapshot());
        }
    }

    /// Start the periodic checks (after the window is shown). Idempotent.
    pub fn start(&self) {
        {
            let mut running = lock(&self.inner.running);
            if *running {
                return;
            }
            *running = true;
        }
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let tick = self.inner.policy.tick;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tick).await;
                let Some(inner) = weak.upgrade() else { return };
                if !*lock(&inner.running) {
                    return;
                }
                let monitor = HealthMonitor { inner };
                let _ = monitor.round(false).await;
            }
        });
    }

    /// Run one round now: every running agent that is idle (no turn in
    /// flight, no chat in the last interval) is checked at once, whatever
    /// its schedule. Resolves when those checks finished. For tests.
    pub async fn check_now(&self) -> Vec<AgentHealth> {
        for handle in self.round(true).await {
            let _ = handle.await;
        }
        self.results()
    }

    /// Find due agents and start their checks. `force` ignores the schedule
    /// (not the idle and busy rules).
    async fn round(&self, force: bool) -> Vec<tokio::task::JoinHandle<()>> {
        let now = Instant::now();
        let policy = self.inner.policy;
        let targets = (self.inner.targets)();
        let mut due = Vec::new();
        let activity: HashMap<String, Instant> = targets
            .iter()
            .filter_map(|t| {
                self.last_activity(&t.connection_id)
                    .map(|at| (t.connection_id.clone(), at))
            })
            .collect();
        let removed = {
            let mut agents = lock(&self.inner.agents);
            let before = agents.len();
            agents.retain(|id, _| targets.iter().any(|t| &t.agent_id == id));
            for target in &targets {
                let tracked = agents
                    .entry(target.agent_id.clone())
                    .or_insert_with(|| Tracked {
                        connection: target.connection_id.clone(),
                        due: now + policy.first_check,
                        checking: false,
                        last: None,
                    });
                if tracked.connection != target.connection_id {
                    *tracked = Tracked {
                        connection: target.connection_id.clone(),
                        due: now + policy.first_check,
                        checking: false,
                        last: None,
                    };
                }
                let quiet_until = activity
                    .get(&target.connection_id)
                    .map(|at| *at + policy.interval);
                if let Some(quiet) = quiet_until {
                    if quiet > tracked.due {
                        tracked.due = quiet;
                    }
                    if quiet > now {
                        continue;
                    }
                }
                if tracked.checking || (!force && now < tracked.due) {
                    continue;
                }
                due.push(target.clone());
            }
            before != agents.len()
        };
        if removed {
            self.publish();
        }
        // Leftover health sessions of earlier checks are cleaned once per
        // agent per run, in the background (scheduled rounds only).
        if !force {
            for target in &targets {
                if lock(&self.inner.cleaned_agents).insert(target.agent_id.clone()) {
                    let monitor = self.clone();
                    let target = target.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(monitor.inner.policy.first_check).await;
                        monitor.cleanup(&target).await;
                    });
                }
            }
        }
        // Connections that ended keep nothing.
        lock(&self.inner.hidden).retain(|c, _| targets.iter().any(|t| &t.connection_id == c));
        lock(&self.inner.sinks).retain(|c| targets.iter().any(|t| &t.connection_id == c));
        due.retain(|t| !self.busy(&t.connection_id));
        if due.is_empty() {
            return Vec::new();
        }
        let enabled = self.inner.enabled.clone();
        let on = tokio::task::spawn_blocking(move || enabled())
            .await
            .unwrap_or(false);
        if !on {
            return Vec::new();
        }
        let mut handles = Vec::new();
        for target in due {
            {
                let mut agents = lock(&self.inner.agents);
                match agents.get_mut(&target.agent_id) {
                    Some(t) if !t.checking => t.checking = true,
                    _ => continue,
                }
            }
            let monitor = self.clone();
            handles.push(tokio::spawn(async move {
                let result = monitor.check(&target).await;
                {
                    let mut agents = lock(&monitor.inner.agents);
                    if let Some(t) = agents
                        .get_mut(&target.agent_id)
                        .filter(|t| t.connection == target.connection_id)
                    {
                        t.checking = false;
                        t.due = Instant::now() + monitor.inner.policy.interval;
                        if result.is_some() {
                            t.last = result;
                        }
                    }
                }
                monitor.publish();
            }));
        }
        handles
    }

    /// A turn is in flight, queued or waiting for the user on `connection`.
    fn turn_running(&self, connection: &str) -> bool {
        self.inner
            .manager
            .session_states(connection)
            .sessions
            .iter()
            .any(|s| s.state != crate::SessionActivity::Idle || s.queued > 0)
    }

    /// A user turn is running on `connection`, or one ended within the last
    /// interval: a successful chat turn already proves the agent answers,
    /// so the check waits.
    fn busy(&self, connection: &str) -> bool {
        let running = self.turn_running(connection);
        let quiet = self
            .last_activity(connection)
            .is_some_and(|at| at.elapsed() < self.inner.policy.interval);
        running || quiet
    }

    /// One check with one retry. `None` when it was abandoned because the
    /// user started chatting with the agent or checks were turned off.
    async fn check(&self, target: &HealthTarget) -> Option<AgentHealth> {
        let policy = self.inner.policy;
        let finish = |state, latency: Option<Duration>, detail| AgentHealth {
            agent_id: target.agent_id.clone(),
            state,
            latency_ms: latency.map(|d| d.as_millis() as u64),
            checked_at_ms: now_ms(),
            detail,
        };
        let failure = match self.attempt(target).await {
            Ok(latency) => {
                let state = if latency > policy.slow {
                    HealthState::Slow
                } else {
                    HealthState::Live
                };
                return Some(finish(state, Some(latency), None));
            }
            Err(Failure::SignedOut(message)) => {
                return Some(finish(HealthState::SignedOut, None, Some(message)))
            }
            Err(Failure::Other(message) | Failure::Rejected(message)) => message,
        };
        tokio::time::sleep(policy.retry_after).await;
        if self.busy(&target.connection_id) {
            return None;
        }
        match self.attempt(target).await {
            Ok(latency) => {
                let state = if latency > policy.slow {
                    HealthState::Slow
                } else {
                    HealthState::Live
                };
                Some(finish(state, Some(latency), None))
            }
            Err(Failure::SignedOut(message)) => {
                Some(finish(HealthState::SignedOut, None, Some(message)))
            }
            Err(Failure::Other(message) | Failure::Rejected(message)) => Some(finish(
                HealthState::Unreachable,
                None,
                Some(if message.is_empty() { failure } else { message }),
            )),
        }
    }

    /// Route the hidden events of `connection` to the waiters, and answer
    /// every request of a check turn with a refusal.
    fn install_sink(&self, connection: &str, service: &AgentService) {
        if !lock(&self.inner.sinks).insert(connection.to_owned()) {
            return;
        }
        let waiters = self.inner.waiters.clone();
        let connection = connection.to_owned();
        // Weak: the sink lives in the service, which must not keep the
        // monitor (and through it the manager) alive.
        let owner = Arc::downgrade(&self.inner);
        // Looked up on a thread of its own: the sink runs on the agent's I/O
        // thread, which must not wait for the manager's lock.
        let answer = move |connection: &str, reply: Box<dyn FnOnce(AgentService) + Send>| {
            let owner = owner.clone();
            let connection = connection.to_owned();
            std::thread::spawn(move || {
                if let Some(service) = owner
                    .upgrade()
                    .and_then(|inner| inner.manager.service(&connection))
                {
                    reply(service);
                }
            });
        };
        let sink: EventSink = Arc::new(move |event| {
            let key = |session: &str| (connection.clone(), session.to_owned());
            match event {
                AgentEvent::Text {
                    session_id, text, ..
                } if !text.trim().is_empty() => {
                    if let Some(waiter) = lock(&waiters).get_mut(&key(&session_id)) {
                        if let Some(tx) = waiter.text.take() {
                            let _ = tx.send(());
                        }
                    }
                }
                AgentEvent::Permission {
                    session_id,
                    request_id,
                    options,
                    ..
                } => {
                    let reject = options
                        .iter()
                        .find(|o| o.kind.starts_with("reject"))
                        .map(|o| o.option_id.clone());
                    answer(
                        &connection,
                        Box::new(move |service| {
                            let _ = service.respond_permission(session_id, request_id, reject);
                        }),
                    );
                }
                AgentEvent::Elicitation { request_id, .. } => answer(
                    &connection,
                    Box::new(move |service| {
                        let _ = service.respond_elicitation(request_id, "cancel".into(), None);
                    }),
                ),
                AgentEvent::Proposal { session_id, .. } => answer(
                    &connection,
                    Box::new(move |service| {
                        let _ = service.cancel(session_id);
                    }),
                ),
                _ => {}
            }
        });
        service.set_hidden_sink(Some(sink));
    }

    /// Send the check prompt once over the connection's one hidden session
    /// and wait for the first reply. The session is created on the first
    /// check and reused afterwards; only when the agent rejects the kept
    /// session is a replacement created, once, and stored instead.
    async fn attempt(&self, target: &HealthTarget) -> Result<Duration, Failure> {
        let connection = target.connection_id.as_str();
        let service = self
            .inner
            .manager
            .service(connection)
            .filter(|s| s.is_open())
            .ok_or_else(|| Failure::Other("The agent is not running".into()))?;
        self.install_sink(connection, &service);
        let kept = lock(&self.inner.hidden).get(connection).cloned();
        let Some(session) = kept else {
            let session = self.create(target, &service).await?;
            return self.prompt_once(connection, &service, &session).await;
        };
        match self.prompt_once(connection, &service, &session).await {
            Err(Failure::Rejected(_)) if service.is_open() => {
                {
                    let mut hidden = lock(&self.inner.hidden);
                    if hidden.get(connection) == Some(&session) {
                        hidden.remove(connection);
                    }
                }
                let replacement = self.create(target, &service).await?;
                self.prompt_once(connection, &service, &replacement).await
            }
            outcome => outcome,
        }
    }

    /// Create the connection's hidden session and keep it for later checks.
    async fn create(
        &self,
        target: &HealthTarget,
        service: &AgentService,
    ) -> Result<String, Failure> {
        let policy = self.inner.policy;
        let session = match tokio::time::timeout(policy.timeout, service.new_hidden_session()).await
        {
            Ok(Ok(session)) => session,
            Ok(Err(message)) if is_auth(&message) => return Err(Failure::SignedOut(message)),
            Ok(Err(message)) => return Err(Failure::Other(message)),
            Err(_) => {
                return Err(Failure::Other(format!(
                    "No session within {} seconds",
                    policy.timeout.as_secs()
                )))
            }
        };
        lock(&self.inner.hidden).insert(target.connection_id.clone(), session.clone());
        self.remember(&target.agent_id, &session);
        Ok(session)
    }

    /// One check prompt on `session`, cancelled once the reply started.
    async fn prompt_once(
        &self,
        connection: &str,
        service: &AgentService,
        session: &str,
    ) -> Result<Duration, Failure> {
        let policy = self.inner.policy;
        let (text_tx, text_rx) = oneshot::channel();
        let waiter_key = (connection.to_owned(), session.to_owned());
        lock(&self.inner.waiters).insert(
            waiter_key.clone(),
            Waiter {
                text: Some(text_tx),
            },
        );
        let started = Instant::now();
        let outcome = match service.start_prompt(
            session.to_owned(),
            HEALTH_PROMPT.into(),
            Vec::new(),
        ) {
            Err(message) => Err(Failure::Rejected(message)),
            Ok(mut done) => {
                let waited = tokio::time::timeout(policy.timeout, async {
                    tokio::select! {
                        Ok(()) = text_rx => Ok(()),
                        result = &mut done => match result {
                            Ok(Ok(())) => Ok(()),
                            Ok(Err(message)) if is_auth(&message) => Err(Failure::SignedOut(message)),
                            Ok(Err(message)) => Err(Failure::Rejected(message)),
                            Err(_) => Err(Failure::Other("The agent process exited".into())),
                        },
                    }
                })
                .await;
                let outcome = match waited {
                    Ok(result) => result.map(|()| started.elapsed()),
                    Err(_) => Err(Failure::Other(format!(
                        "No reply within {} seconds",
                        policy.timeout.as_secs()
                    ))),
                };
                // Stop the turn as soon as the reply started (or the wait ended).
                if service.is_running(session) {
                    let _ = service.cancel(session.to_owned());
                    let _ = tokio::time::timeout(policy.settle, done).await;
                }
                outcome
            }
        };
        lock(&self.inner.waiters).remove(&waiter_key);
        if !service.is_open() {
            lock(&self.inner.hidden).remove(connection);
        }
        outcome
    }

    /// Delete leftover health sessions of `target`'s agent: the ones it
    /// lists (by remembered id or by the check prompt title) and the ones
    /// remembered from earlier runs, except the session in use. Only when
    /// the agent advertises `session/delete`; `session/close` cannot remove
    /// a session from the agent's history, so without delete the listing
    /// filter alone keeps them out of History. At most `cleanup_max` per
    /// run, one every `cleanup_gap`, and never while a user turn runs.
    /// Every id the agent answered for is recorded, so a later run never
    /// asks again. Returns how many were deleted.
    pub async fn cleanup(&self, target: &HealthTarget) -> usize {
        let policy = self.inner.policy;
        let connection = target.connection_id.as_str();
        let Some(service) = self
            .inner
            .manager
            .service(connection)
            .filter(|s| s.is_open() && s.can_delete_sessions())
        else {
            return 0;
        };
        let listed =
            match tokio::time::timeout(policy.timeout, service.list_health_sessions()).await {
                Ok(Ok(found)) => found.into_iter().map(|s| s.session_id).collect(),
                _ => Vec::new(),
            };
        let (remembered, cleaned) = lock(&self.inner.ledger)
            .get(&target.agent_id)
            .map(|agent| (agent.sessions.clone(), agent.cleaned.clone()))
            .unwrap_or_default();
        let current = lock(&self.inner.hidden).get(connection).cloned();
        let mut seen = HashSet::new();
        let candidates: Vec<String> = listed
            .into_iter()
            .chain(remembered)
            .filter(|id| Some(id) != current.as_ref() && !cleaned.contains(id))
            .filter(|id| seen.insert(id.clone()))
            .take(policy.cleanup_max)
            .collect();
        let mut deleted = 0;
        for (index, id) in candidates.into_iter().enumerate() {
            if index > 0 {
                tokio::time::sleep(policy.cleanup_gap).await;
            }
            if !service.is_open() || self.turn_running(connection) {
                break;
            }
            match tokio::time::timeout(policy.timeout, service.delete_session(id.clone())).await {
                Ok(Ok(())) => {
                    deleted += 1;
                    self.mark_cleaned(&target.agent_id, &id);
                }
                // Refused (for example an unknown id): asking again would not help.
                Ok(Err(_)) if service.is_open() => self.mark_cleaned(&target.agent_id, &id),
                _ => break,
            }
        }
        deleted
    }

    /// Stop checking (app exit). The hidden sessions still held are deleted
    /// where the agent supports it (so they leave its history), else closed
    /// where it supports that.
    pub async fn shutdown(&self) {
        *lock(&self.inner.running) = false;
        let held: Vec<(String, String)> = lock(&self.inner.hidden).drain().collect();
        for (connection, session) in held {
            if let Some(service) = self.inner.manager.service(&connection) {
                let wait = Duration::from_secs(2);
                if service.can_delete_sessions() {
                    let _ = tokio::time::timeout(wait, service.delete_session(session)).await;
                } else if service.can_close_sessions() {
                    let _ = tokio::time::timeout(wait, service.close_session(session)).await;
                }
            }
        }
    }

    /// The hidden session currently held on `connection`, if any. For tests.
    pub fn hidden_session(&self, connection_id: &str) -> Option<String> {
        lock(&self.inner.hidden).get(connection_id).cloned()
    }
}
