// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { ModelPopover, barHeight } from "./ModelPopover";
import { SlashPopover } from "./SlashPopover";
import { ActivityBar, PermissionDock, QuestionDock, UrlDock } from "./Docks";
import { PlanDrawer } from "./PlanDrawer";
import { QueuePanel } from "./QueuePanel";
import type { ConfigOptionView, SlashGroup } from "./types";
import { key, mount, text } from "./test-utils";

const options: ConfigOptionView[] = [
  { id: "model", name: "Model", category: "model", currentValue: "fast", choices: [{ value: "fast", name: "Fast", description: "Quick" }, { value: "deep", name: "Deep" }] },
  { id: "effort", name: "Reasoning", category: "thought_level", currentValue: "b", choices: [{ value: "a", name: "Brief" }, { value: "b", name: "Normal" }, { value: "c", name: "Thorough" }, { value: "d", name: "Exhaustive" }] },
  { id: "mode", name: "Mode", category: "mode", currentValue: "ask", choices: [{ value: "ask", name: "Ask" }, { value: "plan", name: "Plan" }] },
];

describe("ModelPopover", () => {
  it("builds sections from the config options and selects by value", () => {
    const picked: string[] = [];
    const closed = vi.fn();
    const host = mount(() => (
      <ModelPopover agentName="Claude" options={options} agents={[{ id: "claude", name: "Claude", current: true }, { id: "gemini", name: "Gemini" }]}
        onSelect={(id, value) => picked.push(`${id}=${value}`)} onSwitchAgent={(id) => picked.push(`agent:${id}`)} onClose={closed} />
    ));
    expect(host.querySelectorAll("[role=radiogroup]")).toHaveLength(3);
    const bars = host.querySelectorAll<HTMLButtonElement>(".sb-level-bar");
    expect([...bars].map((bar) => bar.getAttribute("aria-label"))).toEqual(["Brief", "Normal", "Thorough", "Exhaustive"]);
    expect([...host.querySelectorAll(".sb-level-fill")].map((fill) => fill.classList.contains("on"))).toEqual([true, true, false, false]);
    expect(text(host.querySelector(".sb-level-name"))).toBe("Normal");
    bars[3].click();
    host.querySelector<HTMLButtonElement>("[role=radio][aria-checked=false]:not(.sb-level-bar)")!.click();
    const gemini = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Gemini"))!;
    gemini.click();
    expect(picked).toEqual(["effort=d", "model=deep", "agent:gemini"]);
    const current = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Connected"))!;
    expect(current.disabled).toBe(true);
    key("Escape");
    expect(closed).toHaveBeenCalledOnce();
  });

  it("omits the level control and agent list when the agent reports neither", () => {
    const host = mount(() => <ModelPopover agentName="A" options={[options[0]]} onSelect={() => {}} onClose={() => {}} />);
    expect(host.querySelector(".sb-level")).toBeNull();
    expect(host.textContent).not.toContain("Agent");
  });

  it("derives bar heights without naming levels", () => {
    expect(barHeight(0, 4)).toBe("48%");
    expect(barHeight(3, 4)).toBe("100%");
  });

  it("moves focus with arrow keys", () => {
    const host = mount(() => <ModelPopover agentName="A" options={[options[2]]} onSelect={() => {}} onClose={() => {}} />);
    const [first, second] = [...host.querySelectorAll<HTMLButtonElement>("button")];
    first.focus();
    key("ArrowDown", {}, first);
    expect(document.activeElement).toBe(second);
  });
});

describe("SlashPopover", () => {
  const groups: SlashGroup[] = [
    { label: "Agent commands", items: [{ name: "/compact", description: "Compact", source: "agent" }, { name: "/review", hint: "<path>", source: "agent" }] },
    { label: "Span commands", items: [{ name: "/clear", source: "span" }] },
  ];
  it("navigates across groups with the keyboard and picks with Enter or Tab", () => {
    const picked: string[] = [];
    const closed = vi.fn();
    const host = mount(() => <SlashPopover groups={groups} onSelect={(item) => picked.push(item.name)} onClose={closed} />);
    expect([...host.querySelectorAll(".sb-eyebrow")].map((el) => el.textContent)).toEqual(["Agent commands", "Span commands"]);
    expect(host.querySelector("[aria-selected=true]")!.textContent).toContain("/compact");
    key("ArrowDown");
    key("ArrowDown");
    expect(host.querySelector("[aria-selected=true]")!.textContent).toContain("/clear");
    key("Enter");
    key("ArrowDown");
    expect(host.querySelector("[aria-selected=true]")!.textContent).toContain("/compact");
    key("ArrowUp");
    key("Tab");
    expect(picked).toEqual(["/clear", "/clear"]);
    key("Escape");
    expect(closed).toHaveBeenCalledOnce();
  });
  it("resets the highlight when the list changes and clicks select", () => {
    const [list, setList] = createSignal(groups);
    const picked: string[] = [];
    const host = mount(() => <SlashPopover groups={list()} onSelect={(item) => picked.push(item.name)} onClose={() => {}} />);
    key("ArrowDown");
    setList([groups[1]]);
    expect(host.querySelector("[aria-selected=true]")!.textContent).toContain("/clear");
    host.querySelector<HTMLElement>("[role=option]")!.click();
    expect(picked).toEqual(["/clear"]);
  });
  it("says so when nothing matches and still closes on Escape", () => {
    const closed = vi.fn();
    const host = mount(() => <SlashPopover groups={[]} onSelect={() => {}} onClose={closed} />);
    expect(host.textContent).toContain("No matching commands");
    key("Enter");
    key("Escape");
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe("QuestionDock", () => {
  it("answers with number keys, buttons and free text", () => {
    const answers: unknown[] = [];
    const host = mount(() => (
      <QuestionDock asker={{ id: "claude", name: "Claude" }} step="1 of 2" prompt="Which database?" allowText
        options={[{ id: "pg", label: "Postgres", description: "Server" }, { id: "sq", label: "SQLite" }]} onAnswer={(a) => answers.push(a)} />
    ));
    key("2", {}, host.querySelector(".sb-dock")!);
    host.querySelectorAll<HTMLButtonElement>(".sb-q-option")[0].click();
    const input = host.querySelector<HTMLInputElement>("input")!;
    input.value = "  DuckDB ";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    key("1", {}, input);
    host.querySelector<HTMLFormElement>("form")!.requestSubmit();
    expect(answers).toEqual([{ optionId: "sq" }, { optionId: "pg" }, { text: "DuckDB" }]);
  });
  it("ignores keys when not active", () => {
    const answers: unknown[] = [];
    const host = mount(() => <QuestionDock prompt="p" active={false} options={[{ id: "a", label: "A" }]} onAnswer={(a) => answers.push(a)} />);
    key("1", {}, host.querySelector(".sb-dock")!);
    expect(answers).toEqual([]);
  });
});

describe("PermissionDock", () => {
  const opts = [
    { optionId: "r", name: "Reject", kind: "reject_once" },
    { optionId: "aa", name: "Always allow", kind: "allow_always" },
    { optionId: "ao", name: "Allow once", kind: "allow_once" },
    { optionId: "ra", name: "Never", kind: "reject_always" },
  ];
  it("orders by ACP kind, shows the command, maps Y, A and N, and never draws reject_always", () => {
    const chosen: string[] = [];
    const host = mount(() => <PermissionDock title="Run command" command="git push" reason="Publishes commits" options={opts} onChoose={(id) => chosen.push(id)} />);
    expect([...host.querySelectorAll(".sb-actions button")].map((b) => b.textContent?.replace(/[YAN]$/, ""))).toEqual(["Allow once", "Always allow", "Reject"]);
    expect([...host.querySelectorAll(".sb-actions kbd")].map((k) => k.textContent)).toEqual(["Y", "A", "N"]);
    expect(host.querySelector(".sb-code")!.textContent).toContain("git push");
    const dock = host.querySelector(".sb-dock")!;
    key("y", {}, dock);
    key("N", {}, dock);
    host.querySelectorAll<HTMLButtonElement>(".sb-actions button")[1].click();
    expect(chosen).toEqual(["ao", "r", "aa"]);
  });
  it("does nothing while busy or while typing", () => {
    const chosen: string[] = [];
    const [busy, setBusy] = createSignal(true);
    const host = mount(() => <PermissionDock title="t" options={opts} busy={busy()} onChoose={(id) => chosen.push(id)} />);
    key("y", {}, host.querySelector(".sb-dock")!);
    setBusy(false);
    const input = document.createElement("input");
    document.body.append(input);
    key("y", {}, input);
    expect(chosen).toEqual([]);
  });
  it("falls back to allow_always when no allow_once is offered", () => {
    const chosen: string[] = [];
    const host = mount(() => <PermissionDock title="t" options={[opts[1], opts[0]]} onChoose={(id) => chosen.push(id)} />);
    key("y", {}, host.querySelector(".sb-dock")!);
    expect(chosen).toEqual(["aa"]);
  });
});

describe("UrlDock and ActivityBar", () => {
  it("opens on click or Enter and cancels on Escape", () => {
    const open = vi.fn();
    const cancel = vi.fn();
    const copy = vi.fn();
    const host = mount(() => <UrlDock title="Sign in on the web" href="https://example.com/device" code="ABCD-1234" onOpen={open} onCancel={cancel} onCopyCode={copy} />);
    expect(host.textContent).toContain("ABCD-1234");
    host.querySelector<HTMLButtonElement>(".sb-btn.primary")!.click();
    const dock = host.querySelector(".sb-dock")!;
    key("Enter", {}, dock);
    expect(open).toHaveBeenCalledTimes(2);
    host.querySelector<HTMLButtonElement>("[aria-label='Copy code']")!.click();
    expect(copy).toHaveBeenCalledWith("ABCD-1234");
    key("Escape", {}, dock);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("does not double fire when Enter lands on the Cancel button", () => {
    const open = vi.fn();
    const host = mount(() => <UrlDock title="t" href="https://e.com" onOpen={open} onCancel={() => {}} />);
    const cancelButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Cancel")!;
    key("Enter", {}, cancelButton);
    expect(open).not.toHaveBeenCalled();
  });
  it("shows the label and elapsed time outside any live region", () => {
    const host = mount(() => <ActivityBar label="Working" elapsed="12s" hint="Esc to stop" />);
    expect(host.querySelector("[role=status], [aria-live]")).toBeNull();
    expect(text(host.querySelector(".sb-shimmer"))).toBe("Working · 12s");
  });
});

describe("PlanDrawer", () => {
  it("shows the current step and expands to every entry", () => {
    const host = mount(() => <PlanDrawer items={[{ text: "Read code", status: "completed" }, { text: "Write tests", status: "in_progress" }, { text: "Ship", status: "pending" }]} />);
    const head = host.querySelector<HTMLButtonElement>(".sb-drawer-head")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(text(head)).toContain("Write tests");
    expect(text(head)).toContain("1/3");
    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".sb-plan-item")).toHaveLength(3);
    expect(text(host.querySelector(".sb-plan-item.completed"))).toContain("done");
  });
});

describe("QueuePanel", () => {
  const items = [{ id: "1", text: "first" }, { id: "2", text: "second" }];
  it("edits, removes, sends now and clears", () => {
    const calls: string[] = [];
    const host = mount(() => (
      <QueuePanel items={items} onEdit={(id, t) => calls.push(`edit:${id}:${t}`)} onRemove={(id) => calls.push(`rm:${id}`)} onSendNow={(id) => calls.push(`now:${id}`)} onClear={() => calls.push("clear")} />
    ));
    expect(text(host.querySelector(".sb-queue-head"))).toContain("2 queued");
    host.querySelector<HTMLButtonElement>("[aria-label='Remove queued message 2']")!.click();
    host.querySelector<HTMLButtonElement>("[aria-label='Send queued message 1 now']")!.click();
    host.querySelector<HTMLButtonElement>(".sb-queue-head button")!.click();
    host.querySelector<HTMLButtonElement>("[aria-label='Edit queued message 1']")!.click();
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("first");
    input.value = "first, revised";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    key("Enter", {}, input);
    expect(calls).toEqual(["rm:2", "now:1", "clear", "edit:1:first, revised"]);
    expect(host.querySelector("input")).toBeNull();
  });
  it("offers Send queued with a notice when the queue is held after an error", () => {
    const onSendAll = vi.fn();
    const host = mount(() => <QueuePanel items={items} held onSendAll={onSendAll} onEdit={() => {}} onRemove={() => {}} onSendNow={() => {}} onClear={() => {}} />);
    expect(text(host.querySelector(".sb-queue-held"))).toBe("Not sent: the last turn ended with an error or the agent reconnected.");
    host.querySelector<HTMLButtonElement>("[aria-label='Send 2 queued messages']")!.click();
    expect(onSendAll).toHaveBeenCalledOnce();
  });
  it("shows no Send queued button while the queue drains on its own", () => {
    const host = mount(() => <QueuePanel items={items} onSendAll={() => {}} onEdit={() => {}} onRemove={() => {}} onSendNow={() => {}} onClear={() => {}} />);
    expect(host.querySelector(".sb-queue-held")).toBeNull();
    expect(host.querySelector("[aria-label='Send 2 queued messages']")).toBeNull();
  });
  it("cancels an edit with Escape without saving", () => {
    const onEdit = vi.fn();
    const host = mount(() => <QueuePanel items={items} onEdit={onEdit} onRemove={() => {}} onSendNow={() => {}} onClear={() => {}} />);
    host.querySelector<HTMLButtonElement>("[aria-label='Edit queued message 1']")!.click();
    const input = host.querySelector<HTMLInputElement>("input")!;
    key("Escape", {}, input);
    expect(onEdit).not.toHaveBeenCalled();
    expect(host.querySelector("input")).toBeNull();
  });
});
