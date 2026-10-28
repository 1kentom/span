# 0006: Uploads store

Status: proposed. Backend for the Uploads panel of the File and Upload Viewer
designs. Implemented in `crates/core/src/uploads.rs` and
`apps/desktop/src/uploads.rs`; no UI is wired to it yet (see UNVERIFIED).

## Context

The Uploads panel lists files the user sent to agents or added by paste,
drop or the file picker, grouped as Documents, Data, Media, Code and
archives, with actions to preview, rename, duplicate, remove, save to the
workspace, reveal in the file manager, copy the path and open with the
system default app. The session metadata store (ADR 0005, another branch)
keeps agent and model information; this store keeps the bytes.

Constraints: business logic in `crates/core`, Tauri glue in `apps/desktop`,
IPC types generated through specta, no new dependencies, nothing written
into the workspace except through the existing `save_attachment` path.

## Decisions

### 1. Location: app data, one folder per workspace

The store sits next to `session.json` and `recent-projects.json`:
`~/.config/span/uploads/<key>/` (`HOME`, else `USERPROFILE`). `<key>` is a
128 bit FNV-1a hash of the canonical workspace root, so folder names carry
no path text and two workspaces never see each other's uploads. Layout:

- `index.json`: `{ "version": 1, "uploads": [Upload] }`, written atomically
  with the shared `atomic_write` (temp file, fsync, rename).
- `index.lock`: exclusive file lock held for every operation, so threads
  and Span processes sharing a store serialise index updates.
- `blobs/<id>.bin`: the bytes, written to a `create_new` temp file and
  renamed into place.
- `open/<id>/<name>`: a disposable named copy for reveal, open and copy
  path (decision 5).

### 2. Record

`Upload { id, name, mime, size, kind, fingerprint, source, createdMs,
missing }`.

- `id`: 32 lowercase hex characters from two randomly keyed std
  `RandomState` hashers over time, a counter and the process id. Opaque, not
  a secret. Every entry point validates the id shape before touching disk.
- `name`: validated with the same `check_component` rules as
  `save_attachment` (no separators, control or reserved characters, no
  trailing dot or space, no Windows device names, no `.git`, `.span`,
  `node_modules`, at most 255 bytes).
- `mime` and `kind`: sniffed from magic bytes first (PNG, JPEG, GIF, WebP,
  WAV, PDF, ZIP, gzip, 7z, RAR, xz, zstd, bzip2, MP3, Ogg, FLAC, ISO media,
  Matroska, WOFF, WOFF2, OTF, TTF, SQLite, PE, ELF, Mach-O), then the
  extension, then a UTF-8 text check, else `application/octet-stream`.
  ZIP-based office formats keep their extension type. Informational only,
  never used to decide execution.
- `fingerprint`: `fnv1a128:<hex>`. No SHA-256 implementation is a direct
  dependency of `span-core`, and the brief forbids adding one, so this is a
  cheap non-cryptographic fingerprint for spotting duplicates together with
  `size`. It is not an integrity or security check. Swap for SHA-256 if a
  hash crate becomes a core dependency for another reason.
- `source`: `{ sessionId?, agentId?, messageId?, origin }`, origin one of
  `sent`, `pasted`, `dropped`, `picked`, `agent-generated`. Ids are bounded
  to 256 characters without control characters.
- `missing`: computed on list when the blob file is gone; such entries stay
  listed so the user can remove them.

### 3. Caps, refusing rather than evicting

32 MiB per file (equal to `MAX_ATTACHMENT_BYTES`), 512 MiB total, 2000
files per workspace. An add or duplicate over a cap fails with a message
naming the cap and current usage. Nothing is evicted. `uploads_usage`
reports count, bytes, caps, orphan blobs and quarantined indexes. The
`open/` copies are not counted; each is replaced on the next use and
removed with its upload.

### 4. Corrupt and future indexes

- Unreadable JSON, a wrong shape, a wrong version below the current one, or
  an index over 16 MiB is renamed to `index.corrupt-<ms>-<n>.json` and an
  empty index is used. Blobs are never deleted; they appear as
  `orphanBlobs` in usage.
- Individual entries with an invalid id, name or source, or a repeated id,
  are dropped on load; their blobs also stay as orphans.
- A `version` above the current one is refused without touching the file,
  so an older Span cannot discard a newer index.

### 5. External access: named copies only

Reveal, open and copy path never hand out the blob. The desktop asks the
store for `external_copy(id)`, which validates the id, resolves the blob
from the index (never from a UI path), requires a regular file (no
symlink), canonicalises and checks it is inside the store, then writes a
fresh copy to `open/<id>/<name>` (a symlinked `open/<id>` is removed, not
followed) and checks the copy the same way. An external editor can change
the copy but not the stored bytes.

Copy path: the UI shows the original name everywhere. "Copy path" calls
`uploads_copy_path`, which returns the app data path of the named copy,
only on that explicit action. That path is outside the workspace and is
replaced on the next reveal or open.

### 6. Launching without a shell

`std::process::Command` with null stdio, no shell, no new dependency:

| Platform | Reveal | Open |
| --- | --- | --- |
| macOS | `/usr/bin/open -R <copy>` | `/usr/bin/open -- <copy>` |
| Windows | `%SystemRoot%\explorer.exe /select,"<copy>"` (verbatim arg) | `explorer.exe "<copy>"` (verbatim arg) |
| Linux | `xdg-open <copy folder>` (resolved on PATH) | `xdg-open <copy>` |

On Windows the `\\?\` prefix from `canonicalize` is stripped and a path with
a quote is refused. explorer.exe exit codes are ignored because it returns 1
on success; other platforms report a non-zero exit.

Open is refused, with advice to use Save to workspace, when
`open_refusal(name, head, executable)` matches: an extension the system
would run, install, mount or script (exe, msi, msp, bat, cmd, com, scr, pif,
cpl, hta, ps1, psm1, vbs, vbe, js, jse, wsf, wsh, reg, lnk, url, sh, bash,
zsh, csh, ksh, fish, command, tool, terminal, workflow, app, pkg, mpkg, dmg,
jar, appimage, desktop, run, py, pyw, pl, rb, applescript, scpt), the unix
executable bit on the copy, or content starting with a PE, ELF or Mach-O
header or a `#!` line. Reveal is always allowed. The rule is a pure function
tested on every platform.

### 7. Commands

`uploads_list`, `uploads_usage`, `uploads_add(name, dataBase64, source)`
(size checked on the base64 length before decoding, as `save_attachment`
does), `uploads_read(id, offset, len)` (at most 4 MiB per call, base64),
`uploads_rename`, `uploads_duplicate`, `uploads_remove`,
`uploads_save_to_workspace(id, dir)` (through `save_attachment`: never
overwrites, refuses protected and escaping directories),
`uploads_copy_path`, `uploads_reveal`, `uploads_open`. All run on blocking
workers. Rename re-sniffs the type from the new extension, with magic bytes
still taking precedence. Duplicate picks the first free ` (n)` name among
the workspace's uploads.

## Consequences

- Uploads survive restarts and stay out of the workspace and Git until the
  user saves one.
- Deleting a workspace folder leaves its uploads in app data; there is no
  garbage collection of stores for missing workspaces yet.
- Concurrency relies on `File::lock`; on network file systems that ignore
  advisory locks, two processes could race.
- Opening a file always copies it once, up to 32 MiB of extra disk per
  opened upload until it is removed.

## UNVERIFIED

- Windows and Linux launch paths are tested only as argument construction
  on macOS. explorer.exe `/select` with verbatim quoting, `raw_arg`, the
  `\\?\` stripping and xdg-open behaviour need CI or manual runs.
- `uploads_reveal` and `uploads_open` were not exercised against a real
  Finder or default app; only unit tests ran.
- No UI calls the commands yet; the Tauri IPC round trip is covered by the
  generated bindings and type check only.
- Cross-process locking was not tested with two Span processes.
