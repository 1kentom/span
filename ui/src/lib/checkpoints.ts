import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { commands, events } from "../bindings";
import type {
  CheckpointChanges_Serialize as CheckpointChanges,
  CheckpointConflict_Serialize as CheckpointConflict,
  CheckpointFileChange,
  CheckpointHunkRef,
  CheckpointRestoreReport_Serialize as CheckpointRestoreReport,
  CheckpointRevertReport_Serialize as CheckpointRevertReport,
  CheckpointStatus_Serialize as CheckpointStatus,
  CheckpointTurn,
  ProposalHunk,
} from "../bindings";
import type { DiffLine } from "../components/agent/types";
import { diffLines } from "./agent-view";
import { isDesktop } from "./client";

export type { CheckpointChanges, CheckpointConflict, CheckpointFileChange, CheckpointTurn };

/** The checkpoint commands (ADR 0013). Every one is a user action; nothing here is reachable from an agent. */
export type CheckpointApi = {
  status(): Promise<CheckpointStatus>;
  enable(): Promise<CheckpointStatus>;
  list(sessionId: string): Promise<CheckpointTurn[]>;
  changes(sessionId: string, turn: number | null): Promise<CheckpointChanges>;
  revertHunks(sessionId: string, revision: string, hunks: CheckpointHunkRef[]): Promise<CheckpointRevertReport>;
  revertFiles(sessionId: string, revision: string, paths: string[]): Promise<CheckpointRevertReport>;
  restore(sessionId: string, turn: number): Promise<CheckpointRestoreReport>;
  undo(sessionId: string, undoId: string): Promise<CheckpointRestoreReport>;
  onChanged(listener: (sessionId: string) => void): Promise<() => void>;
};

export const desktopCheckpointApi: CheckpointApi = {
  status: () => commands.checkpointStatus(),
  enable: () => commands.checkpointEnable(),
  list: (sessionId) => commands.checkpointList(sessionId),
  changes: (sessionId, turn) => commands.checkpointTurnChanges(sessionId, turn),
  revertHunks: (sessionId, revision, hunks) => commands.checkpointRevertHunks(sessionId, revision, hunks),
  revertFiles: (sessionId, revision, paths) => commands.checkpointRevertFiles(sessionId, revision, paths),
  restore: (sessionId, turn) => commands.checkpointRestore(sessionId, turn),
  undo: (sessionId, undoId) => commands.checkpointUndoRestore(sessionId, undoId),
  onChanged: async (listener) => (isDesktop ? events.checkpointsChanged.listen((event) => listener(event.payload.sessionId)) : () => {}),
};

export type ChangeFilter = "all" | "turn";

/** The confirm dialog's text: a restore changes files only, never the conversation. */
export function restoreConfirmText(turn: number): { title: string; body: string; confirm: string } {
  return {
    title: `Restore files to before turn ${turn}?`,
    body: "Files in this folder go back to how they were before this turn, including later changes. The agent conversation is NOT rolled back. Span saves a snapshot first, so you can undo this.",
    confirm: "Restore files",
  };
}

export function turnSummary(turn: CheckpointTurn, running: boolean): string {
  if (!turn.hasEnd) return running ? "Capturing checkpoint" : "No checkpoint at the end of this turn";
  if (!turn.changedFiles) return "No files changed";
  return turn.changedFiles === 1 ? "1 file changed" : `${turn.changedFiles} files changed`;
}

/** A checkpoint hunk as unified diff lines; offsets are not line numbers, so lines carry none. */
export function hunkLines(hunk: ProposalHunk): DiffLine[] {
  const trim = (text: string) => text.replace(/\n$/, "");
  return diffLines(trim(hunk.before), trim(hunk.after)).map((line) => ({ kind: line.kind, text: line.text }));
}

export function conflictText(conflicts: readonly CheckpointConflict[]): string | undefined {
  if (!conflicts.length) return undefined;
  const first = conflicts[0];
  const more = conflicts.length > 1 ? ` (and ${conflicts.length - 1} more)` : "";
  return `Could not revert ${first.path}${more}: ${first.reason}`;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong";
}

export type UndoOffer = { undoId: string; text: string };

/**
 * One session's checkpoints: status, turns and the filtered change set, refreshed when the backend says they changed.
 * Revert and restore results land in `notice` (conflicts, failures) and `undo` (the Undo toast's target).
 */
export function createCheckpoints(sessionId: () => string | undefined, api: CheckpointApi = desktopCheckpointApi) {
  const [status, setStatus] = createSignal<CheckpointStatus>();
  const [turns, setTurns] = createSignal<CheckpointTurn[]>([]);
  const [filter, setFilter] = createSignal<ChangeFilter>("all");
  const [selected, setSelected] = createSignal<number>();
  const [changes, setChanges] = createSignal<CheckpointChanges>();
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<string>();
  const [undo, setUndo] = createSignal<UndoOffer>();
  let generation = 0;

  /** The turn "This turn" shows: the one picked from the timeline, else the newest. */
  const focusTurn = () => selected() ?? turns().at(-1)?.turn;

  async function refresh() {
    const session = untrack(sessionId);
    const ticket = ++generation;
    if (!session) {
      setTurns([]);
      setChanges(undefined);
      return;
    }
    try {
      const nextStatus = await api.status();
      if (ticket !== generation) return;
      setStatus(nextStatus);
      if (!nextStatus.available) {
        setTurns([]);
        setChanges(undefined);
        return;
      }
      const list = await api.list(session);
      if (ticket !== generation) return;
      setTurns(list);
      const turn = untrack(filter) === "turn" ? (untrack(selected) ?? list.at(-1)?.turn ?? null) : null;
      if (!list.length || (untrack(filter) === "turn" && turn === null)) {
        setChanges(undefined);
        return;
      }
      const next = await api.changes(session, turn);
      if (ticket === generation) setChanges(next);
    } catch (error) {
      if (ticket === generation) setNotice(message(error));
    }
  }

  createEffect(() => {
    sessionId();
    filter();
    selected();
    void refresh();
  });
  createEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void api.onChanged((changed) => {
      if (changed === untrack(sessionId)) void refresh();
    })
      .then((unlisten) => (live ? (stop = unlisten) : unlisten()))
      .catch(() => undefined);
    onCleanup(() => {
      live = false;
      stop?.();
    });
  });

  async function act<T>(work: (session: string) => Promise<T>, done: (result: T) => void) {
    const session = sessionId();
    if (!session || busy()) return;
    setBusy(true);
    setNotice(undefined);
    try {
      done(await work(session));
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const afterRevert = (report: CheckpointRevertReport) => {
    setNotice(conflictText(report.conflicts));
    if (report.undoId) {
      const count = report.reverted.length || report.revertedFiles.length;
      setUndo({ undoId: report.undoId, text: count === 1 ? "Reverted 1 change" : `Reverted ${count} changes` });
    }
  };

  return {
    status,
    turns,
    filter,
    setFilter,
    focusTurn,
    changes,
    busy,
    notice,
    clearNotice: () => setNotice(undefined),
    undo,
    clearUndo: () => setUndo(undefined),
    refresh,
    /** Show one turn's changes (the timeline's View changes). */
    viewTurn(turn: number) {
      setSelected(turn);
      setFilter("turn");
    },
    showAll() {
      setSelected(undefined);
      setFilter("all");
    },
    enable: () => act(() => api.enable(), (next) => setStatus(next)),
    revertHunk(path: string, hunkId: string) {
      const revision = changes()?.revision;
      if (revision) return act((session) => api.revertHunks(session, revision, [{ path, hunkId }]), afterRevert);
    },
    revertFile(path: string) {
      const revision = changes()?.revision;
      if (revision) return act((session) => api.revertFiles(session, revision, [path]), afterRevert);
    },
    revertAll() {
      const current = changes();
      if (current?.revision && current.files.length) {
        const revision = current.revision;
        return act((session) => api.revertFiles(session, revision, current.files.map((file) => file.path)), afterRevert);
      }
    },
    restore(turn: number) {
      return act(
        (session) => api.restore(session, turn),
        (report) => {
          const skipped = report.skipped.length ? ` ${report.skipped.length} left as they were.` : "";
          if (report.skipped.length) setNotice(`Some files were not restored: ${report.skipped[0].path}: ${report.skipped[0].reason}`);
          if (report.undoId) setUndo({ undoId: report.undoId, text: `Restored ${report.restored.length === 1 ? "1 file" : `${report.restored.length} files`} to before turn ${turn}.${skipped}` });
          else if (!report.skipped.length) setNotice("Files already match this checkpoint.");
        },
      ).catch(() => undefined);
    },
    undoLast() {
      const offer = undo();
      if (!offer) return;
      setUndo(undefined);
      return act(
        (session) => api.undo(session, offer.undoId),
        (report) => {
          if (report.skipped.length) setNotice(`Undo left ${report.skipped.length === 1 ? "1 file" : `${report.skipped.length} files`} as they were because they changed since: ${report.skipped[0].path}`);
        },
      );
    },
  };
}

export type CheckpointStore = ReturnType<typeof createCheckpoints>;

/** Follow agent is remembered per device. Storage can be missing or blocked, so every access is guarded. */
const FOLLOW_KEY = "span.agents.followAgent";
export function rememberedFollow(): boolean {
  try {
    return globalThis.localStorage?.getItem(FOLLOW_KEY) === "1";
  } catch {
    return false;
  }
}
export function rememberFollow(on: boolean) {
  try {
    globalThis.localStorage?.setItem(FOLLOW_KEY, on ? "1" : "0");
  } catch {
    /* Storage blocked: the toggle still works for this session. */
  }
}
