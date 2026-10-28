# Span foundation execution checklist

This checklist expands the approved goal for the Phase 0.1 foundation. It guides research, implementation, review, and verification without promising full production readiness, complete VS Code API compatibility, completed provider integrations, or release channels that have not been exercised. Continue autonomously across the listed work. Ask for clarification only when a genuine missing decision blocks safe implementation.

## Product and evidence rules

- Before changing a feature, research the matching behavior in the primary product sources for VS Code, JetBrains Fleet, and Zed. Record direct source links, observed behavior, Span's intended behavior, scope limits, and acceptance checks in a concise comparison matrix. Prefer official product documentation and official source repositories. Label any behavior inferred from product operation rather than specified in documentation.
- Candidate primary sources: [VS Code documentation](https://code.visualstudio.com/docs), [VS Code keybindings](https://code.visualstudio.com/docs/configure/keybindings), [VS Code settings](https://code.visualstudio.com/docs/configure/settings), [Fleet documentation](https://www.jetbrains.com/help/fleet/), [Zed documentation](https://zed.dev/docs/). Follow links to the precise feature references and verify current behavior before relying on them.
- Preserve the supplied screenshot and ZIP as local visual references. Keep the original archive, extracted reference, and screenshot intact and out of Git. Never execute JavaScript from the reference archive. Preserve supplied SVG assets and their provenance.
- Use the supplied rounded linear Iconsax pack as the authoritative UI icon source. Select and copy only application-needed assets; do not redraw supplied artwork or publish private source paths or raw reference materials.
- Give each request or bug a trackable Git issue with a clear outcome. Link implementation commits and any review or pull request to that issue. Close an issue only after its stated behavior and verification are evidenced.
- For reported defects, first create a reproducible failing test or a precise minimal reproduction. Keep tests focused on user-visible behavior and the regression. Do not claim a fix from implementation alone.
- Assign file ownership before parallel implementation, coordinate shared files, and integrate changes without discarding other contributors' work.

## Research and acceptance matrix

Use the [dated primary-source behavior matrix](editor-behavior-research.md) as the current research baseline. Its ten rows cover windows/tabs/splits, dirty close, file operations, settings, keybindings, autosave, zoom/panels, modal/menu access, ACP, and CLI ownership. It records source URLs, historical Fleet limits, Span's selected behavior, existing tests, and unverified acceptance boundaries.

Run-configuration behavior and its execution-only boundary are recorded in the [focused source comparison](run-configurations-research.md) for [#84](https://github.com/1kentom/span/issues/84).

The selected local Git scope, primary references and session-consent boundary are recorded in [Git integration research](git-integration-research.md). Its acceptance is pending the core/desktop tests and review.

Refresh the feature-specific row before further implementation. This audit documents existing code and does not establish that research preceded earlier changes. Familiar controls do not establish product parity, native performance, or provider interoperability. Keep the issue-specific verification status below separate from the research observations.

## Implementation and review sequence

1. **Establish scope.** Inspect the current issue, working tree, reference material, architecture boundaries, and existing tests. Identify affected crates and UI surfaces. Record the issue link and concrete acceptance criteria.
2. **Research.** Fill the applicable comparison matrix from primary sources. Include scope boundaries and a short explanation for any deliberate difference from the reference products.
3. **Reproduce.** For a bug, add a failing regression test or capture a minimal, repeatable reproduction before the fix. For a feature, define observable success and failure behavior first.
4. **Implement.** Keep business logic in `crates/core`, parsing in `crates/syntax`, ACP integration in `crates/acp`, Tauri integration in `apps/desktop`, and frontend behavior in `ui`. Generate IPC contracts through specta and tauri-specta. Do not hand-maintain duplicate IPC types.
5. **Cover interaction quality.** Check keyboard operation, focus order and restoration, accessible names and states, destructive-action confirmation, cancellation, dirty-buffer protection, and error feedback. Preserve user data through close, move, rename, and failed file operations.
6. **Verify in layers.** Run the targeted regression and relevant unit tests, then the required integration or E2E flow. Capture actual command output or artifact evidence. Run supported cross-platform CI checks and inspect packaging, startup, shutdown, and resource behavior on the platforms claimed. Report unavailable platform runs explicitly.
7. **Independent review.** Have a reviewer who did not implement the change assess design fidelity and interaction behavior. Have a separate functional and security review inspect data loss, filesystem boundaries, process execution, ACP/provider handling, IPC validation, and error paths. Resolve findings or record a concrete blocker; do not mark unverified findings as resolved.
8. **Record and install.** Link the issue, review, and implementation commits. Immediately after a feature's checks pass, install and exercise that feature in the native desktop app. Do not hold verified native installation until unrelated website work is complete. Record what was tested in browser preview versus the native app.
9. **Close accurately.** Close the issue only when acceptance criteria, review findings, targeted checks, and native verification are complete. Keep remaining phase gates open and describe their evidence needed.

## Current implementation cuts

The full approved scope remains active. Use [current verification and the dated numbered issue matrix](current-verification.md) as the authoritative dated status record. It separates source present, source published, exact-source CI, browser fixtures, native process/helper evidence and installed production acceptance. Do not restart implemented work because an old issue body still says implementation pending, and do not close a request because source exists.

| Cut | Current source state | Required completion work |
| --- | --- | --- |
| Save/format/autosave, whole-UI zoom and panel handles: #3/#5/#18/#19 | Implemented and published, including native formatter routing, guarded Save fallback, zoom and overlay controls. | Exact installed success/error/cancel/keyboard/focus states and issue-specific native acceptance. |
| Editor settings, groups, dirty state, clean-tab LRU, indexing and navigation: #6/#20/#21/#27/#28/#30/#31/#32/#33/#41/#63/#65/#66 | Main includes background file indexing, lazy listings, actual clean-only default-10 LRU, LSP frontend, Emmet/Tab, Files shortcuts, Find and menu/icon work. PR #109 adds newer Explorer/drop zones. | Measure native large-folder behavior, finish current-build interaction/platform matrix, preserve drafts and verify newly merged PR #105 intelligence independently of older foundation evidence. |
| Run configurations, terminal and AI tools: #29/#84 | Merged normally through PR #99 at `b1a4f04`. Real native helper MCP approval/output and live Light appearance passed; source fixes and process tests exist. | Production focused first-paint, exact installed Run/Stop/Restart/persistence and lifecycle acceptance remain. Controlled hidden/unfocused helper observations do not establish a production-policy defect. DAP is excluded. |
| ACP catalog/lifecycle, delegated work and provider flow: #13/#22/#23/#38/#50/#52/#54/#81/#82/#87/#95 | Adapter, catalog, permission/tool-server, chat/handoff and related UI source exists; provider-specific limits remain. | Actual supported-provider authentication/proposal/review and native install/remove/delegation/consent tests. A listed tool, fixture or successful controlled command does not prove interoperability. |
| Uploads, viewers and design coverage: #55-#60/#91/#108 | Several components/stores are published; main still has explicit unsupported viewer types and omitted attachment actions. Open PR #104 proposes further mounts/viewers. | Complete entry-point/backend/safety/codec/native acceptance and privately referenced design gaps; do not treat unmerged proposals as complete. |
| Local Git: #110-#115 | Core/desktop/frontend work is active in the isolated Git integration branch. | Verify inline session Enable Git before status and every core operation, exact repository/workspace gates and reviewed-index commit safety; freeze/review generated contracts and real repository tests, publish source/CI, then verify the installed local workflow. No auto-push/discard/amend or remote/branch mutation is implied. |
| CLI and child-process ownership: #26/#61 | Detached launcher and UI PTY/run execution are present. ACP still advertises `terminal:false`; protocol terminal APIs are a separate open feature. | Preserve GUI detachment and owned cleanup. Root's installed help/version checks identify an older installed binary, not latest source. |
| Native performance and real-provider proposal gates: #12/#13 | Harnesses and infrastructure exist. | Complete the defined physical native measurements and actual provider edit/review evidence; these remain independent phase gates. |

## Publication and verification status

Status snapshot: **2026-10-29**. See the [revision/test/native ledger](current-verification.md) for exact links and limits.

- Audited source base is `d1c6fae`, a website metadata commit on runtime `b0a88d7`; remote main advanced during the audit to `d4a6f64` through PR #105. New code-intelligence source does not inherit earlier test/native acceptance. Runtime [CI 40778743104](https://github.com/1kentom/span/actions/runs/40778743104) passed; exact metadata-head CI was still running at the recorded snapshot. Local Git and website polish WIP do not inherit those results.
- PR #99 is merged at `b1a4f04939a9ebf7636b4c67372ee457ae337187`, with green [main CI](https://github.com/1kentom/span/actions/runs/40774780502). Its feature evidence includes 1,265 Node 22 UI tests, 84 browser cases, 87 desktop units, 128 core passes plus one existing ignored Trash case, 23 preferences and nine PTY tests, with revision/scope distinctions in the ledger. These counts are not a current installed-app certification.
- [Nightly .27](https://github.com/1kentom/span/releases/tag/v0.1.0-nightly.20261028.27) was published from `b1a4f04` through a successful four-target workflow. The tag/plan, checksum metadata and five asset links/sizes were verified. It is a development prerelease with updater disabled, not stable or notarization proof.
- The website is live from older source `f8fc50d`; bundled fallback .15 and healthy API .27 were observed separately. Vercel blocks newer deployments with a rate-limit/quota error tracked in #117. New source or a main manifest update does not prove a current production deployment.
- Historical tracker closures, including #39 publication automation and #72 after PR #103, are preserved. Open #84 and Git #110 children remain open. The complete table records each numbered issue, including remaining acceptance for implemented features.

## Website and release gates

- Keep website deployment and desktop completion independent. Do not introduce a database or paid-plan requirement without a requested product need. Preserve the current quota/deployment limitation explicitly.
- Use successful CI for the exact source and exercise the intended release path before claiming it works. Nightly .27 and the first Preview .31 publication paths are verified, with exact-source/tag/asset evidence in the subsequent-delivery ledger. No stable release or updater path is established by those prereleases. Stable retains explicit phase and approval gates.
- Install and exercise verified features as authorized, recording the actual artifact/source. Staging, signing a local test artifact, opening a helper or an old installed version does not replace that evidence.
- Do not claim full editor parity, complete provider coverage, production readiness, signing/notarization or current deployment without direct evidence. Passing UI/mock/process tests does not close #12 or #13.

## Required completion report

Summarize shipped behavior and issue/commit links; primary research; exact-source tests/CI/browser/resource/platform outcomes; independent review; native artifact, installation and exercised behavior; current website/release state; and open gates. Report missing and unavailable evidence directly. The goal is complete only when the full approved scope and its acceptance are actually handled.
