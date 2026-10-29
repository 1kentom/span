# 0010: Agent health check

Status: proposed. Builds on 0001 (session manager), 0003 section 8 and
0009 (background connections of installed agents).

## Context

A running agent can stop answering without its process exiting: a
signed-out account, a stuck adapter, a provider outage. Span only finds out
when the user sends a prompt or a lead delegates to it. With warm starts and
delegation, several agents run per folder, and the user wants to see which
of them would answer before picking one.

## Decision

- `HealthMonitor` (`crates/acp/src/health.rs`) checks the installed agents
  that are running in the background map (`BackgroundAgents::connected`):
  warm starts, on-demand starts, and the chat's own agent when it is
  installed. It never starts an agent; an agent that is not running is not
  checked and has no result.
- One check is one prompt, exactly `Health check. Reply with exactly one
  word: OK`, with no tools offered (no MCP servers), over a hidden session
  Span creates with `session/new` (cwd is the workspace) through
  `AgentService::new_hidden_session`. The first reply text counts: the turn
  is cancelled then. Any reply counts as Live, even when it is not exactly
  "OK"; only the reply arriving matters. Every permission request of a check
  turn is rejected (the first `reject*` option, else cancelled), every input
  request is cancelled, an edit proposal cancels the turn.
- Result per agent: `live` (latency in ms), `slow` (latency over 8 s),
  `signedOut` (the agent answered `-32000` authentication required, on
  `session/new` or the prompt), `unreachable` (process exited, 30 second
  timeout, protocol error), with `checkedAtMs` and a `detail` for failures.
  A failure other than sign-in is retried once after 20 s before it is
  recorded as unreachable.
- Schedule (`HealthPolicy`, scaled down in tests): an agent is first checked
  30 s after it appears, then every 5 minutes. It is skipped while any of
  its sessions runs a turn, has queued follow-ups or waits for the user, and
  while it had chat activity in the last 5 minutes. Activity is any change
  of its session states in the session manager (a turn started or ended, a
  request was raised or answered, a session was opened), recorded by
  `SessionManager::last_activity`; a chat turn therefore postpones the next
  check by 5 minutes.
- No check runs before the window is shown: the UI's first `agent_health()`
  call starts the periodic checks, on the animation frame after the agent
  panel loaded its installed list (the same moment as the warm start).
- The hidden session never reaches the user:
  - its events are diverted inside `AgentService` (from its `Session` event
    on) to the monitor only, so the chat, the session manager, session
    state events and the metadata store (which the UI writes from events)
    never see it; it is never adopted by the session manager;
  - a sign-in failure of a hidden `session/new` or prompt raises no
    `AuthRequired` card and leaves the connection's `auth_required` flag
    alone;
  - `list_sessions` (and so `agent_list_sessions` and
    `agent_list_all_sessions`) drops every hidden id recorded in this
    process (a process wide set, so a reconnect of the same agent still
    hides it) and every session titled with the check prompt (a hidden
    session left over from an earlier run of Span by an agent that cannot
    close or delete it);
  - an ignored Stop on it ends only its turn, never the connection.
- After each check the hidden session is closed (`session/close`) when the
  agent advertises it, else deleted (`session/delete`) when advertised, so
  it does not pile up in the agent's own history. When neither is
  advertised the one hidden session is reused for every check on that
  connection. App exit stops the monitor and closes or deletes what is still
  held, bounded to 3 seconds.
- Setting `agents.healthCheck`, default true, honoured only from the user's
  own settings file (`USER_ONLY`), like `agents.warmStart`: a cloned
  repository must not make Span prompt agents. Settings > Agents has the
  switch "Check agents in the background". Off means no checks and no dots;
  `agent_health()` returns nothing while it is off.
- IPC: `agent_health()` returns the latest results; `AgentHealthChanged`
  carries the full result list whenever one changes (or an agent stopped
  and its result was dropped).
- UI: a health dot on each installed agent in the agent popover and on the
  connect screen's Found rows (green live, amber slow, red-ish unreachable,
  grey signed out or not checked), with a tooltip such as "Replied OK in
  1.2 s, 4 min ago" or "No reply, checked 2 min ago". The "Live agents"
  strip stacks on the prompt box like the plan drawer and shows only when
  more than one agent is involved in the open chat: the lead, the agents it
  delegated to (feed delegation cards) and the agents of earlier segments of
  the thread (session metadata). Each entry has brand, name, state (Working,
  Waiting for you, Idle, Done, Starting) and its dot; a delegated entry
  scrolls to and focuses its delegation card. Dots fade between states and
  do not animate under `prefers-reduced-motion`.

## Cost

Each check is one tiny prompt per idle, running agent every 5 minutes: with
four warm agents and no chatting, about 48 prompts an hour, each a few dozen
tokens in and one word out, billed to that agent's account or plan like any
prompt. Agents that are chatting are not checked. Turn the setting off to
stop it.

## Tests

- `crates/acp/tests/health.rs` (real Node fixture agents, scaled policy):
  live with latency, slow, silent agent unreachable after one retry (two
  check prompts, connection still usable), auth required is signed out
  without a sign-in card, running turn and recent chat skipped and
  postponed, hidden session never listed and reused when close and delete
  are missing, closed when `session/close` is advertised, deleted when only
  `session/delete` is, permission requests rejected, nothing started for a
  check, a warm agent checked on schedule by the running monitor, setting
  off sends nothing.
- `crates/core/tests/preferences.rs`:
  `agent_health_check_is_on_by_default_and_honoured_only_from_user_settings`.
- UI: `AgentHealth.test.tsx` (wording, dots, popover and Found rows, strip
  only for multi-agent chats, child opens its task), `AgentStartSettings.test.tsx`,
  `preview-settings.test.ts`.

## UNVERIFIED

- Not run against real agents in the desktop app: how each real adapter
  titles, lists, closes or deletes the hidden session; whether every agent
  accepts a second concurrent session while the user's chat is idle; real
  reply latencies against the 8 second slow threshold.
- Agents connected by a custom command that is not installed are not in the
  background map and are not checked.
- The protocol debug log (`AgentEvent::Log`) still shows the check's
  JSON-RPC lines.

## Amendment 2026-10-29: one reused session per connection

The first version flooded History: when an agent advertised
`session/close` (or `session/delete`) the check closed its hidden session
after every check, so the next check opened a new one with `session/new`.
Real agents keep closed sessions in their own history, and the title filter
required the whole prompt while agents cut long titles (for example
"Health check. Reply with exactly one word..."), so dozens of check rows
reached History. Changed:

- One hidden session per agent connection, created on the first check and
  prompted again (same one word prompt) by every later check. A check never
  calls `session/new` otherwise. Nothing is closed or deleted after a
  check. When the agent rejects the kept session (an error answer to the
  prompt, for example after its state was reset) one replacement is created
  in the same attempt and stored instead. A new connection (agent restart)
  gets its own session on its first check. Idle only, the schedule, the
  states and timeouts are unchanged; a chat turn in the last interval still
  skips the check, since a successful turn already proves liveness.
- Filtered everywhere: listings (`agent_list_sessions`,
  `agent_list_all_sessions`) drop sessions recorded as hidden in this
  process, ids remembered from earlier runs (the ledger,
  `agent-health-sessions.json` in the app data folder, at most 500 ids per
  list per agent), and every session whose title starts with
  `Health check. Reply with exactly one word` (`HEALTH_TITLE_PREFIX`;
  strict prefix after leading whitespace, case sensitive, so a chat such as
  "Health check of the CI pipeline" stays). Filtering happens page by page,
  so check sessions no longer use up the 100 session cap. The UI history
  store applies the same title filter. `session/load` refuses a hidden id
  (resume last chat cannot pick one), `session_meta_update` refuses one and
  `session_meta_list` leaves out stored entries for one. They are never in
  the session manager, so never in session state counters or the Live
  agents strip.
- Cleanup: once per agent per run, `first_check` after the agent is first
  seen by a scheduled round, a background task deletes leftover health
  sessions (listed by remembered id or by title in every folder, plus
  remembered ids the agent no longer lists) with `session/delete`, only
  when the agent advertises it (ADR 0001 gating). At most 20 per run, one
  every 2 seconds, never the session in use, stopping while a user turn
  runs. Every id the agent answered for is recorded in the ledger, so the
  cleanup is idempotent and continues on the next run. `session/close` is
  not used for cleanup: it cannot remove a session from the agent's
  history and is only accepted for sessions held on the connection. Agents
  without delete rely on the filter. App exit deletes the session in use
  where delete is advertised, else closes it.
- No cheaper liveness request exists in the protocol version Span speaks
  (no ping method), so none is used.

Tests: `crates/acp/tests/health.rs` adds N consecutive checks creating one
session and prompting it N times (plain, with close, with close and
delete), a rejected session replaced once and the replacement reused,
listings without health sessions including old style truncated titles and
near miss chats, strict title matching with near misses, cleanup capped,
idempotent and limited to health sessions, cleanup without delete, ledger
across runs. `apps/desktop/src/session_meta.rs` tests metadata refusal;
`ui/src/lib/agent-stores/history.test.ts` tests History hiding health
sessions while near miss titles stay.

UNVERIFIED: not run in a native window or against a real agent: whether
each real agent accepts repeated prompts on one session for hours, how
long a reused session's context grows (each check adds one short exchange),
whether real agents honour `session/delete` for sessions not loaded on the
connection, and the cleanup against a real History with dozens of
leftovers. The previous section's close and delete after each check no
longer applies.

