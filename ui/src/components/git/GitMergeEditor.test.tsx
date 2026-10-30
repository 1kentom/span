import { expect, it } from "vitest";
import { acceptMergeChoice, mergeConflicts } from "./GitMergeEditor";
const text = "before\n<<<<<<< HEAD\ncurrent\n||||||| base\nancestor\n=======\nincoming\n>>>>>>> branch\nafter\n";
it("reads three-way blocks and preserves surrounding text for every choice", () => {
  const [block] = mergeConflicts(text);
  expect(block.base).toBe("ancestor\n");
  expect(acceptMergeChoice(text, block, "ours")).toBe("before\ncurrent\nafter\n");
  expect(acceptMergeChoice(text, block, "theirs")).toBe("before\nincoming\nafter\n");
  expect(acceptMergeChoice(text, block, "both")).toBe("before\ncurrent\nincoming\nafter\n");
});
it("leaves malformed blocks and other conflicts untouched", () => {
  expect(mergeConflicts("<<<<<<< HEAD\nunfinished")).toEqual([]);
  const repeated = text + text;
  const draft = acceptMergeChoice(repeated, mergeConflicts(repeated)[1], "ours");
  expect(draft.startsWith(text)).toBe(true);
  expect(mergeConflicts(draft)).toHaveLength(1);
});

import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { GitMergeEditor } from "./GitMergeEditor";
import type { GitConflictResource } from "../../bindings";
it("retains an edited draft through refresh and stale save errors", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const resource = { path: "file", base: "base", ours: "ours", theirs: "theirs", working: text, state: {} } as GitConflictResource;
  const [value, update] = createSignal(resource);
  const dispose = render(() => <GitMergeEditor path="file" resource={value()} loading={false} onRefresh={() => update({ ...resource, working: "external update" })} onSave={async () => { throw new Error("stale snapshot"); }} onMarkResolved={async () => {}} />, host);
  try {
    const input = host.querySelector("textarea")!;
    input.value = "my reviewed draft"; input.dispatchEvent(new Event("input", { bubbles: true }));
    const buttons = () => Array.from(host.querySelectorAll("button"));
    buttons().find(button => button.textContent === "Refresh sources")!.click();
    expect(input.value).toBe("my reviewed draft");
    buttons().find(button => button.textContent === "Save resolution")!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(input.value).toBe("my reviewed draft");
    expect(host.textContent).toContain("stale snapshot");
  } finally { dispose(); host.remove(); }
});

it("reloads clean paths and retains the original reviewed snapshot for dirty saves", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const a = { path: "a", base: "", ours: "a", theirs: "a", working: "old a", state: {} } as GitConflictResource;
  const b = { ...a, path: "b", working: "b" };
  const [path, setPath] = createSignal("a"); const [resource, setResource] = createSignal(a);
  let save: (() => Promise<boolean>) | undefined; let dirty = false; let captured: GitConflictResource | undefined;
  const dispose = render(() => <GitMergeEditor path={path()} resource={resource()} loading={false} onRefresh={() => {}} onSave={async (_text, reviewed) => { captured = reviewed; return true; }} onMarkResolved={async () => {}} onDirtyChange={value => { dirty = value; }} onSaveReady={value => { save = value; }} />, host);
  try {
    setPath("b"); setResource(b); setPath("a"); const fresh = { ...a, working: "new a" }; setResource(fresh);
    const input = host.querySelector("textarea")!;
    expect(input.value).toBe("new a");
    input.value = "draft"; input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dirty).toBe(true);
    setResource({ ...fresh, working: "unreviewed update" });
    expect(input.value).toBe("draft");
    expect(await save!()).toBe(true);
    expect(captured).toBe(fresh);
    expect(dirty).toBe(false);
  } finally { dispose(); host.remove(); }
  expect(save).toBeUndefined(); expect(dirty).toBe(false);
});

it("marks resolved with the refreshed snapshot only when it matches the saved result", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const original = { path: "a", base: "", ours: "a", theirs: "a", working: "old", state: {} } as GitConflictResource;
  const [resource, setResource] = createSignal(original);
  const refreshed = { ...original, working: "resolution", state: { ...original.state } };
  let marked: GitConflictResource | undefined;
  const dispose = render(() => <GitMergeEditor path="a" resource={resource()} loading={false} onRefresh={() => {}} onSave={async () => { setResource(refreshed); return true; }} onMarkResolved={async reviewed => { marked = reviewed; return true; }} />, host);
  try {
    const input = host.querySelector("textarea")!;
    input.value = "resolution"; input.dispatchEvent(new Event("input", { bubbles: true }));
    Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Save resolution")!.click();
    await Promise.resolve(); await Promise.resolve();
    Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Mark resolved")!.click();
    await Promise.resolve();
    expect(marked).toBe(refreshed);
    expect(input.value).toBe("resolution");
  } finally { dispose(); host.remove(); }
});
