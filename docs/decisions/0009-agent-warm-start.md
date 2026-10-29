# 0009: Warm start of installed agents

Status: proposed for issue #82. Builds on 0001 (session manager) and 0003
section 8 (on-demand starts).

## Context

Starting an agent process and finishing ACP `initialize` takes seconds
(npm launched adapters more). With delegation on, a lead that delegates to
an installed agent waits for that start inside its tool call, and switching
the chat to another agent waits for it as well.

## Decision

- Setting `agents.warmStart`, default true, honoured only from the user's
  own settings file (`USER_ONLY` in `crates/core/src/settings.rs`, the
  same rule as `agents.delegation.enabled`): a cloned repository must not
  make Span start processes. Settings > Agents has the switch "Start
  installed agents in the background", which writes the user file.
- When the agent panel has loaded the installed list for an open folder,
  the UI calls `agent_warm_start(recent)` on the next animation frame, so
  after the window is shown and painted. The command returns at once.
- The backend orders installed agents by `recent` (agent ids most
  recently used first), then the rest by id, one entry per id, caps the
  list at 4, and starts them one at a time, 300 ms apart, in a tokio task
  through `BackgroundAgents::warm`. A start is the process plus ACP
  `initialize` only: no `session/new`, so no empty sessions and no model
  use.
- It shares the map of 0003 section 8: a delegation or a UI connect that
  arrives while a warm start is mid handshake waits for that start
  instead of spawning a second process.
- A start that fails (not found, crash, timeout) is recorded quietly as
  unavailable: no error card, no feed note. `list_agents` shows it as
  `unavailable` and the next delegation or connect retries.
- The UI switch reuses a warm connection: `agent_connect` with an
  installed agent's exact launch command goes through the map, promotes
  the connection to the UI channel (replaying its status, identity and
  capability events) and only opens the session.
- Warm connections end when the folder changes (`open_workspace`) and on
  app exit. No idle timeout.
- The recently used list is UI-only memory in localStorage
  (`span.agent.recent` in `ui/src/lib/last-session.ts`, at most 8 ids,
  updated on every connect). It holds agent ids only.

## Tests

- `crates/acp/tests/tool_server.rs`:
  `warm_starts_initialize_only_one_at_a_time_and_at_most_the_cap` (cap 4,
  staggered, no session opened, shutdown closes them),
  `a_delegate_during_a_warm_start_waits_for_it` (one process).
- `crates/core/tests/preferences.rs`:
  `agent_warm_start_is_on_by_default_and_honoured_only_from_user_settings`.
- `apps/desktop/src/agents.rs` `warm_order_puts_recent_agents_first_once_each`.
- UI: `WarmStart.test.tsx`, `recent-agents.test.ts`,
  `AgentStartSettings.test.tsx`, `preview-settings.test.ts`.

## UNVERIFIED

- Not run in the desktop app with real agents: startup timing with the
  window shown first, memory use of four idle agent processes, and the
  promoted connection replay in a running UI are covered by tests only.
- Whether every real agent tolerates an `initialize` followed by a long
  idle period before its first `session/new`.
