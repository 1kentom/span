# 0015: Permission modes per thread

Status: accepted, 2026-10-30. Implements decision d and the plan mode and
permission matrix items of phase 5 of 0011 (agent mode). Builds on 0003
(user-only answers, children start in the approval mode, PR #191) and the
start-mode policy of PR #129 (`agents.startMode.<agent>`: `approval` or
`agentDefault`).

## Context

Each agent exposes its own approval controls over ACP: Claude Code a mode
option (`default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`),
codex-acp approval and sandbox presets (`read-only`, `workspace-write`,
`agent` (Auto review), `agent-full-access`) plus a collaboration mode
(`default`, `plan`), Gemini CLI legacy modes (`default`, `autoEdit`,
`yolo`), OpenCode its `build` and `plan` agents. Before this record the
composer showed those raw values and Span only changed a bypass mode back
at session start.

Research, from public sources only (UNVERIFIED): T3 Code
(`docs/user/permission-modes.md`, `runtimeModeConfig.ts`) offers
Supervised, Auto-accept edits, Auto and Full access, with per-provider
supported-mode declarations and a downgrade to Supervised, plus an
interaction mode default or plan. Its open issues are the test ideas used
here: plan mode performing writes before approval (#3744), Claude Auto plus
Plan silently approving writes (#15503), OpenCode Auto ignoring user rules
(#11458), Codex resetting sandbox network access (#13987), new threads
losing the last mode (#6508). Zed's per-tool allow, deny and confirm rules
and Roo's auto-approve matrix were read as UX references; neither is copied.

## Decisions

### a. Span modes, owned by Span

`ThreadPermissionMode` in `crates/core/src/permission_mode.rs`: `ask` (Ask
every time), `acceptEdits` (Accept edits), `plan` (Plan, read only),
`auto` (Auto, safe commands), `full` (Full access). Pure and tested:
`supported_modes(agent)`, `map_to_agent(agent, mode)` (the agent settings
to apply), `from_agent` (the reverse, for `agentDefault`), `downgrade`
(unsupported falls back to Ask, never looser), `allowed_for_child`,
`initial_mode` and the Shift+Tab `cycle_next`.

Mapping. For the modes Span answers itself (Ask, Accept edits, Auto) the
agent stays in its approval mode so it keeps asking: Claude `default`,
Codex `agent` (the approval mode chosen in PR #129) with collaboration
`default`, Gemini `default`, OpenCode `build`, an unknown agent unchanged.
Plan: Claude `plan`, Codex `read-only` plus collaboration `plan`, OpenCode
`plan`; Gemini and unknown agents have no plan mode, so Plan is not offered
there. Full: Claude `bypassPermissions`, Codex `agent-full-access`, Gemini
`yolo`; OpenCode and unknown agents keep their mode and Span allows what
they ask. A mode whose agent setting the session does not offer is removed
from that session's list.

### b. Enforcement at the adapter

In `crates/acp` the permission handler asks `permission_policy::decide`
(`crates/core/src/permission_policy.rs`) before anything else, including a
remembered "always" answer, so Plan refuses a write that was allowed for
good earlier (the #15503 class):

- Ask: everything prompts (unchanged).
- Plan: edit, delete, move, execute, mode switches and unknown tools are
  answered reject once with reason `plan_mode_read_only`, without a
  prompt; read, search, fetch and think prompt as before. Claude's
  ExitPlanMode (a `switch_mode` request) is refused the same way and its
  plan becomes the Plan ready card.
- Accept edits: an edit whose paths are all inside the workspace (lexical
  normalisation, symlinks of existing parents resolved, `.git` excluded)
  and that carries no command is allowed once; everything else prompts.
- Auto: Accept edits plus commands on a small exact allowlist (`git
  status`, `git diff`, `git log` with listed flags, `ls`, `cat`, `rg` with
  listed flags and paths inside the workspace, `cargo check`, `cargo test`
  with listed flags, `pnpm test`, `pnpm typecheck`, `npm test`). Any shell
  syntax (pipes, redirections, separators, substitution, quotes, globs,
  variables), env assignment or unlisted flag prompts. Auto includes Accept
  edits because it sits after it in the order; that is a choice of this
  record.
- Full: allowed without a prompt, every request logged.

Every request Span answers itself is sent to the UI as `permissionAuto`
and shown in the feed ("Blocked in Plan mode: ...", "Allowed by Accept
edits: ..."). Span picks `allow_once` or `reject_once` only, never an
"always" option, so the agent never remembers a Span answer.

After a session starts, is restored, or changes mode, Span reads the
agent's reported options back. If the agent reports another value than the
Span mode needs (it switched itself, or reset a preset), the adapter emits
`modeMismatch`, keeps answering by the Span mode, and sets the agent back
once; `modeMismatch` with `resolved` true follows when the agent reports the
right value. The UI shows a banner until then. Nothing silently proceeds in
a looser mode.

### c. Who may set a mode

- Only the user: `agent_set_permission_mode` and its keyed form, called
  from the mode popover, Shift+Tab, the Plan ready card, the banner's retry
  and restores of the user's own earlier choice. No MCP tool, MCP method or
  ACP request changes a mode or answers a permission; a test drives the
  span-agents server with every such name.
- `session/set_config` on an option a Span mode manages goes through the
  thread's mode: a value that stands for Plan (narrower) or for the current
  mode is applied as that Span mode, anything else is refused. That keeps
  the delegate tool's existing "plan or read-only only" argument for a
  child it starts, and nothing reachable from an agent can loosen a thread.
- Delegated children and hidden sessions start in Ask and can only be Ask
  or Plan, whatever the lead runs in and whatever `agentDefault` says.
- Workspace settings cannot set a mode (`agents.startMode` stays user
  only, 0003 section 6).
- Full access asks for confirmation the first time per thread in the UI.

### d. Defaults and memory

New threads start in Ask. With `agents.startMode.<agent> = agentDefault`
the thread starts in the Span mode the agent's own setting stands for, and
the agent is left as it is. The mode is stored by name only in the session
metadata store (`permissionMode`, unknown names read as absent) and
restored with the thread. The owner's remembered config per agent
(`ui/src/lib/last-config.ts`) keeps restoring everything including Full
(a value remembered before this record, such as `bypassPermissions`, comes
back as Full); the raw mode option is no longer restored by itself. The
active mode is always visible in the composer chip.

## Consequences

- The agent's raw mode option is hidden from the popover for known agents;
  Span's five modes replace it. Unknown agents keep their own options too.
- Codex in Ask runs in Auto review, which lets Codex itself decide which
  actions need approval (PR #129); Span's Ask can only prompt for what the
  agent asks. OpenCode in Ask asks what its own permission configuration
  says. Both are said in the UNVERIFIED section.
- Accept edits and Auto auto-answer only requests the agent sends: an agent
  whose own tools write without asking is not stopped by them.

## UNVERIFIED

- No live Claude Code, Codex, Gemini CLI or OpenCode session was run. Mode
  ids, the ExitPlanMode `switch_mode` shape and the reset shapes come from
  earlier live captures (sanitised fixtures) and source reading; the
  mismatch fixtures for each agent are constructed.
- No native window was seen. The UI is covered by jsdom component tests
  and `tsc`; the native pass is the checklist section "Permission modes".
- Whether Claude keeps planning or ends its turn after Span rejects
  ExitPlanMode.
- Whether Codex in `read-only` with the plan collaboration mode never
  writes without asking, and whether Auto review asks for every write.
- Path containment is lexical plus resolution of existing parents; a
  symlink created after the check, or a hard link, is not seen.
- T3 Code, Zed and Roo were read from public sources on 2026-10-30, not
  run.
