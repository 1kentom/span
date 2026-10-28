# 0002: Per-agent adapter normalisation

Status: proposed for issue #50. Needs human review before merge.

## Context

Claude Code (claude-agent-acp 0.98.0), Codex (codex-acp 2.3.0), Gemini CLI
(0.67 nightly; the registry pins 0.66.0) and OpenCode (2.2.0) each deviate
from plain ACP. Every quirk below was read from adapter source at a fixed
commit. No live agent was run, so all behaviour is UNVERIFIED against a real
process; the fixtures reproduce the shapes read from source.

## Decisions

### Structure

`crates/acp/src/adapter/`: a `Quirks` trait (every method defaults to no
change), one implementation per agent (`claude.rs`, `codex.rs`, `gemini.rs`,
`opencode.rs`) and `generic.rs`, which changes nothing. `Adapter` (mod.rs)
holds per-session state; `map.rs` turns a normalised update into an
`AgentEvent` for all agents. Adapters annotate updates with a private `_span`
object that the mapper reads into typed fields and strips from `contentJson`.
`service.rs` only calls the adapter.

Detection: `initialize` `agentInfo.name` containing `claude`, `codex`,
`gemini` or `opencode` (case-insensitive); otherwise the same test over the
path components of the launch command and arguments; otherwise generic. The
exact agent names are UNVERIFIED.

`session/new`, `session/load`, `session/prompt`, `session/set_model` and the
config setters are sent as raw JSON (`UntypedMessage`) because the pinned
schema (agent-client-protocol 3.5.0, no unstable features) has no `models`,
no `session/set_model` and no prompt `usage`.

### Gemini

| Quirk | Normalisation | Fixture |
| --- | --- | --- |
| `[MODE_UPDATE] <mode>` message text | chunk dropped, `CurrentMode` emitted | gemini/mode-update |
| legacy `modes`/`models`, no `configOptions` | options `mode` (category mode) and `model` (category model); changes go to `session/set_mode` and unstable `session/set_model` | gemini/legacy-config |
| thought `Warning: ...` | warning `Notice` | gemini/thought-warning |
| thought `**subject**\n...` | `newBlock: true` | gemini/thought-subject |
| tool stays pending after approval | `in_progress` synthesised after an allow outcome | gemini/pending-after-approval |
| `resolve-prompt-*` ids, `read_many_files` before any output | `internal: true` | gemini/internal-resolution |
| basename diff paths, unreliable `_meta.kind` | `diffs[]`: root, then location, else `resolved: false`; `change` from `oldText` only (applies to all agents) | gemini/diff-paths |
| empty shell content | `hint: outputUnavailable` | gemini/shell-empty |
| `session/load` answers before replay ends | load resolves after 750 ms without updates (15 s cap); prompts refused meanwhile | gemini/load-replay |
| `-32000` on new and load; key and gateway in `authenticate` `_meta` | `AuthRequired` from new, load and prompt; `AuthMethodInfo.input`; `agent_authenticate_with` sends `_meta["api-key"]` or `_meta.gateway {baseUrl, headers}`; `_meta` redacted from the protocol log, never stored | gemini/auth-meta |
| `max_turn_requests` also means loop detected | `hint: turnLimitOrLoop` on `Complete` | gemini/turn-limit |
| second prompt silently aborts the first | a busy (or replaying) session never gets a second prompt | gemini/busy-prompt |
| permission then write proposal | `features.doubleApproval: true`, behaviour unchanged | gemini/mode-update |

UNVERIFIED: whether 0.66.0 behaves like 0.67 nightly; the exact `_meta` key
and value shape `authenticate` reads for the key and gateway; the
`read_many_files` title; HTTP status codes as JSON-RPC codes are passed
through as error text, not mapped.

### OpenCode

| Quirk | Normalisation | Fixture |
| --- | --- | --- |
| pending with `rawInput {}` and raw name title; completed omits fields; in_progress repeats | merge per toolCallId (last non-null wins), identical repeats dropped, title `null` plus `hint: toolPending` until in_progress | opencode/tool-merge |
| login is a no-op; auth failure only on prompt (`-32000`) | `AuthRequired` from the prompt path with `hint: runOpencodeAuthLogin`; `opencode-login` marked unsupported and never sent | opencode/auth-prompt |
| `_meta["opencode/retry"]`, `_meta["opencode/compaction"]` | `Notice` with `noticeId` and hint, `NoticeCleared` on `null` | opencode/retry-notice |
| replayed non-text user chunks | `User.attachments` markers (applies to all agents) | opencode/replay-attachments |
| `_meta["opencode/child-session"]` | `parentToolCallId` | opencode/child-session |
| `messageId` on chunks | forwarded; a change sets `newBlock` (all agents) | opencode/message-id |
| `mcpCapabilities` sse false, one SSE server fails `session/new` | SSE removed | opencode/mcp-filter |
| ignores client fs, edits on disk | `features.editsBypassReview: true` | opencode/capabilities |
| slash commands end silently | `hint: noOutputStreamed` | opencode/slash-no-output |
| 5 s cancel drain | Stop deadline 8 s (others stay 5 s) | opencode/stop-deadline |
| not in the registry | `agent_presets()` returns `opencode acp` as a custom command | (unit) |

UNVERIFIED: the shape of the child-session and compaction `_meta` values.
Not done: opting into `opencode/child-session-updates`; a `:` in a toolCallId
is not used to guess a parent. Remote servers being forced to `oauth:false`
is OpenCode's own behaviour and needs nothing here.

### Claude and Codex

| Quirk | Normalisation | Fixture |
| --- | --- | --- |
| Claude drops stdio servers with `type: "stdio"` | `type` removed from stdio servers | claude/mcp-stdio |
| Claude subagent link | `_meta.claudeCode.parentToolUseId` to `parentToolCallId` | claude/subagent-parent |
| Codex fails on SSE or ACP servers | never sent, even when advertised | codex/mcp-filter |
| Codex image generation | `images[]` and `savedPath` (reported only, never opened) | codex/image-generation |

Not done: `clientCapabilities.subagents` needs the crate's
`unstable_subagents` feature, which is off; enabling it also makes the agent
send update kinds Span does not render. The Codex subagent link form is not
in the supplied evidence, so only the Claude and OpenCode forms are read.

### All agents

- MCP servers (`AgentService::set_mcp_servers`) are gated by advertised
  `mcpCapabilities` before every `session/new` and `session/load`
  (generic/mcp-gating).
- `Permission` forwards `toolKind`, `rawInput`, `content`, `locations`,
  `diffs`, `meta` and `internal` (generic/permission-details).
- `Complete` carries `usage` and `meta` (generic/complete-usage).
- `Tool` carries typed `rawInput`, `rawOutput`, `locations`, `diffs`,
  `images`, `savedPath`, `internal` and `hint` (generic/tool-fields).
- A `tool_call` without a status is reported as `pending`.
- No agent sends `reject_always`; the backend forwards only offered options.
- Unknown agents are not rewritten (generic/unchanged).

UI strings for hints are not sent: `AgentHint` is a typed enum with the
suggested English in its doc comments.

## Consequences

All new event fields are optional, so the TypeScript change is additive; the
one new variant is `noticeCleared`. Rust code that destructures `Text`,
`Thought`, `User` or `Complete` exhaustively needs `..`. A live run of each
agent is still needed to confirm every row above.

## Live run findings

A live probe (`crates/acp/examples/live_probe.rs`) ran Span's client against
claude-agent-acp 0.98.0, codex-acp 2.3.0, OpenCode 2.0.32 and gemini-cli
0.46.0. The fixtures below copy sanitised shapes from those captures; the
fixes were verified against the fixtures, not by a second live run.

| Finding | Change | Fixture or test |
| --- | --- | --- |
| `connect` returned before `Ready` reached the manager, so `open_lead` saw no features | `Ready` and `Capabilities` are emitted before `AgentService::start` resolves | tool_server `open_lead_right_after_connect_always_sees_features` |
| Codex `session/list` returns empty pages that still carry a cursor | the cursor is followed until null, a repeat, 50 pages or 100 sessions, within 30 s overall (20 s per page) | codex/list-empty-pages |
| Bypass modes are silent | a warning `Notice` (`noticeId` `span/permission-bypass`, hint `permissionsBypassed`, title the mode's name) while a mode option or current mode is `bypassPermissions`, `agent-full-access`, `yolo` or `never`; `NoticeCleared` when it becomes safe | claude/bypass-mode, codex/full-access-mode, gemini/yolo-mode, opencode/reject-cancelled (none raised) |
| Claude keeps listing a deleted session | ids deleted by the user are hidden from `list_sessions` for the connection; a notice with hint `deletedStillListed` names the session once | claude/delete-still-listed |
| OpenCode ends a turn `cancelled` after a rejection | `Complete.hint` `rejectedByUser` when the user rejected a permission or edit in the turn and did not press Stop | opencode/reject-cancelled |
| MCP tool calls lose kind `other` | a `tool_call` without `kind` is reported as `other` | claude/mcp-tool-kind |
| `_auth/status_update` carries the account email and plan | params of `_auth/*` methods are redacted from the protocol log | claude/auth-status-redacted |
| Doubled "Authentication required" prefix | added only when the agent's text lacks it | opencode/auth-default-model |
| OpenCode default model unsigned while others work | hint `runOpencodeAuthLoginOrSwitchModel` when the model option offers another model | opencode/auth-default-model |
| Gemini `-32000` carries an account tier notice | `AuthRequired.agentMessage` holds the agent's text when it does not read as a sign-in request; `vertex-ai` (no `_meta` input) is unsupported with hint `needsEnvironmentSetup` | gemini/unsupported-client |
| Codex `session_info_update` with only `_meta` | no `SessionInfo` event | codex/thread-status |
| Claude replays `[Request interrupted by user]` | info notice with hint `interruptedByUser` | claude/interrupted-replay |

Not changed: Codex notices name files under the user's home directory. They
are shown only to that user, name the file to fix, and the same paths are in
the protocol log, so they are left as sent.
