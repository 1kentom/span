//! ADR 0014 stage 2: `delegate_many` with Span's own queue and group
//! budgets, `wait`, `task_status` and `list_tasks`. A child module of the
//! server so it shares its private state and helpers.
use super::*;
use crate::PromptAttachment;
use std::collections::HashSet;

/// Most tasks one `delegate_many` call starts.
const MAX_GROUP: usize = 8;
/// Most task ids one `wait` call takes.
const MAX_WAIT_IDS: usize = 16;
/// Longest `wait`, in policy seconds: under Codex's 60 s tool timeout.
pub(super) const MAX_WAIT_MANY_SECONDS: f64 = 50.0;
const DEFAULT_WAIT_SECONDS: f64 = 30.0;
const MAX_LIST: usize = 50;
const STATUSES: [&str; 5] = ["queued", "running", "completed", "failed", "lost"];

/// A child's first task waiting in Span's queue for a free slot.
pub(super) struct HeldLaunch {
    pub task_id: String,
    pub child: SessionKey,
    pub text: String,
    pub attachments: Vec<PromptAttachment>,
}

/// One `delegate_many` call: its tasks and the group budget they share.
#[derive(Clone)]
pub(super) struct Group {
    task_ids: Vec<String>,
    budget: BudgetRequest,
    started: Instant,
    stopped: bool,
}

impl Shared {
    /// Launch held tasks, oldest first, while the lead runs fewer than
    /// `max_concurrent` children.
    pub(super) fn pump(self: &Arc<Self>) {
        let Ok(control) = self.control() else {
            return;
        };
        let _pump = lock(&self.pump);
        loop {
            if self.registry.busy_children() >= self.config.policy.max_concurrent {
                return;
            }
            let Some(launch) = lock(&self.held).pop_front() else {
                return;
            };
            let done = {
                let _order = lock(&self.order);
                if !self.registry.launch_held(&launch.task_id) {
                    continue;
                }
                match control.enqueue(&launch.child, launch.text, launch.attachments) {
                    Ok(done) => done,
                    Err(error) => {
                        self.registry.finish(&launch.task_id, Err(error));
                        self.finished(control.caller(), &launch.child, &launch.task_id);
                        continue;
                    }
                }
            };
            self.sync_record(&launch.task_id);
            self.watch_turn(control.caller().clone(), launch.child, launch.task_id, done);
        }
    }

    /// End a task that still waits in Span's queue, with Span's reason.
    pub(super) fn cancel_held(&self, task_id: &str, reason: FailureReason, detail: String) {
        let launch = {
            let mut held = lock(&self.held);
            let index = held.iter().position(|l| l.task_id == task_id);
            index.and_then(|i| held.remove(i))
        };
        let child = launch
            .map(|l| l.child)
            .or_else(|| self.registry.task_key(task_id));
        self.registry.fail_held(task_id, reason, detail);
        if let (Some(child), Ok(control)) = (child, self.control()) {
            self.finished(control.caller(), &child, task_id);
        }
    }

    /// A child session ended: its unfinished tasks are lost (unless Span
    /// stopped them), including a first task still held in Span's queue.
    pub(super) fn child_gone(&self, key: &SessionKey) {
        let held = self.registry.held_task(key);
        if let Some(id) = &held {
            lock(&self.held).retain(|l| l.task_id != *id);
        }
        self.registry.session_gone(key);
        if let (Some(id), Some(control)) = (held, lock(&self.control).clone()) {
            self.finished(control.caller(), key, &id);
        }
    }

    /// Stop every unfinished task of a group whose shared budget is spent.
    pub(super) fn check_groups(&self) {
        let second = self.second();
        let groups: Vec<(String, Group)> = lock(&self.groups)
            .iter()
            .filter(|(_, g)| !g.stopped)
            .map(|(id, g)| (id.clone(), g.clone()))
            .collect();
        for (group_id, group) in groups {
            let unfinished: Vec<String> = group
                .task_ids
                .iter()
                .filter(|id| {
                    self.registry
                        .view(id, second)
                        .is_some_and(|v| !v.task.status.finished())
                })
                .cloned()
                .collect();
            if unfinished.is_empty() {
                continue;
            }
            let (mut turns, mut tokens, mut cost) = (0u32, 0u64, 0f64);
            for id in &group.task_ids {
                if let Some((t, used, spent)) = self.registry.delegation_usage(id) {
                    turns += t;
                    tokens += used.unwrap_or(0);
                    cost += spent.unwrap_or(0.0);
                }
            }
            let elapsed = (group.started.elapsed().as_secs_f64()
                / second.as_secs_f64().max(f64::EPSILON)) as u64;
            let budget = &group.budget;
            let breach = if budget.timeout_seconds.is_some_and(|t| elapsed >= t) {
                Some(format!(
                    "the group {group_id} ran {elapsed} s, its budget of {} s",
                    budget.timeout_seconds.unwrap_or_default()
                ))
            } else if budget.max_turns.is_some_and(|t| turns > t) {
                Some(format!(
                    "the group {group_id} ran {turns} turns, over its budget of {}",
                    budget.max_turns.unwrap_or_default()
                ))
            } else if budget.max_tokens.is_some_and(|t| tokens >= t) {
                Some(format!(
                    "the group {group_id} used about {tokens} tokens, its budget of {}",
                    budget.max_tokens.unwrap_or_default()
                ))
            } else if budget.max_cost.is_some_and(|c| cost > c) {
                Some(format!(
                    "the group {group_id} cost {cost:.2}, over its budget of {:.2}",
                    budget.max_cost.unwrap_or_default()
                ))
            } else {
                None
            };
            let Some(detail) = breach else {
                continue;
            };
            if let Some(g) = lock(&self.groups).get_mut(&group_id) {
                g.stopped = true;
            }
            let control = self.control().ok();
            for id in unfinished {
                let Some(key) = self.registry.task_key(&id) else {
                    continue;
                };
                if self.registry.held_task(&key).as_deref() == Some(id.as_str()) {
                    self.cancel_held(&id, FailureReason::BudgetExceeded, detail.clone());
                } else {
                    self.registry
                        .stopping(&key, FailureReason::BudgetExceeded, detail.clone());
                    if let Some(control) = &control {
                        let _ = control.cancel(&key);
                    }
                }
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ManyArgs {
    tasks: Vec<ManyTask>,
    budget: Option<BudgetRequest>,
    pub client_request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManyTask {
    agent: String,
    task: String,
    model: Option<String>,
    effort: Option<String>,
    mode: Option<String>,
    context: Option<ContextArgs>,
    deliverables: Option<DeliverablesArgs>,
    workspace: Option<WorkspaceArg>,
    on_approval: Option<OnApproval>,
    #[serde(default)]
    attachments: Vec<String>,
    expect: Option<String>,
    save_to: Option<String>,
}

impl From<ManyTask> for DelegateArgs {
    fn from(t: ManyTask) -> Self {
        DelegateArgs {
            agent: t.agent,
            task: t.task,
            attachments: t.attachments,
            expect: t.expect,
            save_to: t.save_to,
            budget: None,
            model: t.model,
            effort: t.effort,
            mode: t.mode,
            context: t.context,
            deliverables: t.deliverables,
            workspace: t.workspace,
            on_approval: t.on_approval,
            client_request_id: None,
        }
    }
}

/// Take `n` of `max` delegation slots at once, or none.
fn reserve_many(count: &std::sync::atomic::AtomicUsize, n: usize, max: usize) -> Option<usize> {
    use std::sync::atomic::Ordering::SeqCst;
    let mut current = count.load(SeqCst);
    while current + n <= max {
        match count.compare_exchange(current, current + n, SeqCst, SeqCst) {
            Ok(_) => return None,
            Err(seen) => current = seen,
        }
    }
    Some(current)
}

fn group_failure(mut failure: Value, index: usize) -> Value {
    failure["structuredContent"]["failedTask"] = json!(index);
    if let Some(text) = failure["content"][0]["text"].as_str() {
        failure["content"][0]["text"] = json!(format!(
            "delegate_many refused as a whole (tasks[{index}]), no child was started. {text}"
        ));
    }
    failure
}

pub(super) async fn delegate_many(shared: &Arc<Shared>, args: ManyArgs) -> Result<Value, RpcError> {
    let control = shared.control()?;
    let n = args.tasks.len();
    if !(2..=MAX_GROUP).contains(&n) {
        return Err(invalid(format!(
            "tasks takes 2 to {MAX_GROUP} tasks; use delegate for a single task"
        )));
    }
    let tasks: Vec<DelegateArgs> = args.tasks.into_iter().map(Into::into).collect();
    let mut prepared = Vec::new();
    for (i, t) in tasks.iter().enumerate() {
        let at = |e: RpcError| invalid(format!("tasks[{i}]: {}", e.message));
        if t.task.trim().is_empty() {
            return Err(invalid(format!("tasks[{i}].task must not be empty")));
        }
        for (field, value) in [
            ("model", &t.model),
            ("effort", &t.effort),
            ("mode", &t.mode),
        ] {
            if value.as_deref().is_some_and(|v| v.trim().is_empty()) {
                return Err(invalid(format!(
                    "tasks[{i}].{field} must not be empty when given"
                )));
            }
        }
        let options = check_options(shared, t).map_err(at)?;
        let mut attachments = Vec::new();
        for path in &t.attachments {
            let (absolute, shown) = inside_workspace(&shared.root, path)
                .map_err(invalid)
                .map_err(at)?;
            if !absolute.exists() {
                return Err(invalid(format!(
                    "tasks[{i}]: Attachment does not exist: {shown}"
                )));
            }
            attachments.push(resource_link(&absolute, &shown, None));
        }
        for (absolute, shown) in &options.context_files {
            attachments.push(resource_link(
                absolute,
                shown,
                Some("Context file from the lead agent".into()),
            ));
        }
        let save_to = match &t.save_to {
            Some(path) => Some(
                inside_workspace(&shared.root, path)
                    .map_err(invalid)
                    .map_err(at)?
                    .1,
            ),
            None => None,
        };
        prepared.push((options, attachments, save_to));
    }
    for (i, t) in tasks.iter().enumerate() {
        if t.workspace == Some(WorkspaceArg::Worktree) {
            return Ok(group_failure(
                result::failure(
                    &t.agent,
                    FailureReason::WorktreeUnavailable,
                    WORKTREE_UNAVAILABLE,
                ),
                i,
            ));
        }
        if let Some(mode) = t.mode.as_deref().filter(|m| bypass_like(m)) {
            return Ok(group_failure(
                result::choice_error(
                    &t.agent,
                    "mode_refused",
                    &format!("the mode {mode} runs tools without asking, and delegated children always ask the user"),
                    json!([]),
                ),
                i,
            ));
        }
    }
    let policy = &shared.config.policy;
    let depth = control.depth().unwrap_or(0);
    if depth >= policy.max_depth {
        return Ok(result::failure(
            &shared.lead_name,
            FailureReason::DepthExceeded,
            &format!(
                "this session is at depth {depth} and the delegation depth limit is {}",
                policy.max_depth
            ),
        ));
    }
    let group_budget = args.budget.unwrap_or_default();
    let refuse = |detail: String| {
        Ok(result::failure(
            "delegate_many",
            FailureReason::BudgetExceeded,
            &format!("delegate_many refused as a whole, no child was started: {detail}"),
        ))
    };
    if let Some(turns) = group_budget.max_turns.filter(|t| (*t as usize) < n) {
        return refuse(format!(
            "the group budget allows {turns} turns but the group has {n} tasks"
        ));
    }
    if let Some(used) = reserve_many(&shared.delegations, n, policy.max_delegations) {
        return refuse(format!(
            "it would start {n} delegations, and this lead already started {used} of the {} one lead may start; send follow-ups to children you already started with message",
            policy.max_delegations
        ));
    }
    let mut slots = Slots {
        count: &shared.delegations,
        n,
        kept: false,
    };
    let used_turns = shared.registry.lead_turns();
    if used_turns as usize + n > policy.max_lead_turns as usize {
        return refuse(format!(
            "it needs {n} turns, and this lead's children already ran {used_turns} of the lead's total of {}",
            policy.max_lead_turns
        ));
    }
    if let Err(spent) = shared
        .registry
        .lead_budget_left(policy.max_lead_turns, policy.max_lead_tokens)
    {
        return refuse(spent);
    }
    // Every child exists and is configured before any task is registered:
    // one failure discards them all (atomic admission).
    let mut created: Vec<(ConnectionInfo, SessionKey, Applied)> = Vec::new();
    for (i, t) in tasks.iter().enumerate() {
        let target = match resolve_target(shared, &control, &t.agent).await {
            Ok(target) => target,
            Err(outcome) => {
                discard_all(&control, created).await;
                return outcome.map(|failure| group_failure(failure, i));
            }
        };
        let child = match control
            .delegate_limited(&target.connection_id, policy.max_depth)
            .await
        {
            Ok(child) => child,
            Err(error) => {
                discard_all(&control, created).await;
                return Ok(group_failure(
                    result::failure(
                        &target.agent_name,
                        FailureReason::from_error(&error),
                        &error,
                    ),
                    i,
                ));
            }
        };
        match configure_child(&control, &child, &target.agent_name, t).await {
            Ok(applied) => created.push((target, child, applied)),
            Err(failure) => {
                discard_child(&control, &child, &target.agent_name).await;
                discard_all(&control, created).await;
                return Ok(group_failure(failure, i));
            }
        }
    }
    slots.kept = true;
    let group_id = format!(
        "group-{}",
        shared
            .next_group
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1
    );
    let ceiling = BudgetRequest {
        max_turns: None,
        max_tokens: group_budget.max_tokens,
        timeout_seconds: group_budget.timeout_seconds,
        max_cost: group_budget.max_cost,
    };
    let budget = policy.budget.narrowed(&ceiling);
    let mut task_ids: Vec<String> = Vec::new();
    let mut entries = Vec::new();
    for ((t, (options, attachments, save_to)), (target, child, applied)) in
        tasks.iter().zip(prepared).zip(created)
    {
        sweep_later(
            control.manager().clone(),
            target.connection_id.clone(),
            target.agent_name.clone(),
            policy.end_gap,
        );
        adopt_child(
            shared,
            &control,
            &child,
            &target.agent_name,
            budget.clone(),
            applied.model.clone(),
            t.on_approval == Some(OnApproval::Fail),
        );
        let names: Vec<String> = options
            .context_files
            .iter()
            .map(|(_, s)| s.clone())
            .collect();
        let text = compose_prompt(
            &shared.lead_name,
            t,
            save_to.as_deref(),
            options.deliverables.as_ref(),
            &names,
        );
        let task_id = match shared.registry.register_held(
            &child,
            save_to,
            Some(group_id.clone()),
            shared.second(),
        ) {
            Ok(id) => id,
            Err(error) => {
                // Checked above; only a race with another call gets here.
                for id in &task_ids {
                    shared.cancel_held(id, FailureReason::BudgetExceeded, error.clone());
                }
                return refuse(error);
            }
        };
        if let Some(deliverables) = &options.deliverables {
            shared
                .registry
                .set_deliverables(&task_id, deliverables.clone());
        }
        shared.emit(DelegationEvent::Delegated {
            lead: control.caller().clone(),
            child: child.clone(),
            task_id: task_id.clone(),
            agent_name: target.agent_name.clone(),
            model: applied.model.clone(),
            deliverables: options.deliverables.clone(),
            group_id: Some(group_id.clone()),
        });
        shared.sync_record(&task_id);
        lock(&shared.held).push_back(HeldLaunch {
            task_id: task_id.clone(),
            child: child.clone(),
            text,
            attachments,
        });
        task_ids.push(task_id.clone());
        entries.push((task_id, child, target.agent_name.clone(), applied));
    }
    lock(&shared.groups).insert(
        group_id.clone(),
        Group {
            task_ids: task_ids.clone(),
            budget: group_budget.clone(),
            started: Instant::now(),
            stopped: false,
        },
    );
    shared.pump();
    let second = shared.second();
    let listed: Vec<Value> = entries
        .iter()
        .map(|(task_id, child, agent, applied)| {
            let status = shared
                .registry
                .view(task_id, second)
                .map_or("queued", |v| v.task.status.as_str());
            json!({
                "taskId": task_id,
                "sessionId": child.session_id,
                "connectionId": child.connection_id,
                "agent": agent,
                "model": applied.model,
                "status": status,
            })
        })
        .collect();
    let queued = listed.iter().filter(|t| t["status"] == "queued").count();
    Ok(result::ok(
        format!(
            "Started group {group_id}: {} tasks running, {queued} queued in Span until a slot frees. Call wait with this groupId.",
            n - queued
        ),
        json!({
            "groupId": group_id,
            "tasks": listed,
            "budget": {
                "maxTurns": group_budget.max_turns,
                "maxTokens": group_budget.max_tokens,
                "timeoutSeconds": group_budget.timeout_seconds,
                "maxCost": group_budget.max_cost,
            },
        }),
    ))
}

async fn discard_all(control: &AgentControl, created: Vec<(ConnectionInfo, SessionKey, Applied)>) {
    for (target, child, _) in created {
        discard_child(control, &child, &target.agent_name).await;
    }
}

/// Frees reserved delegation slots unless the group started.
struct Slots<'a> {
    count: &'a std::sync::atomic::AtomicUsize,
    n: usize,
    kept: bool,
}

impl Drop for Slots<'_> {
    fn drop(&mut self) {
        if !self.kept {
            self.count
                .fetch_sub(self.n, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
enum Until {
    #[default]
    First,
    All,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WaitArgs {
    task_ids: Option<Vec<String>>,
    group_id: Option<String>,
    #[serde(default)]
    until: Until,
    timeout_seconds: Option<f64>,
}

pub(super) async fn wait(
    shared: &Arc<Shared>,
    args: WaitArgs,
    mut progress: Option<Progress>,
) -> Result<Value, RpcError> {
    shared.control()?;
    let ids: Vec<String> = match (args.task_ids, args.group_id) {
        (Some(ids), None) => {
            if ids.is_empty() || ids.len() > MAX_WAIT_IDS {
                return Err(invalid(format!("taskIds takes 1 to {MAX_WAIT_IDS} ids")));
            }
            let mut unique = Vec::new();
            for id in ids {
                if shared.registry.task_key(&id).is_none() {
                    return Err(invalid(format!("Unknown taskId: {id}")));
                }
                if !unique.contains(&id) {
                    unique.push(id);
                }
            }
            unique
        }
        (None, Some(group)) => lock(&shared.groups)
            .get(&group)
            .map(|g| g.task_ids.clone())
            .ok_or_else(|| invalid(format!("Unknown groupId: {group}")))?,
        _ => return Err(invalid("Pass taskIds or groupId, not both")),
    };
    let timeout = args.timeout_seconds.unwrap_or(DEFAULT_WAIT_SECONDS);
    if !(0.0..=MAX_WAIT_MANY_SECONDS).contains(&timeout) {
        return Err(invalid(format!(
            "timeoutSeconds takes 0 to {MAX_WAIT_MANY_SECONDS}"
        )));
    }
    let policy = &shared.config.policy;
    let second = policy.second;
    let deadline = Instant::now() + second.mul_f64(timeout);
    let interval = second * policy.progress_interval_seconds.max(1) as u32;
    let mut changes = shared.registry.watch();
    let blocked_now = |shared: &Shared| -> HashSet<String> {
        ids.iter()
            .filter(|id| {
                shared
                    .registry
                    .view(id, second)
                    .is_some_and(|v| !v.task.status.finished() && v.waiting_for_user > 0)
            })
            .cloned()
            .collect()
    };
    let blocked_at_start = blocked_now(shared);
    let mut next_progress = Instant::now();
    let mut finished_seen = usize::MAX;
    let (newly_done, early, timed_out) = loop {
        let reported = lock(&shared.reported).clone();
        let finished: Vec<&String> = ids
            .iter()
            .filter(|id| {
                shared
                    .registry
                    .view(id, second)
                    .is_some_and(|v| v.task.status.finished())
            })
            .collect();
        let newly: Vec<String> = finished
            .iter()
            .filter(|id| !reported.contains(**id))
            .map(|id| (*id).clone())
            .collect();
        let all = finished.len() == ids.len();
        let complete = match args.until {
            Until::First => !newly.is_empty() || all,
            Until::All => all,
        };
        let blocked = blocked_now(shared);
        let early = blocked.iter().any(|id| !blocked_at_start.contains(id));
        let now = Instant::now();
        if complete || early || now >= deadline {
            break (newly, early && !complete, !complete && !early);
        }
        if let Some(progress) = progress.as_mut() {
            if now >= next_progress || finished.len() != finished_seen {
                // Span's own words only: no child-written text here.
                progress.send(format!(
                    "{} of {} tasks finished; {} waiting for the user",
                    finished.len(),
                    ids.len(),
                    blocked.len()
                ));
                finished_seen = finished.len();
                next_progress = now + interval;
            }
        }
        let wake = if progress.is_some() {
            deadline.min(next_progress)
        } else {
            deadline
        };
        tokio::select! {
            _ = changes.changed() => {}
            _ = tokio::time::sleep_until(wake.into()) => {}
        }
    };
    let mut content = Vec::new();
    let mut done = Vec::new();
    for id in &newly_done {
        let result = task_result(shared, id)?;
        if let Some(blocks) = result["content"].as_array() {
            // Everything but the trailing JSON copy of structuredContent:
            // the framed text and the artifact links.
            content.extend(blocks.iter().take(blocks.len().saturating_sub(1)).cloned());
        }
        done.push(result["structuredContent"].clone());
    }
    lock(&shared.reported).extend(newly_done.iter().cloned());
    let blocked_ids = blocked_now(shared);
    let mut pending = Vec::new();
    let mut blocked = Vec::new();
    for id in &ids {
        let Some(view) = shared.registry.view(id, second) else {
            continue;
        };
        if view.task.status.finished() {
            continue;
        }
        if blocked_ids.contains(id) {
            blocked.push(json!({
                "taskId": id,
                "agent": view.task.agent,
                "waitingFor": view.waiting_for.unwrap_or("permission"),
            }));
        } else {
            pending.push(json!({
                "taskId": id,
                "agent": view.task.agent,
                "status": view.task.status.as_str(),
                "progress": {
                    "activity": view.task.activity,
                    "events": view.task.events,
                    "elapsedSeconds": view.usage.elapsed_seconds,
                },
            }));
        }
    }
    let mut summary = format!(
        "wait: {} finished now, {} still running or queued, {} waiting for the user.",
        done.len(),
        pending.len(),
        blocked.len()
    );
    if early {
        summary.push_str(" Returned early: a child is waiting for the user to answer it in Span (you cannot answer it). Do other work or call wait again.");
    } else if timed_out {
        summary.push_str(" Timed out: call wait again to keep waiting.");
    }
    content.insert(0, json!({"type": "text", "text": summary}));
    let structured = json!({
        "done": done,
        "pending": pending,
        "blocked": blocked,
        "timedOut": timed_out,
    });
    content.push(json!({"type": "text", "text": structured.to_string()}));
    Ok(json!({"content": content, "structuredContent": structured, "isError": false}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskStatusArgs {
    task_id: String,
}

pub(super) fn task_status(shared: &Arc<Shared>, args: TaskStatusArgs) -> Result<Value, RpcError> {
    shared.control()?;
    if shared.registry.task_key(&args.task_id).is_some() {
        shared.sync_record(&args.task_id);
        return task_result(shared, &args.task_id);
    }
    // Known only to the store (a later stage reads it after a restart).
    let record = shared
        .store
        .get(&args.task_id)
        .ok_or_else(|| invalid(format!("Unknown taskId: {}", args.task_id)))?;
    let structured = json!({
        "status": record.status,
        "taskId": record.task_id,
        "agent": record.agent,
        "connectionId": record.connection_id,
        "sessionId": record.session_id,
        "stopReason": Value::Null,
        "artifacts": [],
        "reason": record.reason.map(|r| r.as_str()),
        "detail": record.detail,
    });
    let mut text = format!(
        "Task {} ({}): {}",
        record.task_id, record.agent, record.status
    );
    if let Some(summary) = &record.summary {
        text.push_str("\n\n");
        text.push_str(summary);
    }
    Ok(json!({
        "content": [{"type": "text", "text": text}, {"type": "text", "text": structured.to_string()}],
        "structuredContent": structured,
        "isError": record.status == "failed" || record.status == "lost",
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ListArgs {
    status: Option<Vec<String>>,
    group_id: Option<String>,
    limit: Option<usize>,
    cursor: Option<String>,
}

pub(super) fn list_tasks(shared: &Arc<Shared>, args: ListArgs) -> Result<Value, RpcError> {
    shared.control()?;
    let statuses = args.status.unwrap_or_default();
    if let Some(bad) = statuses.iter().find(|s| !STATUSES.contains(&s.as_str())) {
        return Err(invalid(format!(
            "Unknown status {bad}; use {}",
            STATUSES.join(", ")
        )));
    }
    let limit = args.limit.unwrap_or(20);
    if !(1..=MAX_LIST).contains(&limit) {
        return Err(invalid(format!("limit takes 1 to {MAX_LIST}")));
    }
    shared.sync_all();
    let page = shared
        .store
        .list(&super::super::store::TaskQuery {
            statuses,
            group_id: args.group_id,
            limit,
            cursor: args.cursor,
        })
        .map_err(invalid)?;
    let mut lines = vec![format!("{} tasks (newest first).", page.tasks.len())];
    let tasks: Vec<Value> = page
        .tasks
        .iter()
        .map(|r| {
            lines.push(format!(
                "- {} {} ({}){}{}",
                r.task_id,
                r.agent,
                r.status,
                r.group_id
                    .as_deref()
                    .map(|g| format!(", {g}"))
                    .unwrap_or_default(),
                r.reason
                    .map(|x| format!(", {}", x.as_str()))
                    .unwrap_or_default()
            ));
            if let Some(summary) = &r.summary {
                lines.push(summary.clone());
            }
            json!({
                "taskId": r.task_id,
                "groupId": r.group_id,
                "agent": r.agent,
                "model": r.model,
                "status": r.status,
                "reason": r.reason.map(|x| x.as_str()),
                "startedAtMs": r.started_at_ms,
                "finishedAtMs": r.finished_at_ms,
                "summary": r.summary,
            })
        })
        .collect();
    Ok(result::ok(
        lines.join("\n"),
        json!({"tasks": tasks, "nextCursor": page.next_cursor}),
    ))
}

/// Schemas for the stage 2 tools.
pub(super) fn definitions(
    task_schema: &Value,
    budget_schema: &Value,
    client_request_schema: &Value,
    result_schema: &Value,
) -> Vec<Value> {
    vec![
        json!({
            "name": "delegate_many",
            "title": "Delegate several tasks",
            "description": "Start 2 to 8 independent tasks at once, each on its own agent and optionally its own model, effort and mode, under one shared group budget. Refused as a whole (no child started) when it would exceed this lead's delegation or turn caps. Up to 4 tasks run at once; the rest start as queued in Span and launch as slots free. Returns a groupId: call wait with it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tasks": {"type": "array", "minItems": 2, "maxItems": MAX_GROUP, "items": task_schema},
                    "budget": {
                        "type": "object",
                        "additionalProperties": false,
                        "description": "The group total, summed across its tasks. When spent, the group's unfinished tasks are cancelled with budget_exceeded.",
                        "properties": budget_schema["properties"].clone(),
                    },
                    "clientRequestId": client_request_schema,
                },
                "required": ["tasks"],
                "additionalProperties": false,
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "groupId": {"type": "string"},
                    "tasks": {"type": "array", "items": {"type": "object", "properties": {
                        "taskId": {"type": "string"},
                        "sessionId": {"type": "string"},
                        "connectionId": {"type": "string"},
                        "agent": {"type": "string"},
                        "model": {"type": ["string", "null"]},
                        "status": {"type": "string", "enum": STATUSES},
                    }}},
                    "budget": {"type": "object"},
                    "retried": {"type": "boolean"},
                },
                "required": ["groupId", "tasks"],
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "openWorldHint": true},
        }),
        json!({
            "name": "wait",
            "title": "Wait for tasks",
            "description": "Block until tasks finish: until first (default) returns when any task finished, until all when every one did. At most 50 seconds per call (default 30); sends progress notifications. Each finished result is returned once in done (later only through get_result or task_status). Returns early when a child starts waiting for the user (blocked): the user answers it in Span, you cannot; do other work or call wait again.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskIds": {"type": "array", "minItems": 1, "maxItems": MAX_WAIT_IDS, "items": {"type": "string"}},
                    "groupId": {"type": "string"},
                    "until": {"type": "string", "enum": ["first", "all"]},
                    "timeoutSeconds": {"type": "number", "minimum": 0, "maximum": MAX_WAIT_MANY_SECONDS},
                },
                "additionalProperties": false,
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "done": {"type": "array", "items": result_schema},
                    "pending": {"type": "array", "items": {"type": "object"}},
                    "blocked": {"type": "array", "items": {"type": "object", "properties": {
                        "taskId": {"type": "string"},
                        "waitingFor": {"type": "string", "enum": ["permission", "question", "edit_review"]},
                    }}},
                    "timedOut": {"type": "boolean"},
                },
                "required": ["done", "pending", "blocked", "timedOut"],
            },
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        }),
        json!({
            "name": "task_status",
            "title": "Task status",
            "description": "The get_result shape for one task, without waiting. Includes lost (the child session is gone).",
            "inputSchema": {
                "type": "object",
                "properties": {"taskId": {"type": "string"}},
                "required": ["taskId"],
                "additionalProperties": false,
            },
            "outputSchema": result_schema,
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        }),
        json!({
            "name": "list_tasks",
            "title": "List tasks",
            "description": "This lead's tasks, newest first, optionally filtered by status or groupId. Summaries are inside the untrusted output frame.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": {"type": "array", "items": {"type": "string", "enum": STATUSES}},
                    "groupId": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIST},
                    "cursor": {"type": "string"},
                },
                "additionalProperties": false,
            },
            "outputSchema": {
                "type": "object",
                "properties": {
                    "tasks": {"type": "array", "items": {"type": "object"}},
                    "nextCursor": {"type": ["string", "null"]},
                },
                "required": ["tasks"],
            },
            "annotations": {"readOnlyHint": true, "openWorldHint": false},
        }),
    ]
}
