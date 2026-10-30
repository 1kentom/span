// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { ChangesCard, DiffView, SearchMatches, StepRow, TerminalOutput, WorkGroup } from "./WorkGroup";
import { HistoryList, groupSessions } from "./HistoryList";
import type { HistoryScope, SessionRow, StepView } from "./types";
import { key, mount, text } from "./test-utils";

const steps: StepView[] = [
  { id: "1", kind: "read", verb: "Read", target: "src/a.ts", status: "completed", meta: "120 lines" },
  { id: "2", kind: "run", verb: "Ran", target: "pnpm test", status: "failed", detail: { type: "terminal", lines: [{ kind: "cmd", text: "pnpm test" }, { kind: "err", text: "boom" }], cwd: "~/span", exitCode: 1 } },
  { id: "3", kind: "edit", verb: "Edited", target: "src/b.ts", status: "completed", delta: { add: 3, del: 1 }, detail: { type: "diff", path: "src/b.ts", lines: [{ kind: "del", n: 4, text: "old" }, { kind: "add", n: 4, text: "new" }, { kind: "ctx", n: 5, text: "same" }] } },
  { id: "4", kind: "search", verb: "Searched", target: "TODO", status: "completed", detail: { type: "matches", matches: [{ loc: "a.ts:3", text: "// TODO" }] } },
  { id: "5", kind: "other", verb: "Task", status: "in_progress", children: [{ id: "c", kind: "read", verb: "Read", target: "x" }] },
];

describe("WorkGroup", () => {
  it("collapses, counts failures and toggles step detail", () => {
    const host = mount(() => <WorkGroup headline="Worked" counts="1 read, 1 command" steps={steps} />);
    const head = host.querySelector<HTMLButtonElement>(".sb-work-head")!;
    expect(text(head)).toContain("1 failed");
    expect(host.querySelectorAll(".sb-step")).toHaveLength(5);
    expect(host.querySelector(".sb-term")).toBeNull();
    const rows = host.querySelectorAll<HTMLButtonElement>("button.sb-step-row");
    expect(rows).toHaveLength(3);
    rows[0].click();
    expect(host.querySelector(".sb-term")).not.toBeNull();
    expect(rows[0].getAttribute("aria-expanded")).toBe("true");
    rows[0].click();
    expect(host.querySelector(".sb-term")).toBeNull();
    head.click();
    expect(host.querySelectorAll(".sb-step")).toHaveLength(0);
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });
  it("shows subagent children and a spinner for running steps", () => {
    const host = mount(() => <WorkGroup headline="Worked" steps={[steps[4]]} />);
    expect(host.querySelectorAll(".sb-child")).toHaveLength(1);
    expect(host.querySelector(".sb-step-glyph .sb-spinner")).not.toBeNull();
  });
  it("opens the default expanded step", () => {
    const host = mount(() => <WorkGroup headline="Worked" steps={steps} defaultExpanded={["3"]} />);
    expect(host.querySelector(".sb-diff")).not.toBeNull();
  });
});

describe("step detail views", () => {
  it("a long output shows its tail, draws earlier lines only on request and copies all of it", () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ kind: "out" as const, text: `line ${i}` }));
    const full = vi.fn(() => all);
    const copied: string[] = [];
    const host = mount(() => <TerminalOutput lines={[{ kind: "cmd", text: "cargo build" }, ...all.slice(-200)]} hidden={2300} full={full} onCopyOutput={(value) => copied.push(value)} />);
    expect(host.querySelectorAll(".sb-term-line")).toHaveLength(201);
    expect(full).not.toHaveBeenCalled();
    expect(text(host.querySelector(".sb-term-more"))).toBe("2,300 earlier lines not shownShow 1,000 more");
    (host.querySelector(".sb-term-more button") as HTMLButtonElement).click();
    expect(host.querySelectorAll(".sb-term-line")).toHaveLength(1201);
    expect(host.querySelectorAll(".sb-term-line")[1].textContent).toBe("line 1300");
    (host.querySelector(".sb-term-more button") as HTMLButtonElement).click();
    expect(text(host.querySelector(".sb-term-more button"))).toBe("Show all");
    (host.querySelector(".sb-term-more button") as HTMLButtonElement).click();
    expect(host.querySelectorAll(".sb-term-line")).toHaveLength(2501);
    expect(host.querySelector(".sb-term-more")).toBeNull();
    (host.querySelector("[aria-label='Copy output']") as HTMLButtonElement).click();
    expect(copied[0].split("\n")).toHaveLength(2501);
    expect(copied[0].startsWith("$ cargo build\nline 0\n")).toBe(true);
  });

  it("renders terminal lines, exit code and a copy action", () => {
    const copy = vi.fn();
    const host = mount(() => <TerminalOutput lines={[{ kind: "cmd", text: "ls" }, { kind: "out", text: "a" }, { kind: "err", text: "x" }]} cwd="~" exitCode={0} onCopy={copy} />);
    expect(host.querySelectorAll(".sb-term-line.cmd .sb-prompt")).toHaveLength(1);
    expect(text(host.querySelector(".sb-term-foot"))).toContain("exit 0");
    host.querySelector<HTMLButtonElement>("[aria-label='Copy command']")!.click();
    expect(copy).toHaveBeenCalled();
  });
  it("marks diff signs as text and opens the file", () => {
    const open = vi.fn();
    const host = mount(() => <DiffView path="a.ts" onOpen={open} lines={[{ kind: "add", n: 1, text: "x" }, { kind: "del", n: 2, text: "y" }, { kind: "ctx", n: 3, text: "z" }]} />);
    expect([...host.querySelectorAll(".sb-diff-text")].map((el) => el.textContent)).toEqual(["+ x", "- y", "  z"]);
    host.querySelector<HTMLButtonElement>(".sb-link")!.click();
    expect(open).toHaveBeenCalled();
  });
  it("makes search locations buttons only when openable", () => {
    const open = vi.fn();
    const plain = mount(() => <SearchMatches matches={[{ loc: "a:1", text: "t" }]} />);
    expect(plain.querySelector("button")).toBeNull();
    const live = mount(() => <SearchMatches matches={[{ loc: "a:1", text: "t" }]} onOpen={open} />);
    live.querySelector<HTMLButtonElement>("button")!.click();
    expect(open).toHaveBeenCalledWith("a:1");
  });
  it("renders a step without detail as a non-button row", () => {
    const host = mount(() => <StepRow step={steps[0]} />);
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("120 lines");
  });
});

describe("ChangesCard", () => {
  const files = [
    { path: "a.ts", name: "a.ts", dir: "src", add: 2, del: 1, state: "pending" as const },
    { path: "b.ts", name: "b.ts", dir: "src", add: 1, del: 0, state: "accepted" as const },
  ];
  it("totals counts and only shows actions the app supplies", () => {
    const host = mount(() => <ChangesCard headline="2 files changed" files={files} />);
    expect(text(host.querySelector(".sb-changes-head"))).toContain("+3-1");
    expect(host.querySelector("button")).toBeNull();
    const calls: string[] = [];
    const live = mount(() => <ChangesCard headline="x" files={files} onAccept={(p) => calls.push(`a:${p}`)} onReject={(p) => calls.push(`r:${p}`)} onAcceptAll={() => calls.push("all")} />);
    live.querySelector<HTMLButtonElement>("[aria-label='Accept a.ts']")!.click();
    live.querySelector<HTMLButtonElement>("[aria-label='Reject a.ts']")!.click();
    live.querySelector<HTMLButtonElement>(".sb-btn.primary")!.click();
    expect(calls).toEqual(["a:a.ts", "r:a.ts", "all"]);
    expect(live.querySelectorAll("[aria-label^='Accept']")).toHaveLength(1);
    expect(live.textContent).not.toContain("Reject all");
  });
  it("opens the file when a row name is clicked, for pending and reviewed rows (#56)", () => {
    const opened: string[] = [];
    const host = mount(() => <ChangesCard headline="x" files={files} onOpen={(p) => opened.push(p)} />);
    const names = [...host.querySelectorAll<HTMLButtonElement>("button.sb-change-name")];
    expect(names.map((button) => button.textContent)).toEqual(["a.ts", "b.ts"]);
    names[0].click();
    names[1].click();
    expect(opened).toEqual(["a.ts", "b.ts"]);
  });
});

describe("groupSessions", () => {
  const noon = new Date(2026, 9, 28, 12, 0).getTime();
  const row = (id: string, updatedAt: number): SessionRow => ({ id, title: id, updatedAt, inWorkspace: true });
  it("buckets by calendar day, newest first, dropping empty groups", () => {
    const groups = groupSessions([row("old", noon - 5 * 864e5), row("t1", noon - 3600e3), row("y", new Date(2026, 9, 27, 23, 0).getTime()), row("t2", noon)], noon);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([["Today", ["t2", "t1"]], ["Yesterday", ["y"]], ["Earlier", ["old"]]]);
    expect(groupSessions([row("a", noon)], noon).map((g) => g.label)).toEqual(["Today"]);
  });
});

describe("HistoryList", () => {
  const noon = new Date(2026, 9, 28, 12, 0).getTime();
  const rows: SessionRow[] = [
    { id: "s1", title: "Fix parser", updatedAt: noon - 1000, inWorkspace: true, current: true, models: ["opus"], files: 12 },
    { id: "s2", title: "Other repo chat", updatedAt: noon - 864e5 * 3, inWorkspace: false },
    { id: "s3", title: "Locked chat", updatedAt: noon - 2000, inWorkspace: true, locked: true },
  ];
  function view(extra: Partial<Parameters<typeof HistoryList>[0]> = {}) {
    const calls: string[] = [];
    const host = mount(() => {
      const [query, setQuery] = createSignal("");
      const [scope, setScope] = createSignal<HistoryScope>("workspace");
      return <HistoryList rows={rows} now={noon} query={query()} onQuery={setQuery} scope={scope()} onScope={setScope} formatTime={() => "t"} onOpen={(id) => calls.push(`open:${id}`)} {...extra} />;
    });
    return { host, calls };
  }
  it("filters by scope and search, groups rows, and flags the current one", () => {
    const { host } = view();
    expect([...host.querySelectorAll(".sb-session-title .sb-ellipsis")].map((el) => el.textContent)).toEqual(["Fix parser", "Locked chat"]);
    expect(host.textContent).toContain("Current");
    expect([...host.querySelectorAll(".sb-group > .sb-eyebrow")].map((el) => el.textContent)).toEqual(["Today"]);
    host.querySelectorAll<HTMLButtonElement>(".sb-pill")[1].click();
    expect(host.querySelectorAll(".sb-session")).toHaveLength(3);
    expect([...host.querySelectorAll(".sb-group > .sb-eyebrow")].map((el) => el.textContent)).toEqual(["Today", "Earlier"]);
    const search = host.querySelector<HTMLInputElement>("input[type=search]")!;
    search.value = "OTHER";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(host.querySelectorAll(".sb-session")).toHaveLength(1);
    search.value = "zzz";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(host.textContent).toContain("No sessions match \u201czzz\u201d.");
  });
  it("hides the scope control when no unfiltered list exists, and shows every row it is given", () => {
    const host = mount(() => <HistoryList rows={rows} now={noon} query="" onQuery={() => undefined} formatTime={() => "t"} onOpen={() => undefined} />);
    expect(host.querySelector("[aria-label='Session scope']")).toBeNull();
    expect(host.textContent).not.toContain("All folders");
    expect(host.querySelectorAll(".sb-session")).toHaveLength(3);
  });
  it("opens unlocked rows and blocks locked ones with the reason", () => {
    const { host, calls } = view();
    const buttons = host.querySelectorAll<HTMLButtonElement>(".sb-session-main");
    buttons[0].click();
    buttons[1].click();
    expect(calls).toEqual(["open:s1"]);
    expect(buttons[1].disabled).toBe(true);
    expect(host.textContent).toContain("Read-only. This agent doesn't support session/load.");
  });
  it("offers no menu without actions, and only the supported actions", () => {
    const bare = view().host;
    expect(bare.querySelector("[aria-label='Actions for Locked chat']")).toBeNull();
    expect(bare.querySelector("[aria-label='Actions for Fix parser']")).toBeNull();
    const calls: string[] = [];
    const { host } = view({ onCopyId: (id) => calls.push(`copy:${id}`) });
    host.querySelector<HTMLButtonElement>(".row-menu")!.click();
    expect([...host.querySelectorAll("[role=menuitem]")].map((el) => text(el))).toEqual(["Copy session ID"]);
    host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")[0].click();
    expect(calls).toEqual(["copy:s1"]);
    expect(host.querySelector("[role=menu]")).toBeNull();
  });
  it("closes the menu on Escape and renames inline", () => {
    const calls: string[] = [];
    const { host } = view({ onRename: (id, title) => calls.push(`rename:${id}:${title}`), onCopyId: () => {} });
    const trigger = host.querySelector<HTMLButtonElement>(".row-menu")!;
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    key("Escape");
    expect(host.querySelector("[role=menu]")).toBeNull();
    trigger.click();
    [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((el) => text(el.querySelector(".sb-menu-label")) === "Rename")!.click();
    const input = host.querySelector<HTMLInputElement>("[aria-label='Session name']")!;
    expect(input.value).toBe("Fix parser");
    input.value = "Parser fix";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    key("Enter", {}, input);
    expect(calls).toEqual(["rename:s1:Parser fix"]);
    expect(host.querySelector("[aria-label='Session name']")).toBeNull();
  });
});
