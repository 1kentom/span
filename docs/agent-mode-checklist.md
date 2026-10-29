# Agent mode native checklist

The owner's visual pass in the native app at each agent mode phase gate
(ADR 0011, section e). Agents working on Span cannot see the native window,
so this pass is the only native evidence for these phases. Record the
result on the phase PR or the tracking issue: build or commit, date, macOS
version, which agents were used, and each item as pass, fail (with what was
seen) or not checked.

## Before every pass

- Install the build named on the PR (not an older installed app).
- Open a small test folder that is a git repository with a few files.
- Have at least two installed agents signed in. Use read-only prompts
  unless the phase needs edits.
- Note the light or dark appearance used; check both when the phase changes
  layout or colours.

## Every phase (regression)

- Editor mode: the agent sidebar opens, connects, sends a prompt and shows
  the reply as before.
- Permission prompts still appear for an agent in ask mode (ask it to edit
  a file).
- Settings > Agents shows its switches and they persist after a restart.
- No error card or blank panel at startup.
- Agent health check (ADR 0010): with the app open and an agent connected
  for 10 minutes or more, History shows no "Health check. Reply with exactly
  one word" rows, in this workspace and in All folders. Earlier leftovers
  are gone after a restart where the agent supports `session/delete`.
- Delegation thread clutter (ADR 0003, amendment of 2026-10-29): have a
  Claude lead delegate one task to Codex and send it three follow-ups with
  `message`. History (this workspace and All folders, on Claude and on
  Codex) shows only the lead's row, never a child row; the delegation card
  inside the lead still opens the child. `claude --resume` in the workspace
  does not list the Claude child. Ten minutes after the child's last task,
  or when the lead chat is closed or the app quits, the child is closed or
  deleted where the agent supports it, and a late `message` gets the "closed
  after sitting idle" error. A fifth parallel delegation is refused while
  four run. Reopening the app resumes the last chat without leaving an
  extra empty session in the agent's history.

## Phase 1: backend multi-session

Mostly invisible; check that nothing regressed.

- Two chats on two agents (start one, switch agent, start another): each
  keeps its own replies, and a permission prompt answers the chat it came
  from.
- Settings shows "Store transcripts" (or the final label) on by default.
- Clear history removes past threads' content; History rows remain as
  metadata only.
- Quit and reopen: a thread from an agent without `session/load` reopens
  with its stored content; one with load is replayed by the agent, not
  shown twice.
- The app data folder holds the transcript files; the workspace and
  `.span` hold none.

## Phase 2: frontend stores

- Sidebar behaviour unchanged: connect, prompt, stop, queue a follow-up,
  switch agent with the divider, History, rename, archive, export.
- A delegated child's card and permission still appear in the lead's chat.
- Health dots and the live agents strip still update.
- Two chats on one agent (thread store, part 2b): leave one running with a
  queued message and a half typed draft, start a new chat, then go back
  through History. The running chat's output kept arriving, and its queue
  and draft are intact; the new chat never showed its output.
- A permission request in the background chat raises the attention count
  only, and its dock appears after switching to that chat.

## Phase 3: page shell

- The Editor/Agents control switches views; Cmd+Shift+A does the same and
  focus lands in the new view.
- Agents page: sessions rail, thread in the centre, side panel with
  Changes, Agents and Files tabs, matching the local design reference in
  layout and spacing.
- A running thread keeps running when switching to Editor and back; the
  same thread shows the same feed in the sidebar and on the page.
- Narrow window: rail and side panel collapse without overlap or clipped
  text.
- Keyboard only: reach the rail, the thread, the composer and each tab.

## Phase 4: review

- Ask an agent to edit two files. The Changes tab lists both with line
  counts, including a file the agent wrote with its own tools.
- Accept one hunk and reject another in the same file; the file on disk
  matches what was accepted.
- Follow-agent: the editor or Files tab follows the file being edited, and
  turning it off stops that.

## Phase 5: checkpoints, plan mode, permissions

- Restore a checkpoint: all files go back, then undo the restore and the
  later work comes back.
- `git branch -a` and `git status` show no new branches or staged changes
  from checkpoints.
- Plan mode: the agent proposes but no file changes and no command runs.
- Per-thread mode: set a looser mode on one thread; another thread on the
  same agent still asks.
- A workspace `.span/settings.jsonc` that tries to set a mode has no effect.

## Phase 6: worktrees, steer or queue, goals, child tree

- A new thread gets its own worktree; edits there do not appear in the main
  folder until merged by the user.
- Sending while a turn runs offers steer or queue, and each does what it
  says.
- A goal or budget on a thread is shown and the thread stops when it is
  reached.
- Delegated children appear nested under their lead in the rail; stopping
  the lead stops them.

## Phase 7: verification

- Run the full list above on the release candidate build.
- VoiceOver: rail items, thread messages, tabs and permission prompts are
  announced with names and states.
- Reduce motion on: no animated dots or transitions.

## Drag and drop (native pass)

Covered by vitest with mocked Tauri drag-drop events; none of this has been
exercised in a native window yet. Check on macOS and on Windows (WebView2):

- Finder or Explorer file onto the AI panel (anywhere on it, not only the
  prompt box): the full panel "Drop to attach" overlay shows while hovering
  the panel and hides when the pointer moves over the editor or leaves.
- Drop several files at once: one chip each, with icon, name and size;
  clicking a chip opens the shared viewer; the remove button works.
- A file from inside the open project becomes a workspace chip (no copy in
  Uploads after sending); a file from elsewhere is kept in Uploads on send.
- A folder from inside the project attaches as an outline; a folder from
  elsewhere attaches as a path only and is not listed.
- Hit testing on a Retina display, a 100% Windows display, and a scaled
  Windows display (125% or 150%), and with the window zoomed in and out:
  drops just inside the panel's left edge attach, drops just outside do not.
- A Finder file dropped on the editor area: a file inside the project opens
  in the group under the pointer; a file outside the project, or with no
  project open, shows a notice and never switches the project, opens its
  folder, prompts, or adds it to recent projects, even with unsaved edits.
- A single folder dropped on the editor asks about unsaved changes before
  switching, the same as Open Folder.
- Explorer row (file or folder) and an editor tab dragged onto the AI panel:
  the drag label reads "attach to AI" and release adds a chip; the tab stays
  open in its group.
- Selected editor text dragged onto the prompt box inserts at the drop
  position; onto the rest of the panel it is appended; long text becomes a
  "Pasted text" chip. On Windows, HTML text dragging may stay blocked by the
  native drop handler (see docs/internal-dragging.md); note the result.
- An image dragged from Finder, from a browser, and from Span's own image
  viewer attaches as an image chip.
