//! Delegated child sessions (ADR 0003, amendment of 2026-10-29). A child a
//! lead delegated to is a real session in the target agent, so the agent
//! keeps it in its own history and lists it in `session/list`. Span records
//! every child id here, keeps them out of the History list, and ends them
//! (`session/delete` where the agent advertises it, else `session/close`)
//! once their lead is gone. Leftovers of an earlier run are ended later, but
//! only ids recorded here: nothing is matched by title.
//!
//! The record is the same small JSON ledger the health check keeps
//! (`agent-health-sessions.json`, see [`crate::HealthMonitor::set_ledger`]):
//! per agent name, the child ids Span created and the ids already ended.
use crate::health::{push_capped, write_ledger, LedgerAgent};
use crate::{SessionKey, SessionManager};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

#[derive(Default)]
struct Ledger {
    agents: BTreeMap<String, LedgerAgent>,
    path: Option<PathBuf>,
    /// Every recorded child id, ended or not, for the listing filter.
    ids: HashSet<String>,
    /// Agents whose leftovers were already swept in this process.
    swept: HashSet<String>,
}

static LEDGER: LazyLock<Mutex<Ledger>> = LazyLock::new(Mutex::default);

fn ledger() -> MutexGuard<'static, Ledger> {
    LEDGER.lock().unwrap_or_else(|p| p.into_inner())
}

fn save(ledger: &Ledger) {
    if let Some(path) = &ledger.path {
        write_ledger(path, &ledger.agents);
    }
}

/// True for a session Span opened as a delegated child, in this run or a
/// recorded earlier one. Such a session is never a History row of its own.
pub fn is_delegated_session(session_id: &str) -> bool {
    ledger().ids.contains(session_id)
}

/// Remember delegated child ids across runs in the JSON file at `path`. The
/// ids already in it are hidden from listings at once. A missing or
/// unreadable file starts empty. Ids recorded before this call are kept.
pub fn set_delegated_ledger(path: PathBuf) {
    let loaded: BTreeMap<String, LedgerAgent> = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut ledger = ledger();
    for (agent, recorded) in loaded {
        let entry = ledger.agents.entry(agent).or_default();
        for id in recorded.sessions {
            push_capped(&mut entry.sessions, &id);
        }
        for id in recorded.cleaned {
            push_capped(&mut entry.cleaned, &id);
        }
    }
    let ids: Vec<String> = ledger
        .agents
        .values()
        .flat_map(|agent| agent.sessions.iter().chain(&agent.cleaned).cloned())
        .collect();
    ledger.ids.extend(ids);
    ledger.path = Some(path);
    save(&ledger);
}

/// Record a child Span just created on `agent`.
pub fn record_delegated_session(agent: &str, session_id: &str) {
    let mut ledger = ledger();
    ledger.ids.insert(session_id.to_owned());
    let changed = push_capped(
        &mut ledger.agents.entry(agent.to_owned()).or_default().sessions,
        session_id,
    );
    if changed {
        save(&ledger);
    }
}

/// Recorded children of `agent` that were not ended yet, oldest first.
pub fn open_delegated_sessions(agent: &str) -> Vec<String> {
    ledger()
        .agents
        .get(agent)
        .map(|recorded| {
            recorded
                .sessions
                .iter()
                .filter(|id| !recorded.cleaned.contains(id))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Recorded children of `agent` that were ended (or refused by the agent).
pub fn ended_delegated_sessions(agent: &str) -> Vec<String> {
    ledger()
        .agents
        .get(agent)
        .map(|recorded| recorded.cleaned.clone())
        .unwrap_or_default()
}

fn mark_ended(agent: &str, session_id: &str) {
    let mut ledger = ledger();
    let changed = push_capped(
        &mut ledger.agents.entry(agent.to_owned()).or_default().cleaned,
        session_id,
    );
    if changed {
        save(&ledger);
    }
}

fn recorded(agent: &str, session_id: &str) -> (bool, bool) {
    let ledger = ledger();
    let Some(entry) = ledger.agents.get(agent) else {
        return (false, false);
    };
    (
        entry.sessions.iter().any(|id| id == session_id),
        entry.cleaned.iter().any(|id| id == session_id),
    )
}

/// What [`end_delegated_session`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// `session/delete` succeeded: the child left the agent's history.
    Deleted,
    /// `session/close` succeeded (the agent cannot delete).
    Closed,
    /// Ended before, or the agent refused: never asked again.
    AlreadyEnded,
    /// The id was never recorded as a delegated child. Nothing was sent.
    NotRecorded,
    /// The agent advertises neither delete nor close. The child stays out
    /// of History through the listing filter only.
    Unsupported,
    /// The connection is gone or the call timed out. Retried next run.
    Unavailable,
}

/// End one recorded child on `connection_id`: delete it where the agent
/// advertises `session/delete`, else close it where it advertises
/// `session/close`. Only ids recorded with [`record_delegated_session`] are
/// touched, each at most once (idempotent), so a user chat is never ended.
pub async fn end_delegated_session(
    manager: &SessionManager,
    connection_id: &str,
    agent: &str,
    session_id: &str,
    timeout: Duration,
) -> Ended {
    match recorded(agent, session_id) {
        (false, _) => return Ended::NotRecorded,
        (true, true) => return Ended::AlreadyEnded,
        (true, false) => {}
    }
    let Some(service) = manager.service(connection_id).filter(|s| s.is_open()) else {
        return Ended::Unavailable;
    };
    let key = SessionKey::new(connection_id, session_id);
    let (deleting, outcome) = if service.can_delete_sessions() {
        (
            true,
            tokio::time::timeout(timeout, manager.delete(&key)).await,
        )
    } else if service.can_close_sessions() {
        (
            false,
            tokio::time::timeout(timeout, manager.close(&key)).await,
        )
    } else {
        return Ended::Unsupported;
    };
    match outcome {
        Ok(Ok(())) => {
            mark_ended(agent, session_id);
            if deleting {
                Ended::Deleted
            } else {
                Ended::Closed
            }
        }
        // Refused (an unknown or already closed id): asking again would not help.
        Ok(Err(_)) if service.is_open() => {
            mark_ended(agent, session_id);
            Ended::AlreadyEnded
        }
        _ => Ended::Unavailable,
    }
}

/// End the leftovers of earlier runs on `agent`: recorded children that were
/// never ended and that this process does not hold. Runs once per agent per
/// process, at most `max` children, `gap` apart. Returns how many ended.
pub async fn sweep_delegated_sessions(
    manager: &SessionManager,
    connection_id: &str,
    agent: &str,
    max: usize,
    gap: Duration,
    timeout: Duration,
) -> usize {
    if !ledger().swept.insert(agent.to_owned()) {
        return 0;
    }
    let candidates: Vec<String> = open_delegated_sessions(agent)
        .into_iter()
        .filter(|id| {
            manager
                .session(&SessionKey::new(connection_id, id.as_str()))
                .is_none()
        })
        .take(max)
        .collect();
    let mut ended = 0;
    for (index, id) in candidates.iter().enumerate() {
        if index > 0 {
            tokio::time::sleep(gap).await;
        }
        match end_delegated_session(manager, connection_id, agent, id, timeout).await {
            Ended::Deleted | Ended::Closed => ended += 1,
            Ended::Unavailable | Ended::Unsupported => break,
            Ended::AlreadyEnded | Ended::NotRecorded => {}
        }
    }
    ended
}
