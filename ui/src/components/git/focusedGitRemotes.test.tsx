// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { GitRemotes } from "./GitRemotes";
import type { GitWorkbench } from "../../stores/git";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); });
function fixture() {
  const [repository, setRepository] = createSignal("repo");
  const [fingerprint, setFingerprint] = createSignal("config");
  const remoteSelected = vi.fn(async () => false);
  const g = {
    context: () => ({ repository: { id: repository() } }),
    status: () => ({ repository: { branch: "main" } }),
    remotes: () => ({ configFingerprint: fingerprint(), remotes: [{ name: "origin", current: true, fetchUrl: "https://example.test/repo", pushUrl: "https://example.test/repo" }] }),
    operation: () => null, ready: () => true, remoteSelected,
    autoFetchEnabled: () => false, autoFetching: () => false, lastFetch: () => null, autoFetchError: () => null,
  } as unknown as GitWorkbench;
  const host = document.createElement("div"); document.body.append(host);
  disposers.push(render(() => <GitRemotes git={g} />, host));
  const push = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Push")!;
  const target = () => host.querySelector<HTMLInputElement>("#git-network-branch")!;
  const review = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input => input.parentElement?.textContent?.includes("I reviewed"))!;
  return { host, remoteSelected, setRepository, setFingerprint, push, target, review };
}
it("opens remote actions without networking and invalidates review when the target or configuration changes", () => {
  const f = fixture();
  const details = f.host.querySelector<HTMLDetailsElement>(".git-network-actions")!;
  expect(details.open).toBe(false);
  details.querySelector("summary")!.click();
  expect(details.open).toBe(true);
  expect(f.remoteSelected).not.toHaveBeenCalled();
  f.review().click(); expect(f.push().disabled).toBe(false);
  f.target().value = "release"; f.target().dispatchEvent(new Event("input", { bubbles: true }));
  expect(f.push().disabled).toBe(true);
  f.review().click(); f.setFingerprint("changed");
  expect(f.push().disabled).toBe(true);
});
it("retains failed target drafts and clears review and draft when the repository changes", async () => {
  const f = fixture();
  f.target().value = "publish-draft"; f.target().dispatchEvent(new Event("input", { bubbles: true }));
  f.review().click(); f.push().click();
  await vi.waitFor(() => expect(f.remoteSelected).toHaveBeenCalledWith("push", "origin", "publish-draft", true));
  expect(f.target().value).toBe("publish-draft");
  f.setRepository("other");
  expect(f.target().value).toBe("main");
  expect(f.review().checked).toBe(false);
  expect(f.push().disabled).toBe(true);
});
