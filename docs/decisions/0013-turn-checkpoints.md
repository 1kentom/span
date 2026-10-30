# 0013: Turn checkpoints

Status: accepted on 2026-10-30 under the owner's delegation for agent mode
phases 4 and 5a (ADR 0011). Builds on 0003 (edit review stays user only),
0011 (agent mode, phases 4 and 5) and the local Git service in
`crates/core/src/git`.

## Context

Proposal review (edit proposals in `crates/core/src/proposal_diff.rs`,
`agent_review` and `agent_review_hunks`) only covers agents that route
writes through Span. Agents that write files directly (OpenCode, any agent
with its own file tools, shell commands) change the disk before Span sees
anything, so there is nothing to accept or reject. Rewind and fork
(`ui/src/lib/agent-rewind.ts`) start a new session and cannot undo edits
already on disk.

T3 Code (read from its public docs and source, not run) keeps checkpoints as
commits on hidden refs, built with a temporary `GIT_INDEX_FILE`, so nothing
lands on the user's branch, and restores all files of a checkpoint or none.
Zed's checkpoint restore has no undo (ADR 0011 research), which is the
failure this record is written to avoid.

## Decisions

### a. Snapshots are commits on hidden refs

- Refs: `refs/span/checkpoints/<session>/turns/<turn>/start` and `/end`,
  and `refs/span/checkpoints/<session>/restores/<n>` for undo points. The
  session part is the session id when it is plain (letters, digits, `-`,
  `_`), otherwise a short stable hash. The turn number is zero padded.
- The commit message is `span checkpoint <session> <label>`, nothing else.
  No prompt text, reply text or file names are stored in refs or messages.
- Commits have a fixed `Span` identity and are never signed
  (`commit-tree --no-gpg-sign`).
- Two snapshots of the same tree share one commit (a start right after the
  previous end is an alias of it).

### b. Capture never touches the user's Git state

- Built with plumbing only: `ls-files --cached --others --exclude-standard`
  for the file list (so `.gitignore` is respected and untracked files are
  included), `hash-object -w --no-filters --stdin-paths` for blobs,
  `update-index --index-info` and `write-tree` against a private index file
  in a temporary folder, `commit-tree`, and `update-ref --stdin`.
- No hooks run: `update-ref` and `commit-tree` get `core.hooksPath`
  pointing at an empty private folder. No configured clean filter, textconv,
  external diff or signing helper runs (`--no-filters`, `--no-textconv`,
  `--no-ext-diff`, `--no-gpg-sign`). Read-only calls set
  `GIT_OPTIONAL_LOCKS=0` on top of the runner's `--no-optional-locks`.
- Because nothing configurable runs, capture does not wait for the Git
  panel's per-session "Enable Git" consent. The Git panel's consent still
  governs status, staging and commits.
- All calls go through the shared guarded runner (`git/process.rs`), with its
  environment scrubbing, timeout, output cap and cancellation. There is no
  second Git runner.
- Excluded: `.span` in the workspace, anything under a `.git` folder,
  symlinks, folders and nested repositories.
- Caps: 20,000 files and 256 MiB in total, otherwise the turn is not
  checkpointed and the status says why. Files over 4 MiB are left out of
  snapshots and are never written or deleted by a restore.
- A folder that is not in a Git repository gets `Unavailable { reason }`.
  "Enable checkpoints" runs `git init` only as an explicit user action
  (`checkpoint_enable`); Span never initialises a repository on its own.
- When the workspace is a subfolder of a repository, only that subfolder is
  captured, compared and restored.

### c. When snapshots are taken

- Start: in `prompt_key`, before the prompt goes to the agent, only for an
  idle session. It waits at most 1.5 s. A slower capture is cancelled (a
  late snapshot could include the agent's first edits) and the turn has no
  checkpoint; the prompt is never held longer.
- End: after the turn completes, in the background, serialised per session
  so start and end land in order. `CheckpointsChanged { sessionId }` tells
  the UI to refresh.
- A prompt refused because the session is busy drops its start snapshot.
- Follow-ups the session manager runs from its own queue are not wrapped
  (they do not pass through `prompt_key`); their changes appear in the
  next wrapped turn or in "All turns".
- Retention: the last 50 turns and the last 20 undo points per session.
  Deleting a session deletes its refs. Git's own garbage collection frees
  the objects later.

### d. Review, revert and restore are user only

- Commands: `checkpoint_status`, `checkpoint_enable`, `checkpoint_list`,
  `checkpoint_turn_changes`, `checkpoint_revert_hunks`,
  `checkpoint_revert_files`, `checkpoint_restore`,
  `checkpoint_undo_restore`. They are Tauri commands only. No ACP request,
  MCP method or span-agents tool reaches them (a test checks the tool
  server sources), following ADR 0003.
- Diffs reuse `ProposalHunk` (line hunks from `proposal_diff::line_edits`,
  in the pre-turn file's UTF-16 coordinates), so the existing diff views
  render them. Each view carries a `revision` (the two commits compared);
  revert takes it back and refuses when it no longer names this session's
  snapshots, so hunk ids cannot drift.
- Revert hunk: the hunk's post-turn text is located in the current file
  with up to three unchanged lines of context on each side and must match
  in exactly one place; otherwise that hunk is refused and reported as a
  conflict. Other hunks still apply. Added, deleted and binary files revert
  as a whole and only when the file still equals the post-turn content.
- Restore turn: the folder's files go back to the turn's start (all files
  that differ, including later work). The agent conversation is not rolled
  back, and the UI says so before asking.
- Every revert and restore first captures a "before" snapshot and refuses
  to touch files if it cannot. After writing it captures an "after" snapshot
  whose parent is the "before" one, and records it as an undo point. A
  failed write puts back every file already written before reporting.
- Undo writes the "before" content back only for files that still hold
  exactly what the restore wrote; files changed since are left alone and
  listed. Undo is itself recorded as an undo point.
- Per-turn diffs do not yet exclude files merged in from elsewhere (T3
  Code's merged-in filter); a turn shows everything that changed on disk
  during it, including edits by the user or another thread in the same
  folder.

## UNVERIFIED

- No native window pass: the Changes tab filter, turn timeline, confirm
  dialog and Undo toast are verified only in component tests.
- No real agent writing files directly (OpenCode or another) has been run
  against this; turn wrapping is verified with unit tests of the core logic
  against real temporary Git repositories and a desktop test that a turn
  without a workspace gets no checkpoint without waiting.
- Windows: executable bits and path handling are untested there; symlinks
  are skipped on every platform.
- Capture cost on large repositories (near the caps) is not measured.

## Consequences

- Users see their changes and can undo them for every agent, not only
  those that send edit proposals.
- Hidden refs live in the user's repository. They do not show in
  `git branch` or `git status`, but `git for-each-ref` and some Git GUIs
  list them, and they keep objects alive until pruned.
- A restore is all or nothing for the files it can touch and always
  undoable; it never pretends to roll back the conversation.
