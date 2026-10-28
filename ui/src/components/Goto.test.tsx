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
