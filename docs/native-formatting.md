# Formatting

Format Document and `editor.formatOnSave` use the current Rust-owned buffer revision. The editor sends a path and revision to the desktop process; Rust reads from its Rope, runs the selected formatter outside the workspace lock, and applies the result only if that revision is still current. A completed format appears as one undo step shared by every split showing that file.

## Built-in providers

When no project formatter configuration, workspace Prettier installation, or configured Prettier executable takes precedence, Span calls the embedded Rust plugin libraries directly for:

- JavaScript and JSX: `.js`, `.jsx`, `.mjs`, `.cjs`
- TypeScript and TSX: `.ts`, `.tsx`, `.mts`, `.cts`
- JSON and JSONC: `.json`, `.jsonc`
- Markdown: `.md`, `.markdown`, including fenced JavaScript, JSX, TypeScript, TSX, and JSON blocks

Unsupported Markdown fence languages are left without a language-specific formatter callback. Rust uses the `rustfmt` executable resolved from the GUI process environment, including `~/.cargo/bin`, `~/.local/bin`, standard system locations, and `PATH`; Python uses Ruff. Other languages can use a formatter executable configured in Span settings. HTML and CSS support depends on a configured formatter, a recognized project tool, or an available Prettier executable.

The embedded TypeScript, JSON, and Markdown plugin APIs are pinned in the [core Cargo manifest](../crates/core/Cargo.toml): [TypeScript 0.96.1 `format_text`](https://docs.rs/dprint-plugin-typescript/0.96.1/dprint_plugin_typescript/fn.format_text.html), [JSON 0.25.2 `format_text`](https://docs.rs/dprint-plugin-json/0.25.2/dprint_plugin_json/fn.format_text.html), and [Markdown 0.28.2 source](https://docs.rs/crate/dprint-plugin-markdown/0.28.2/source/src/format_text.rs). These built-in calls do not start the dprint CLI or a WebAssembly runtime. Other project tools may have their own runtime requirements. Project configuration remains authoritative: local Prettier and recognized dprint or Biome configuration are routed to the matching project tool when available. A recognized but unavailable project tool produces a formatting error instead of silently imposing Span's native defaults. Deno and other unsupported project formatter configurations must be configured explicitly in Span settings.

## Limits and failure behavior

Formatting accepts documents up to 16 MiB and uses bounded worker admission. Native formatting has a 10 second deadline; because the library calls are synchronous, a timed-out Rust worker is logically cancelled, its result is dropped, and its slot remains occupied until it finishes. External formatter processes have a 10 second timeout and are stopped as a process tree.

Edits, discard, a workspace switch, a newer format request, or closing the last editor view cancel active work where possible. The renderer also checks the originating workspace, buffer revision, document identity, and local edit counter before applying a result. If a local edit races with a formatter result, the visible draft is retained and rebased onto the latest accepted buffer. Other split views keep the shared formatter job alive.

On Save, a formatter failure or cancellation falls back to saving the current authoritative Rope snapshot. The fallback chooses and writes that snapshot while holding the workspace lock, and sends one save operation through the same per-path gate as formatting. Disk conflicts and other save errors remain visible. Manual Format reports formatter errors and never saves.
