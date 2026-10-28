// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import { Explorer } from "./Explorer";
import { setCompactFolders } from "../lib/explorer-prefs";
import type { FileEntry } from "../bindings";

// Fixture-only tests: an in-memory fake of the workbench surface the Explorer uses.
const dir = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: true } as FileEntry);
const file = (path: string): FileEntry => ({ name: path.split("/").pop()!, path, isDir: false } as FileEntry);
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
beforeEach(() => setCompactFolders(true));
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setTimeout(done, 0)); };

function fake(disk: Record<string, FileEntry[]>, active = "") {
  const [directories, setDirectories] = createStore<Record<string, FileEntry[]>>({ "": disk[""] });
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set([""]));
  const [generation] = createSignal(0);
  const listed: string[] = [];
  const loadDirectory = async (path: string) => { await Promise.resolve(); listed.push(path); setDirectories(path, disk[path] ?? []); };
  const toggleDirectory = async (path: string) => {
    if (expanded().has(path)) setExpanded(c => { const n = new Set(c); n.delete(path); return n; });
    else { if (!directories[path]) await loadDirectory(path); setExpanded(c => new Set([...c, path])); }
  };
  const workbench = { directories, expanded, loadDirectory, toggleDirectory, activePath: () => active, dirty: () => false, workspace: () => ({ name: "ws", root: "/ws" }), workspaceGeneration: generation, requestWorkspace: () => {}, search: async () => {}, searching: () => false, searchResults: () => [] };
  const root = document.createElement("div"); document.body.append(root);
  disposers.push(render(() => <Explorer workbench={workbench as never} view="Files" onNavigate={() => {}} />, root));
  return { root, expanded, listed, setDirectories, rows: () => Array.from(root.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')) };
}
const disk = {
  "": [dir("com"), file("README.md")],
  com: [dir("com/example")], "com/example": [dir("com/example/todo")],
  "com/example/todo": [file("com/example/todo/A.java"), dir("com/example/todo/ui")], "com/example/todo/ui": [file("com/example/todo/ui/V.java")],
};

describe("Explorer compact folders (fixture)", () => {
  it("auto-loads single child chains on expand and keeps one stable merged row", async () => {
    const t = fake(disk);
    t.rows()[0].click(); await tick();
    const row = t.rows()[0];
    expect(row.textContent).toBe("com/example/todo");
    expect(row.getAttribute("data-path")).toBe("com/example/todo");
    expect(row.getAttribute("title")).toBe("com/example/todo"); expect(row.getAttribute("aria-label")).toBe("com/example/todo");
    expect(row.getAttribute("aria-expanded")).toBe("true"); expect(row.getAttribute("aria-level")).toBe("1");
    expect(row.querySelectorAll(".tree-segment")).toHaveLength(3);
    expect(t.rows().map(r => r.getAttribute("data-path"))).toEqual(["com/example/todo", "com/example/todo/A.java", "com/example/todo/ui", "README.md"]);
    expect([...t.expanded()].sort()).toEqual(["", "com", "com/example", "com/example/todo"]);
    expect(new Set(t.listed).size).toBe(t.listed.length);
  });
  it("does not drop rows while the chain extends", async () => {
    const t = fake(disk); const counts: number[] = [];
    t.rows()[0].click();
    for (let i = 0; i < 20; i++) { counts.push(t.rows().length); await Promise.resolve(); }
    await tick(); counts.push(t.rows().length);
    expect(counts.every((n, i) => i === 0 || n >= counts[i - 1] - 0)).toBe(true);
    expect(counts.at(-1)).toBe(4);
  });
  it("collapses only the deepest, then re-expands every chain directory", async () => {
    const t = fake(disk); t.rows()[0].click(); await tick();
    t.rows()[0].click(); await tick();
    expect(t.rows()[0].getAttribute("aria-expanded")).toBe("false"); expect(t.expanded().has("com/example/todo")).toBe(false); expect(t.expanded().has("com")).toBe(true);
    const before = t.rows().length;
    t.rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); await tick();
    expect(t.rows()[0].getAttribute("aria-expanded")).toBe("true"); expect(t.rows().length).toBeGreaterThan(before);
    t.rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); await tick();
    expect(t.rows()[0].getAttribute("aria-expanded")).toBe("false");
  });
  it("keeps the row element and its focus while the chain extends", async () => {
    const t = fake(disk); const first = t.rows()[0]; first.focus(); first.click(); await tick();
    expect(t.rows()[0]).toBe(first); expect(document.activeElement).toBe(first);
  });
  it("reveals a file inside a chain when every directory is expanded in the shared set", async () => {
    const t = fake(disk);
    t.rows()[0].click(); await tick();
    expect(t.rows().some(r => r.getAttribute("data-path") === "com/example/todo/A.java")).toBe(true);
  });
  it("splits the chain when an intermediate gains a second child", async () => {
    const t = fake(disk); t.rows()[0].click(); await tick();
    t.setDirectories("com", [dir("com/example"), file("com/NOTES.md")]); await tick();
    expect(t.rows()[0].textContent).toBe("com"); expect(t.rows().map(r => r.getAttribute("data-path"))).toContain("com/example/todo");
  });
  it("renders legacy one directory rows when the preference is off", async () => {
    setCompactFolders(false);
    const t = fake(disk); t.rows()[0].click(); await tick();
    expect(t.rows()[0].textContent).toBe("com"); expect(t.rows()[0].hasAttribute("aria-label")).toBe(false);
    expect(t.rows()[1].textContent).toBe("example"); expect(t.rows()[1].getAttribute("aria-level")).toBe("2");
  });
  it("uses dotted labels and plain icons below a Java source root", async () => {
    const java = {
      "": [dir("src")], src: [dir("src/main")], "src/main": [dir("src/main/java")], "src/main/java": [dir("src/main/java/com")],
      "src/main/java/com": [dir("src/main/java/com/example")], "src/main/java/com/example": [file("src/main/java/com/example/A.java")],
    };
    const t = fake(java); t.rows()[0].click(); await tick();
    expect(t.rows()[0].textContent).toBe("src/main"); expect(t.rows()[0].getAttribute("aria-expanded")).toBe("true");
    t.rows()[1].click(); await tick();
    expect(t.rows()[1].textContent).toBe("java");
    t.rows()[2].click(); await tick();
    expect(t.rows()[2].textContent).toBe("com.example");
    expect(t.rows()[2].querySelector("img")!.getAttribute("src")).toMatch(/folder/);
  });
});
