# Performance measurements

Performance numbers have different scopes. A Chromium browser preview measurement does not prove Tauri native startup, IPC synchronization, disk access, or the production webview's input-to-pixel time.

## Browser preview

Start `pnpm dev` in another terminal, then run:

```sh
pnpm bench:web
```

The benchmark uses a fresh Chromium browser context for each navigation and records elapsed time from navigation start until the first CodeMirror editor is editable. This includes browser navigation and development-server module loading. It is a web-only cold-load proxy, not native process startup.

For typing, it records the interval from the DOM `keydown` event until two animation frame callbacks have run. This gives the browser one paint opportunity after the input. It includes frame scheduling delay and cannot observe when pixels physically reached the screen. The script reports median and p95 together with the exact method, viewport, browser version, sample count, and runtime. Input samples edit the actual CodeMirror document through keyboard events.

The latest local browser run on an Apple M3 Pro (11 logical CPUs, 18 GiB memory) using Chromium 156 reported fresh-context navigation p50 267.90 ms and p95 352.32 ms across five samples. The 100-key second-animation-frame proxy reported p50 29.10 ms and p95 30.40 ms. These are development-browser measurements; the typing proxy includes frame scheduling by definition and does not establish native startup or physical paint timing.

The output is `bench/results/web.json`. No release budget is marked passed from this proxy alone. Use a packaged Tauri app and an instrumented native capture to establish cold start, warm start, and actual keystroke-to-pixel gates on reference hardware.

## Core 100 MiB rope

```sh
cargo run --release -p span-core --example rope_bench
```

The core example creates a 100 MiB ASCII file, then measures the real core `open_buffer` path (disk read, rope construction, and initial snapshot) and a versioned middle edit (UTF-16 validation and metadata acknowledgement). Fixture generation is excluded and the OS file cache is warm. It records the actual byte count. This does not establish Tauri serialization, transfer, CodeMirror synchronization, editable paint, memory budget, or scrolling frame rate.

The first local release run reported 183.426833 ms for opening 104,857,600 bytes and 0.0945 ms for the middle edit. See `bench/results/core.json`; the native file-open release gate remains unverified.

## Phase 0.1 release status

Native cold startup under 600 ms, warm startup under 250 ms, keystroke-to-pixel p95 under 16 ms, opening a 100 MB file editable under one second, 60 fps scrolling, and idle memory under 250 MB remain unverified until measured on the specified reference hardware with the packaged desktop app.
