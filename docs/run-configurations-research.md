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

These results do not verify the subsequent union with newer main, an installed native Run/Stop/Restart workflow, a real AI provider, Windows/macOS/Linux parity, or phase completion. Repeat the combined checks after upstream integration and record the exact resulting commit and hosted CI. The issue remains open.
