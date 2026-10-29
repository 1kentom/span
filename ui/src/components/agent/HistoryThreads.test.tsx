// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { HistoryList } from "./HistoryList";
import type { SessionRow } from "./types";
import { key, mount, text } from "./test-utils";

describe("History thread rows", () => {
  const now = Date.now();
  const rows: SessionRow[] = [
    {
      id: "t",
      title: "Ship path filtering",
      updatedAt: now,
      inWorkspace: true,
      agents: [
        { id: "codex", name: "Codex" },
        { id: "claude-acp", name: "Claude Agent" },
      ],
      models: ["gpt-5.1-codex · high", "Opus 4.5", "Sonnet 4.5 · subagent"],
    },
    { id: "q", title: "Quiet chat", updatedAt: now - 1000, inWorkspace: true, noChanges: true },
    { id: "old", title: "Archived chat", updatedAt: now - 2000, inWorkspace: true, archived: true },
    { id: "far", title: "Other folder chat", updatedAt: now - 3000, inWorkspace: false, folder: "/w/other-project" },
  ];
  const row = (host: HTMLElement, title: string) => [...host.querySelectorAll<HTMLElement>(".sb-session")].find((element) => element.textContent?.includes(title));
  const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem] .sb-menu-label")].map((item) => text(item));
  const menuItem = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => text(item.querySelector(".sb-menu-label")) === label)!;
  function view(extra: Partial<Parameters<typeof HistoryList>[0]> = {}) {
    const calls: string[] = [];
    const host = mount(() => (
      <HistoryList
        rows={rows}
        query=""
        onQuery={() => undefined}
        onOpen={(id) => calls.push(`open:${id}`)}
        onRename={(id, title) => calls.push(`rename:${id}:${title}`)}
        onFork={(id) => calls.push(`fork:${id}`)}
        onExport={(id) => calls.push(`export:${id}`)}
        onCopyId={(id) => calls.push(`copy:${id}`)}
        onArchive={(id, archived) => calls.push(`archive:${id}:${archived}`)}
        onDelete={(id) => calls.push(`delete:${id}`)}
        {...extra}
      />
    ));
    return { host, calls };
  }

  it("shows every provider and model of a thread, the subagent marker included", () => {
    const { host } = view();
    const thread = row(host, "Ship path filtering")!;
    expect(thread.querySelectorAll(".sb-avatars .brand-icon").length).toBe(2);
    expect([...thread.querySelectorAll(".sb-chip.mono")].map((chip) => text(chip))).toEqual(["gpt-5.1-codex · high", "Opus 4.5", "Sonnet 4.5 · subagent"]);
    expect(text(thread.querySelector(".sb-session-meta"))).toBe("2 agents");
  });

  it("says No changes only for a row that tracked its changes", () => {
    const { host } = view();
    expect(text(row(host, "Quiet chat")!.querySelector(".sb-session-meta"))).toBe("No changes");
    expect(row(host, "Ship path filtering")!.textContent).not.toContain("No changes");
  });

  it("lists the row menu in the design's order", () => {
    const { host } = view();
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Quiet chat']")!.click();
    expect(items(host)).toEqual(["Rename", "Fork session", "Export as Markdown", "Copy session ID", "Archive", "Delete"]);
  });

  it("forks, exports and archives from the menu", () => {
    const { host, calls } = view();
    for (const label of ["Fork session", "Export as Markdown", "Archive"]) {
      host.querySelector<HTMLButtonElement>("[aria-label='Actions for Quiet chat']")!.click();
      menuItem(host, label).click();
    }
    expect(calls).toEqual(["fork:q", "export:q", "archive:q:true"]);
  });

  it("hides archived rows until the Archived filter is on, and restores from there", () => {
    const { host, calls } = view();
    expect(row(host, "Archived chat")).toBeUndefined();
    const chip = [...host.querySelectorAll<HTMLButtonElement>(".sb-pill")].find((pill) => text(pill) === "Archived")!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    chip.click();
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(row(host, "Archived chat")).toBeDefined();
    expect(row(host, "Quiet chat")).toBeUndefined();
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Archived chat']")!.click();
    expect(items(host)).toContain("Restore");
    expect(items(host)).not.toContain("Archive");
    menuItem(host, "Restore").click();
    expect(calls).toEqual(["archive:old:false"]);
  });

  it("renames inline on double click of the title without opening the row", async () => {
    const { host, calls } = view();
    const title = row(host, "Quiet chat")!.querySelector<HTMLElement>(".sb-session-title .sb-ellipsis")!;
    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    title.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const input = host.querySelector<HTMLInputElement>("input[aria-label='Session name']")!;
    expect(input.value).toBe("Quiet chat");
    input.value = "Renamed";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    key("Enter", {}, input);
    expect(calls).toEqual(["rename:q:Renamed"]);
  });

  it("still opens a row on a single click of the title", async () => {
    const { host, calls } = view();
    row(host, "Quiet chat")!.querySelector<HTMLElement>(".sb-session-title .sb-ellipsis")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toEqual(["open:q"]);
  });

  it("offers the scope chips and keeps a row from another folder read-only", () => {
    const scopes: string[] = [];
    const { host, calls } = view({ scope: "all", onScope: (scope) => scopes.push(scope) });
    const chips = [...host.querySelectorAll<HTMLButtonElement>(".sb-seg .sb-pill")];
    expect(chips.map((chip) => text(chip))).toEqual(["This workspace", "All folders"]);
    chips[0].click();
    expect(scopes).toEqual(["workspace"]);
    const far = row(host, "Other folder chat")!;
    expect(text(far.querySelector(".sb-session-note"))).toBe("In other-project. Open that folder to resume it.");
    far.click();
    expect(calls).toEqual([]);
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Other folder chat']")!.click();
    expect(items(host)).toEqual(["Copy session ID"]);
  });

  it("shows only this workspace's rows in the workspace scope", () => {
    const { host } = view({ scope: "workspace", onScope: () => undefined });
    expect(row(host, "Other folder chat")).toBeUndefined();
  });
});
