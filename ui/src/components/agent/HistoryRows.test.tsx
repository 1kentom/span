// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { HistoryList, historyTime } from "./HistoryList";
import type { SessionRow } from "./types";
import { key, mount, text } from "./test-utils";

describe("History rows", () => {
  const now = Date.now();
  const rows: SessionRow[] = [
    {
      id: "a",
      title: "Chat A",
      updatedAt: now,
      inWorkspace: true,
      current: true,
      agents: [{ id: "codex", name: "Codex" }, { id: "gemini", name: "Gemini" }],
      models: ["gpt-5.1-codex · high"],
      files: 2,
      delta: { add: 28, del: 4 },
      status: { kind: "running", label: "Running", attention: false },
    },
    { id: "b", title: "Chat B", updatedAt: now - 1000, inWorkspace: true, agents: [{ id: "codex", name: "Codex" }] },
    { id: "c", title: "Locked C", updatedAt: now - 2000, inWorkspace: true, locked: true },
  ];
  const row = (host: HTMLElement, title: string) => [...host.querySelectorAll<HTMLElement>(".sb-session")].find((element) => element.textContent?.includes(title))!;
  const items = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem] .sb-menu-label")].map((item) => text(item));
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

  it("stacks one avatar per stored agent and shows model chips, without agent name chips", () => {
    const { host } = view();
    const a = row(host, "Chat A");
    expect(a.querySelectorAll(".sb-avatars .brand-icon").length).toBe(2);
    expect(a.querySelector(".sb-avatars")?.getAttribute("title")).toBe("Codex, Gemini");
    expect(a.querySelector(".sb-chip.agent")).toBeNull();
    expect([...a.querySelectorAll(".sb-chip.mono")].map((chip) => text(chip))).toEqual(["gpt-5.1-codex · high"]);
    const b = row(host, "Chat B");
    expect(b.querySelectorAll(".sb-avatars .brand-icon").length).toBe(1);
    expect(b.querySelector(".sb-chip")).toBeNull();
  });

  it("writes the agent and file counts and the line delta only when the metadata has them", () => {
    const { host } = view();
    const meta = row(host, "Chat A").querySelector(".sb-session-meta")!;
    expect(text(meta.firstElementChild)).toBe("2 agents · 2 files");
    expect([text(meta.querySelector(".add")), text(meta.querySelector(".del"))]).toEqual(["+28", "−4"]);
    expect(row(host, "Chat B").querySelector(".sb-session-meta")).toBeNull();
    const single = mount(() => <HistoryList rows={[{ id: "x", title: "One", updatedAt: now, inWorkspace: true, files: 1 }]} query="" onQuery={() => undefined} onOpen={() => undefined} />);
    expect(text(single.querySelector(".sb-session-meta"))).toBe("1 file");
  });

  it("shows running and waiting as a badge, and no badge for an idle chat with nothing queued", () => {
    const host = mount(() => (
      <HistoryList
        rows={[
          { id: "i", title: "Idle chat", updatedAt: now, inWorkspace: true, status: { kind: "idle", label: "Idle", attention: false } },
          { id: "q", title: "Queued chat", updatedAt: now, inWorkspace: true, status: { kind: "idle", label: "Idle · Queued 2", attention: false } },
          { id: "r", title: "Busy chat", updatedAt: now, inWorkspace: true, status: { kind: "running", label: "Running 0:12", attention: false } },
        ]}
        query=""
        onQuery={() => undefined}
        onOpen={() => undefined}
      />
    ));
    expect(row(host, "Idle chat").querySelector(".sb-session-state")).toBeNull();
    expect(text(row(host, "Queued chat").querySelector(".sb-session-state"))).toBe("Idle · Queued 2");
    expect(text(row(host, "Busy chat").querySelector(".sb-session-state.sb-badge"))).toBe("Running 0:12");
  });

  it("lists Rename, Copy session ID, Close and Delete with the bound keys, and no Resume", () => {
    const { host, calls } = view({ onDelete: (id) => calls.push(`delete:${id}`) });
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat A']")!.click();
    expect(items(host)).toEqual(["Rename", "Copy session ID", "Close session", "Delete"]);
    const hints = [...host.querySelectorAll("[role=menuitem]")].map((item) => text(item.querySelector(".sb-menu-key")) ?? "");
    expect(hints).toEqual(["F2", "", "", "⌫"]);
    expect(host.querySelector("[role=menu] [role=separator]")).not.toBeNull();
    expect(host.querySelector("[role=menu] .sb-menu-item.danger")?.textContent).toContain("Delete");
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    expect(items(host)).toEqual(["Rename", "Copy session ID", "Delete"]);
  });

  it("shows a key hint only when its action exists", () => {
    const { host } = view();
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    expect(items(host)).toEqual(["Rename", "Copy session ID"]);
    expect(host.textContent).not.toContain("⌫");
  });

  it("renames with F2 and asks to delete with Backspace on the focused row", () => {
    const { host, calls } = view({ onDelete: (id) => calls.push(`delete:${id}`) });
    const main = row(host, "Chat B").querySelector<HTMLButtonElement>(".sb-session-main")!;
    main.focus();
    key("F2", {}, main);
    const input = host.querySelector<HTMLInputElement>("[aria-label='Session name']")!;
    expect(input.value).toBe("Chat B");
    input.value = "Better";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    key("Enter", {}, input);
    expect(calls).toEqual(["rename:b:Better"]);
    const again = row(host, "Chat B").querySelector<HTMLButtonElement>(".sb-session-main")!;
    key("Backspace", {}, again);
    expect(host.querySelector(".sb-confirm")).not.toBeNull();
    host.querySelector<HTMLButtonElement>(".sb-confirm .danger")!.click();
    expect(calls).toEqual(["rename:b:Better", "delete:b"]);
  });

  it("opens a row on click anywhere in it, but not from the actions button or on a locked row", () => {
    const { host, calls } = view();
    row(host, "Chat B").querySelector<HTMLElement>(".sb-session-time")!.click();
    row(host, "Chat B").querySelector<HTMLButtonElement>(".row-menu")!.click();
    row(host, "Locked C").click();
    expect(calls).toEqual(["open:b"]);
  });

  it("opens the same menu on right click and keeps the browser menu closed", () => {
    const { host } = view();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    row(host, "Chat B").querySelector(".sb-session-main")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(items(host)).toEqual(["Rename", "Copy session ID"]);
    expect(host.querySelector("[aria-label='Actions for Chat B']")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the menu from the keyboard with the context menu key or Shift+F10, and Escape returns focus to the row", async () => {
    const { host } = view();
    const main = row(host, "Chat B").querySelector<HTMLButtonElement>(".sb-session-main")!;
    main.focus();
    key("ContextMenu", {}, main);
    expect(items(host)).toEqual(["Rename", "Copy session ID"]);
    await Promise.resolve();
    expect(document.activeElement?.textContent).toContain("Rename");
    key("Escape");
    expect(host.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(main);
    key("F10", { shiftKey: true }, main);
    expect(items(host)).toEqual(["Rename", "Copy session ID"]);
  });

  it("renames from the menu and copies the session id", () => {
    const { host, calls } = view();
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => text(item)?.startsWith("Rename"))!.click();
    const input = host.querySelector<HTMLInputElement>("[aria-label='Session name']")!;
    input.value = "Better name";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    key("Enter", {}, input);
    host.querySelector<HTMLButtonElement>("[aria-label='Actions for Chat B']")!.click();
    [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => text(item) === "Copy session ID")!.click();
    expect(calls).toEqual(["rename:b:Better name", "copy:b"]);
  });

  it("offers no menu on a locked row when nothing applies", () => {
    const bare = mount(() => <HistoryList rows={rows} query="" onQuery={() => undefined} onOpen={() => undefined} />);
    expect(row(bare, "Locked C").querySelector(".row-menu")).toBeNull();
    expect(row(bare, "Chat B").querySelector(".row-menu")).toBeNull();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row(bare, "Locked C").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    const copy = view();
    row(copy.host, "Locked C").querySelector<HTMLButtonElement>(".row-menu")!.click();
    expect(items(copy.host)).toEqual(["Rename", "Copy session ID"]);
  });

  it("searches titles, models and agents and highlights the match", () => {
    const [query, setQuery] = createSignal("gemini");
    const host = mount(() => <HistoryList rows={rows} query={query()} onQuery={setQuery} onOpen={() => undefined} />);
    expect([...host.querySelectorAll(".sb-session-title .sb-ellipsis")].map((title) => text(title))).toEqual(["Chat A"]);
    setQuery("chat");
    expect(host.querySelectorAll(".sb-session").length).toBe(2);
    expect([...host.querySelectorAll(".sb-session-title mark")].map((mark) => mark.textContent)).toEqual(["Chat", "Chat"]);
    setQuery("codex · h");
    expect([...host.querySelectorAll(".sb-chip.mono mark")].map((mark) => mark.textContent)).toEqual(["codex · h"]);
    setQuery("nothing like it");
    expect(text(host.querySelector("[role=status]"))).toBe("No sessions match “nothing like it”.");
  });

  it("says when there are no sessions at all", () => {
    const host = mount(() => <HistoryList rows={[]} query="" onQuery={() => undefined} onOpen={() => undefined} />);
    expect(text(host.querySelector("[role=status]"))).toBe("No earlier sessions in this workspace yet.");
  });

  it("filters by agent with a menu built from the agents present, shown only when there are two or more", () => {
    const host = mount(() => <HistoryList rows={rows} query="" onQuery={() => undefined} onOpen={() => undefined} />);
    const filter = host.querySelector<HTMLButtonElement>(".sb-agent-filter")!;
    expect(text(filter)).toBe("All agents");
    filter.click();
    const options = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")];
    expect(options.map((option) => text(option))).toEqual(["All agents", "Codex", "Gemini"]);
    options[2].click();
    expect(text(host.querySelector(".sb-agent-filter"))).toBe("Gemini");
    expect([...host.querySelectorAll(".sb-session")].map((element) => text(element.querySelector(".sb-session-title .sb-ellipsis")))).toEqual(["Chat A"]);
    const single = mount(() => <HistoryList rows={[rows[1]]} query="" onQuery={() => undefined} onOpen={() => undefined} />);
    expect(single.querySelector(".sb-agent-filter")).toBeNull();
  });

  it("shows a clock time for today and yesterday and a short date for earlier days", () => {
    const today = new Date(2026, 9, 28, 14, 32).getTime();
    const clock = new Date(today).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(historyTime(today, today)).toBe(clock);
    expect(historyTime(new Date(2026, 9, 27, 17, 22).getTime(), today)).toBe(new Date(2026, 9, 27, 17, 22).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    expect(historyTime(new Date(2026, 9, 21, 9, 0).getTime(), today)).toBe(new Date(2026, 9, 21).toLocaleDateString([], { month: "short", day: "numeric" }));
  });
});
