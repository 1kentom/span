# 0012: Usage page

Status: accepted by the owner on 2026-10-29, who delegated the individual
decisions below and approved them as recorded. Builds on 0003 (span-agents
budget meter), 0005 (session metadata, amended by this record) and 0011
(agent mode). Stage A (counters and page) shipped with this record in
#189; stage B (opt-in local log importers) followed in its own change.

## Context

The owner wants one page that shows what all their agents used: tokens and
cost in dollars, per agent, per model, per session and over time, in the
spirit of T3 Code's usage views.

Span already receives some usage over ACP. `usage_update` (stable ACP v1)
carries `used` and `size` (context window occupancy, not consumption) and an
optional cumulative session `cost {amount, currency}`. The unstable
`PromptResponse.usage` carries `inputTokens`, `outputTokens`, `totalTokens`
and optional `thoughtTokens`, `cachedReadTokens` and `cachedWriteTokens`.
`AgentEvent::Complete` already forwards it. The composer's context meter
(`ui/src/lib/context-usage.ts`) shows these live, and the delegation meter
(`crates/acp/src/tools/budget.rs`, ADR 0003) sums per-turn totals. Nothing
was stored, so no history existed.

### Research findings

Read from public sources on 2026-10-29, not from runs of those products. See
UNVERIFIED for what was not confirmed.

- T3 Code (github.com/pingdotgg/t3code):
  - Plan limits come from provider-specific probes:
    - Claude: the Agent SDK usage control request, with five hour and seven
      day windows, `utilization` and `resets_at`, plus mid-turn rate limit
      events (`apps/server/src/provider/claudeUsageLimits.ts`).
    - Codex: the app-server request `account/rateLimits/read`
      (`codexUsageLimits.ts`).
  - Historical usage comes from an incremental scan of local transcripts
    (`apps/server/src/usage/usageTranscriptReader.ts`,
    `usageScanCache.ts`). It resumes at a byte offset with a hash guard and
    honours `CLAUDE_CONFIG_DIR`. Codex `token_count` events take their model
    from the preceding `turn_context`.
  - Pricing is LiteLLM based with per-model overrides (`usagePricing.ts`).
  - UI: a Usage page (`apps/web/src/components/usage/UsagePage.tsx`,
    `UsageProviderChart.tsx`, `UsagePriceOverrides.tsx`), a composer limits
    banner, and a resume-at-reset banner.
  - Issues show what goes wrong: multi-account limits mixed up (#11515), an
    HTTP 429 shown as "usage limit reached" (#24885), compressed rollouts
    not counted (#25453, #22590), and a resume notice without a time zone
    (#23018). #7338 reports much higher usage through T3 than in the native
    app; the issue has no diagnosis.
- ccusage (github.com/ryoppippi/ccusage, now Rust):
  - Claude Code input: `**/*.jsonl` under each `projects/` folder of
    `CLAUDE_CONFIG_DIR`, `~/.config/claude` or `~/.claude`.
  - Fields read: `message.usage.{input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens}`,
    `message.model`, `message.id`, `requestId`, `timestamp`, `costUSD`.
  - Dedupe is on `message.id` plus `requestId`. Five hour blocks start at
    the first entry floored to the hour.
  - Codex input: `token_count` events under the Codex home `sessions/` and
    `archived_sessions/`, preferring `last_token_usage`, else the difference
    of `total_token_usage`. Fields: `input_tokens`, `cached_input_tokens`,
    `output_tokens`, `reasoning_output_tokens`.
  - Prices: a LiteLLM snapshot with a models.dev fallback.
- Claude Code: `/usage` shows session cost and per-model tokens, and plan
  bars on subscription plans. The only documented machine-readable route to
  plan windows is the statusline JSON (`rate_limits.five_hour` and
  `seven_day`, each with `used_percentage` and `resets_at`).
- Codex: plan windows are in the app-server protocol (`RateLimitSnapshot`,
  `RateLimitWindow {usedPercent, windowDurationMins, resetsAt}`).
- ACP has no plan-limit or reset-window concept.

## Decisions

### a. Source A: what Span observes, always on

- The UI controller keeps the latest `usage_update` of each session. When a
  turn completes (any chat on the connection, focused or in the background)
  it sends one usage patch with the session metadata update. The patch
  holds:
  - the turn's token counts from `PromptResponse.usage`, when sent;
  - the agent's cumulative cost, when reported;
  - the context reading;
  - the model selected for that session;
  - the local calendar day.

  The store is written once per turn, never once per update
  (`ui/src/lib/usage.ts`, `createUsageRecorder`).
- Storage: an optional `usage` field on `SessionMeta` in the existing
  per-workspace store (ADR 0005). It holds counters only: no prompt text,
  replies, paths or credentials.
- Counters are kept in buckets of one day and one model, so a total over any
  range of days is a plain sum:
  - `turns` and `turnsWithTokens`
  - `input`, `output`, `cacheRead`, `cacheWrite`, `thought` and `total`
  - `costMicros` and `currency`
- Additive by construction:
  - Token counts add per turn. The draft ACP RFD describes end-of-turn usage
    as per turn, and the ADR 0003 meter reads it the same way.
  - Cost is cumulative in ACP, so the store keeps the last reported total
    (`costSeen`) and adds only its growth. A report of the same total (a
    replay) adds nothing. A lower total in the same currency means the
    agent's counter restarted, so the whole figure counts as new.
  - The context peak and size are kept apart: occupancy is not consumption.
- Bounds:
  - At most 32 buckets per session. The oldest bucket folds into the next
    bucket of the same model, so model totals stay exact and only its day
    moves later. If no bucket of that model is left, it folds into the next
    oldest bucket.
  - Store caps and eviction are unchanged (ADR 0005). Evicting a session
    drops its usage history.
- Migration:
  - No schema version bump. Older stores read with `usage` absent.
  - An older Span ignores the field and drops it on its next write of that
    session. This is accepted, because a version bump would make older
    builds refuse the whole history.
- Reading: `usage_summary(range)`, `usage_sessions(range)` and
  `usage_prices` (`apps/desktop/src/usage.rs`, typed with specta).
  - They read every workspace store under `~/.config/span/session-meta`
    (regular `<16 hex>.json` files only, never symlinks, at most 512 files).
    The page therefore spans all folders and works without an open folder.
  - Health check sessions (ADR 0010) are left out.
  - The aggregation is pure, in `crates/core/src/usage.rs`.

### b. Source B: opt-in local log importers (stage B)

- Setting `agents.usage.importLocalLogs`, off by default, user only (dropped
  from workspace settings like the other user-only keys).
- Read-only importers for Claude Code (`projects/**/*.jsonl` under
  `CLAUDE_CONFIG_DIR` or `~/.claude`) and Codex (`sessions/**/rollout-*.jsonl`
  under `CODEX_HOME` or `~/.codex`). They show all-time usage, including
  sessions started outside Span.
- Read only usage fields and the model. Dedupe Claude entries on `message.id`
  plus `requestId`. For Codex, use `last_token_usage`, else the growth of
  `total_token_usage`, with the model from `turn_context`.
- An incremental scan in the background with progress:
  - A per-file offset and a hash guard, cached in the app data folder.
  - Size and count caps.
  - Never follows a symlink out of the root, never uploads anything, never
    stores prompt text.
- Imported figures are labelled "Imported from local logs" and Span's own
  "Tracked by Span", with a source filter on the page. Sessions seen by both
  are not double counted: the Span-tracked figure wins for sessions Span ran.
- Tests use generated sample JSONL only, never real logs.
- As built (`crates/core/src/usage_import.rs`, `apps/desktop/src/usage.rs`):
  - Commands: `usage_import_scan` starts a background scan and returns
    straight away; `usage_import_status` reports progress and the last
    outcome. The page polls the status while a scan runs, then reloads.
  - Imported usage is kept per UTC hour. The page sends its UTC offset with
    each request (`UsageRange.utcOffsetMinutes`), so imported hours land on
    local days. Past days use today's offset, so a daylight saving change
    can move an hour across midnight.
  - Imported sessions use the agent ids `claude-code-logs` and `codex-logs`.
    `UsageRange.source` (`all`, `tracked`, `imported`) filters them, and
    agent and session rows carry `imported`.
  - A session id Span tracked itself is skipped in the import, so it is not
    counted twice.
  - The cache is `~/.config/span/usage-import/cache.json`. It holds path
    hashes, offsets, head hashes, per-hour counters and dedupe keys.
  - Caps:
    - depth 6;
    - 20,000 files;
    - 512 MB per file;
    - 16 MB per line.
  - Lines still being written are left for the next scan.
  - Settings: the toggle "Import usage from agents' local logs" sits under
    Settings > Agents. The page offers the same switch with the same
    explanation.

### c. Pricing

- A bundled, dated table: `crates/core/src/usage_prices.json`.
  - USD per million tokens for input, output, cache read and cache write,
    by model id, with aliases.
  - `asOf` is 2026-10-29.
  - Transcribed on that date from the official pages:
    - https://platform.claude.com/docs/en/about-claude/pricing
    - https://developers.openai.com/api/docs/pricing
    - https://ai.google.dev/gemini-api/docs/pricing
  - Standard tier, short context only. Long-context, regional, fast, batch
    and flex variants are not applied, and a `note` says so where a page
    lists them. For Anthropic, cache writes use the 5 minute rate.
- Lookup order:
  1. The user's override.
  2. The exact id, after normalisation: provider prefix, `[1m]` suffix and
     date snapshot removed; Claude dots read as dashes.
  3. An alias. `opus`, `sonnet`, `haiku` and `fable` mean the current model
     of that line on the table date.
  4. The longest priced id the model id extends, where the next part does
     not start with a digit. So `gpt-5.5-codex` is priced as `gpt-5.5`, but
     `claude-opus-4-9` is never priced as `claude-opus-4`.

  The page names the match: Priced as, Alias, Variant, or Your price.
- Cache convention: OpenAI and Google report cached tokens as part of input,
  so the estimate charges fresh input as input minus cache reads. Anthropic
  reports them apart. Reasoning tokens are part of output and never counted
  twice.
- A bucket's cost:
  - The agent's own reported USD cost when there is one. Claude Code's
    reported cost is itself a list-price estimate.
  - Otherwise the estimate from its tokens.
  - Otherwise unknown.
- Unknown is never $0:
  - A row with no price shows "No price".
  - A total where some tokens had no price shows a trailing "+" and says how
    many tokens were left out.
  - Tokens are always shown.
- Labels: every dollar figure says "estimate" and "API-equivalent cost, not
  your subscription bill".
- Overrides: `agents.usage.prices.<model id or prefix> = {input, output,
  cacheRead?, cacheWrite?}`, user only. Invalid values (negative, not
  finite, over 10,000) are ignored.
- Plan limits: subscriptions have limit windows, not bills. ACP does not
  carry them, and Span does not scrape them, so the page omits them. A later
  change may show them only for an agent that reports them through ACP
  `_meta` or a documented channel.

### d. UI

- `UsagePage` (`ui/src/components/usage/`) opens from:
  - a toolbar button (Iconsax chart icon, vendored with provenance);
  - the command "Show Usage".

  The Agents page rail footer ("Plan limits") can link to it later.
- Layout:
  - Summary tiles: cost estimate, tokens in, out and cache, sessions and
    turns, most used model.
  - A range switch: Today, 7 days, 30 days, All.
  - Daily stacked bars by agent, switchable between tokens and cost, with a
    hover and keyboard tooltip, a legend, and a table view. One day shows a
    single share bar.
  - Sortable tables by agent, model and session, with brand marks and model
    marks.
  - The estimate notice with the price sources and date.
  - Empty, loading, error and browser-preview states.
  - CSV export into the open folder through `save_attachment`, which never
    overwrites. Formula characters are neutralised, and unknown costs are
    left empty.
- Colour (dataviz method):
  - Five categorical slots as theme tokens `--viz-1..5` plus `--viz-other`,
    stepped per theme. Validated with the dataviz palette script. See the
    redesign note below for the current values.
  - Claude, Codex, Gemini and OpenCode keep fixed slots. A sixth agent folds
    into "Other".
- Styles live in `ui/src/styles/usage.css` and use tokens only. Motion is
  limited to `prefers-reduced-motion: no-preference`.

### e. Redesign (2026-10-30)

The owner rejected the first layout as too loud. The page was rebuilt:

- Layout:
  - A header with the title and a quiet scan status ("Scanned 4 min ago",
    or "Scanning 2,314 files, 41%" with a thin progress line), a refresh
    button and the source filter (shown when the importer is on).
  - A range control (Today, 7d, 30d, 90d, All) and agent filter chips with
    brand marks. Imported and tracked sessions of one agent count as one
    provider.
  - Four tiles: estimated cost, total tokens (with an input, output and
    cache bar), sessions, top model. Each shows the change against the
    previous period of the same length.
  - One chart: daily stacked columns by provider, inline SVG at the measured
    width, with tokens or cost on the one y-axis. Ranges over 120 days fold
    into weeks. Hover or the arrow keys show exact numbers. A table view
    holds the same figures.
  - Two columns: "By model" with share bars on the left. On the right, "By
    agent" with sparklines, and "By source" (tracked against imported).
  - A searchable, sortable sessions table. A row opens the session when it
    belongs to the connected agent.
  - A collapsed "Pricing and estimates" note. It names each model with no
    price ("No price for X"); those models never show as $0.
- Width: fluid, `clamp(960px, 70vw, 1800px)`. Two columns collapse to one
  below 1000 px.
- Palette: muted OKLCH steps, chroma just above the 0.10 floor. Clay, steel
  blue, teal, plum and ochre, in that slot order:
  - Dark and Purple: `#b87342 #3e78b1 #3ca78f #965d91 #a69140`.
    - Lightness band, chroma floor and contrast pass.
    - Worst adjacent CVD separation 11.0, normal vision 16.3.
  - Light: `#ac6734 #2a669f #2a9a82 #844b80 #a18b32`.
    - Worst adjacent CVD separation 12.8, normal vision 17.7.
  - Selection, progress and share bars use the single app accent. The
    token mix uses neutral steps.
- Checked visually only in a browser preview with invented fixtures, at
  1000, 1440, 2560 and 3440 px in the dark theme and at 1440 px in the light
  theme.

## Consequences

- Tracked usage history starts when stage A ships. Earlier Claude Code and
  Codex sessions appear only after the user turns on the importer.
- Figures depend on what each agent reports:
  - An agent that sends no `PromptResponse.usage` shows turns and any
    reported cost, but "Not reported" for tokens.
  - An agent that reports neither shows turns only.
- Usage of delegated children on other connections is not recorded by the
  lead's controller. Their own sessions record usage when the user chats in
  them.
- The cost reported in a turn's last `usage_update` after the turn ends is
  counted with the session's next turn.
- The price table ages. Stale prices are visible through `asOf`, and the
  user can override them.

## UNVERIFIED

- Not run in the native app. Verified with Rust unit tests (`usage::tests`
  and the user-only preference test), vitest (`ui/src/lib/usage.test.ts`),
  and a browser preview with an IPC fixture of invented data at 1000, 1440,
  2560 and 3440 px, in the dark and light themes.
- Which agents send `PromptResponse.usage` today, and whether a given agent
  sends per-turn or cumulative figures. The unstable schema text says
  "across all turns" while the draft RFD says per turn. If an agent sends
  cumulative figures, its token totals here over-count.
- Whether `inputTokens` from each ACP adapter includes cached tokens. The
  provider convention above is assumed.
- The bundled prices were transcribed from the pages through a fetch tool on
  2026-10-29. Spot checks were repeated for several rows, but not every row
  was checked twice.
- The importers were tested against generated sample lines in the documented
  formats (ccusage and T3 Code sources), not against real logs. They were not
  checked against compressed Codex rollouts (T3 Code #25453), which are
  skipped because their lines do not parse. Whether Span's ACP session ids
  equal the agents' own log session ids, which the double-count guard
  relies on, is not verified.
- T3 Code's refresh interval for limits, its handling of
  `account/rateLimits/updated`, and the current output of Claude Code's
  `/cost` and `/status` and Codex's `/status` were not read.
