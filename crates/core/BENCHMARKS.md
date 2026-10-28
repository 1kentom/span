# Core measurement, 2026-10-28

Machine: Apple M3 Pro, macOS, release Rust build. One local measurement during the foundation implementation, not a statistical gate result.

Command: `cargo run --release -p span-core --example rope_bench`

| Measurement | Observed |
| --- | --- |
| Open 100 MiB, disk read plus rope construction plus initial full snapshot | 183.426833 ms |
| Middle insertion, UTF-16 validation plus metadata acknowledgement | 94.5 microseconds |

Fixture: 104,857,600 ASCII bytes, generated before timing. File contents are warm in the OS cache. The insertion uses `edit_buffer_delta`, so the result contains revision metadata rather than a complete document.

This verifies a core-only operation on this machine. Tauri serialization, frontend document creation, editable paint, startup, 60 fps scrolling, and process memory are not included. The M3 Pro is newer than the phase's reference M1, so this run cannot certify the release gate on the reference hardware.
