# ACP process idle wake investigation

Date: 2026-10-29. Tracks [#148](https://github.com/1kentom/span/issues/148), under the separate [native performance gate #12](https://github.com/1kentom/span/issues/12).

## Primary sources and selected behavior

| Source | Observed contract | Span behavior and acceptance |
| --- | --- | --- |
| [ACP SDK 3.5 process implementation](https://github.com/agentclientprotocol/rust-sdk/blob/305aefda6fbe88be6ae8b9088003e383f909b135/src/agent-client-protocol/src/acp_agent.rs) | `AcpAgent` owns the child guard, stdout protocol, stderr drain and bounded shutdown. | Preserve the same process future, result, errors and drop behavior. An idle child must not create continuous client polling. |
| [ACP SDK 3.5 transport implementation](https://github.com/agentclientprotocol/rust-sdk/blob/305aefda6fbe88be6ae8b9088003e383f909b135/src/agent-client-protocol/src/jsonrpc.rs) | The SDK composes owned transport drivers, channel forwarding and shared completion futures. | Decorate the single mutable process-future poll boundary. Leave SDK fan-out and protocol actors intact. |
| [async-io source](https://github.com/smol-rs/async-io/blob/v2.6.0/src/reactor.rs) | `Source::poll_ready` wakes the previous waiter when replacing a different waker. | Keep a stable child I/O wake identity, forwarding actual readiness to the current caller. No polling interval or delay. |
| [AtomicWaker](https://docs.rs/futures-util/0.3.34/futures_util/task/struct.AtomicWaker.html) | Coordinates concurrent wake registration and notification. | Register before polling the child. Clear the parent registration on cancellation/drop. Cover caller migration and concurrent registration/wake. |
| [Zed external agents](https://zed.dev/docs/ai/external-agents), [VS Code agents](https://code.visualstudio.com/docs/agents/overview), [Fleet retirement](https://blog.jetbrains.com/fleet/2025/12/the-future-of-fleet/) | External agent runtimes remain independently owned; Fleet is a historical comparison. | This change adjusts runtime scheduling only. It introduces no new UI, provider coverage or reference-editor parity claim. |

## Reproduction and limits

The actual installed macOS development artifact `c063212` showed sustained backend CPU after a completed OpenCode Hello turn. Its native sample identified ACP transport/shared-future polling. The active user's session and unsent composer draft were preserved. The wire log remained at 53 entries across repeated observations, excluding a visible incoming-traffic storm. Raw profiles and machine paths stay local.

A bounded standalone probe linked already-built ACP SDK 3.5 dependencies and launched the deterministic Node peer in a fresh temporary folder. It sent initialize, session/new and one echo prompt, then waited without sending requests. No provider, credential, paid usage or private workspace was involved. A cached Span client consumed 1.24 process CPU seconds during 4.02 completed-idle seconds, with zero new wire log entries.

The smaller direct-SDK comparison on this macOS 27 ARM64 host measured:

| Transport boundary | Client polls during two idle seconds | Process user/system CPU | Involuntary context switches |
| --- | ---: | ---: | ---: |
| Original | 92,889 | 0.26 / 0.43 seconds | 111,544 |
| Stable identity experiment | 1 | 0.00 / 0.00 seconds | 43 |
| Final AtomicWaker adapter at `62198d8` | 1 | 0.00 / 0.00 seconds | 112 |

The first two rows used a simple forwarding experiment. The final row imported the exact committed `process.rs` module at `62198d8` into the same direct-SDK peer. Its baseline rerun produced 103,940 polls, 0.25 / 0.44 CPU seconds and 113,454 involuntary context switches. Both paths completed a second prompt after idle. All four exact-source wake/cancellation unit tests passed locally, including 64 concurrent registration/readiness races. This verifies the adapter on the affected host, not the installed app. The original diagnostic commit `8a906bf` passed hosted macOS, Windows and both Linux test shards in [CI 40827028961](https://github.com/1kentom/span/actions/runs/40827028961); its hosted environments did not reproduce this local host's idle polling. Vercel's deployment quota check is unrelated to these Rust results.

## Final source verification and remaining acceptance

The exact candidate `62198d8` passed [CI 40828867353](https://github.com/1kentom/span/actions/runs/40828867353): macOS and Windows workspace checks/tests, both Linux Rust shards, Clippy, formatting, Linux desktop build and gate. The hosted suites include the completed-prompt idle regression and its second prompt.

Local current-source ACP integration suites passed with the desktop `dev-tools` feature union: 51 adapter fixtures, 12 health checks, 30 process client tests, 15 session manager tests and 35 tool server tests, 143 total. Those integration binaries were rebuilt in the validation window and their baked fixture paths identify the ACP completion worktree. These are separate from the unit-only idle regression. EOF/error, permissions, review, Stop, disconnect, session lifecycle and delegation cases passed. Independent source and evidence review approved wake registration, cancellation and owned-future cleanup.

[PR #151](https://github.com/1kentom/span/pull/151) merged normally at `3855954e44a84c6d40599978cac683c3a3c46d95`. The remaining acceptance is:
- Install the exact reviewed candidate and repeat connected-idle/completed/error/reconnect CPU measurements, including the real supported provider.
- Keep #148 and #12 open until their own installed acceptance is recorded. This work does not implement ACP terminal methods (#61) or establish a real-provider edit/review flow (#13).
