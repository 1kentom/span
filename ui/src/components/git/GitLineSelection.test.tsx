// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { GitLineReview } from "../../bindings";
import { GitLineSelection } from "./GitLineSelection";
const review = (): GitLineReview => ({ diff: { repositoryId: "repo", path: "file", side: "working", indexRevision: "exact-index", patch: "", binary: false, truncated: false }, worktreeSnapshot: "exact-disk", metadata: ["new file"], hunks: [{ id: "hunk", header: "Lines 1 / 1", lines: [{ id: "opaque-a", kind: "delete", text: "old\n", oldLine: 1, newLine: null }, { id: "", kind: "context", text: "same\n", oldLine: 2, newLine: 1 }, { id: "opaque-b", kind: "insert", text: "new\n", oldLine: null, newLine: 2 }, { id: "opaque-c", kind: "insert", text: "last\n", oldLine: null, newLine: 3 }] }] });
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); document.body.replaceChildren(); });
it("sends explicit opaque changed IDs and exact review snapshots with metadata opt-in", async () => {
  const value = review(), action = vi.fn(async (_review: GitLineReview, _ids: string[], _metadata: boolean) => undefined), host = document.createElement("div"); document.body.append(host);
  dispose = render(() => <GitLineSelection review={value} onAction={action} />, host);
  const checkboxes = () => [...host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')];
  expect(checkboxes()).toHaveLength(3);
  checkboxes()[0].click(); checkboxes()[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Stage selected"))!.click();
  await vi.waitFor(() => expect(action).toHaveBeenCalledWith(value, ["opaque-a", "opaque-b", "opaque-c"], true));
  expect(action.mock.calls[0][0].diff.indexRevision).toBe("exact-index"); expect(action.mock.calls[0][0].worktreeSnapshot).toBe("exact-disk");
});
it("preserves failed selection and metadata across identical polls, resets for new snapshots", async () => {
  const action = vi.fn(async () => { throw new Error("Stale review"); }), host = document.createElement("div"); document.body.append(host);
  const [value, setValue] = createSignal(review());
  dispose = render(() => <GitLineSelection review={value()} onAction={action} />, host);
  host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!.click();
  host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Stage selected"))!.click();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Stale review"));
  setValue(review());
  expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  setValue({ ...review(), worktreeSnapshot: "new-disk" });
  expect(host.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
});
it("supports keyboard shift range and blocks unsupported review mutation", () => {
  const host = document.createElement("div"); document.body.append(host); const [value, setValue] = createSignal(review());
  dispose = render(() => <GitLineSelection review={value()} onAction={() => undefined} />, host);
  const controls = [...host.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')];
  controls[0].click(); controls[2].dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }));
  expect(controls.every(control => control.getAttribute("aria-checked") === "true")).toBe(true);
  setValue({ ...review(), diff: { ...review().diff, truncated: true } });
  expect(host.textContent).toContain("Selected-line actions are unavailable");
  expect(host.querySelector<HTMLButtonElement>('button[role="checkbox"]')!.disabled).toBe(true);
});
