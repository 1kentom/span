// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { FileEntry, FileIndexStatus, Workspace } from "../bindings";
import { Goto, type GotoProps } from "./Goto";
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.useRealTimers(); });
async function settle() { for (let index = 0; index < 5; index += 1) await Promise.resolve(); }
const files = ["src/first.ts", "src/second.ts", "images/logo.png"].map(path => ({ path, name: path.split("/").pop()!, isDir: false }));
function setup(extra: Partial<GotoProps> = {}) {
  const root = document.createElement("div"); document.body.append(root); const open = vi.fn(); const close = vi.fn();
  disposers.push(render(() => <Goto files={files} onOpen={open} onClose={close} onOpenFolder={vi.fn()} {...extra} />, root));
  return { root, open, close, input: root.querySelector<HTMLInputElement>("input")! };
}
function inputValue(input: HTMLInputElement, value: string) { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); }
function key(input: HTMLElement, key: string) { input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }
function selectMode(root: HTMLElement, name: string) { [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === name)!.click(); }

describe("Goto", () => {
  it("shows recent files first, navigates results and opens the actual selected file and line", async () => {
    const { root, open, close, input } = setup({ recentPaths: ["src/second.ts"] }); await settle();
    expect(document.activeElement).toBe(input);
    expect(root.querySelector('[role="option"]')?.textContent).toContain("second.ts");
    key(input, "ArrowDown"); key(input, "Enter"); expect(open).toHaveBeenCalledWith("src/first.ts", undefined); expect(close).toHaveBeenCalledOnce();
    inputValue(input, "second:23"); await settle(); key(input, "Enter"); expect(open).toHaveBeenLastCalledWith("src/second.ts", 23);
    inputValue(input, "missing"); await settle(); key(input, "ArrowDown"); key(input, "Enter"); expect(open).toHaveBeenCalledTimes(2);
  });
  it("lists only real registered actions and runs the chosen handler", async () => {
    const save = vi.fn(); const { root, input } = setup({ handlers: { save } });
    selectMode(root, "Actions"); await settle(); expect(root.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(root.textContent).not.toContain("Go to Definition"); expect(root.textContent).not.toContain("Symbols");
    key(input, "Enter"); expect(save).toHaveBeenCalledOnce();
  });
  it("debounces file previews and rejects stale responses when selection changes", async () => {
    vi.useFakeTimers();
    let first!: (value: string) => void; let second!: (value: string) => void;
    const preview = vi.fn((path: string) => new Promise<string>(resolve => { if (path === "src/first.ts") first = resolve; else second = resolve; }));
    const { root, input } = setup({ onPreview: preview }); await settle();
    await vi.advanceTimersByTimeAsync(100); expect(preview).toHaveBeenCalledWith("src/first.ts");
    key(input, "ArrowDown"); await settle(); await vi.advanceTimersByTimeAsync(100);
    second("const selected = true;"); await settle(); first("stale preview"); await settle();
    expect(root.querySelector(".goto-preview")?.textContent).toContain("const selected = true;");
    expect(root.querySelector(".goto-preview")?.textContent).not.toContain("stale preview");
    key(input, "ArrowDown"); await settle(); await vi.advanceTimersByTimeAsync(100); expect(preview).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain("Preview is unavailable for this file type");
  });
  it("keeps text search separate, ignores stale results and opens the matching line", async () => {
    vi.useFakeTimers(); let old!: (value: { path: string; line: number; column: number; text: string }[]) => void;
    const search = vi.fn((query: string) => query === "old" ? new Promise<{ path: string; line: number; column: number; text: string }[]>(resolve => { old = resolve; }) : Promise.resolve([{ path: "src/second.ts", line: 7, column: 2, text: "new match" }]));
    const { root, input, open } = setup({ onSearch: search }); await settle();
    inputValue(input, "old"); await settle(); await vi.advanceTimersByTimeAsync(200); expect(search).not.toHaveBeenCalled();
    selectMode(root, "Text Search"); await settle(); await vi.advanceTimersByTimeAsync(180);
    inputValue(input, "new"); await settle(); await vi.advanceTimersByTimeAsync(180); old([{ path: "src/first.ts", line: 2, column: 1, text: "stale match" }]); await settle();
    expect(root.querySelectorAll('[role="option"]')).toHaveLength(1); expect(root.textContent).toContain("new match"); expect(root.textContent).not.toContain("stale match");
    key(input, "Enter"); expect(open).toHaveBeenCalledWith("src/second.ts", 7);
  });
  it("dismisses with Escape", async () => {
    const { input, close } = setup(); await settle(); key(input, "Escape"); expect(close).toHaveBeenCalledOnce();
  });
  it("colors a code preview with the file grammar and keeps source text inert", async () => {
    const { root } = setup({ onPreview: async () => 'const html = "<img src=x onerror=alert(1)>";' });
    await vi.waitFor(() => expect(root.querySelector(".goto-preview .tok-keyword")?.textContent).toBe("const"));
    expect(root.querySelector(".goto-preview img")).toBeNull();
    expect(root.querySelector(".goto-preview")?.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("Goto path completion", () => {
  it("completes the selected relative path with Tab, retains focus and places the caret at its end", async () => {
    const { root, input, open, close } = setup({ workspace: { name: "project", root: "C:\\project" }, files: ["C:\\project\\src\\first.ts", "C:\\project\\src\\second.ts"].map(path => ({ path, name: path.split("\\").pop()!, isDir: false })) });
    inputValue(input, "src/"); await settle(); key(input, "ArrowDown");
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); input.dispatchEvent(event); await settle();
    expect(event.defaultPrevented).toBe(true); expect(input.value).toBe("src/second.ts"); expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(input.value.length); expect(input.selectionEnd).toBe(input.value.length);
    const selectedId = input.getAttribute("aria-activedescendant")!; expect(root.querySelector('[role="option"][aria-selected="true"]')?.id).toBe(selectedId);
    expect(open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    inputValue(input, `${input.value}:12:3`); await settle(); expect(input.getAttribute("aria-activedescendant")).toBe(selectedId); key(input, "Enter");
    expect(open).toHaveBeenCalledWith("C:\\project\\src\\second.ts", 12, 3); expect(close).toHaveBeenCalledOnce();
  });
  it("completes the first match and retains an unfinished line or column suffix", async () => {
    const { input } = setup(); inputValue(input, "fir:12:"); await settle(); key(input, "Tab"); await settle(); expect(input.value).toBe("src/first.ts:12:"); expect(input.selectionStart).toBe(input.value.length);
  });
  it("does not complete Shift+Tab, other modes, or a query with no results", async () => {
    const { root, input } = setup({ handlers: { save: vi.fn(), settings: vi.fn() }, onSearch: async () => [] }); await settle();
    const press = (shiftKey = false) => { const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }); input.dispatchEvent(event); return event; };
    inputValue(input, "fir"); await settle(); expect(press(true).defaultPrevented).toBe(false); expect(input.value).toBe("fir");
    inputValue(input, "no result"); await settle(); expect(press().defaultPrevented).toBe(false); expect(input.value).toBe("no result");
    for (const mode of ["Actions", "Tools", "Text Search"]) { selectMode(root, mode); inputValue(input, "save"); await settle(); expect(press().defaultPrevented).toBe(false); expect(input.value).toBe("save"); }
  });
  it("keeps incomplete colons matched but refuses malformed positions", async () => {
    const { root, input, open, close } = setup();
    for (const query of ["first:", "first:12:"]) { inputValue(input, query); await settle(); expect(root.querySelectorAll('[role="option"]')).toHaveLength(1); }
    key(input, "Enter"); expect(open).toHaveBeenCalledWith("src/first.ts", 12);
    for (const query of ["first:0", "first:12:0", "first:12:bad", "missing:12:3"]) { inputValue(input, query); await settle(); key(input, "Enter"); expect(root.querySelectorAll('[role="option"]')).toHaveLength(0); expect(input.hasAttribute("aria-activedescendant")).toBe(false); }
    expect(open).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it("uses the explicit active file for a line-only jump", async () => {
    const { input, open } = setup({ activePath: "src/second.ts" }); inputValue(input, ":8:2"); await settle(); key(input, "Enter"); expect(open).toHaveBeenCalledWith("src/second.ts", 8, 2);
  });
  it("preserves the selected file and its loaded preview when only its position changes", async () => {
    vi.useFakeTimers(); const preview = vi.fn(async () => Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join("\n"));
    const { root, input } = setup({ onPreview: preview }); inputValue(input, "src/"); await settle(); key(input, "ArrowDown"); await settle(); await vi.advanceTimersByTimeAsync(100);
    const selectedId = input.getAttribute("aria-activedescendant"); expect(preview).toHaveBeenCalledOnce();
    inputValue(input, "src/:12:3"); await settle(); await vi.advanceTimersByTimeAsync(100);
    expect(input.getAttribute("aria-activedescendant")).toBe(selectedId); expect(preview).toHaveBeenCalledOnce(); expect(root.querySelector(".goto-preview")?.textContent).toContain("line 12");
    inputValue(input, "no result"); await settle(); expect(root.querySelector(".goto-preview")).not.toBeNull(); expect(root.querySelector(".goto-preview")?.textContent).toContain("Select a file to preview");
  });
});


describe("indexed Goto", () => {
  const workspace = { root: "/project", name: "project" };
  const status = (indexedFiles = 0): FileIndexStatus => ({ workspaceRoot: workspace.root, generation: 1, status: "scanning", indexedFiles, scannedEntries: indexedFiles * 2, errorCount: 0, lastError: null, watcherReady: true, watcherError: null });
  const file = (path: string): FileEntry => ({ path, name: path.split("/").pop()!, isDir: false });
  it("queries incrementally, keeps fuzzy rank and recents, and ignores older query results", async () => {
    vi.useFakeTimers(); let old!: (files: FileEntry[]) => void;
    const query = vi.fn((term: string) => term === "old" ? new Promise<FileEntry[]>(resolve => { old = resolve; }) : Promise.resolve(term ? [file("zebra.ts"), file("alpha.ts")] : [file("alpha.ts")]));
    const { root, input, open } = setup({ workspace, onQueryFiles: query, recentPaths: ["recent.ts"], indexStatus: status() });
    await settle(); await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('[role="option"]')?.textContent).toContain("recent.ts");
    inputValue(input, "old"); await settle(); await vi.advanceTimersByTimeAsync(80);
    inputValue(input, "za:12:3"); await settle(); await vi.advanceTimersByTimeAsync(80);
    expect(query).toHaveBeenLastCalledWith("za");
    old([file("stale.ts")]); await settle();
    expect([...root.querySelectorAll('.goto-name')].map(node => node.textContent)).toEqual(["zebra.ts", "alpha.ts"]);
    key(input, "Enter"); expect(open).toHaveBeenCalledWith("zebra.ts", 12, 3);
  });
  it("updates partial results as indexing progresses, without changing the query", async () => {
    vi.useFakeTimers(); const [progress, setProgress] = createSignal(status());
    const query = vi.fn(async () => progress().indexedFiles ? [file("new.ts")] : []);
    const { root } = setup({ workspace, files: [], onQueryFiles: query, get indexStatus() { return progress(); } });
    await settle(); await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain("Files are still being indexed"); expect(root.textContent).toContain("0 found");
    setProgress(status(12)); await settle(); await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain("12 found"); expect(root.querySelector('.goto-name')?.textContent).toBe("new.ts");
  });
  it("rejects query and preview responses after switching workspace with the picker open", async () => {
    vi.useFakeTimers(); let pending!: (files: FileEntry[]) => void;
    const [currentWorkspace, changeWorkspace] = createSignal<Workspace>(workspace);
    const query = vi.fn(() => new Promise<FileEntry[]>(resolve => { pending = resolve; }));
    const { root } = setup({ files: [], get workspace() { return currentWorkspace(); }, onQueryFiles: query });
    await settle(); await vi.advanceTimersByTimeAsync(0); const previous = pending;
    changeWorkspace({ root: "/next", name: "next" }); await settle(); await vi.advanceTimersByTimeAsync(0);
    pending([file("fresh.ts")]); await settle(); previous([file("stale.ts")]); await settle();
    expect(root.textContent).toContain("fresh.ts"); expect(root.textContent).not.toContain("stale.ts");
  });
});


it("keeps an indexed path available for Tab completion and disambiguates real colon filenames", async () => {
  vi.useFakeTimers();
  const query = vi.fn(async () => [{ path: "deep/report:12", name: "report:12", isDir: false }]);
  const { input, open } = setup({ files: [], workspace: { root: "/project", name: "project" }, onQueryFiles: query });
  inputValue(input, "report:12"); await settle(); await vi.advanceTimersByTimeAsync(160);
  expect(query).toHaveBeenLastCalledWith("report:12");
  key(input, "Tab"); await settle(); expect(input.value).toBe("deep/report:12");
  key(input, "Enter"); expect(open).toHaveBeenLastCalledWith("deep/report:12", undefined);
  inputValue(input, "deep/report:12:9:2"); await settle(); key(input, "Enter");
  expect(open).toHaveBeenLastCalledWith("deep/report:12", 9, 2);
});

it("invalidates a pending preview when workspace changes but the relative path is identical", async () => {
  vi.useFakeTimers(); const [workspace, setWorkspace] = createSignal({ root: "/first", name: "first" });
  let resolve!: (value: string) => void;
  const preview = vi.fn(() => new Promise<string>(done => { resolve = done; }));
  const { root } = setup({ get workspace() { return workspace(); }, onPreview: preview });
  await settle(); await vi.advanceTimersByTimeAsync(100); const old = resolve;
  setWorkspace({ root: "/next", name: "next" }); await settle(); await vi.advanceTimersByTimeAsync(100);
  resolve("current workspace preview"); await settle(); old("stale workspace preview"); await settle();
  expect(root.textContent).toContain("current workspace preview"); expect(root.textContent).not.toContain("stale workspace preview");
});

it("keeps an in-flight file query alive while progress updates arrive", async () => {
  vi.useFakeTimers(); const [status, setStatus] = createSignal<FileIndexStatus>({ workspaceRoot: "/project", generation: 1, status: "scanning", indexedFiles: 0, scannedEntries: 0, errorCount: 0, lastError: null, watcherReady: true, watcherError: null });
  let resolve!: (value: FileEntry[]) => void;
  const query = vi.fn(() => new Promise<FileEntry[]>(done => { resolve = done; }));
  const { root } = setup({ files: [], workspace: { root: "/project", name: "project" }, get indexStatus() { return status(); }, onQueryFiles: query });
  await settle(); await vi.advanceTimersByTimeAsync(0);
  setStatus({ ...status(), indexedFiles: 10, scannedEntries: 20 }); await settle(); await vi.advanceTimersByTimeAsync(1000);
  expect(query).toHaveBeenCalledTimes(1);
  resolve([{ path: "fresh.ts", name: "fresh.ts", isDir: false }]); await settle();
  expect(root.querySelector('.goto-name')?.textContent).toBe("fresh.ts");
});


it("refreshes the same file query on a discovery policy change and drops the prior reply", async () => {
  vi.useFakeTimers();
  const [revision, setRevision] = createSignal(0);
  const replies: ((files: FileEntry[]) => void)[] = [];
  const query = vi.fn(() => new Promise<FileEntry[]>(resolve => replies.push(resolve)));
  const { root } = setup({ files: [], workspace: { root: "/project", name: "project" }, get discoveryRevision() { return revision(); }, onQueryFiles: query });
  await settle(); await vi.advanceTimersByTimeAsync(0);
  setRevision(1); await settle(); await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledTimes(2);
  replies[1]([{ path: "visible.ts", name: "visible.ts", isDir: false }]); await settle();
  replies[0]([{ path: ".hidden.ts", name: ".hidden.ts", isDir: false }]); await settle();
  expect(root.querySelector('.goto-name')?.textContent).toBe("visible.ts");
  expect(root.textContent).not.toContain(".hidden.ts");
});

it("refreshes text matches after a discovery policy change and rejects old results", async () => {
  vi.useFakeTimers();
  const [revision, setRevision] = createSignal(0);
  const replies: ((matches: { path: string; line: number; column: number; text: string }[]) => void)[] = [];
  const search = vi.fn(() => new Promise<{ path: string; line: number; column: number; text: string }[]>(resolve => replies.push(resolve)));
  const { root, input } = setup({ workspace: { root: "/project", name: "project" }, get discoveryRevision() { return revision(); }, onSearch: search });
  selectMode(root, "Text Search"); inputValue(input, "marker"); await settle(); await vi.advanceTimersByTimeAsync(180);
  setRevision(1); await settle(); await vi.advanceTimersByTimeAsync(180);
  expect(search).toHaveBeenCalledTimes(2);
  replies[1]([{ path: "visible.ts", line: 1, column: 1, text: "new marker" }]); await settle();
  replies[0]([{ path: ".hidden.ts", line: 1, column: 1, text: "old marker" }]); await settle();
  expect(root.textContent).toContain("new marker"); expect(root.textContent).not.toContain("old marker");
});
