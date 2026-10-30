# 0014: span-agents v2, an orchestration MCP server

Status: accepted, 2026-10-30. Stages 1 and 2 are implemented (see the
implementation note at the end); stages 3 to 7 are planned. Builds on 0001 (session manager), 0003 (span-agents tool
server and its amendments, including the delegate model choice in
progress), 0005 (session metadata), 0011 (agent mode), 0012 (usage page)
and 0013 (turn checkpoints).

## Context

The owner wants Span's own MCP for calls from one agent to another, done as
well as T3 Code's orchestrator server. span-agents v1 (0003) has six tools,
one loopback Streamable HTTP server per lead with a bearer token, depth 1,
user-only answers, untrusted framing, per-lead caps and children started in
approval mode. Its gaps: one task per call, polling with 30 second waits,
state in memory only, no way to pass context except attachments, no model
or effort choice (being added), no isolation, and child usage is missing
from the Usage page (0012 notes the gap).

T3 Code (pingdotgg/t3code, `docs/orchestration-v2/orchestrator-mcp-server.md`
and `packages/contracts/src/orchestratorMcp.ts`, read 2026-10-30): the doc
says eleven tools, the code registers about twenty. The core set is
`orchestrator_capabilities`, `delegate_task` (`target`, `role`,
`isolation: shared|worktree`, `mode: async|wait`, `timeoutMs`,
`runtimeMode`, `interactionMode`, `clientRequestId`), `task_status`,
`task_cancel`, `create_threads` (1 to 20 top-level threads), and
`t3_thread_launch`, `t3_thread_list`, `t3_thread_read` (paginated, 100
items, truncation flags), `t3_thread_update`, `t3_thread_send`
(`auto|queue|steer|restart`), `t3_thread_wait`, `t3_thread_interrupt`, plus
`t3_pending_request` (questions only). Credentials: 32 random bytes, only
the SHA-256 hash kept in memory, scoped to environment, parent thread and
provider session, 24 hour idle expiry, revoked on provider session release.
Task state is a durable SQL projection replayed after restart; async tasks
wake the parent on completion. Children never get the parent history. A
child may not run with a broader runtime or interaction mode than its
caller. Child questions wake the parent, which may answer them; approvals
are not routed. Open issues: #24711 (agent text reached the model as a user
turn), #23006 (`parent_not_active` after handoff or restart), #26294 (a
child waiting on an approval never wakes the parent), #21354 (orphaned
Codex subagent processes, about 1.5 GB after a day).

## Decisions

### 1. Goals and non-goals

Goals: fan-out with one shared budget; blocking waits that return results
as they finish; task state that survives a restart; budgeted, framed reads
of transcripts; explicit context hand-off instead of history copies; model,
effort, deliverables and approval policy per task; optional worktree
isolation; a read-only second opinion; full visibility in the feed, the
Agents page and the Usage page. Every v1 call keeps working unchanged.

Non-goals: no agent answers a permission, question or edit review (0003
section 4 stands; T3's `t3_pending_request` has no Span equivalent); no
`onApproval: "auto"`; no top-level thread creation by agents (T3
`create_threads`); no scheduling, secrets or cross-machine environments;
no depth above 1 by default; no MCP 2026-07-28 sessionless revision.

### 2. Tool set

All tools keep `additionalProperties: false` and declare an `outputSchema`
with `structuredContent` (plus the serialized text block, as in v1).
Malformed arguments stay JSON-RPC -32602; delegation outcomes use the
closed `reason` set, extended with `lost`, `permission_required`,
`mode_unavailable` and `worktree_unavailable`. A shared `Context` object:

```json
{"files": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
 "handoff": {"type": "object", "additionalProperties": false, "properties": {
   "maxTokens": {"type": "integer", "minimum": 200, "maximum": 8000},
   "focus": {"type": "string", "maxLength": 2000}}},
 "notes": {"type": "string", "maxLength": 20000}}
```

`files` are workspace relative paths sent as ACP `resource_link`s (inside
the workspace, symlinks resolved). `handoff` asks Span to build a summary of
the lead's own transcript capped at `maxTokens`, scrubbed with the
`redact_log` rules and labelled as a summary; the parent history is never
copied.

Kept, backward compatible:

- `list_agents {}`: adds `models[]` (from the agent's ACP config options,
  capped at 16 per agent with `omittedModels`) and `modes[]`.
- `delegate`: v1 fields plus `model`, `effort`
  (`low|medium|high|max`, mapped to the agent's config option when one
  exists, else reported as `applied.effort: null`), `context` (`Context`),
  `workspace: "shared"|"worktree"` (default shared), `deliverables
  {files?: string[<=20], format?: "summary"|"diff"|"json"}`,
  `onApproval: "ask_user"|"fail"` (default ask_user), `clientRequestId`
  (at most 256 characters; a repeat returns the same task). Result adds
  `applied {model, effort, workspace}`.
- `get_result`: unchanged; result adds `lost` status, `deliverables
  {missing[]}` and `worktree?`.
- `message` gains `context`; `cancel` and `record_decision` unchanged.

New:

- `delegate_many` fans out 2 to 8 independent tasks.
  Input: `{tasks: [{agent, task, model?, effort?, context?, deliverables?,
  workspace?, onApproval?}] (minItems 2, maxItems 8), budget?, clientRequestId?}`.
  Output: `{groupId, tasks: [{taskId, sessionId, connectionId, agent,
  status: "running"|"queued"}], budget}`. Atomic admission: refused whole
  with `budget_exceeded` when the count exceeds the lead's remaining
  `max_delegations` or turn budget. Tasks beyond `max_concurrent` start
  `queued` in a Span-side queue and launch as slots free. `budget` is the
  group total (turns, tokens, seconds, cost) summed across its tasks; when
  spent, the group's unfinished tasks are cancelled with `budget_exceeded`.
  Example: `{"tasks":[{"agent":"codex","task":"Write tests for parser.rs","model":"gpt-5"},{"agent":"claude","task":"Review parser.rs for panics"}],"budget":{"timeoutSeconds":900}}`.
- `wait` blocks on one or many tasks.
  Input: `{taskIds: string[1..16] | groupId, until: "first"|"all"
  (default first), timeoutSeconds: 0..50 (default 30)}`. Output:
  `{done: [<get_result structuredContent>], pending: [{taskId, status,
  progress}], blocked: [{taskId, waitingFor: "permission"|"question"|"edit_review"}],
  timedOut}`. It sends `notifications/progress` while waiting and returns
  early when any task becomes blocked on the user (the fix for T3 #26294:
  the lead learns, the user answers). A finished result is returned once
  as `done`, then only through `get_result`. The 50 second ceiling stays
  under Codex's 60 second tool timeout.
- `task_status {taskId}`: the `get_result` shape without waiting, from the
  durable record (section 4), including `lost`.
- `list_tasks {status?: string[], groupId?, limit: 1..50 (default 20), cursor?}`:
  `{tasks: [{taskId, groupId?, agent, model?, status, reason?, startedAtMs,
  finishedAtMs?, summary?}], nextCursor?}`, this lead only, newest first.
- `read_thread {target: "lead"|taskId, maxTokens: 200..8000 (default 2000),
  view: "summary"|"recent" (default summary)}`: read-only.
  Output: `{text, truncated, approxTokens, items}`. The text is a summary or
  the most recent turns of the lead's own thread or one of its children,
  scrubbed with `redact_log` (tokens, auth metadata, MCP headers and
  environment values never appear), capped hard at 8000 tokens, and a
  child's text is inside the `<untrusted-agent-output>` frame. Another
  lead's thread is -32602.
- `share_context {sessionId, connectionId?, context}`: queues a context-only
  message to an idle child (counts as a turn); refused while it runs.
- `second_opinion {agent?, subject: {diff: "working"|"turn"} | {plan: string},
  question?, model?}`: delegates to another agent (default: a different
  agent than the lead) in plan mode (0011 d, enforced at the adapter: no
  writes, no commands). The diff comes from the 0013 checkpoint of the
  lead's last turn or the working tree, inlined up to 60,000 characters.
  An agent without an enforceable read-only mode gets `mode_unavailable`;
  Span never falls back to a writable child. Returns a `taskId`.

Errors (all tools): -32602 for bad arguments, unknown ids and paths outside
the workspace; -32603 before `bind`; tool failure with a closed `reason`
for anything about the delegation itself.

### 3. Delegate options and safety

- `model` and `effort` may not exceed what the user allows the agent (the
  model list Span reads); an unknown model is -32602.
- `onApproval: "fail"`: when the child raises a permission or edit review,
  Span cancels the child's turn (ACP cancel, which resolves the pending
  request as cancelled) and the task fails with `permission_required`.
  Span never selects an option for it. `ask_user` is v1 behaviour.
- `workspace: "worktree"` depends on 0011 phase 6 and refuses with
  `worktree_unavailable` until then. Rules: the folder must be a Git
  repository; Span creates the worktree under its own `_work`-style folder
  outside the user's checkout from the lead's `HEAD` (uncommitted edits do
  not travel, which the result says); branch `span/task/<taskId>`, never
  pushed; nothing is merged automatically, the user merges from the
  Changes tab; removal only when the worktree is clean and its branch is
  merged or empty, never with force, otherwise it is kept and listed;
  checkpoints (0013) and edit review apply inside it.
- Mode narrowing (as T3): a child starts in approval mode (0003 amendment
  item 7), in plan mode when the lead is in plan mode, and never broader
  than its lead. No tool changes any mode.

### 4. Lifecycle and durability

- Create: `delegate`, `delegate_many`, `second_opinion`. Reuse: `message`
  and `share_context` (same child session). Idle close: after
  `child_idle_seconds` (600) the child session is closed or deleted; the
  task record stays. Delete: deleting the lead's thread deletes its task
  records. Lead end: children end (0003, unchanged).
- Durability: each task record (ids, agent, model, status, reason,
  timings, usage counters, artifact paths) is written to the lead's
  session metadata (0005, a `delegations` field, counters only), and the
  framed summary to the transcript store (0011 a, scrubbed). `task_status`,
  `list_tasks` and `read_thread` read from there after a restart.
- Restart recovery: children end on app exit (0003 amendment), so on load
  any record that was `queued` or `running` becomes `lost` with reason
  `lost` and detail "Span restarted while this task ran; the child session
  is gone, delegate again". Finished records keep their result.
- Retries: a repeated `clientRequestId` returns the existing task.

### 5. Credentials

Per lead, 32 CSPRNG bytes (v1). v2 adds: only the SHA-256 hash is held
after the entry is built; the token is scoped to one lead `SessionKey` and
the tool groups enabled for it (delegation, run tools); a 12 hour idle
expiry (401 after it, a fresh token on the next `session/load`); revocation
on lead end, on `session/load` (old token dies when the new one is
offered) and on app exit. Never logged, never in the transcript, metadata
or protocol log (`redact_log`). Children at depth 1 get no token.

### 6. Injection and cycle defences

- Every child-written string (results, `read_thread`, `wait`) stays in the
  defused `<untrusted-agent-output>` frame; Span-authored notices are
  labelled as Span, never as the user (T3 #24711).
- Depth 1. If the user raises `max_depth`, each child server gets its own
  token scoped to its subtree, the ancestor chain is checked on every
  delegate (a cycle, an agent already in its own chain with the same task
  hash, is refused with `depth_exceeded`), and budgets are charged to the
  root lead.
- No child-to-lead tool access: children cannot message, read or cancel
  their lead.
- No permission laundering: approval mode start, never broader than the
  lead, answers user only, no `auto`.

### 7. Cost controls

Per-lead totals summed across children (`max_lead_turns` 60,
`max_lead_tokens`, now also `max_lead_seconds` default 3600 and
`max_lead_cost` when reported), `max_delegations` 8, `max_concurrent` 4,
per-task budgets lower only, group budgets for `delegate_many`. Child usage
is written to the child's session metadata usage buckets (0012) with the
`parent` link, so the Usage page attributes it and can roll it up per lead.

### 8. Observability and UI

Every call shows in the lead's feed: a delegation card per task, a group
card for `delegate_many`, a wait card listing what it waits on, a
read-only badge on second opinions, the worktree path when used. The
protocol log carries every MCP request with the token redacted. UI work:
the Agents page child tree under each lead (0011 phase 6), a task list tab
(filter by status, lost tasks visible), blocked-on-you markers, and the
per-lead roll-up on the Usage page.

### 9. MCP features

Use: `outputSchema` and `structuredContent` on every tool, `resource_link`
for artifacts and deliverables, `notifications/progress` on `wait`, tool
annotations. Not used: `notifications/tools/list_changed` (needs the GET
stream Span answers 405; the tool list is fixed per server), and the
experimental MCP tasks primitive of 2025-11-25 until agent clients are
shown to support it.

### 10. Comparison

| | T3 Code | Span v1 | Span v2 |
|---|---|---|---|
| Fan-out | `create_threads` 1 to 20, top-level, no lineage | one per call | `delegate_many` 2 to 8, shared budget |
| Waiting | `mode: wait`, `t3_thread_wait`, auto wake | `get_result` 30 s polls | `wait` first/all, early return when blocked |
| Durability | SQL projection, replay | memory | metadata plus transcript store, `lost` |
| Credential | hashed, 24 h idle, revoke on release | per lead, dies with server | hashed, 12 h idle, revoke on load and end |
| Context | task only, paginated reads | attachments | `context`, `read_thread` capped 8000 tokens |
| Isolation | `isolation: worktree` | shared | `workspace: worktree` after phase 6 |
| Modes | narrowing enforced | approval start | approval or plan start, never broader |
| Questions | parent may answer | user only | user only, lead told it is blocked |
| Approvals | not routed, #26294 | user only | user only, or `onApproval: fail` |
| Framing | provenance lost (#24711) | framed | framed, Span notices labelled |
| Depth | nested | 1 | 1, cycle checks if raised |

## Migration and tests

v1 schemas only gain optional fields and enum values; v1 calls and results
stay valid. Tests: fixture agents in `crates/acp/tests` for every new tool
and reason (fan-out admission, Span-side queue, group budget cancel, wait
first and all, blocked early return, `onApproval: fail` never answering,
restart to `lost`, `read_thread` cap and scrubbing, cross-lead -32602,
second opinion refusing without plan mode); replay tests from recorded,
scrubbed MCP exchanges with real Claude and Codex clients (0011 phase 7);
an end-to-end smoke with two fixture agents: a lead calls `delegate_many`,
`wait` all, `read_thread`, then the app restarts and `list_tasks` shows the
results and one `lost` task.

## Staged plan

1. Schemas and options, S, `crates/acp`: output schemas, new reasons,
   `effort`, `deliverables`, `onApproval`, `clientRequestId` (after the
   model choice lands).
2. Fan-out and waits, M, `crates/acp`: `delegate_many`, Span-side queue,
   group budgets, `wait`, `task_status`, `list_tasks` in memory.
3. Durability, M, `crates/core` and `apps/desktop`: task records in
   metadata, summaries in the transcript store (needs 0011 phase 1),
   restart to `lost`.
4. Context, M, `crates/acp` and `crates/core`: `context`, `share_context`,
   `read_thread`, `second_opinion` (needs phase 5 plan mode).
5. Credentials and usage, S, `crates/acp`, `crates/core`, `ui`: hashed
   token, expiry, revocation on load, child usage with the parent link.
6. UI, M, `ui`: cards, task list, child tree, Usage roll-up.
7. Worktrees, L, `crates/core` (git), `crates/acp`, `apps/desktop`, `ui`:
   after 0011 phase 6.

## UNVERIFIED

- T3 details come from its doc and source on 2026-10-30; the doc and code
  disagree on tool count, `isolation` and a maximum token lifetime, and
  `Orchestrator.ts` and the full `t3_thread_launch` schema were not read.
- Claude Code subagents, Codex collaboration tools and the OpenCode task
  tool were not researched.
- Whether real agent MCP clients accept 50 second waits with progress,
  `outputSchema`, and resource links is untested (0003 UNVERIFIED stands).
- Whether every agent exposes model and effort as ACP config options, and
  which have an adapter-enforceable plan mode, is unknown.
- MCP tasks primitive support in agent clients was not checked.
- None of this design has run; sizes are estimates.

## Implementation note, 2026-10-30

Stage 1 shipped in `crates/acp/src/tools` (fixture tests in
`crates/acp/tests/tool_server.rs`):

- `delegate` accepts `context` (`files` as resource links inside the
  workspace, at most 20; `notes` at most 20,000 characters, about 5,000
  tokens, framed in the child's task as `<lead-context>` from the lead and
  never the user, with the closing tag defused), `deliverables` (`files` at
  most 20, `format` summary, diff or json; appended to the child's task,
  shown on the delegation card, existing files returned as resource links
  and missing ones as `deliverables.missing` on completion), `workspace`
  (`worktree` fails with `worktree_unavailable`), `onApproval`
  (`ask_user` default, `fail`; `auto` is -32602) and `clientRequestId`
  (at most 256 characters; a repeat with the same arguments, even while the
  first call runs, returns the same task with `retried: true`; the same id
  with other arguments is -32602; a first call that created nothing is
  forgotten so a corrected retry runs).
- `onApproval: "fail"`: a permission request or edit review from the child
  makes Span cancel the turn (the pending request resolves as cancelled,
  no option is selected) and the task fails with `permission_required`.
- New closed reasons: `lost`, `permission_required`, `mode_unavailable`,
  `worktree_unavailable`. `delegate` results add `applied {model, effort,
  workspace}`, `onApproval` and `deliverables`; every delegation tool
  declares an `outputSchema`.

Deviations from this record in stage 1: `context.handoff` is in the schema
but refused with -32602 until the transcript store exists (stage 4 needs
it); `effort` keeps the free string and the `effort_unavailable` error
from the delegate model choice change instead of `applied.effort: null`;
the run tools (a separate feature) did not gain output schemas.
