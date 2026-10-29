# 0001: Session manager for concurrent agent connections

Status: accepted for issue #51. Groundwork for #52 (delegation tool server)
and #53 (guardrails).

## Context

The desktop backend held one `ActiveAgent`: one `AgentService` (one agent
process) and one current session. Delegation needs several agent processes
at once, sessions that belong to other sessions, and a guarantee that work
started by an agent stops when the work that started it stops. The existing
UI consumes `AgentEvent`s for a single agent and must keep working
unchanged, and another agent is about to change the ACP adapters in
`crates/acp/src/service.rs`.

## Decisions

### 1. A manager above `AgentService`, not inside it

`SessionManager` (`crates/acp/src/manager.rs`) owns N connections, one
`AgentService` per agent command, and a map of sessions keyed by
`SessionKey { connectionId, sessionId }`. `service.rs` is unchanged: each
service already supports several sessions on one process, so the manager
only adds bookkeeping and policy.

Consequence: adapter work in `service.rs` does not conflict with the
manager. The cost is that some per-session state (running, cancelled) is
tracked in both layers; the service stays authoritative for protocol state,
the manager for queueing and the session tree.

### 2. Session keys always include the connection id

Agent session ids are only unique within one process (two fixture agents
both hand out `fixture-1`). Permission and elicitation request ids are also
per process (`permission-1`). Every manager API and every pending request is
keyed by connection id plus the agent's id.

### 3. Event identity: a wrapper event, `AgentEvent` unchanged

`AgentEvent` and the generated TypeScript bindings are unchanged. The
manager emits `SessionEvent { connectionId, agentName, sessionId, event }`
to its own sink for every connection. A connection can also be given a
`direct` sink that receives the unwrapped `AgentEvent`s; the desktop passes
the existing Tauri channel there for the primary connection, so the current
sidebar sees exactly what it saw before.

Rejected: adding `connectionId` to every `AgentEvent` variant. It changes
every generated type the UI matches on, and the existing UI has no use for
it while it only shows one agent.

`agentName` is the name the agent reported in `initialize`, falling back to
the launch script or command name. `sessionId` is `None` for connection
level events (`Ready`, `Status`, `Log`, `Error`, `Capabilities`,
`AuthRequired`, `ElicitationComplete`); `ElicitationResolved` gets its
session from the matching pending request.

The wrapper is not exported to TypeScript yet because no command or event
carries it. When the UI shows several agents, register it as a tauri-specta
event or channel type and the bindings follow.

Update (2026-10-29): the UI now shows background agents (warm starts of
0009, health dots and the live agents strip of 0010, delegated children of
0003), so "only shows one agent" no longer holds, though those surfaces
still arrive through dedicated events rather than this wrapper. Agent mode
(0011) will show many sessions at once; its phase 1 registers the wrapper
with tauri-specta and keys commands by `SessionKey`.

### 4. One prompt in flight per session, FIFO follow-ups

`SessionManager::prompt` starts the turn if the session is idle, otherwise
appends it to the session's queue. A driver task runs queued turns in order
after each turn finishes. The returned future resolves when that prompt's
own turn finishes; dropping it does not withdraw the prompt. Requires a
Tokio runtime (Tauri's async runtime is Tokio).

`agent_prompt` goes through `SessionManager::start_turn`: an idle session
starts the turn, a busy one refuses it with the typed `PromptError::Busy`
(nothing is sent or queued) so the UI offers steer or queue instead of an
error card. A session also counts as busy while its agent still runs a turn
the manager did not start. A prompt that arrives after the turn reported its
end, but before the driver collected it, runs next instead of being refused.
Queueing applies to prompts sent through `prompt` and `enqueue` (delegation).

### 4a. Session runtime state is published, not inferred

The manager derives each session's runtime state (`idle`, `running`,
`waitingForApproval`, `waitingForAnswer`, queued count, when the turn started
and its newest unfinished tool title) and publishes the states of a
connection whenever one changes (`watch_states`). The desktop forwards them as
the `AgentSessionStatesChanged` event and answers `agent_session_states` with
the active connection's snapshot. `agent_resume_session` skips `session/load`
for a held session that is still working, so reopening it never replays over
a live turn. Closing a session that runs a turn stops that turn first (the
usual Stop and deadline), so no work keeps running untracked.

### 5. Session tree and cascades

Each session records `parent`, `depth` (0 for a root) and `origin` (`user`
or `delegated`). A child is only registered if its parent still exists when
the agent finishes creating it; otherwise it is cancelled and closed.

- `cancel(key)`: drops queued follow-ups for the session and every
  descendant, sends Stop to the descendants (deepest first) and then the
  session. Each connection applies the existing five second Stop deadline
  and terminates an unresponsive agent. Sessions stay open.
- `close(key)` and `delete(key)`: cancel descendants first, then close or
  delete the session on its agent. On success, descendants are cancelled,
  closed best effort (agents without `session/close` keep an idle session)
  and forgotten. On failure they stay registered, already cancelled.
- `disconnect(connection)`: forgets every session on the connection and
  every descendant on other connections, cancels those descendants, then
  shuts the process down. Returns the shutdown result as before.
- The process exiting on its own has the same cascade. The connection entry
  stays (marked closed, refusing new sessions) until `disconnect`, so the
  desktop's existing disconnect semantics hold.

Consequence: a child never outlives its root, across processes.

### 6. Answers to agent requests are user only

Permission and elicitation answers, and edit review, are reachable only
through `SessionManager` (and `AgentService` behind it), which only the
desktop holds. Agents get `AgentControl`, scoped to one caller session: it
can delegate a child, message, cancel and list sessions below the caller,
and has no method that answers a request. #52's tool server is meant to
receive only an `AgentControl`.

`SessionManager::respond_permission` checks the full key, so the same
session id on another connection cannot answer. `pending_requests()` lists
every waiting request with connection id, agent name and session id for the
UI.

A test (`child_permission_carries_identity_and_only_the_user_can_answer_it`)
drives every `AgentControl` path while a child's permission is pending and
shows it stays pending until the user answers.

## Consequences and follow-ups

- #52 builds the MCP tool server on `AgentControl`: `delegate`, `message`,
  `cancel`, `children`. It still needs a task id, result capture (stop
  reason and text from the `SessionEvent` stream) and progress.
- #53 adds the depth limit (depth is recorded, not enforced), budgets from
  `Usage` events, and routing child edit proposals through the same review.
  Child proposals already reach the user as `Proposal` events tagged by the
  wrapper, but nothing shows non-primary events in the UI yet.
- The desktop registers sessions it creates on the primary connection, so
  `agent_cancel`, `agent_close_session`, `agent_delete_session` and
  `agent_disconnect` cascade to any children. No new Tauri commands.
