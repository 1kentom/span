// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { HistoryList } from "./HistoryList";
import type { SessionRow } from "./types";
import { key, mount, text } from "./test-utils";

describe("History rows", () => {
  const now = Date.now();
  const rows: SessionRow[] = [
    { id: "a", title: "Chat A", updatedAt: now, inWorkspace: true, current: true, agents: [{ id: "codex", name: "Codex" }], models: ["gpt-5.1-codex · high"], status: { kind: "running", label: "Running", attention: false } },
    { id: "b", title: "Chat B", updatedAt: now - 1000, inWorkspace: true },
    { id: "c", title: "Locked C", updatedAt: now - 2000, inWorkspace: true, locked: true },
  ];
  const row = (host: HTMLElement, title: string) => [...host.querySelectorAll<HTMLElement>(".sb-session")].find((element) => element.textContent?.includes(title))!;
  const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].map((item) => text(item));
  function view(extra: Partial<Parameters<typeof HistoryList>[0]> = {}) {
    const calls: string[] = [];
    const host = mount(() => (
      <HistoryList
        rows={rows}
        query=""
        onQuery={() => undefined}
        onOpen={(id) => calls.push(`open:${id}`)}
        onRename={(id, title) => calls.push(`rename:${id}:${title}`)}
        onCopyId={(id) => calls.push(`copy:${id}`)}
        onClose={(id) => calls.push(`close:${id}`)}
        {...extra}
      />
    ));
    return { host, calls };
  }

  it("shows agent and model chips only for rows whose metadata has them, and the state as a badge", () => {
    const { host } = view();
    const a = row(host, "Chat A");
    expect([...a.querySelectorAll(".sb-chip.agent")].map((chip) => text(chip))).toEqual(["Codex"]);
    expect(a.querySelector(".sb-chip.agent .brand-icon")).not.toBeNull();
    expect([...a.querySelectorAll(".sb-chip.mono")].map((chip) => text(chip))).toEqual(["gpt-5.1-codex · high"]);
    expect(a.querySelector(".sb-session-state.sb-badge")).not.toBeNull();
    const b = row(host, "Chat B");
    expect(b.querySelector(".sb-chip")).toBeNull();
    expect(b.querySelector(".sb-session-state")).toBeNull();
  });

  it("lists Resume, Rename, Copy session ID, Close and Delete from the ... button, with Close on the current row only", () => {
    const { host, calls } = view({ onDelete: (id) => calls.push(`delete:${id}`) });
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat A']")!.click();
    expect(items(host)).toEqual(["Resume", "Rename", "Copy session ID", "Close session", "Delete"]);
    expect(host.querySelector("[role=menu] [role=separator]")).not.toBeNull();
    expect(host.querySelector("[role=menu] .sb-menu-item.danger")?.textContent).toContain("Delete");
    expect(host.textContent).not.toMatch(/\bPin\b|Unpin/);
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    expect(items(host)).toEqual(["Resume", "Rename", "Copy session ID", "Delete"]);
    host.querySelector<HTMLButtonElement>("[role=menuitem]")!.click();
    expect(calls).toEqual(["open:b"]);
    expect(host.querySelector("[role=menu]")).toBeNull();
  });

  it("offers Delete only when the agent can delete", () => {
    const { host } = view();
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    expect(items(host)).not.toContain("Delete");
  });

  it("opens the same menu on right click and keeps the browser menu closed", () => {
    const { host } = view();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    row(host, "Chat B").querySelector(".sb-session-main")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(items(host)).toEqual(["Resume", "Rename", "Copy session ID"]);
    expect(host.querySelector("[aria-label='Actions for Chat B']")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the menu from the keyboard with the context menu key or Shift+F10, and Escape returns focus to the row", async () => {
    const { host } = view();
    const main = row(host, "Chat B").querySelector<HTMLButtonElement>(".sb-session-main")!;
    main.focus();
    key("ContextMenu", {}, main);
    expect(items(host)).toEqual(["Resume", "Rename", "Copy session ID"]);
    await Promise.resolve();
    expect(document.activeElement?.textContent).toContain("Resume");
    key("Escape");
    expect(host.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(main);
    key("F10", { shiftKey: true }, main);
    expect(items(host)).toEqual(["Resume", "Rename", "Copy session ID"]);
  });

  it("renames from the menu and copies the session id", () => {
    const { host, calls } = view();
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => text(item) === "Rename")!.click();
    const input = host.querySelector<HTMLInputElement>("[aria-label='Session name']")!;
    input.value = "Better name";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    key("Enter", {}, input);
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => text(item) === "Copy session ID")!.click();
    expect(calls).toEqual(["rename:b:Better name", "copy:b"]);
  });

  it("leaves Resume off a locked row and offers no menu when nothing else applies", () => {
    const bare = mount(() => <HistoryList rows={rows} query="" onQuery={() => undefined} onOpen={() => undefined} />);
    expect(row(bare, "Locked C").querySelector(".row-menu")).toBeNull();
    expect(row(bare, "Chat B").querySelector(".row-menu")).not.toBeNull();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row(bare, "Locked C").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(bare.querySelector("[role=menu]")).toBeNull();
    const copy = view();
    row(copy.host, "Locked C").querySelector<HTMLButtonElement>(".row-menu")!.click();
    expect(items(copy.host)).toEqual(["Rename", "Copy session ID"]);
  });
});
