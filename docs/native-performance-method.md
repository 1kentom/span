# Packaged startup diagnostic method

Issue: [#12](https://github.com/1kentom/span/issues/12). Research checked **2026-10-29**. This method adds measurement infrastructure, not a passed native performance gate.

## Primary-source comparison

| Reference | Documented observation | Span choice and acceptance |
| --- | --- | --- |
| [VS Code CLI](https://code.visualstudio.com/docs/configure/command-line#advanced-cli-options) and [performance guidance](https://github.com/microsoft/vscode/wiki/Performance-Issues) | Startup profiling and startup timers are distinct from interactive performance profiles. | Emit bounded startup marks on explicit opt-in, with a separate external capture still required for typing and rendering. |
| [Fleet historical help](https://www.jetbrains.com/help/fleet/reporting-performance-problems.html) | The help URL redirects to the [retirement announcement](https://blog.jetbrains.com/fleet/2025/12/the-future-of-fleet/). No surviving startup profiling contract was established. | Record Fleet startup behavior as unknown. Do not substitute IntelliJ profiling behavior. |
| [Zed troubleshooting](https://zed.dev/docs/troubleshooting#performance-issues-profiling) | macOS profiling uses Instruments with a selected process and a recorded problematic action. | Keep native process profiling and complete application memory measurement separate from webview marks. |
| [Tauri CLI](https://v2.tauri.app/reference/cli/#build) | Build mode and its debug flag are distinct options. | Use the actual installed release artifact and record its source/hash. A debug build or browser preview is separate evidence. |
| [W3C Paint Timing](https://www.w3.org/TR/paint-timing/) | First paint is optional and distinct from first contentful paint. | Preserve the existing frontend fallback, label it browser paint with ambiguous FP/FCP source, and report missing or invalid paint as unavailable. |

## Opt-in capture

Quit the app normally first, preserving drafts and waiting for its process to exit. The single-instance handoff of a second process is not a fresh startup. Verify the installed executable version and SHA256 before measuring. Set `APP_EXECUTABLE` to that installed packaged executable and `CAPTURE_FILE` to a private local output file, then run:

```sh
SPAN_STARTUP_TRACE=1 "$APP_EXECUTABLE" 2> "$CAPTURE_FILE"
```

Use the actual application executable, rather than the detached `span` launcher or an OS `open` command that may reuse an existing instance or discard stderr. Quit normally after the startup completes. Repeat with one capture file per fresh process. The exact value `1` is required, read once at Rust app entry; unset, `0`, `true` and whitespace variants do not enable tracing. GUI launch environments may not inherit shell variables. Windows release GUI-subsystem builds may lack usable stderr even with redirection; missing output is unavailable evidence, not a zero-duration pass.

The app writes at most three JSON lines with schema `span.startup.v1`, one per event for the process lifetime. Tracing opens no files and adds no IPC contract. Records contain only fixed labels and finite, nonnegative millisecond durations, never raw epoch timestamps, paths, workspace contents, identifiers, provider data or credentials. With tracing disabled, this diagnostic performs no serialization or stderr writes. Raw stderr can contain unrelated application diagnostics, so keep captures local and inspect them before sharing.

```sh
node bench/native-startup.mjs "$CAPTURE_FILE"
node bench/native-startup.mjs "$FIRST_CAPTURE" "$SECOND_CAPTURE"
node --test bench/native-startup.test.mjs
```

The helper accepts at most 100 captures and reads at most 1 MiB per file and rejects larger inputs, skips lines over 4 KiB, validates known records, and strips arbitrary fields. It prints aggregate sample counts, nearest-rank p50/p95 and missing/rejected-record counts without filenames or raw stderr. Keep first-after-reboot runs separate from subsequent launches, and record the actual OS/cache state; a fresh process alone does not establish a cold cache. Use enough independent samples for a meaningful distribution. The app does not reset sessions, clear caches, or terminate processes for benchmarking.

## Metric meaning and limits

- `processElapsedMs` uses a monotonic clock initialized at the beginning of Rust `run()`, before CLI parsing. It excludes OS process creation and loader work, so it is not click-to-launch latency.
- `window_created` is the existing Tauri setup hook after startup services and the main window exist, not the moment the OS allocated a window.
- `window_shown` follows a successful native `show()` call. `shownBy` records `frontend` or `failsafe`. It does not establish compositor presentation, focus success or physical visibility.
- `webview_startup` arrives through the existing frontend timing report after its animation-frame/timer heuristic. `entryEvaluatedMs`, `shellRenderedMs`, `sessionReadyMs` and `webviewPaintMs` use the webview navigation clock. They are browser-reported observations rather than trusted acceptance results.
- `paintSource` is `first-paint-or-first-contentful-paint` because the existing frontend can return either through its current IPC field. `paintStatus: unavailable` and a null paint duration mean no usable observation. Do not substitute a show call or session-ready duration as paint.
- `navigationProcessMs` and `sessionReadyProcessMs` are approximate clock alignments using `performance.timeOrigin` and the native start wall clock. Negative, non-finite or future alignments are unavailable; wall-clock changes may invalidate or distort alignment. Raw epoch values are never emitted.

Record hardware, OS, artifact source/hash, build mode, workspace/session workload, cache state, sample count and any rejected/incomplete captures beside a published aggregate. Report trace overhead as part of the instrumented method. A slow or incomplete sample must not be silently discarded. A complete three-event capture means the records arrived, not that any budget passed.

Physical keystroke-to-pixel, one-second editable 100 MB open, sustained scrolling, total application idle memory and the #148 CPU regression remain separate measurements. Include the webview, GPU and owned child processes where applicable in memory accounting; a backend-only `footprint` observation does not establish the 250 MB total gate. No native performance budget is closed by these helpers or unit tests.
