# 0003: span-agents MCP tool server

Status: shipped (originally proposed) for issue #52 (tool server) with the
guardrails of #53 and the `record_decision` tool of #54. Builds on 0001
(session manager). Shipped in the desktop behind `agents.delegation.enabled`,
default on (section 6); not yet verified against real agents (see
UNVERIFIED). The UI setting for `max_depth` (section 4) is not built.
Status updated 2026-10-29; agent mode (0011) builds on this record.

## Context

ACP defines no agent-to-agent messaging, so Span brokers delegation. A lead
agent needs tools to find other agents, start work on them, poll for the
result, follow up, stop them and record decisions. ACP lets a client offer
MCP servers in `session/new` `mcpServers`: stdio is mandatory for every
agent, HTTP and SSE only when the agent advertises `mcpCapabilities.http` or
`.sse`. MCP-over-ACP and proxy chains are draft RFDs, not stable.

Constraints: logic lives in `crates/acp`; no new direct dependencies; the
server must never be able to answer a permission, elicitation or edit
review; delegated work must never outlive the lead.

## Decisions

### 1. Transport: in-process MCP Streamable HTTP on loopback

The server runs inside Span on `127.0.0.1`, random port, path `/mcp`, one
server per lead session. It is offered as an ACP `McpServer::Http` entry
whose only header is `Authorization: Bearer <token>`.

- Rejected, stdio: the agent would launch a second process that then has to
  reach back into Span (a socket or pipe plus its own auth), which is the
  same loopback problem with an extra process and lifecycle to manage.
- Rejected, HTTP+SSE (MCP 2024-11-05): deprecated since MCP 2025-03-26.
  Agents that advertise only `sse` do not get the server.
- Gating: `transport_for(features)` uses the lead's advertised
  `mcpCapabilities`. Without `http`, `ToolServer::start` refuses with a
  reason for the UI (tested for none, sse only, http). Claude, Codex, Gemini
  and OpenCode advertise `http` according to their adapter source
  (UNVERIFIED against live agents in this change).

Security:

- Binds `127.0.0.1` only and drops non-loopback peers.
- 32 random bytes (64 hex chars) per server, so per lead session. Source:
  the OS CSPRNG through `getrandom`. Without it the server does not
  start; there is no weaker fallback.
- Every request needs the exact `Bearer` token (constant time compare),
  else 401. A present `Origin` other than the server's own is 403, and
  `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
- The token is never logged by the server and `Debug` hides it. It does
  travel inside `session/new` and `session/load`; `redact_log` removes
  `mcpServers` from the protocol log the UI receives.
- Nothing is written to disk. Tokens, tasks and decisions live in memory
  and die with the server.

MCP revision targeted: **2025-11-25**, the last initialize-based revision
(https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
also accepting `2025-06-18` and `2025-03-26` in `initialize` and in the
`MCP-Protocol-Version` header. The current revision on
modelcontextprotocol.io is 2026-07-28 (sessionless, per-request `_meta`,
`server/discover`). It is not implemented: deployed agent MCP clients are
expected to speak the initialize-based revisions (UNVERIFIED). A request
declaring an unsupported version gets HTTP 400 with JSON-RPC code -32600
(not the modern -32022), which the 2026-07-28 compatibility rules make a
dual-era client treat as a legacy server and fall back to `initialize`.

Subset implemented: POST of one JSON-RPC message; `initialize`, `ping`,
`tools/list`, `tools/call`; notifications and responses get 202; GET and
DELETE get 405; batches get 400; unknown methods -32601. `tools/call` with
`_meta.progressToken` and `Accept: text/event-stream` answers on a request
scoped SSE stream: `notifications/progress` (strictly increasing
`progress`), then the response, then the stream ends. Not implemented:
`MCP-Session-Id`, resumability (no event ids are sent, so clients have no
reason to reconnect with `Last-Event-ID`), the priming event, server to
client requests.

HTTP machinery: none of hyper, axum or tiny_http is a direct dependency of
a workspace crate (hyper is only transitive through reqwest). The server is
a small HTTP/1.1 reader over `tokio::net::TcpListener`: request line,
headers (16 KiB cap), `Content-Length` or chunked bodies (1 MiB cap),
`Connection: close` responses. `tokio`'s `net` feature was already
compiled into the workspace through reqwest; `crates/acp/Cargo.toml` now
declares it, which adds no crate (Cargo.lock unchanged by this). SHA-256
and base64 are implemented locally (tested against FIPS 180-4 and RFC 4648
vectors) for the same reason. reqwest, already a direct dependency of
`span-acp`, is the real HTTP client in the tests.

### 2. Tools

Six delegation tools, deterministic order. Full JSON schemas are in
`tool_definitions()` in `crates/acp/src/tools/server.rs`; argument objects
use `additionalProperties: false` and unknown arguments are rejected.

- `list_agents {}`: connected agents with `reported` (the agent's ACP
  `initialize` features, verbatim) and `hinted` (`{source: "span",
  capabilities}`, from `CAPABILITY_HINTS`, currently only `codex ->
  image_generation`, UNVERIFIED), plus installed agents that are not
  running. Every entry has a `state`: `connected` (with `installedId` when
  Span started it for an installed agent), `ready to start`, `starting` or
  `unavailable` (the last start failed; the next delegate retries), and
  `delegable`. Installed agents are delegable when the server has a
  background starter (section 8) and the caller's depth allows; without
  one they keep `state: "not connected"`, `delegable: false`. Also
  `maxDepth`, `callerDepth`, `canDelegate`.
- `delegate {agent, task, attachments?, expect?, saveTo?, budget?}`: creates
  a child session on a connected agent (by connection id or name), queues
  the prompt and returns `{status: "running", taskId, sessionId,
  connectionId, budget}` without waiting for the turn. It does wait for
  `session/new` (bounded by the service's 30 s), well under Codex's
  default MCP `tool_timeout_sec` of 60 s (from Codex docs, UNVERIFIED
  here). Attachments are workspace files sent as ACP `resource_link`s.
  `saveTo` is appended to the prompt and reported as an artifact. An
  installed agent that is not running is started first (section 8); the
  call then also waits for that start, bounded by
  `ToolPolicy::launch_timeout_seconds` (25). `agent` matches a connection
  id first, then an installed id, then a reported agent name.
- `get_result {taskId, waitSeconds <= 30}`: waits until the task finishes or
  the wait ends, sending progress (default every 5 s) when the call has a
  progress token. Returns `queued`/`running` with `progress {activity,
  events, elapsedSeconds, waitingForUser}`, or the final result. Bounded
  waits keep each call under Codex's 60 s default and give Claude's idle
  timer progress to reset on (whether the Claude Agent SDK subprocess
  inherits the 5 min network idle timeout is UNVERIFIED).
- `message {sessionId, connectionId?, text}`: follow-up to a delegated
  child, queued through `SessionManager::enqueue` (FIFO, one prompt per
  session). Returns a new `taskId`.
- `cancel {taskId | sessionId, connectionId?}`: `AgentControl::cancel`,
  which cascades to everything below the child and drops its queue.
- `record_decision {chosen, why, alternatives[]}`: stores a
  `DecisionRecord` in memory and emits `DelegationEvent::Decision`. No other
  effect (tested: no session is created).

The same per-lead MCP endpoint can also offer saved workspace run
configuration tools when the user's separate `agents.runTools.enabled`
setting is on. This setting is off by default and is honoured only from user
settings, never from a cloned workspace. The run tools list and read saved or
detected configurations, propose configuration saves/deletes, start/stop/
restart runs, list runs and read bounded output. Detected configurations are
read only until saved as a copy. When run tools are enabled without delegation,
the server lists only run tools; the delegation setting does not grant process
execution access. Both tool groups require the agent to advertise MCP over
Streamable HTTP.

Every configuration mutation and process action waits for a separate user
approval in Span. Run and Restart resolve the executable, arguments, working
directory and environment once before showing the approval. The approval view
shows that resolved invocation locally, while environment values remain
hidden. After approval, Span checks the active workspace and exact saved
configuration and manifest snapshot, then executes that same prepared plan
through the shared desktop RunService. Execution uses direct argv without an
implicit shell. Agent configuration reads expose environment variable names
only, and agent edits may set a variable only with a `${env:NAME}` reference or
remove it. Expanded environment values are not returned by the MCP tools.
Run output is bounded by the shared service and may contain anything the
process itself prints.

Session ids are only unique per agent process, so results carry both
`sessionId` and `connectionId`; `message` and `cancel` need `connectionId`
only when the id is ambiguous among this lead's children.

### 3. Result shape

`get_result` returns an MCP `CallToolResult`:

1. A text summary first (status line plus the child's reply, truncated at
   4000 characters).
2. One `resource_link` per artifact: `file://` URI of the absolute path,
   `name` = workspace relative path, `mimeType`, `size`. Only paths that
   resolve inside the workspace (symlinks followed) are reported.
3. One inline `image` preview, only when the lead advertised the ACP
   `image` prompt capability and the image is at most 256 KiB (SVG never).
   Using the lead's ACP prompt capability as "accepts images" is a proxy
   (UNVERIFIED that every agent's MCP client forwards images to the model).
4. The structured content serialized as a final text block (spec SHOULD).

`structuredContent`: `{status, taskId, agent, connectionId, sessionId,
stopReason, artifacts: [{path, mimeType, bytes, sha256, source}], usage:
{turns, tokens?, contextSize?, cost?, currency?, elapsedSeconds},
progress?, reason?, detail?}`. `get_result` declares an `outputSchema`
with these fields. Artifacts are the edits the user accepted during the
task plus `saveTo`; `source` is `buffer` when the content is an accepted,
unsaved editor edit (hash of what the user sees), else `disk`.

Failures set `isError: true` with `reason` from a closed set:
`auth_required, permission_rejected, refused, cancelled, output_limit,
agent_unavailable, depth_exceeded, budget_exceeded, timeout`. Mapping:
stop reason `refusal` -> refused, `max_tokens`/`max_turn_requests` ->
output_limit, `cancelled` -> the reason Span stopped it (lead cancel,
budget, timeout, lead ended) or permission_rejected when the user rejected
a permission or edit in that turn, else cancelled; prompt errors with
"Authentication required" -> auth_required, others -> agent_unavailable.
Malformed arguments (empty task, path outside the workspace, unknown
taskId) are JSON-RPC -32602 errors, not tool failures, so the closed set
stays about the delegation.

### 4. Guardrails (#53)

- Depth: `ToolPolicy::max_depth`, default 1 (user session is depth 0, a
  child depth 1, so children cannot delegate). Enforced twice: the tool
  checks the caller's depth, and `AgentControl::delegate_limited` refuses
  atomically at the manager. Children are created without any MCP server,
  so they do not get span-agents at all unless a future change starts one
  for them when `child depth < max_depth`. A user raises the limit by
  constructing the server with a higher `max_depth`; the UI setting for it
  does not exist yet. Tested: recursion from a child fails with
  `depth_exceeded` and creates no grandchild; with `max_depth: 2` it works.
- Budget per delegation (`Budget`, defaults): 20 turns, 30 minute wall
  clock, no token or cost limit by default (the agent's context window
  already bounds context tokens, and cost is rarely reported). A lead may
  only lower limits via `delegate.budget`. Tokens measure what the
  delegation spent (see "Token budget measures spend" below); cost only
  when reported. Checked on every usage event and every policy second
  while a turn runs; over budget, Span cancels the child (cascade) and the
  task fails with `budget_exceeded` or `timeout`. A message beyond the
  turn or token budget is refused with `budget_exceeded`.
- Token budget measures spend (amended). `usage_update.used` is context
  window occupancy, and a fresh agent session already holds roughly 25k
  to 31k tokens of system prompt and tool definitions before the task
  starts. Comparing the peak `used` with `maxTokens` therefore failed every
  small budget at the child's first usage report: a lead asking for
  `maxTokens: 1000` saw "reported 31290 tokens, over the 1000 token
  budget" on tasks that would have answered in seconds. The meter now
  takes the first `used` reading of the delegation as a baseline and
  counts the sum of unstable `PromptResponse.usage.totalTokens` over
  finished turns plus the context growth since the last of them; without
  per-turn totals that is just the growth over the baseline. A
  baseline-only reading counts as nothing, and a compacted context never
  makes the growth negative. A running turn that really exceeds the budget
  is still cancelled with `budget_exceeded` and the detail "used about N
  tokens since it started, over the M token budget". A usage report that
  arrives after the turn's completion was seen never stops or fails that
  task: it stays `completed`, and when the delegation is over its token
  budget its `detail` carries the quiet note "Used about N tokens, over
  the M token budget" (refreshed by later reports while nothing else is
  queued). The UI shows that note on the card and in the Active agents
  tooltip; such a task reads Done and is not counted as failed.
  `usage.tokens` (`UsageReport`, IPC) stays the peak context occupancy for
  the context meter, labelled "in context" on the card; the lead's
  `get_result` `usage` also carries `spentTokens` and `maxTokens`. Budgets
  remain lower only; turn, timeout and cost checks are unchanged. Tests:
  `budget::tests`, `tasks::tests`,
  `a_small_token_budget_measures_spend_not_the_childs_starting_context`,
  `exceeding_a_budget_cancels_the_child_and_reports_it`.
- Cancel cascade: `cancel` goes through the manager. Stopping the lead
  stops its children (0001). When the lead session leaves the manager
  (close, delete, disconnect, process exit), an end hook stops the server
  and cancels its children; dropping the `ToolServer` does the same.
- Permissions and questions: child `session/request_permission` and
  elicitations reach the user through the existing `SessionEvent` path,
  labelled with connection id and agent name. The server holds only an
  `AgentControl`, which has no answering method, and its own subscription
  is read only. A test drives every tool with answer-like arguments, tries
  invented tool and method names, and shows the request stays pending
  until the user answers through `SessionManager`.
- Edits: a child's `fs/write_text_file` becomes an `EditProposal` in the
  same editor review as the lead's (tested: the user accepts it through
  the service's `review_proposal`, then the artifact reports it).
  Agents that write files with their own built-in tools bypass ACP review,
  exactly as a lead would; that is not something Span can intercept.
- One prompt per session: all prompts go through `SessionManager::enqueue`.

### 5. Lifecycle

`ToolServer::start(manager, lead_connection, config)` binds the port and
creates the token before the lead session exists, because the URL goes into
its `session/new`. `bind(manager, lead)` attaches the `AgentControl` once
the agent returned the session id; tools fail with -32603 before that.

## Manager hooks added (crates/acp/src/manager.rs)

`ConnectionInfo` and `connections()` (reported features per connection),
`subscribe()` returning a `Subscription` guard (additional event sink),
`on_session_end()` hooks run after a session leaves the manager,
`enqueue()` (the synchronous half of `prompt`, so tasks are registered in
the order the manager runs them), rejection tracking in
`respond_permission`, and on `AgentControl`: `delegate_limited`,
`enqueue`, `prompt`, `depth`, `session`, `agents`, `permission_rejected`,
`on_caller_end`, `on_session_end`. None of them answers a request.

### 6. Desktop wiring and settings

- Setting: `agents.delegation.enabled`, default true (it was false until
  the connect screen gained the "Agents work together" switch, which
  writes this key to the user settings file). It is honoured only from the
  user's own settings file (`~/.config/span/settings.jsonc`). A workspace
  `.span/settings.jsonc` arrives with a cloned repository, so it must not
  be able to change delegation: core settings merging drops the key from
  workspace settings before merging (a workspace `false` does not turn off
  the default or a user `true`, and a workspace `true` does not override a
  user `false`), and typed saves leave it out of the workspace file. An
  agent cannot change it either: it has no settings write path. The depth
  and budget limits above apply whatever the setting. Unknown keys next to
  it are still rejected. Tested in `crates/core/tests/preferences.rs`
  (`agent_delegation_is_on_by_default_and_honoured_only_from_user_settings`).
- `LeadServers` (`crates/acp/src/tools/host.rs`) owns one server per lead
  session. The desktop opens every user session through it (connect,
  new chat, sign in): with delegation on and an agent that advertises
  `mcpCapabilities.http`, a server is started, its entry is offered in
  that one `session/new` via `new_session_with`, and it is bound once the
  session id is known. Delegated children and other sessions on the
  connection never get the entry. Otherwise the session opens without it
  and `DelegationEvent::Unavailable` carries the reason.
- Load and resume: ACP does not keep MCP servers across `session/load`,
  so restoring a chat with delegation on offers a fresh server and token
  in that load only. If the session already has a running server (loaded
  again while still open), that same entry is offered again so the
  agent's MCP connection keeps working. Turning delegation on applies to
  sessions started or restored afterwards; the status reason says so.
- The server stops when its lead leaves the manager (close, delete,
  disconnect, process exit) and on app exit (`shutdown_all`).
- Commands: `agent_delegation_status` returns `DelegationStatus`
  (setting, availability and reason, lead, attached, tasks, decisions).
  `agent_child_permission(connectionId, sessionId, requestId, optionId)`
  answers a delegated child's permission request through
  `SessionManager::respond_permission`; it refuses sessions whose origin
  is not `Delegated`. It is a Tauri command the UI calls on the user's
  choice; no agent-callable path exists, since the tool server holds only
  an `AgentControl`. Delegation events reach the UI on the agent channel
  as `AgentEvent::Delegation`, so `DelegationEvent` is now in the
  generated bindings.

### 7. UI facing additions (issue #54 follow-up)

Four gaps the delegation UI reported, closed in the backend:

- Ordering: `DelegationEvent::Delegated` is emitted from inside
  `Shared::run_task`, after the task id exists and before the child's
  prompt is queued (`registered` callback, under the same lock that orders
  tasks). No turn event of that task can precede it. Session setup events
  (commands, config) of the child can still arrive earlier, since the
  session exists before the task does. If queueing fails after the event,
  a `TaskFinished` (failed) follows. Test:
  `delegated_is_emitted_before_any_child_event`.
- `DelegationEvent::ChildPermission { lead, child, taskId, agentName,
  connectionId, sessionId, requestId, requestKind }` is emitted when a
  delegated child raises a permission request or an elicitation
  (`requestKind` is `permission` or `elicitation`; `taskId` is the task at
  the front of the child's queue, null if none). The plain `Permission` or
  `Elicitation` agent event is still sent. Answering is unchanged and user
  only: `agent_child_permission` (or `agent_elicitation`). No tool takes a
  request id. Test: `a_child_permission_emits_one_typed_event_that_no_tool_can_answer`.
- `DelegationTask` gained `startedAtMs`, `finishedAtMs`, `progressText`,
  `resultSummary` (first 600 characters of the child's text, finished
  tasks only), `artifacts` (the existing `Artifact` type, finished tasks
  only, read from the workspace at listing time) and `budgetUsed` (the
  existing `UsageReport`). Everything comes from the task tracker;
  `progressText` is the child's last reported activity and is null when it
  reported none, `tokens` is null unless the agent reports usage.
  `budgetUsed` is per delegation (all prompts of that child), not per
  task, and its elapsed seconds keep counting after a task ends. Test:
  `tasks_report_timing_progress_summary_artifacts_and_usage`.
- `agent_cancel_task(taskId)` is a Tauri command, not a tool. It resolves
  the task in the active chat's lead (task ids repeat across leads), marks
  the stop as `cancelled by the user` and cancels the child and every
  session below it through the manager. The task ends as `failed` with
  reason `cancelled` (the UI shows that as cancelled). Finished tasks are
  refused. The span-agents `cancel` tool is unchanged and separate. Test:
  `the_user_can_cancel_one_task_and_the_child_tree_stops`; the cascade to
  descendants is the manager's existing `cancel`, covered by
  `cancel_cascades_and_the_server_ends_with_its_lead`. UI wrapper:
  `agentCancelTask(taskId)` in `ui/src/lib/client.ts`.
  Two guarantees back it. The manager's turn driver is spawned, so a
  cancel could reach the agent before the accepted turn's prompt and be
  dropped (the prompt then reset the cancelled flag and ran to the end).
  `cancel` now bumps a per session epoch and the driver checks it and
  writes the prompt under the same lock, so the prompt is either ahead of
  the cancel or refused ("Cancelled before the turn started"). And a task
  the user cancelled always ends `failed` with reason `cancelled`, even if
  the child's turn completed normally in the same instant, and a later
  report cannot overwrite it. Tests: `a_cancel_right_after_a_prompt_is_never_lost`,
  `a_user_cancel_right_after_delegate_ends_cancelled_not_completed`, and
  the `tools::tasks` unit tests.

### 8. On-demand starts of installed agents (#82)

With delegation on (the user's setting, default on), a lead can delegate
to any installed agent; the user does not connect it first. Turning
delegation on is the consent: no extra dialog, the start is made visible
instead.

- `BackgroundAgents` (`crates/acp/src/background.rs`) keeps one map from
  installed agent id to its connection. A start runs the process and ACP
  `initialize` only, through `SessionManager::connect` with the launch
  command from the agent's install manifest (the same command and PATH
  resolution as the UI's connect). Concurrent requests for one agent share
  one start (`ensure`), so two delegations never spawn two processes. A
  start that outlives the caller's wait keeps going and its connection is
  kept for the next request. A failed start is recorded quietly and the
  next request retries.
- `delegate` to such an agent emits `DelegationEvent::Starting {lead,
  agentId}`, waits for the start, emits `StartFinished {connectionId,
  agentName, launched, reason, detail}`, then opens the child exactly as
  for a connected agent. Failures map to the closed set:
  `agent_unavailable` (not found where Span can run it, or exited),
  `timeout` (no `initialize` within the limit), `auth_required` (the
  child's `session/new` asks for sign-in). The lead's turn keeps working.
- Guardrails are unchanged: the depth check runs before any start, so a
  child at the depth limit starts nothing (tested); budgets, the cancel
  cascade and user-only answering apply to the child as before.
- The background connection never takes over the user's chat. Its events
  go through a router: until the UI makes it the active connection, only
  permission, elicitation and edit proposal events of delegated child
  sessions are forwarded to the UI's agent channel (the child sink); its
  status, identity and log events are kept back. `agent_review` and
  `agent_elicitation` try the active agent first and then the other open
  connections, so the user can answer a background child's edit review or
  question. Proposal ids come from the shared workspace and are unique;
  elicitation ids are per process, so an id pending on both the active and
  a background agent resolves the active one first (UNVERIFIED in a
  running app).
- When the UI connects an installed agent (`agent_connect` with the
  manifest's exact launch command), it goes through the same map and the
  connection is promoted to the UI's channel, replaying the status,
  identity and capability events it missed. A running background process
  is reused instead of starting a second one.
- Background connections end when the folder changes and on app exit.
  Children of a lead end with the lead as before.
- `message` is unchanged: it targets an existing child session, so its
  agent is already running.

Tests (`crates/acp/tests/tool_server.rs`):
`list_agents_reports_installed_agents_as_ready_to_start`,
`delegating_to_an_installed_agent_starts_it_and_returns_the_childs_result`,
`two_simultaneous_delegates_share_one_start`,
`a_failed_start_maps_to_a_closed_reason_and_the_lead_keeps_working`,
`a_child_cannot_start_agents_unless_depth_allows`,
`delegation_off_exposes_no_tool`,
`background_connections_forward_only_child_requests_until_promoted`.

## Resolved blockers

1. Per-session MCP entry: `AgentService::new_session_with` and
   `load_session_with` send the entry in one request only; the desktop
   uses them through `LeadServers`.
2. Token in the protocol log: `redact_log` redacts `mcpServers` in
   `session/new` and `session/load` params.
3. Random source: `getrandom` 0.4.3 (already in Cargo.lock through
   `agent-client-protocol`) is a direct dependency of `span-acp`, approved
   by the user on 2026-10-28. Token creation fails rather than falling
   back when the OS source is unavailable.

## Consequences

- Delegation works end to end in process level tests with fixture agents
  and a real HTTP client, including a Node fixture lead calling `delegate`
  from its own process.
- The HTTP layer is minimal and hand written; anything beyond the subset
  above (sessions, resumability, the 2026-07-28 revision) is new work.
- The UI wrappers (`agentDelegationStatus`, `agentChildPermission` in
  `ui/src/lib/client.ts`) exist; rendering decision and nested agent
  cards is #54.
- The connect screen's "Agents work together" switch writes
  `agents.delegation.enabled` to the user settings file.

## UNVERIFIED

- Nothing here ran against Claude, Codex, Gemini or OpenCode. Whether their
  MCP HTTP clients accept this server (initialize negotiation, the 400
  fallback, SSE progress, `structuredContent`, `resource_link`, inline
  images) is untested.
- Codex `tool_timeout_sec` default 60 s and Claude's idle timeout values
  come from the issue and vendor docs, not from runs.
- The `codex -> image_generation` hint.
- The desktop wiring was not exercised in a running app with a real agent;
  it is covered by `cargo check`, clippy and the crate tests only.
- Time scaling: the "3 minute child" test runs 180 policy seconds with one
  policy second = 10 ms (`ToolPolicy::second`). A real 3 minute wall clock
  run was not done.

## Amendment (2026-10-29): delegated child sessions and thread clutter

A delegated child is a real session in the target agent, so every
`delegate` used to leave one more row in that agent's History list and in
its own resume list (for example `claude --resume`), long after the task.
Session lifecycle policy from now on:

- Lead: created on a user action, reused with `session/load`, closed when
  the user closes the chat.
- Child: created by `delegate` only, reused only through `message` (same
  child session, one turn per task, no `session/new`), ended when idle or
  when its lead ends.
- Health check: one hidden session per connection (ADR 0010), opened
  ephemeral where the agent allows it.
- Background and warm starts: process and `initialize` only, never a
  session; the UI promotes the connection on connect.

What changed:

1. Record. `SessionManager::open_session_with` records every child id the
   moment the agent returns it (`crate::delegated`), per agent name, in the
   app data file `agent-delegated-sessions.json` (same format and atomic
   write as the health ledger, `agent-health-sessions.json`).
2. Hidden from History. `AgentService::list_sessions` drops recorded child
   ids page by page, like health sessions, and `session_meta_list` drops
   their metadata. The UI (`visibleThreadRows`) also drops any session whose
   metadata carries a `parent` link. A child is reached only from its
   delegation card inside the lead's thread.
3. Out of the agent's own history where possible. Children (and health
   sessions) are opened with `AgentService::new_child_session`: for Claude
   it sends `_meta.claudeCode.options.persistSession: false`, which
   claude-agent-acp 0.98.0 spreads into the Agent SDK options (read from the
   adapter source; not run against a live agent). Other adapters send
   nothing extra.
4. Ended. Strictly by recorded id, each at most once (the ledger keeps the
   ended ids): `session/delete` where advertised, else `session/close`.
   - After `ToolPolicy::child_idle_seconds` (600) with no task, the child is
     closed or deleted and marked closed; a later `message` returns
     `agent_unavailable` with "closed after sitting idle ... delegate again".
   - When the lead ends (chat closed, disconnect, server dropped), every
     child is ended, `ToolPolicy::end_gap` (500 ms) apart.
   - On app exit, children still held are ended within 3 seconds.
   - Leftovers of an earlier run (recorded, never ended, not held now) are
     ended once per agent per process when a lead binds on that agent or
     delegates to it, at most 20, `end_gap` apart. Nothing is matched by
     title, so sessions from versions before this amendment (no recorded
     ids) are neither hidden nor ended by this mechanism.
5. Caps per lead, each refused with `budget_exceeded` and a detail that
   tells the lead what to do: `max_delegations` 8 distinct children,
   `max_concurrent` 4 children with a running or queued task,
   `max_lead_turns` 60 prompts across all children, `max_lead_tokens`
   (none by default) measured tokens across all children. The `delegate`
   description tells the lead to use `message` for follow-ups.

Tests: `crates/acp/tests/tool_server.rs` (one `session/new` for five
prompts to one delegation, distinct and concurrent caps, a child hidden from
`session/list` and deleted exactly once when the lead ends, idle close and
the late `message` error, leftover sweep by recorded id only), unit tests in
`tools/tasks.rs`, `service.rs`, `adapter/claude.rs`,
`apps/desktop/src/session_meta.rs`, and the UI tests in
`session-threads.test.ts` and `RestoreLast.test.tsx`.

Unverified: no run against Claude, Codex or another real agent; whether
Claude honours `persistSession: false` for ACP sessions and whether Codex
keeps closed children in its own history were not observed. The desktop
exit path was not exercised in a native window.

