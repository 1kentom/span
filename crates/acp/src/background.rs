//! Installed agents Span starts without the user picking them: on demand when
//! a lead delegates to an agent that is not running, and as warm starts when
//! a folder opens. Both paths share one map keyed by installed agent id, so a
//! second request for an agent that is starting waits for that start instead
//! of spawning another process.
//!
//! A start runs the agent process and ACP `initialize` only. No session is
//! created here: the caller opens one (a delegated child, or the user's chat
//! when the UI switches to a warm agent).
//!
//! Events of a background connection never reach the user's chat as if they
//! were the active agent's. Until the UI makes the connection its active one
//! ([`BackgroundAgents::promote`]), only the requests of delegated child
//! sessions (permissions, questions, edit proposals) are forwarded to the
//! child sink, so the user can answer them. See ADR 0003 section 8.
use crate::{AgentEvent, EventSink, InstalledAgent, SessionKey, SessionManager, SessionOrigin};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;
use tokio::sync::watch;

pub type LaunchFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// Starts one installed agent and returns its connection id. The sink must
/// be passed to [`SessionManager::connect`] as `direct`.
pub type LaunchFn = Arc<dyn Fn(InstalledAgent, EventSink) -> LaunchFuture + Send + Sync>;

/// What Span knows about one installed agent's background connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackgroundState {
    /// Not running; a delegation or warm start would start it.
    Idle,
    Starting,
    /// Running and initialized on this connection.
    Connected(String),
    /// The last start failed with this message. The next request retries.
    Unavailable(String),
}

/// The result of [`BackgroundAgents::ensure`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ensured {
    pub connection_id: String,
    /// True when this call started the process (false when it was already
    /// running or another request started it).
    pub launched: bool,
}

type Outcome = Option<Result<String, String>>;

enum Phase {
    Starting(watch::Receiver<Outcome>),
    Ready(String),
    Failed(String),
}

struct Slot {
    generation: u64,
    phase: Phase,
    route: Arc<Route>,
}

struct Inner {
    manager: SessionManager,
    launch: LaunchFn,
    slots: Mutex<HashMap<String, Slot>>,
    generation: Mutex<u64>,
    child_sink: Mutex<Option<EventSink>>,
}

/// Where one background connection's events go.
struct Route {
    owner: Weak<Inner>,
    connection: Mutex<Option<String>>,
    /// Set once the UI made this connection its active one: every event goes there.
    primary: Mutex<Option<EventSink>>,
    /// The latest connection level events, replayed on promotion so the UI
    /// learns the agent's identity and features it missed.
    cached: Mutex<Vec<AgentEvent>>,
    /// Elicitations forwarded to the child sink, so their resolution follows.
    elicitations: Mutex<HashSet<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn key(id: &str) -> String {
    id.to_ascii_lowercase()
}

impl Route {
    fn deliver(&self, event: AgentEvent) {
        if let Some(primary) = lock(&self.primary).clone() {
            primary(event);
            return;
        }
        if matches!(
            event,
            AgentEvent::Status { .. } | AgentEvent::Ready { .. } | AgentEvent::Capabilities { .. }
        ) {
            let mut cached = lock(&self.cached);
            cached.retain(|e| std::mem::discriminant(e) != std::mem::discriminant(&event));
            cached.push(event);
            return;
        }
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        if self.for_child(&owner, &event) {
            if let Some(sink) = lock(&owner.child_sink).clone() {
                sink(event);
            }
        }
    }

    /// Requests the user must answer from a delegated child session.
    fn for_child(&self, owner: &Inner, event: &AgentEvent) -> bool {
        let session = match event {
            AgentEvent::Permission { session_id, .. }
            | AgentEvent::PermissionResolved { session_id, .. }
            | AgentEvent::Proposal { session_id, .. }
            | AgentEvent::ProposalResolved { session_id, .. } => Some(session_id.clone()),
            AgentEvent::Elicitation { session_id, .. } => session_id.clone(),
            AgentEvent::ElicitationResolved { request_id } => {
                return lock(&self.elicitations).remove(request_id);
            }
            _ => None,
        };
        let (Some(session), Some(connection)) = (session, lock(&self.connection).clone()) else {
            return false;
        };
        let delegated = owner
            .manager
            .session(&SessionKey::new(connection, session))
            .is_some_and(|s| s.origin == SessionOrigin::Delegated);
        if delegated {
            if let AgentEvent::Elicitation { request_id, .. } = event {
                lock(&self.elicitations).insert(request_id.clone());
            }
        }
        delegated
    }
}

/// The background connections of installed agents. Cheap to clone.
#[derive(Clone)]
pub struct BackgroundAgents {
    inner: Arc<Inner>,
}

impl BackgroundAgents {
    pub fn new(manager: SessionManager, launch: LaunchFn) -> Self {
        Self {
            inner: Arc::new(Inner {
                manager,
                launch,
                slots: Mutex::default(),
                generation: Mutex::new(0),
                child_sink: Mutex::default(),
            }),
        }
    }

    /// Where requests of delegated children on background connections go
    /// (the UI's agent channel).
    pub fn set_child_sink(&self, sink: Option<EventSink>) {
        *lock(&self.inner.child_sink) = sink;
    }

    fn open(&self, connection_id: &str) -> bool {
        self.inner
            .manager
            .connection(connection_id)
            .is_some_and(|c| c.open && c.features.is_some())
    }

    pub fn state(&self, agent_id: &str) -> BackgroundState {
        match lock(&self.inner.slots)
            .get(&key(agent_id))
            .map(|s| &s.phase)
        {
            None => BackgroundState::Idle,
            Some(Phase::Starting(_)) => BackgroundState::Starting,
            Some(Phase::Failed(message)) => BackgroundState::Unavailable(message.clone()),
            Some(Phase::Ready(connection)) if self.open(connection) => {
                BackgroundState::Connected(connection.clone())
            }
            Some(Phase::Ready(_)) => BackgroundState::Idle,
        }
    }

    /// The installed agent id a running connection was started for.
    pub fn agent_for(&self, connection_id: &str) -> Option<String> {
        lock(&self.inner.slots)
            .iter()
            .find_map(|(id, slot)| match &slot.phase {
                Phase::Ready(c) if c == connection_id => Some(id.clone()),
                _ => None,
            })
    }

    /// The connection of `agent`, starting the agent when it is not running.
    /// Concurrent calls for one agent share one start. Waits at most
    /// `timeout`; a start that outlives it keeps going and its connection is
    /// kept for the next request.
    pub async fn ensure(
        &self,
        agent: &InstalledAgent,
        timeout: Duration,
    ) -> Result<Ensured, String> {
        let (mut receiver, launched) = {
            let mut slots = lock(&self.inner.slots);
            match slots.get(&key(&agent.id)).map(|s| &s.phase) {
                Some(Phase::Ready(connection)) if self.open(connection) => {
                    return Ok(Ensured {
                        connection_id: connection.clone(),
                        launched: false,
                    });
                }
                Some(Phase::Starting(receiver)) => (receiver.clone(), false),
                _ => (self.spawn(&mut slots, agent.clone()), true),
            }
        };
        let waited = tokio::time::timeout(timeout, receiver.wait_for(Option::is_some)).await;
        match waited {
            Ok(Ok(outcome)) => match outcome.clone() {
                Some(Ok(connection_id)) => Ok(Ensured {
                    connection_id,
                    launched,
                }),
                Some(Err(error)) => Err(error),
                None => Err(format!("{} did not start", agent.id)),
            },
            Ok(Err(_)) => Err(format!("{} start was abandoned", agent.id)),
            Err(_) => Err(format!(
                "{} did not finish starting: timed out after {:.1} seconds",
                agent.id,
                timeout.as_secs_f64()
            )),
        }
    }

    /// Start `agent` in a task of its own, recorded as starting in `slots`.
    fn spawn(
        &self,
        slots: &mut HashMap<String, Slot>,
        agent: InstalledAgent,
    ) -> watch::Receiver<Outcome> {
        let generation = {
            let mut next = lock(&self.inner.generation);
            *next += 1;
            *next
        };
        let (tx, rx) = watch::channel(None);
        let route = Arc::new(Route {
            owner: Arc::downgrade(&self.inner),
            connection: Mutex::default(),
            primary: Mutex::default(),
            cached: Mutex::default(),
            elicitations: Mutex::default(),
        });
        slots.insert(
            key(&agent.id),
            Slot {
                generation,
                phase: Phase::Starting(rx.clone()),
                route: route.clone(),
            },
        );
        let sink_route = route.clone();
        let sink: EventSink = Arc::new(move |event| sink_route.deliver(event));
        let launch = (self.inner.launch)(agent.clone(), sink);
        let inner = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            let result = launch.await;
            if let Ok(connection) = &result {
                *lock(&route.connection) = Some(connection.clone());
            }
            let Some(inner) = inner.upgrade() else {
                return;
            };
            let current = {
                let mut slots = lock(&inner.slots);
                match slots.get_mut(&key(&agent.id)) {
                    Some(slot) if slot.generation == generation => {
                        slot.phase = match &result {
                            Ok(connection) => Phase::Ready(connection.clone()),
                            Err(error) => Phase::Failed(error.clone()),
                        };
                        true
                    }
                    _ => false,
                }
            };
            if !current {
                // Shut down while it was starting: nothing may keep it.
                if let Ok(connection) = &result {
                    let _ = inner.manager.disconnect(connection);
                }
            }
            let _ = tx.send(Some(if current {
                result
            } else {
                Err(format!("{} was stopped while it started", agent.id))
            }));
        });
        rx
    }

    /// Warm start: start `agents` one at a time, `gap` apart, at most `cap`
    /// of them, in the order given. Failures are recorded quietly (the agent
    /// shows as unavailable and the next request retries). Returns at once.
    pub fn warm(&self, agents: Vec<InstalledAgent>, gap: Duration, cap: usize, timeout: Duration) {
        let this = self.clone();
        tokio::spawn(async move {
            for (index, agent) in agents.into_iter().take(cap).enumerate() {
                if index > 0 {
                    tokio::time::sleep(gap).await;
                }
                let _ = this.ensure(&agent, timeout).await;
            }
        });
    }

    /// The UI makes `agent`'s running connection its active one: from now on
    /// every event of it goes to `sink`, starting with the identity and
    /// status events it missed.
    pub fn promote(&self, agent_id: &str, sink: EventSink) -> Result<String, String> {
        let (connection, route) = {
            let slots = lock(&self.inner.slots);
            let slot = slots
                .get(&key(agent_id))
                .ok_or("The agent is not running")?;
            match &slot.phase {
                Phase::Ready(connection) => (connection.clone(), slot.route.clone()),
                _ => return Err("The agent is not running".into()),
            }
        };
        // Replay under the primary lock so no newer event overtakes them or
        // lands in the cache after it was emptied.
        let mut primary = lock(&route.primary);
        let cached = std::mem::take(&mut *lock(&route.cached));
        for event in cached {
            sink(event);
        }
        *primary = Some(sink);
        Ok(connection)
    }

    /// Stop every background connection (folder closed, app exit). Starts in
    /// flight are disconnected when they finish.
    pub fn shutdown(&self) {
        let slots: Vec<Slot> = lock(&self.inner.slots).drain().map(|(_, s)| s).collect();
        for slot in slots {
            if let Phase::Ready(connection) = slot.phase {
                let _ = self.inner.manager.disconnect(&connection);
            }
        }
    }

    /// Connection ids currently running for installed agents.
    pub fn connections(&self) -> Vec<String> {
        lock(&self.inner.slots)
            .values()
            .filter_map(|slot| match &slot.phase {
                Phase::Ready(connection) => Some(connection.clone()),
                _ => None,
            })
            .collect()
    }
}
