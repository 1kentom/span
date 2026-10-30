//! Delegations and their tasks. A delegation is one child session; each
//! prompt sent to it (the delegation itself and every `message`) is a task
//! with its own id. Tasks of one child run in order, matching the manager's
//! one-prompt-per-session queue.
use super::budget::{Budget, Meter};
use super::result::{Deliverables, FailureReason, UsageReport};
use crate::{AgentEvent, SessionEvent, SessionKey};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::watch;

const MAX_TEXT_BYTES: usize = 256 * 1024;
/// Longest `resultSummary`, in characters.
pub const SUMMARY_CHARS: usize = 600;

const USER_CANCEL: &str = "cancelled by the user";

/// Milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A child's permission or elicitation request, for the typed UI event.
#[derive(Debug, Clone)]
pub struct ChildRequest {
    pub key: SessionKey,
    pub agent: String,
    pub task_id: Option<String>,
    pub request_id: String,
    pub request_kind: &'static str,
}

impl Task {
    /// The start of the child's text, bounded.
    pub fn summary(&self) -> Option<String> {
        let text = self.text.trim();
        if text.is_empty() || !self.status.finished() {
            return None;
        }
        let mut shown: String = text.chars().take(SUMMARY_CHARS).collect();
        if shown.len() < text.len() {
            shown.push_str(" [truncated]");
        }
        Some(shown)
    }

    /// The last activity the child reported, if any.
    pub fn progress_text(&self) -> Option<String> {
        if self.status.finished() {
            self.last_progress.clone()
        } else if self.events > 0 {
            Some(self.activity.clone())
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn finished(self) -> bool {
        matches!(self, Self::Completed | Self::Failed)
    }
}

/// A decision the lead recorded with `record_decision` (#54).
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRecord {
    pub id: String,
    pub chosen: String,
    pub why: String,
    pub alternatives: Vec<String>,
    /// Milliseconds since the Unix epoch.
    pub recorded_at: u64,
}

#[derive(Debug, Clone)]
pub struct Task {
    pub key: SessionKey,
    pub agent: String,
    pub status: TaskStatus,
    pub text: String,
    pub stop_reason: Option<String>,
    pub reason: Option<FailureReason>,
    pub detail: Option<String>,
    /// Count of child events seen while the task ran. Grows monotonically.
    pub events: u64,
    pub activity: String,
    pub save_to: Option<String>,
    /// Workspace paths of edits the user accepted during this task.
    pub changed: Vec<String>,
    /// Milliseconds since the Unix epoch.
    pub started_at_ms: u64,
    pub finished_at_ms: Option<u64>,
    /// What the lead expects back, for the task a delegation started with.
    pub deliverables: Option<Deliverables>,
    last_progress: Option<String>,
    /// The user cancelled this task. Its terminal state is then always
    /// `failed` with reason `cancelled`, whatever the child reports later.
    user_cancelled: bool,
    permission_rejected: bool,
}

struct Delegation {
    agent: String,
    /// Display name of the model the child runs, when the agent reported one.
    model: Option<String>,
    budget: Budget,
    meter: Meter,
    /// Task ids in prompt order. The front one is running.
    queue: VecDeque<String>,
    proposals: HashMap<String, String>,
    /// Set when Span stops the child (lead cancel, budget, timeout) so the
    /// resulting `cancelled` stop reason reports why.
    stop_override: Option<(FailureReason, String)>,
    edit_rejected: bool,
    waiting_for_user: u32,
    /// The task that finished last, for a usage report that arrives late.
    last_finished: Option<String>,
    /// Bumped by every task, so an idle timer knows no prompt came since.
    generation: u64,
    /// Span ended the child after it sat idle: `message` is refused.
    closed: bool,
    /// Delegated with `onApproval: "fail"`: a permission request or edit
    /// review stops the running turn instead of waiting for the user.
    fail_on_approval: bool,
}

/// Why a child was closed while idle, as the lead reads it.
pub const IDLE_CLOSED: &str =
    "this child session was closed after sitting idle with no message; delegate again to start a new one";

#[derive(Default)]
struct Inner {
    next_task: u64,
    delegations: HashMap<SessionKey, Delegation>,
    tasks: HashMap<String, Task>,
    decisions: Vec<DecisionRecord>,
}

/// A copy of one task with its delegation's usage, for building results.
#[derive(Debug, Clone)]
pub struct TaskView {
    pub task: Task,
    pub usage: UsageReport,
    /// Tokens the delegation spent, as its budget measures them.
    pub spent_tokens: Option<u64>,
    pub max_tokens: Option<u64>,
    pub waiting_for_user: u32,
}

pub struct Registry {
    inner: Mutex<Inner>,
    changed: watch::Sender<u64>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            changed: watch::channel(0).0,
        }
    }
}

fn append(text: &mut String, more: &str) {
    if text.len() + more.len() <= MAX_TEXT_BYTES {
        text.push_str(more);
    }
}

impl Registry {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn bump(&self) {
        self.changed.send_modify(|generation| *generation += 1);
    }

    /// Wakes whenever any task or delegation changes.
    pub fn watch(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    pub fn add_delegation(&self, key: SessionKey, agent: String, budget: Budget) {
        self.inner().delegations.insert(
            key,
            Delegation {
                agent,
                model: None,
                budget,
                meter: Meter::new(),
                queue: VecDeque::new(),
                proposals: HashMap::new(),
                stop_override: None,
                edit_rejected: false,
                waiting_for_user: 0,
                last_finished: None,
                generation: 0,
                closed: false,
                fail_on_approval: false,
            },
        );
    }

    /// `onApproval: "fail"` for this child: Span stops its turn when it asks
    /// for a permission or an edit review, and never answers the request.
    pub fn fail_on_approval(&self, key: &SessionKey) {
        if let Some(delegation) = self.inner().delegations.get_mut(key) {
            delegation.fail_on_approval = true;
        }
    }

    /// Record what the lead expects back from a task.
    pub fn set_deliverables(&self, task_id: &str, deliverables: Deliverables) {
        if let Some(task) = self.inner().tasks.get_mut(task_id) {
            task.deliverables = Some(deliverables);
        }
    }

    /// Register the next prompt for a child. Refused when the turn budget
    /// is spent.
    pub fn start_task(
        &self,
        key: &SessionKey,
        save_to: Option<String>,
        second: Duration,
    ) -> Result<String, String> {
        let mut inner = self.inner();
        inner.next_task += 1;
        let id = format!("task-{}", inner.next_task);
        let delegation = inner
            .delegations
            .get_mut(key)
            .ok_or("Unknown delegated session")?;
        if delegation.closed {
            return Err(IDLE_CLOSED.into());
        }
        delegation.meter.turn_allowed(&delegation.budget)?;
        if let Some((_, detail)) = delegation.meter.over(&delegation.budget, second) {
            return Err(format!("budget spent: {detail}"));
        }
        delegation.meter.turns += 1;
        delegation.generation += 1;
        let status = if delegation.queue.is_empty() {
            TaskStatus::Running
        } else {
            TaskStatus::Queued
        };
        delegation.queue.push_back(id.clone());
        let agent = delegation.agent.clone();
        inner.tasks.insert(
            id.clone(),
            Task {
                key: key.clone(),
                agent,
                status,
                text: String::new(),
                stop_reason: None,
                reason: None,
                detail: None,
                events: 0,
                activity: if status == TaskStatus::Running {
                    "starting".into()
                } else {
                    "queued".into()
                },
                save_to,
                changed: Vec::new(),
                started_at_ms: now_ms(),
                finished_at_ms: None,
                deliverables: None,
                last_progress: None,
                user_cancelled: false,
                permission_rejected: false,
            },
        );
        drop(inner);
        self.bump();
        Ok(id)
    }

    /// The typed UI record for a permission or elicitation event from a
    /// delegated child, or `None` for any other event or session.
    pub fn child_request(&self, event: &SessionEvent) -> Option<ChildRequest> {
        let (request_id, request_kind) = match &event.event {
            AgentEvent::Permission { request_id, .. } => (request_id, "permission"),
            AgentEvent::Elicitation { request_id, .. } => (request_id, "elicitation"),
            _ => return None,
        };
        let key = SessionKey::new(event.connection_id.clone(), event.session_id.clone()?);
        let inner = self.inner();
        let delegation = inner.delegations.get(&key)?;
        Some(ChildRequest {
            task_id: delegation.queue.front().cloned(),
            agent: delegation.agent.clone(),
            key,
            request_id: request_id.clone(),
            request_kind,
        })
    }

    /// Fold one child event into its running task. Returns a budget breach
    /// the caller must act on by cancelling the child. `rejected` reports
    /// whether the user rejected a permission in the turn that completes.
    pub fn observe(
        &self,
        event: &SessionEvent,
        second: Duration,
        rejected: impl Fn(&SessionKey) -> bool,
    ) -> Option<(SessionKey, FailureReason, String)> {
        let session_id = event.session_id.as_ref()?;
        let key = SessionKey::new(event.connection_id.clone(), session_id.clone());
        let mut inner = self.inner();
        let Inner {
            delegations, tasks, ..
        } = &mut *inner;
        let delegation = delegations.get_mut(&key)?;
        let running = delegation
            .queue
            .front()
            .and_then(|id| tasks.get_mut(id))
            .filter(|task| task.status == TaskStatus::Running);
        let mut breach = None;
        let mut touched = true;
        let mut late_usage = false;
        // A request the user must answer, under `onApproval: "fail"`.
        let mut approval_stop: Option<String> = None;
        let has_running = running.is_some();
        match (&event.event, running) {
            (AgentEvent::Text { text, .. }, Some(task)) => {
                append(&mut task.text, text);
                task.activity = "writing a reply".into();
                task.events += 1;
            }
            (AgentEvent::Thought { .. }, Some(task)) => {
                task.activity = "thinking".into();
                task.events += 1;
            }
            (AgentEvent::Plan { entries, .. }, Some(task)) => {
                task.activity = format!("planning ({} steps)", entries.len());
                task.events += 1;
            }
            (AgentEvent::Tool { title, status, .. }, Some(task)) => {
                task.activity = match (title, status) {
                    (Some(title), Some(status)) => format!("{title} ({status})"),
                    (Some(title), None) => title.clone(),
                    _ => "running a tool".into(),
                };
                task.events += 1;
            }
            (AgentEvent::Permission { title, .. }, task) => {
                delegation.waiting_for_user += 1;
                approval_stop = Some(format!("a permission request ({title})"));
                if let Some(task) = task {
                    task.activity =
                        format!("waiting for the user to answer a permission request: {title}");
                    task.events += 1;
                }
            }
            (AgentEvent::Elicitation { message, .. }, task) => {
                delegation.waiting_for_user += 1;
                if let Some(task) = task {
                    task.activity = format!("waiting for the user to answer: {message}");
                    task.events += 1;
                }
            }
            (AgentEvent::PermissionResolved { .. } | AgentEvent::ElicitationResolved { .. }, _) => {
                delegation.waiting_for_user = delegation.waiting_for_user.saturating_sub(1);
            }
            (AgentEvent::Proposal { proposal, .. }, task) => {
                delegation
                    .proposals
                    .insert(proposal.id.clone(), proposal.path.clone());
                delegation.waiting_for_user += 1;
                approval_stop = Some(format!("an edit review of {}", proposal.path));
                if let Some(task) = task {
                    task.activity = format!(
                        "waiting for the user to review an edit to {}",
                        proposal.path
                    );
                    task.events += 1;
                }
            }
            (
                AgentEvent::ProposalResolved {
                    proposal_id,
                    accepted,
                    ..
                },
                task,
            ) => {
                delegation.waiting_for_user = delegation.waiting_for_user.saturating_sub(1);
                let path = delegation.proposals.remove(proposal_id);
                if !accepted {
                    delegation.edit_rejected = true;
                }
                if let (true, Some(path), Some(task)) = (*accepted, path, task) {
                    if !task.changed.contains(&path) {
                        task.changed.push(path);
                    }
                }
            }
            (
                AgentEvent::Usage {
                    used,
                    size,
                    cost_amount,
                    cost_currency,
                    ..
                },
                task,
            ) => {
                let meter = &mut delegation.meter;
                meter.record_context(*used, *size);
                if cost_amount.is_some() {
                    meter.cost = *cost_amount;
                    meter.currency = cost_currency.clone();
                }
                late_usage = task.is_none();
                if let Some(task) = task {
                    task.events += 1;
                    // A report that arrives after the turn ended (its
                    // completion was already seen) never stops it: the task
                    // keeps its result and the usage shows the overrun.
                    if delegation.stop_override.is_none() && task.stop_reason.is_none() {
                        if let Some((reason, detail)) = meter.over(&delegation.budget, second) {
                            delegation.stop_override = Some((reason, detail.clone()));
                            breach = Some((key.clone(), reason, detail));
                        }
                    }
                }
            }
            (
                AgentEvent::Complete {
                    stop_reason, usage, ..
                },
                Some(task),
            ) => {
                task.stop_reason = Some(stop_reason.clone());
                task.permission_rejected = rejected(&key);
                // Unstable ACP `PromptResponse.usage`: tokens spent by this turn.
                if let Some(total) = usage
                    .as_ref()
                    .and_then(|u| u.get("totalTokens"))
                    .and_then(serde_json::Value::as_u64)
                {
                    delegation.meter.record_turn_total(total);
                }
            }
            _ => touched = false,
        }
        if let Some(what) = approval_stop {
            if delegation.fail_on_approval && has_running && delegation.stop_override.is_none() {
                let detail = format!(
                    "the child raised {what} and this task was delegated with onApproval fail, so Span stopped its turn without answering the request; delegate again with onApproval ask_user to let the user decide"
                );
                delegation.stop_override =
                    Some((FailureReason::PermissionRequired, detail.clone()));
                breach = Some((key.clone(), FailureReason::PermissionRequired, detail));
            }
        }
        if late_usage && delegation.queue.is_empty() {
            // The last turn already ended: refresh its quiet overrun note,
            // never its status.
            if let Some(task) = delegation
                .last_finished
                .as_ref()
                .and_then(|id| tasks.get_mut(id))
                .filter(|task| task.status == TaskStatus::Completed)
            {
                task.detail = delegation.meter.overrun_note(&delegation.budget);
            }
        }
        drop(inner);
        if touched {
            self.bump();
        }
        breach
    }

    /// A prompt future resolved. Marks the task finished and starts the
    /// next queued one.
    pub fn finish(&self, task_id: &str, result: Result<(), String>) {
        let mut inner = self.inner();
        let Inner {
            delegations, tasks, ..
        } = &mut *inner;
        let Some(task) = tasks.get_mut(task_id) else {
            return;
        };
        if task.status.finished() {
            return;
        }
        let delegation = delegations.get_mut(&task.key);
        let (override_reason, edit_rejected) = match delegation {
            Some(d) => {
                d.queue.retain(|id| id != task_id);
                let rejected = std::mem::take(&mut d.edit_rejected);
                // Every task stopped by one Span stop shares its reason.
                let reason = if d.queue.is_empty() {
                    d.stop_override.take()
                } else {
                    d.stop_override.clone()
                };
                (reason, rejected)
            }
            None => (None, false),
        };
        match result {
            Ok(()) => {
                let stop = task
                    .stop_reason
                    .clone()
                    .unwrap_or_else(|| "end_turn".into());
                task.stop_reason = Some(stop.clone());
                match FailureReason::from_stop_reason(&stop) {
                    None => task.status = TaskStatus::Completed,
                    Some(FailureReason::Cancelled) => {
                        task.status = TaskStatus::Failed;
                        let (reason, detail) = match override_reason {
                            Some(found) => found,
                            None if task.permission_rejected || edit_rejected => (
                                FailureReason::PermissionRejected,
                                "the user rejected a permission request or an edit from the child"
                                    .into(),
                            ),
                            None => (FailureReason::Cancelled, "the turn was stopped".into()),
                        };
                        task.reason = Some(reason);
                        task.detail = Some(detail);
                    }
                    Some(reason) => {
                        task.status = TaskStatus::Failed;
                        task.reason = Some(reason);
                        task.detail = Some(format!("the agent stopped with {stop}"));
                    }
                }
            }
            Err(message) => {
                task.status = TaskStatus::Failed;
                let (reason, detail) = override_reason
                    .unwrap_or_else(|| (FailureReason::from_error(&message), message));
                task.reason = Some(reason);
                task.detail = Some(detail);
            }
        }
        if task.user_cancelled {
            // A completion that raced the cancel must not read as success.
            task.status = TaskStatus::Failed;
            task.reason = Some(FailureReason::Cancelled);
            task.detail = Some(USER_CANCEL.into());
        }
        if let Some(d) = delegations.get_mut(&task.key) {
            if task.status == TaskStatus::Completed {
                task.detail = d.meter.overrun_note(&d.budget);
            }
            d.last_finished = Some(task_id.to_owned());
        }
        if task.events > 0 {
            task.last_progress = Some(task.activity.clone());
        }
        task.activity = task.status.as_str().into();
        task.finished_at_ms = Some(now_ms());
        let key = task.key.clone();
        if let Some(next) = delegations.get(&key).and_then(|d| d.queue.front().cloned()) {
            if let Some(next) = tasks.get_mut(&next) {
                next.status = TaskStatus::Running;
                next.activity = "starting".into();
            }
        }
        drop(inner);
        self.bump();
    }

    /// The user cancels one task. Returns its child to stop. Refused once
    /// the task finished; cancelling twice is allowed and changes nothing.
    pub fn cancel_by_user(&self, task_id: &str) -> Result<SessionKey, String> {
        let mut inner = self.inner();
        let task = inner
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| format!("Unknown taskId: {task_id}"))?;
        if task.status.finished() {
            return Err(format!(
                "Task {task_id} already finished, nothing to cancel"
            ));
        }
        task.user_cancelled = true;
        let key = task.key.clone();
        if let Some(d) = inner.delegations.get_mut(&key) {
            if d.stop_override.is_none() {
                d.stop_override = Some((FailureReason::Cancelled, USER_CANCEL.into()));
            }
        }
        Ok(key)
    }

    /// Span is stopping the child; the next `cancelled` stop reports why.
    pub fn stopping(&self, key: &SessionKey, reason: FailureReason, detail: String) {
        if let Some(d) = self.inner().delegations.get_mut(key) {
            if d.stop_override.is_none() {
                d.stop_override = Some((reason, detail));
            }
        }
    }

    /// Children with a running turn that are over their budget or timeout.
    /// Each breach is reported once.
    /// A turn whose completion was already seen is not running any more.
    pub fn breaches(&self, second: Duration) -> Vec<(SessionKey, FailureReason, String)> {
        let mut inner = self.inner();
        let Inner {
            delegations, tasks, ..
        } = &mut *inner;
        let mut found = Vec::new();
        for (key, d) in delegations.iter_mut() {
            if d.stop_override.is_some() {
                continue;
            }
            let running = d
                .queue
                .front()
                .and_then(|id| tasks.get(id))
                .is_some_and(|task| task.stop_reason.is_none());
            if !running {
                continue;
            }
            if let Some((reason, detail)) = d.meter.over(&d.budget, second) {
                d.stop_override = Some((reason, detail.clone()));
                found.push((key.clone(), reason, detail));
            }
        }
        found
    }

    /// The child session left the manager: every unfinished task fails.
    pub fn session_gone(&self, key: &SessionKey) {
        let ids: Vec<String> = self
            .inner()
            .delegations
            .get(key)
            .map(|d| d.queue.iter().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.finish(&id, Err("The delegated session ended".into()));
        }
    }

    pub fn view(&self, task_id: &str, second: Duration) -> Option<TaskView> {
        let inner = self.inner();
        let task = inner.tasks.get(task_id)?.clone();
        let delegation = inner.delegations.get(&task.key);
        let usage = delegation
            .map(|d| UsageReport {
                turns: d.meter.turns,
                // Context occupancy for the meter; turn totals only when the
                // agent reports no context.
                tokens: d.meter.tokens.or_else(|| d.meter.used_tokens()),
                context_size: d.meter.context_size,
                cost: d.meter.cost,
                currency: d.meter.currency.clone(),
                elapsed_seconds: d.meter.elapsed(second),
            })
            .unwrap_or_default();
        Some(TaskView {
            task,
            usage,
            spent_tokens: delegation.and_then(|d| d.meter.used_tokens()),
            max_tokens: delegation.and_then(|d| d.budget.max_tokens),
            waiting_for_user: delegation.map_or(0, |d| d.waiting_for_user),
        })
    }

    /// Find a delegated session by the agent's session id, optionally
    /// narrowed by connection (session ids repeat across processes).
    pub fn resolve(
        &self,
        session_id: &str,
        connection_id: Option<&str>,
    ) -> Result<SessionKey, String> {
        let inner = self.inner();
        let matches: Vec<&SessionKey> = inner
            .delegations
            .keys()
            .filter(|k| {
                k.session_id == session_id && connection_id.is_none_or(|c| k.connection_id == c)
            })
            .collect();
        match matches.as_slice() {
            [one] => Ok((*one).clone()),
            [] => Err(format!(
                "No session {session_id} was delegated by this lead"
            )),
            _ => Err(format!(
                "Session id {session_id} exists on several agents. Pass connectionId."
            )),
        }
    }

    /// Every task id, oldest first (ids are `task-<n>`).
    pub fn task_ids(&self) -> Vec<String> {
        let mut ids: Vec<(u64, String)> = self
            .inner()
            .tasks
            .keys()
            .map(|id| {
                let n = id
                    .rsplit('-')
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(u64::MAX);
                (n, id.clone())
            })
            .collect();
        ids.sort();
        ids.into_iter().map(|(_, id)| id).collect()
    }

    pub fn task_key(&self, task_id: &str) -> Option<SessionKey> {
        self.inner().tasks.get(task_id).map(|t| t.key.clone())
    }

    /// The child's task generation when it has no running or queued task
    /// and is still open, else `None`. An idle timer starts from this.
    pub fn idle(&self, key: &SessionKey) -> Option<u64> {
        let inner = self.inner();
        let d = inner.delegations.get(key)?;
        (d.queue.is_empty() && !d.closed).then_some(d.generation)
    }

    /// Mark the child closed if no task started since `generation` and none
    /// is queued. True when the caller must now end its session.
    pub fn close_if_idle(&self, key: &SessionKey, generation: u64) -> bool {
        let mut inner = self.inner();
        let Some(d) = inner.delegations.get_mut(key) else {
            return false;
        };
        if d.closed || d.generation != generation || !d.queue.is_empty() {
            return false;
        }
        d.closed = true;
        drop(inner);
        self.bump();
        true
    }

    /// Children with a running or queued task.
    pub fn busy_children(&self) -> usize {
        self.inner()
            .delegations
            .values()
            .filter(|d| !d.queue.is_empty())
            .count()
    }

    /// The lead's children together, against the lead's total budget:
    /// `Err` with the reason once `max_turns` prompts or `max_tokens`
    /// measured tokens were spent across all of them.
    pub fn lead_budget_left(&self, max_turns: u32, max_tokens: Option<u64>) -> Result<(), String> {
        let inner = self.inner();
        let turns: u32 = inner.delegations.values().map(|d| d.meter.turns).sum();
        if turns >= max_turns {
            return Err(format!(
                "budget spent: this lead's children together already ran {turns} turns, the lead's total of {max_turns}"
            ));
        }
        if let Some(max) = max_tokens {
            let used: u64 = inner
                .delegations
                .values()
                .filter_map(|d| d.meter.used_tokens())
                .sum();
            if used >= max {
                return Err(format!(
                    "budget spent: this lead's children together used about {used} tokens, the lead's total of {max}"
                ));
            }
        }
        Ok(())
    }

    /// Every child with the agent name it was delegated to.
    /// Record the display name of the model a child runs.
    pub fn set_model(&self, key: &SessionKey, model: Option<String>) {
        if let Some(delegation) = self.inner().delegations.get_mut(key) {
            delegation.model = model;
        }
    }

    /// The display name of the model a child runs, when known.
    pub fn model_of(&self, key: &SessionKey) -> Option<String> {
        self.inner()
            .delegations
            .get(key)
            .and_then(|d| d.model.clone())
    }

    pub fn children_with_agents(&self) -> Vec<(SessionKey, String)> {
        self.inner()
            .delegations
            .iter()
            .map(|(key, d)| (key.clone(), d.agent.clone()))
            .collect()
    }

    pub fn record_decision(&self, decision: DecisionRecord) {
        self.inner().decisions.push(decision);
        self.bump();
    }

    pub fn decisions(&self) -> Vec<DecisionRecord> {
        self.inner().decisions.clone()
    }

    pub fn decision_count(&self) -> usize {
        self.inner().decisions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> (Registry, SessionKey, String) {
        registry_with(Budget::default())
    }

    fn registry_with(budget: Budget) -> (Registry, SessionKey, String) {
        let registry = Registry::default();
        let key = SessionKey::new("c", "s");
        registry.add_delegation(key.clone(), "worker".into(), budget);
        let id = registry
            .start_task(&key, None, Duration::from_secs(1))
            .unwrap();
        (registry, key, id)
    }

    const SECOND: Duration = Duration::from_secs(1);

    fn event(event: AgentEvent) -> SessionEvent {
        SessionEvent {
            connection_id: "c".into(),
            agent_name: "worker".into(),
            session_id: Some("s".into()),
            event,
        }
    }

    fn usage(used: u64) -> SessionEvent {
        event(AgentEvent::Usage {
            session_id: "s".into(),
            used,
            size: 200_000,
            cost_amount: None,
            cost_currency: None,
        })
    }

    fn complete(stop_reason: &str, total: Option<u64>) -> SessionEvent {
        event(AgentEvent::Complete {
            session_id: "s".into(),
            stop_reason: stop_reason.into(),
            usage: total.map(|t| serde_json::json!({ "totalTokens": t })),
            meta: None,
            hint: None,
        })
    }

    fn small_budget() -> Budget {
        Budget {
            max_tokens: Some(1000),
            ..Budget::default()
        }
    }

    #[test]
    fn a_fresh_childs_system_prompt_does_not_break_a_small_token_budget() {
        let (registry, _, id) = registry_with(small_budget());
        // A fresh session already holds about 31k tokens of prompt and tools.
        assert!(registry
            .observe(&usage(31_290), SECOND, |_| false)
            .is_none());
        assert!(registry
            .observe(&usage(31_700), SECOND, |_| false)
            .is_none());
        assert!(registry.breaches(SECOND).is_empty());
        registry.observe(&complete("end_turn", None), SECOND, |_| false);
        registry.finish(&id, Ok(()));
        let view = registry.view(&id, SECOND).unwrap();
        assert_eq!(view.task.status, TaskStatus::Completed);
        assert_eq!(view.usage.tokens, Some(31_700));
        assert_eq!(view.spent_tokens, Some(410));
        assert_eq!(view.max_tokens, Some(1000));
        assert_eq!(view.task.detail, None);
    }

    #[test]
    fn a_late_usage_report_after_the_turn_ended_keeps_the_task_completed() {
        let (registry, _, id) = registry_with(small_budget());
        registry.observe(&usage(25_036), SECOND, |_| false);
        registry.observe(&complete("end_turn", None), SECOND, |_| false);
        // The turn's completion was seen; this report lands before `finish`.
        assert!(registry
            .observe(&usage(28_000), SECOND, |_| false)
            .is_none());
        assert!(registry.breaches(SECOND).is_empty());
        registry.finish(&id, Ok(()));
        // And one more after it finished.
        assert!(registry
            .observe(&usage(29_000), SECOND, |_| false)
            .is_none());
        let view = registry.view(&id, SECOND).unwrap();
        assert_eq!(view.task.status, TaskStatus::Completed);
        assert_eq!(view.task.reason, None);
        assert_eq!(view.spent_tokens, Some(3964));
        assert_eq!(
            view.task.detail.as_deref(),
            Some("Used about 3964 tokens, over the 1000 token budget")
        );
    }

    #[test]
    fn a_running_child_that_really_exceeds_its_budget_is_stopped() {
        let (registry, key, id) = registry_with(small_budget());
        registry.observe(&usage(30_000), SECOND, |_| false);
        let (stopped, reason, detail) = registry
            .observe(&usage(31_500), SECOND, |_| false)
            .expect("a breach to act on");
        assert_eq!(stopped, key);
        assert_eq!(reason, FailureReason::BudgetExceeded);
        assert_eq!(
            detail,
            "used about 1500 tokens since it started, over the 1000 token budget"
        );
        // Reported once.
        assert!(registry.breaches(SECOND).is_empty());
        registry.observe(&complete("cancelled", None), SECOND, |_| false);
        registry.finish(&id, Ok(()));
        let task = registry.view(&id, SECOND).unwrap().task;
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.reason, Some(FailureReason::BudgetExceeded));
        assert_eq!(task.detail.as_deref(), Some(detail.as_str()));
    }

    #[test]
    fn a_turn_total_is_the_spend_and_gates_the_next_message() {
        let (registry, key, id) = registry_with(small_budget());
        registry.observe(&usage(30_000), SECOND, |_| false);
        registry.observe(&usage(36_000), SECOND, |_| false);
        // That growth breached while running, but the turn ended normally.
        registry.observe(&complete("end_turn", Some(400)), SECOND, |_| false);
        registry.finish(&id, Ok(()));
        let view = registry.view(&id, SECOND).unwrap();
        assert_eq!(view.task.status, TaskStatus::Completed);
        assert_eq!(view.spent_tokens, Some(400));
        // 400 of 1000 spent: a follow-up fits.
        let next = registry.start_task(&key, None, SECOND).unwrap();
        registry.observe(&complete("end_turn", Some(700)), SECOND, |_| false);
        registry.finish(&next, Ok(()));
        assert_eq!(
            registry.view(&next, SECOND).unwrap().task.status,
            TaskStatus::Completed
        );
        // 1100 spent now: the next one is refused with the measured spend.
        let refused = registry.start_task(&key, None, SECOND).unwrap_err();
        assert!(refused.contains("used about 1100 tokens"), "{refused}");
    }

    #[test]
    fn a_completion_that_races_the_user_cancel_still_ends_cancelled() {
        let (registry, key, id) = registry();
        assert_eq!(registry.cancel_by_user(&id).as_ref(), Ok(&key));
        // The child's turn ended normally just as the cancel was applied.
        registry.finish(&id, Ok(()));
        let task = registry.view(&id, Duration::from_secs(1)).unwrap().task;
        assert_eq!(task.status, TaskStatus::Failed);
        assert_eq!(task.reason, Some(FailureReason::Cancelled));
        assert_eq!(task.detail.as_deref(), Some(USER_CANCEL));
        // A later report never overwrites the terminal state.
        registry.finish(&id, Err("late".into()));
        let task = registry.view(&id, Duration::from_secs(1)).unwrap().task;
        assert_eq!(task.reason, Some(FailureReason::Cancelled));
    }

    #[test]
    fn an_idle_child_closes_only_when_no_prompt_came_since() {
        let (registry, key, id) = registry();
        assert_eq!(registry.idle(&key), None, "a running task is not idle");
        registry.finish(&id, Ok(()));
        let generation = registry.idle(&key).unwrap();
        // A message arrives before the timer fires: no close.
        let next = registry.start_task(&key, None, SECOND).unwrap();
        assert!(!registry.close_if_idle(&key, generation));
        registry.finish(&next, Ok(()));
        let generation = registry.idle(&key).unwrap();
        assert!(registry.close_if_idle(&key, generation));
        assert!(!registry.close_if_idle(&key, generation), "closed once");
        assert_eq!(registry.idle(&key), None);
        assert_eq!(
            registry.start_task(&key, None, SECOND).unwrap_err(),
            IDLE_CLOSED
        );
    }

    #[test]
    fn the_lead_total_budget_sums_every_child() {
        let registry = Registry::default();
        for name in ["a", "b"] {
            let key = SessionKey::new("c", name);
            registry.add_delegation(key.clone(), "worker".into(), Budget::default());
            let id = registry.start_task(&key, None, SECOND).unwrap();
            registry.finish(&id, Ok(()));
        }
        assert!(registry.lead_budget_left(3, None).is_ok());
        let refused = registry.lead_budget_left(2, None).unwrap_err();
        assert!(
            refused.contains("together already ran 2 turns"),
            "{refused}"
        );
        assert_eq!(registry.busy_children(), 0);
    }

    #[test]
    fn cancelling_a_finished_task_is_refused_clearly() {
        let (registry, _, id) = registry();
        registry.finish(&id, Ok(()));
        let error = registry.cancel_by_user(&id).unwrap_err();
        assert!(error.contains("already finished"), "{error}");
        let task = registry.view(&id, Duration::from_secs(1)).unwrap().task;
        assert_eq!(task.status, TaskStatus::Completed);
        assert!(registry.cancel_by_user("task-99").is_err());
    }
}
