// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
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
