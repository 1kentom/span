# 0016: Archive viewer and safe extraction

Date: 2026-10-30

Status: accepted. The backend (span-core `archive`, span-desktop `archives`)
is covered by Rust unit tests that build every archive inside the test. The
viewer and Explorer wiring are covered by vitest in jsdom and `tsc`. Nothing
was exercised in a native window or against real malicious archives (see
UNVERIFIED).

## Context

The shared file viewer (ADR 0006, ADR 0008) already listed ZIP files in the
browser with fflate and defined an `ArchiveApi` contract for a native
backend that did not exist. Two earlier branches tried to supply it:

- `feature/archive-backend` (zip 2.6.1, tar, flate2; 719 commits behind main)
  listed and extracted ZIP, tar and tar.gz with an in-memory source.
- `feature/archive-extraction` (zip 9.1.3, cap-std, cap-fs-ext,
  unicode-normalization, unicode-casefold; 207 commits behind main) was the
  stricter design: no library extract helper, directory-relative writes,
  collision keys, declared sizes never trusted, owned uploads only.

The owner chose the stricter design. Both branches conflict heavily with main,
so neither was merged. This ADR records a re-implementation on current main.

Archives are untrusted input. They arrive from agents, downloads and uploads,
and the classic attacks (zip slip, links, bombs, colliding names) all target
the extraction step.

## Decisions

### 1. Formats and dependencies

- ZIP and the ZIP family by extension: `.zip`, `.jar`, `.war`, `.apk`, `.whl`,
  `.vsix`. Format detection uses magic bytes first (`PK`, gzip, `ustar`), the
  extension only as a fallback, so a renamed file is read as what it is.
- tar and tar.gz (`.tar`, `.tgz`, `.tar.gz`).
- Compression methods read: Stored and Deflate. Other ZIP methods are listed
  and flagged "unsupported compression method"; they are never previewed or
  extracted.

| Crate | Version | Why | Notes |
| --- | --- | --- | --- |
| `zip` | =9.1.3 | ZIP central directory and entry readers | `default-features = false`, `deflate-flate2-zlib-rs` (pure Rust zlib-rs, already in the lockfile). New transitive crates: `typed-path` 0.13.0, `nix` 0.31.3 (Unix only). |
| `tar` | 0.4.46 | tar headers and data | Already in the lockfile (span-lsp). `default-features = false`, so no `xattr`. |
| `flate2` | 1.1.10 | gzip for tar.gz | Already a span-core dependency. |
| `cap-std`, `cap-fs-ext` | =4.0.3 | Directory capability writes | New transitive: `cap-primitives`, `ambient-authority`, `fs-set-times`, `io-extras`, `io-lifetimes`, `maybe-owned`, `rustix-linux-procfs` (Linux), `winx` (Windows). |
| `unicode-normalization` | 0.1.26 | NFKC and NFC for collision keys | |
| `unicode-casefold` | 0.2.0 | Unicode case folding for collision keys | |

All are pure Rust; nothing needs a system library, so the macOS and Windows
CI builds need no new tooling. zip 9.1.3 declares Rust 1.88.

### 2. Listing reads metadata only

- ZIP listing uses the central directory (`by_index_data`), never an entry's
  data. tar listing walks the headers; for tar.gz the stream has to be
  decompressed to reach them, so the walk is bounded (below).
- Each entry reports name, folder or file, kind, declared size, compressed
  size, modified time (ZIP DOS time read as UTC), encryption and the
  executable bit, plus `unsafeReason` when it will never be previewed or
  extracted.
- Caps: at most 50,000 entries (a longer archive is listed up to the cap,
  marked `truncated`, and cannot be extracted); names longer than 1,024 bytes
  are cut for display and refused. The sum of declared sizes is reported as
  `declaredSize` and never trusted.

### 3. Entry rules (shared by preview and extraction)

An entry is refused, with its reason shown in the viewer, when:

| Rule | Test (span-core `archive::tests`) |
| --- | --- |
| Absolute path, drive prefix (`C:`), `..` component, NUL, backslash anywhere in the name (no backslash-as-separator tricks), control characters, colon (alternate data streams), trailing dot or space, Windows device names, empty components | `archive_refuses_zip_slip_names_and_writes_only_safe_entries` |
| Deeper than 64 folders, a path over 1,024 bytes or a component over 255 bytes | `archive_refuses_deep_and_long_paths` |
| ZIP symbolic link entry (Unix mode) | `archive_never_extracts_symlink_entries` |
| tar symbolic link, hard link, character or block device, FIFO, sparse or unknown entry type | `archive_never_extracts_tar_links_or_devices` |
| Two files with the same key after NFKC, Unicode case folding and NFC, a file named like a folder, or a file used as a parent folder (`a` and `a/b`) | `archive_refuses_names_that_collide_after_normalisation_or_case_folding` |
| Encrypted entry (flagged, never decrypted or read) | `archive_flags_encrypted_entries_and_never_reads_them` |
| Declared size over 512 MiB per file, or a ratio above 200:1 for entries of 1 MiB or more | `archive_flags_zip_bombs_by_ratio_and_declared_size` |

Links are skipped entirely: no link entry is ever written, even one that
points inside the archive. That removes every write-through-link case at the
cost of archives that rely on internal links.

### 4. Preview

`archive_read_entry` returns one entry for the viewer, text or image only:
at most 1 MiB is read; text is cut at 1 MiB and marked truncated; images over
1 MiB and anything that is not UTF-8 text without NUL bytes are refused.
Nested archives (`.zip`, `.jar`, `.tar`, `.gz`, `.7z` and similar) are shown as
entries and never opened (`archive_lists_nested_archives_as_entries_without_opening_them`).
Preview tests: `archive_previews_only_bounded_text_and_images`.

### 5. Extraction

User initiated only (viewer buttons, Explorer "Extract here" and "Extract
to..."). Nothing is run and nothing extracted is opened afterwards.

- Destination: an existing workspace folder checked with the Explorer import
  rules (`import_target`: inside the workspace after canonicalisation, not a
  symbolic link, not inside `.git`), plus a new folder named after the archive
  (`build.tar.gz` to `build`). Destinations outside the workspace are refused
  (`archive_target_rules_reuse_the_import_containment`).
- Staging: a fresh `.span-extract-<pid>-<n>` folder is created inside the
  destination folder through a cap-std `Dir` opened without following links.
  Every folder is opened with `open_dir_nofollow` and every file is created
  with `create_new`, relative to that capability, so a traversal is impossible
  by construction even if a name rule were missed.
- Publish: the staging folder is renamed onto the new folder name with the
  Explorer clash policy (`publish_import`): Keep both is the default
  ("build copy"), Skip leaves the existing item, Replace moves it to the
  system Trash. A name taken by a symbolic link is never written through:
  Keep both picks "name copy" and Replace refuses the link
  (`archive_refuses_to_extract_through_a_symlink_in_the_destination`,
  `archive_keeps_both_on_a_clash_and_skip_leaves_the_existing_folder`).
- Bounds: the selection's declared total is checked against the cap before
  anything is written (`archive_selection_over_the_total_limit_is_refused_before_writing`);
  while writing, every byte read is counted against the declared size of the
  entry, the per file cap, the total cap and the ratio, so a lying header
  fails the run. The total cap defaults to 1 GiB and is the user setting
  `archiveExtractLimitMb` (1 to 16,384), honoured only from the user's own
  settings file (`archive_extract_limit_setting_is_user_only_and_bounded`).
- tar.gz streams are wrapped in a counter that stops at 8 GiB of decompressed
  data or at 200:1 against the compressed file size past the 1 MiB floor
  (`archive_stops_a_tar_gz_bomb_while_listing`).
- Failure and cancel: the staging folder is removed and nothing is published
  (`archive_cancel_leaves_no_partial_files`, which cancels mid run for ZIP and
  tar; `archive_reports_truncated_or_corrupt_archives_cleanly`).
- Permissions: files are written 0644. The executable bit (0755) is kept only
  for entries that had it and only when the user opts in; set-user-ID,
  set-group-ID and sticky bits are never set
  (`archive_strips_setuid_and_executable_bits_unless_kept`). Windows has no
  mode bits to set.
- Too many entries: refused (`archive_with_too_many_entries_is_truncated_and_not_extractable`).

### 6. IPC and reachability

Typed commands generated with specta (span-desktop `archives`):
`archive_list`, `archive_read_entry`, `archive_plan_extract`,
`archive_extract` (progress over a Tauri `Channel`, a renderer chosen job ID)
and `archive_cancel`. At most two extractions run at once; changing the
workspace cancels them. Extraction checks the destination under the workspace
lock, writes the staging folder without holding it, then publishes under it.

An archive source is either a workspace path (resolved by `existing_path`,
which canonicalises and refuses anything outside the workspace) or the ID of
one of the user's own uploads (ADR 0006), the only outside file the viewer
opens, or a file from the latest native drop (recorded natively, the same
check `read_dropped_file` uses), so a dropped archive can be listed for a
chat attachment outline. Any other outside path is refused
(`archive_sources_outside_the_workspace_are_refused`).

The commands are renderer only. They are not agent tools and not MCP methods
(`archive_commands_are_not_agent_tools` checks the span-agents tool list). An
archive attached to a chat is listed as a text outline; it is never extracted
and its contents never enter the model context.

### 7. The older branches are superseded

The owner decision between `feature/archive-backend` and
`feature/archive-extraction` is closed by this ADR: both branches are
superseded and kept on origin for reference, not deleted. Taken from
`archive-extraction`: the dependency set and pins, cap-std writes with
no-follow opens, the name rules (Windows device names, trailing dot or space,
colons), the NFKC plus case folding collision key and the file-as-folder
collision, never trusting declared sizes, the ratio rule with a 1 MiB floor,
per entry `unsafeReason`, and the viewer's honest cancel state. Taken from
`archive-backend`: tar and tar.gz support through the tar crate over a
bounded gzip stream with a whole-stream ratio guard, and the tar entry type
mapping. Not taken: the in-memory sources and 64 MiB input caps of both, the
single fresh folder policy of `archive-extraction` (replaced by the Explorer
clash policy) and the `attachment.rs` refactor of `archive-backend`.

## UNVERIFIED

- No real-world malicious archive corpus was run. Every attack case is an
  archive constructed in a test (hand-built ZIP records, raw tar headers).
- No native window was seen. The viewer, the Explorer menu and the progress
  and cancel UI are covered by jsdom tests and `tsc`; the native pass is the
  checklist section "Archive viewer".
- Windows behaviour (no mode bits, case insensitive names, reserved names on
  disk) is covered only by the name rules and CI compilation, not a run.
- Self extracting ZIP files and ZIP64 archives larger than a few MiB were not
  tested.
- Rename atomicity on network or FUSE file systems was not checked.
