// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { GitBlameView } from "./GitBlameView";
import type { GitLineInfo } from "../../stores/git-line-info";
import type { GitDecorations } from "../../stores/git-decorations";
it("opens actual line commits, leaves changed lines unattributed, and toggles age colors accessibly", () => {
  const commit = vi.fn(), history = vi.fn(), close = vi.fn();
  const info = { blame: () => ({ repositoryId: "r", path: "f", head: "h", lines: [{ line: 1, originalLine: 1, author: "Author", authorEmail: "a@test", commitId: "123456789", timestamp: 100, summary: "<unsafe>" }] }), error: () => "" } as unknown as GitLineInfo;
  const decorations = { baseline: () => ({ repositoryId: "r", path: "f", headText: "old", indexText: "old", indexRevision: "i", binary: false, truncated: false }) } as unknown as GitDecorations;
  const host = document.body.appendChild(document.createElement("div"));
  const dispose = render(() => <GitBlameView info={info} decorations={decorations} path="f" text={"old\nnew"} onCommit={commit} onHistory={history} onClose={close} />, host);
  try {
    expect(host.textContent).toContain("Uncommitted changes"); expect(host.querySelector("unsafe")).toBeNull();
    host.querySelector<HTMLButtonElement>('[aria-label="Review commit 12345678 for line 1"]')!.click(); expect(commit).toHaveBeenCalledWith("123456789", "f");
    const heatmap = host.querySelector<HTMLButtonElement>('[aria-pressed]')!; heatmap.click(); expect(heatmap.getAttribute("aria-pressed")).toBe("true"); expect(host.querySelector('[data-age="older"]')).not.toBeNull();
    host.querySelector("section")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); expect(close).toHaveBeenCalledOnce();
  } finally { dispose(); host.remove(); }
});
