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
