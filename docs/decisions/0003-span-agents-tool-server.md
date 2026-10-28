# 0003: span-agents MCP tool server

Status: proposed for issue #52 (tool server) with the guardrails of #53 and
the `record_decision` tool of #54. Builds on 0001 (session manager).
Wired into the desktop behind `agents.delegation.enabled` (section 6);
not yet run against real agents (see UNVERIFIED).

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

Six tools, deterministic order. Full JSON schemas are in
`tool_definitions()` in `crates/acp/src/tools/server.rs`; argument objects
use `additionalProperties: false` and unknown arguments are rejected.

- `list_agents {}`: connected agents with `reported` (the agent's ACP
  `initialize` features, verbatim) and `hinted` (`{source: "span",
  capabilities}`, from `CAPABILITY_HINTS`, currently only `codex ->
  image_generation`, UNVERIFIED), plus installed but unconnected agents
  (`connected: false`, `delegable: false`). Also `maxDepth`,
  `callerDepth`, `canDelegate`.
- `delegate {agent, task, attachments?, expect?, saveTo?, budget?}`: creates
  a child session on a connected agent (by connection id or name), queues
  the prompt and returns `{status: "running", taskId, sessionId,
  connectionId, budget}` without waiting for the turn. It does wait for
  `session/new` (bounded by the service's 30 s), well under Codex's
  default MCP `tool_timeout_sec` of 60 s (from Codex docs, UNVERIFIED
  here). Attachments are workspace files sent as ACP `resource_link`s.
  `saveTo` is appended to the prompt and reported as an artifact. Installed
  but unconnected agents fail with `agent_unavailable`: starting a process
  stays a user action.
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
  only lower limits via `delegate.budget`. Tokens are the larger of the
  peak `usage_update.used` and the sum of unstable
  `PromptResponse.usage.totalTokens`; cost only when reported. Checked on
  every usage event and every policy second; over budget, Span cancels the
  child (cascade) and the task fails with `budget_exceeded` or `timeout`.
  A message beyond the turn budget is refused with `budget_exceeded`.
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

- Setting: `agents.delegation.enabled`, default false. It is honoured only
  from the user's own settings file (`~/.config/span/settings.jsonc`). A
  workspace `.span/settings.jsonc` arrives with a cloned repository, so it
  must not be able to switch delegation on: core settings merging drops
  the key from workspace settings before merging (a workspace `false`
  does not override a user `true` either), and typed saves leave it out
  of the workspace file. Unknown keys next to it are still rejected.
  Tested in `crates/core/tests/preferences.rs`
  (`agent_delegation_is_off_by_default_and_honoured_only_from_user_settings`).
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
- There is no UI to edit user settings yet, so delegation is turned on by
  editing `~/.config/span/settings.jsonc`.

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
