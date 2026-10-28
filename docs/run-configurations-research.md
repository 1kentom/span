# Run configurations: research and acceptance

Checked **2026-10-28** for [#84](https://github.com/1kentom/span/issues/84), against primary documentation. These are documented observations, not independently exercised behavior in the reference editors. This record scopes an in-progress implementation and does not establish product parity or native execution evidence.

## Source comparison

| Reference | Documented observation | Span selection and boundary |
| --- | --- | --- |
| [VS Code tasks](https://code.visualstudio.com/docs/debugtest/tasks), checked through the [official documentation source](https://github.com/microsoft/vscode-docs/blob/main/docs/debugtest/tasks.md) | Workspace tasks use `.vscode/tasks.json`. Providers can detect tasks; custom tasks distinguish process and shell commands, with working-directory, environment and output-presentation options. | Offer explicit, saved executable configurations and reviewable detected targets. Validate the selected invocation and document supported detection. Do not claim VS Code task-schema compatibility. |
| [Zed tasks](https://zed.dev/docs/tasks) | Tasks can be global, worktree-local or temporary. Spawn and rerun are distinct actions. Default reruns reuse a terminal and wait for an existing task to finish. | Make configuration scope and persistence explicit. Provide Run, Stop and Restart with a documented concurrency policy; Restart must clean up the previous owned run before replacement. Do not infer disk output retention from terminal reuse. |
| [Fleet run-configuration help](https://www.jetbrains.com/help/fleet/run-confs.html), now redirected to [the retirement notice](https://blog.jetbrains.com/fleet/2025/12/the-future-of-fleet/) | The former help page no longer supplies a verifiable run-configuration contract. Fleet downloads and updates ended in 2025. | Keep Fleet historical. No current Fleet, IntelliJ or Air behavior is substituted for missing documentation. |

The VS Code live documentation fetch timed out during this check; its official repository source was available. None of the reference observations establishes DAP debugging support in Span.

## Executable configuration contract

The implementation should support configuration CRUD, stable selection, supported target detection, explicit native Run, Stop and Restart, and inspectable output with exit status. Detection must not launch commands. Missing programs, invalid invocation settings and failed starts need actionable feedback.

Saved configurations must survive app restart in a documented workspace/user scope. Completed output must remain inspectable when switching configurations, with bounded retention and an explicit clear policy. The implementation must state whether output is session-only or disk-persisted, and test that actual policy rather than imply durable logs.

Stop and Restart must manage owned child processes and preserve run identity through rapid clicks, late output, failed creation, edits and workspace changes. A browser fixture can verify rendering and dispatch but cannot prove native execution or process cleanup.

## AI tool bridge

The user extended [#84](https://github.com/1kentom/span/issues/84) to include AI tools that list and edit configurations, Run, Stop and read output. This is a Span requirement, not a claim about the reference editors. Register these operations through the actual tool bridge and use the same core store/executor as the UI, with the existing permission checks at the action boundary.

Exercise real bridge dispatch and native execution, including allow/deny, cancellation, run/workspace identity and bounded output. Record the client/provider used. Component mocks do not establish a working AI tool path or external-provider interoperability. The extended request requires a working native terminal with real input/output, interruption and owned-process cleanup. Existing PTY source may be evaluated for narrowly approved reuse; a placeholder is insufficient, and no automatic import or installed capability is assumed.

## Read-only PTY reuse checkpoint

On 2026-10-28, [PR #68](https://github.com/1kentom/span/pull/68) was open at `49902eb5615bd6c1b885e34cecfa72b7e5ad3b69` and conflicting with its target branch. Its [CI run](https://github.com/1kentom/span/actions/runs/40717288762) passed the standard macOS, Windows and Linux checks; the additional real-language-server Ubuntu job failed. This is an unmerged-source checkpoint, not overall green CI, installed terminal evidence or approval to import the older terminal feature cut. Any selected reuse needs a fresh source/conflict review and integration decision. No terminal source or Git state was changed for this inspection.

## Required acceptance evidence

| Area | Evidence required before closure |
| --- | --- |
| CRUD and detection | Save/reload, duplicate/delete/selection and invalid-edit regressions; supported detection fixtures; proof that detection does not execute a target. |
| Native execution | Real command checks for arguments, cwd, environment, stdout/stderr, nonzero exit and missing executables. Record the exact source and operating system tested. |
| Stop and Restart | Real process liveness and cleanup checks; replacement starts after prior cleanup; late events cannot change or terminate another run. |
| Output and persistence | Bounded output and clear behavior, completed-run inspection, configuration reload across restart, and the documented output-retention policy. |
| Working terminal | Real native input/output, interruption and owned-process cleanup from the selected implementation; no placeholder or mocked callback claim. |
| AI access | Registered-tool dispatch to the real core executor; existing permissions allow/deny; correct run identity, Stop and output retrieval; UI consistency after AI edits. Record the exact client/provider exercised. |
| Delivery | Meaningful UI/browser lifecycle checks, independent review, public source and hosted checks, then the exact installed-native Run/Stop/Restart and AI-tool workflow. |

DAP, debugger adapters, breakpoints, stepping, variable inspection and debugger parity are outside [#84](https://github.com/1kentom/span/issues/84). The issue remains open until its execution and persistence acceptance is verified.

## Feature snapshot evidence before upstream integration

The local feature cut from `9c135ef` passed 747 UI unit tests, its production build and seven browser flows. Browser flows use explicit IPC fixtures and prove UI dispatch and lifecycle behavior, not process execution. Separate local native checks passed 15 core run tests, one preference regression, 33 desktop tests, two actual HTTP tool-server integration tests and nine real PTY tests. HTTP tool tests exercise the registered bridge with a controlled process fixture, not an external AI provider. The ACP cancellation regression and all 25 tool-server tests passed after the final fix. Independent functional/security and integrated terminal design review found no blocker in this snapshot.

The feature snapshot is committed locally as `77b6172`. It is being combined with upstream `f8fc50d`, including its LSP, formatting, indexing, navigation and keybinding work. These results do not verify that subsequent union, an installed native Run/Stop/Restart workflow, a real AI provider, Windows/macOS/Linux parity, or phase completion. Repeat the combined checks after upstream integration and record the exact resulting commit and hosted CI. The issue remains open.

## Terminal architecture references

The [VS Code advanced terminal documentation](https://code.visualstudio.com/docs/terminal/advanced) describes its xterm.js renderer and PTY/ConPTY integration. Its [terminal process implementation](https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/node/terminalProcess.ts) informs process ownership review. Span reuses [xterm.js](https://github.com/xtermjs/xterm.js); the [write-completion flow-control guide](https://xtermjs.org/docs/guides/flowcontrol/) informs bounded delivery and acknowledgement behavior. These are architecture references, not parity or performance evidence.

[Wave](https://github.com/wavetermdev/waveterm) is an AI-integrated terminal UX reference; [WezTerm](https://github.com/wezterm/wezterm) is a Rust terminal architecture reference. Review of [Zed terminal handling](https://github.com/zed-industries/zed/blob/main/crates/terminal/src/terminal.rs), [its view](https://github.com/zed-industries/zed/blob/main/crates/terminal_view/src/terminal_element.rs), [task templates](https://github.com/zed-industries/zed/blob/main/crates/task/src/task_template.rs) and [task UI](https://github.com/zed-industries/zed/blob/main/crates/tasks_ui/src/modal.rs), plus [Lapce terminal handling](https://github.com/lapce/lapce/blob/master/lapce-proxy/src/terminal.rs) and [its view](https://github.com/lapce/lapce/blob/master/lapce-app/src/terminal/view.rs), informs behavior comparison. Zed pairs `alacritty_terminal` with a native GPUI renderer; Lapce also uses a native terminal/rendering stack. These are not drop-in webview UI libraries. Span uses xterm because it integrates with the existing Tauri webview; this is an architectural fit decision, not evidence that xterm is faster or that another engine could not be evaluated later. No source was imported from Zed or Lapce. No external editor runtime or timing benchmark was performed.

## Native acceptance observations, 2026-10-29

The exact `7b49f97` feature source passed [all four hosted CI jobs](https://github.com/1kentom/span/actions/runs/40752128621), including Windows native process tests and the real-language-server job. This does not establish the later union with main `030b667` or installation readiness.

The isolated native helper from `67f7599` produced the following evidence, separately from browser IPC fixtures and external-provider acceptance:

| Native check | Observation and limit |
| --- | --- |
| Terminal execution and lifecycle | The initial shell prompt painted. A second shell created from Markdown Run retained its VT output, parsed 346 bytes and acknowledged delivery, but its hidden-document WebGL surface painted no text. Genuine DOM fallback visibly displayed the marker, working directory, Japanese text and emoji. This isolates a renderer acceptance failure; parsed bytes alone do not prove visible output. |
| Appearance | Light settings produced white application CSS while xterm retained dark options. The synchronous appearance correction and native macOS DOM-renderer policy passed 31 focused UI tests and independent review. The paused-animation-frame regression failed before the correction and passed afterward. Rebuilt native acceptance remains pending. |
| Shell selection and close | Hide/show preserved two shells. Closing the second shell retained the first. These observations do not establish every platform or rapid lifecycle race. |
| Actual tool approval and execution | The actual approval dialog accepted Approve once and the controlled command exited successfully. The Run view still reported an output acknowledgement deadline. The optional bounded-observer correction passed source review, and its completed-background-history UI regression passed independently. Its Rust no-listener HTTP and 256 KiB observer-cap tests have not run: the focused release build was interrupted during compilation, with exit 130. Repeat those checks and native approval/output verification before claiming acceptance. This is a controlled tool-process fixture, not proof of external AI-provider interoperability. |

Issue #84 remains open. Complete the combined-source checks and repeat the affected native flows before claiming the updated app is ready to install. DAP and phase completion remain outside this evidence.
