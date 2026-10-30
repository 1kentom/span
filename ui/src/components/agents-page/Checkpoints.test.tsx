// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { createCheckpoints, rememberFollow, rememberedFollow, restoreConfirmText, type CheckpointApi, type CheckpointStore } from "../../lib/checkpoints";
import { mount, text } from "../agent/test-utils";
import { CheckpointChanges, CheckpointTimeline, CheckpointUndoToast } from "./Checkpoints";

vi.mock("../../lib/client", () => ({ isDesktop: true }));

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const file = (path: string) => ({
  path,
  kind: "modified" as const,
  additions: 1,
  deletions: 1,
  binary: false,
  hunks: [
    { id: "h0", from: 0, to: 2, before: "a\n", after: "A\n" },
    { id: "h1", from: 4, to: 6, before: "c\n", after: "C\n" },
  ],
});

function fakeApi(overrides: Partial<CheckpointApi> = {}): CheckpointApi & { calls: string[] } {
  const calls: string[] = [];
  const api: CheckpointApi = {
    status: vi.fn(async () => ({ available: true, reason: null, canInit: false })),
    enable: vi.fn(async () => ({ available: true, reason: null, canInit: false })),
    list: vi.fn(async () => [
      { turn: 1, capturedAt: 1, hasStart: true, hasEnd: true, changedFiles: 1 },
      { turn: 2, capturedAt: 2, hasStart: true, hasEnd: true, changedFiles: 2 },
    ]),
    changes: vi.fn(async (_session: string, turn: number | null) => {
      calls.push(`changes:${turn}`);
      return { sessionId: "s", turn, revision: turn === null ? "a..c" : "b..c", files: turn === null ? [file("src/one.ts"), file("two.ts")] : [file("src/one.ts")] };
    }),
    revertHunks: vi.fn(async (_s: string, revision: string, hunks) => {
      calls.push(`revertHunks:${revision}:${hunks.map((h: { path: string; hunkId: string }) => `${h.path}#${h.hunkId}`).join(",")}`);
      return { reverted: hunks, revertedFiles: [], conflicts: [], undoId: "1" };
    }),
    revertFiles: vi.fn(async (_s: string, revision: string, paths: string[]) => {
      calls.push(`revertFiles:${revision}:${paths.join(",")}`);
      return { reverted: [], revertedFiles: paths, conflicts: [], undoId: "2" };
    }),
    restore: vi.fn(async (_s: string, turn: number) => {
      calls.push(`restore:${turn}`);
      return { restored: ["src/one.ts"], skipped: [], undoId: "3" };
    }),
    undo: vi.fn(async (_s: string, id: string) => {
      calls.push(`undo:${id}`);
      return { restored: ["src/one.ts"], skipped: [], undoId: "4" };
    }),
    onChanged: vi.fn(async () => () => {}),
    ...overrides,
  };
  return Object.assign(api, { calls });
}

function setup(api: CheckpointApi, running = false) {
  let store!: CheckpointStore;
  const opened: string[] = [];
  const host = mount(() => {
    const [session] = createSignal<string | undefined>("s");
    store = createCheckpoints(session, api);
    return (
      <>
        <CheckpointTimeline store={store} running={running} onViewChanges={(turn) => store.viewTurn(turn)} />
        <CheckpointChanges store={store} running={running} onOpenFile={(path) => opened.push(path)} showUnavailable />
        <CheckpointUndoToast store={store} />
      </>
    );
  });
  return { host, store: () => store, opened };
}

const button = (host: ParentNode, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label || text(b) === label) as HTMLButtonElement | undefined;

describe("checkpoint changes", () => {
  it("filters between all turns and this turn", async () => {
    const api = fakeApi();
    const { host } = setup(api);
    await flush();
    expect(host.querySelectorAll(".cp-file")).toHaveLength(2);
    expect(button(host, "All turns")?.getAttribute("aria-checked")).toBe("true");
    button(host, "This turn")!.click();
    await flush();
    expect(api.calls).toContain("changes:2");
    expect(host.querySelectorAll(".cp-file")).toHaveLength(1);
    expect(text(host.querySelector(".cp-filter [aria-checked='true']"))).toBe("Turn 2");
  });

  it("reverts one hunk with the revision it was shown with and offers Undo", async () => {
    const api = fakeApi();
    const { host } = setup(api);
    await flush();
    button(host, "Revert change 2 in src/one.ts")!.click();
    await flush();
    expect(api.calls).toContain("revertHunks:a..c:src/one.ts#h1");
    expect(text(host.querySelector(".cp-toast"))).toContain("Reverted 1 change");
    button(host, "Undo")!.click();
    await flush();
    expect(api.calls).toContain("undo:1");
  });

  it("shows a conflict when a hunk no longer applies", async () => {
    const api = fakeApi({
      revertHunks: vi.fn(async () => ({ reverted: [], revertedFiles: [], conflicts: [{ path: "src/one.ts", hunkId: "h0", reason: "The file changed after this turn, so this change no longer applies." }], undoId: null })),
    });
    const { host } = setup(api);
    await flush();
    button(host, "Revert change 1 in src/one.ts")!.click();
    await flush();
    expect(text(host.querySelector(".cp-changes [role='alert']"))).toContain("Could not revert src/one.ts: The file changed after this turn");
    expect(host.querySelector(".cp-toast")).toBeNull();
  });

  it("reverts all files and opens a file only on an explicit click", async () => {
    const api = fakeApi();
    const { host, opened } = setup(api);
    await flush();
    expect(opened).toEqual([]);
    button(host, "Revert all")!.click();
    await flush();
    expect(api.calls).toContain("revertFiles:a..c:src/one.ts,two.ts");
    (host.querySelector(".cp-file .sb-link") as HTMLButtonElement).click();
    expect(opened).toEqual(["src/one.ts"]);
  });

  it("shows the unavailable state with an explicit Enable checkpoints action", async () => {
    const api = fakeApi({ status: vi.fn(async () => ({ available: false, reason: "This folder is not a Git repository, so Span cannot keep checkpoints.", canInit: true })) });
    const { host } = setup(api);
    await flush();
    expect(api.enable).not.toHaveBeenCalled();
    expect(text(host.querySelector(".cp-unavailable"))).toContain("not a Git repository");
    expect(host.querySelector(".cp-timeline")).toBeNull();
    expect(host.querySelector(".cp-changes")).toBeNull();
    button(host, "Enable checkpoints (git init)")!.click();
    await flush();
    expect(api.enable).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the session has no checkpoints", async () => {
    const api = fakeApi({ list: vi.fn(async () => []) });
    const { host } = setup(api);
    await flush();
    expect(host.querySelector(".cp-timeline")).toBeNull();
    expect(host.querySelector(".cp-changes")).toBeNull();
  });
});

describe("checkpoint timeline", () => {
  it("lists one row per turn with its changed file count", async () => {
    const { host } = setup(fakeApi());
    await flush();
    const rows = Array.from(host.querySelectorAll(".cp-turn")).map((row) => text(row.querySelector(".cp-turn-meta")));
    expect(rows).toEqual(["Turn 1 · 1 file changed", "Turn 2 · 2 files changed"]);
    expect(text(host.querySelector(".cp-turn .cp-turn-title"))).toBe("Checkpoint");
  });

  it("marks the running turn as capturing and blocks restore while it runs", async () => {
    const api = fakeApi({ list: vi.fn(async () => [{ turn: 1, capturedAt: 1, hasStart: true, hasEnd: false, changedFiles: 0 }]) });
    const { host } = setup(api, true);
    await flush();
    expect(text(host.querySelector(".cp-turn-meta"))).toBe("Turn 1 · Capturing checkpoint");
    expect(button(host, "Restore files to before this turn")?.disabled).toBe(true);
  });

  it("confirms a restore, says the conversation is not rolled back, then offers Undo", async () => {
    const api = fakeApi();
    const { host } = setup(api);
    await flush();
    button(host, "Restore files to before this turn")!.click();
    await flush();
    const dialog = document.querySelector("[role='dialog']");
    expect(text(dialog)).toContain("Restore files to before turn 1?");
    expect(text(dialog)).toContain("The agent conversation is NOT rolled back.");
    expect(api.calls).not.toContain("restore:1");
    button(document, "Restore files")!.click();
    await flush();
    expect(api.calls).toContain("restore:1");
    expect(text(host.querySelector(".cp-toast"))).toContain("Restored 1 file to before turn 1.");
    button(host, "Undo")!.click();
    await flush();
    expect(api.calls).toContain("undo:3");
  });

  it("cancelling the confirm restores nothing", async () => {
    const api = fakeApi();
    const { host } = setup(api);
    await flush();
    button(host, "Restore files to before this turn")!.click();
    await flush();
    button(document, "Cancel")!.click();
    await flush();
    expect(api.restore).not.toHaveBeenCalled();
  });

  it("reports a failed restore with its reason", async () => {
    const api = fakeApi({ restore: vi.fn(async () => Promise.reject(new Error("Span could not take the snapshot it needs before restoring"))) });
    const { host } = setup(api);
    await flush();
    button(host, "Restore files to before this turn")!.click();
    await flush();
    button(document, "Restore files")!.click();
    await flush();
    expect(text(host.querySelector(".cp-timeline [role='alert']"))).toContain("could not take the snapshot");
  });

  it("View changes switches the filter to that turn", async () => {
    const api = fakeApi();
    const { host, store } = setup(api);
    await flush();
    button(host, "View changes")!.click();
    await flush();
    expect(store().filter()).toBe("turn");
    expect(api.calls).toContain("changes:1");
  });

  it("restore confirm text is fixed", () => {
    expect(restoreConfirmText(3).body).toContain("NOT rolled back");
  });
});

describe("follow agent preference", () => {
  it("is off by default and remembered once toggled", () => {
    localStorage.removeItem("span.agents.followAgent");
    expect(rememberedFollow()).toBe(false);
    rememberFollow(true);
    expect(rememberedFollow()).toBe(true);
    rememberFollow(false);
    expect(rememberedFollow()).toBe(false);
  });
});
