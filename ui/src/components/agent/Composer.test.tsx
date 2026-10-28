// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { ModelPopover } from "./ModelPopover";
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

const claudeModels: ConfigOptionView = {
  id: "model", name: "Model", category: "model", currentValue: "default",
  choices: [
    { value: "default", name: "Default (recommended)", description: "Sonnet 5.5" },
    { value: "opus", name: "Opus 5.5", description: "For complex work and everyday tasks" },
    { value: "haiku", name: "Haiku 5.5", description: "Fastest for quick answers" },
    { value: "luna", name: "gpt-6-luna" },
  ],
};

describe("ModelPopover traits", () => {
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".sb-option[role=radio]")];
  it("shows an icon on every model row, the bolt on fast models and the star on heavy ones", () => {
    mount(() => <ModelPopover agentName="Claude" brand={{ id: "claude-acp" }} options={[claudeModels]} onSelect={() => {}} onClose={() => {}} />);
    expect(rows()).toHaveLength(4);
    for (const row of rows()) expect(row.querySelector(".sb-model-icon img")).not.toBeNull();
    expect(rows().map((row) => row.querySelectorAll(".sb-trait-badge").length)).toEqual([0, 1, 1, 0]);
    const badge = rows()[2].querySelector(".sb-trait-badge")!;
    expect(badge.getAttribute("aria-label")).toBe("Fast model");
    expect(badge.getAttribute("title")).toBe("Fast model");
    expect(badge.getAttribute("data-trait")).toBe("fast");
    const star = rows()[1].querySelector(".sb-trait-badge")!;
    expect(star.getAttribute("aria-label")).toBe("Most capable");
    expect(star.getAttribute("data-trait")).toBe("frontier");
  });
  it("labels the other trait chip, skips redundant and unknown ones, and keeps the check", () => {
    mount(() => <ModelPopover agentName="Claude" brand={{ id: "claude-acp" }} options={[claudeModels]} onSelect={() => {}} onClose={() => {}} />);
    expect(rows().map((row) => row.querySelector(".sb-trait-chip")?.getAttribute("aria-label") ?? null)).toEqual([null, "Most capable", null, null]);
    expect(rows()[3].querySelector(".sb-trait-badge")).toBeNull();
    expect(rows().map((row) => Boolean(row.querySelector(".sb-accent")))).toEqual([true, false, false, false]);
    expect(rows().map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
  });
  it("applies an explicit fast switch to the current model only", () => {
    const fastSwitch: ConfigOptionView = { id: "fast", name: "Fast", currentValue: "true", choices: [{ value: "true", name: "On" }, { value: "false", name: "Off" }] };
    mount(() => <ModelPopover agentName="Claude" brand={{ id: "claude-acp" }} options={[{ ...claudeModels, currentValue: "opus" }, fastSwitch]} onSelect={() => {}} onClose={() => {}} />);
    expect(rows().slice(0, 4).map((row) => row.querySelectorAll(".sb-trait-badge").length)).toEqual([0, 1, 1, 0]);
  });
  it("keeps keyboard focus on the selected model", async () => {
    mount(() => <ModelPopover agentName="Claude" brand={{ id: "claude-acp" }} options={[claudeModels]} onSelect={() => {}} onClose={() => {}} />);
    await Promise.resolve();
    expect(document.activeElement).toBe(rows()[0]);
  });
});

describe("ModelPopover", () => {
  it("builds sections from the config options and selects by value", () => {
    const picked: string[] = [];
    const closed = vi.fn();
    const host = mount(() => (
      <ModelPopover agentName="Claude" options={options} agents={[{ id: "claude", name: "Claude", current: true }, { id: "gemini", name: "Gemini" }]}
        onSelect={(id, value) => picked.push(`${id}=${value}`)} onSwitchAgent={(id) => picked.push(`agent:${id}`)} onClose={closed} />
    ));
    expect(host.querySelectorAll("[role=radiogroup]")).toHaveLength(2);
    const slider = host.querySelector<HTMLElement>("[role=slider]")!;
    expect(slider.getAttribute("aria-label")).toBe("Reasoning");
    expect([slider.getAttribute("aria-valuemin"), slider.getAttribute("aria-valuemax"), slider.getAttribute("aria-valuenow")]).toEqual(["0", "3", "1"]);
    expect(slider.getAttribute("aria-valuetext")).toBe("Normal");
    expect(text(host.querySelector(".fx-label:not(.fx-label-out)"))).toBe("Normal");
    key("End", {}, slider);
    host.querySelector<HTMLElement>(".fx-track")!.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true }));
    host.querySelector<HTMLButtonElement>("[role=radio][aria-checked=false]")!.click();
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
    expect(host.querySelector(".fx")).toBeNull();
    expect(host.textContent).not.toContain("Agent");
  });

  it("keeps arrow keys on the slider and the model line focuses the selected model", () => {
    const host = mount(() => <ModelPopover agentName="A" options={options} onSelect={() => {}} onClose={() => {}} />);
    const slider = host.querySelector<HTMLElement>("[role=slider]")!;
    slider.focus();
    key("ArrowDown", {}, slider);
    expect(document.activeElement).toBe(slider);
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    const model = host.querySelector<HTMLButtonElement>(".fx-model")!;
    expect(text(model)).toBe("Fast");
    model.click();
    expect(document.activeElement?.textContent).toContain("Fast");
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
  });

  it("moves focus with arrow keys", () => {
    const host = mount(() => <ModelPopover agentName="A" options={[options[2]]} onSelect={() => {}} onClose={() => {}} />);
    const [first, second] = [...host.querySelectorAll<HTMLButtonElement>("button")];
    first.focus();
    key("ArrowDown", {}, first);
    expect(document.activeElement).toBe(second);
  });

  it("keeps keyboard focus and the rows when a config update delivers new option objects", () => {
    const fresh = (current: string) => options.map((option) => ({ ...option, choices: option.choices.map((choice) => ({ ...choice })), currentValue: option.id === "mode" ? current : option.currentValue }));
    const [list, setList] = createSignal(fresh("ask"));
    const host = mount(() => <ModelPopover agentName="A" options={list()} onSelect={() => {}} onClose={() => {}} />);
    const plan = [...host.querySelectorAll<HTMLButtonElement>("button[role=radio]")].find((b) => b.textContent?.includes("Plan"))!;
    plan.focus();
    setList(fresh("plan"));
    const after = [...host.querySelectorAll<HTMLButtonElement>("button[role=radio]")].find((b) => b.textContent?.includes("Plan"))!;
    expect(after).toBe(plan);
    expect(document.activeElement).toBe(plan);
    expect(plan.getAttribute("aria-checked")).toBe("true");
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
    expect(text(host.querySelector(".sb-queue-head"))).toContain("Queued · 2");
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
