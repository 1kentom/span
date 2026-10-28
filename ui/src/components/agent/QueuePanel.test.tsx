// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { QueuePanel } from "./QueuePanel";
import { key, mount, text } from "./test-utils";

const four = [1, 2, 3, 4].map((n) => ({ id: `q${n}`, text: `message ${n}` }));
const noop = () => {};
const base = { onEdit: noop, onRemove: noop, onSendNow: noop, onClear: noop };
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("li.sb-queue-row")];
const grip = (host: HTMLElement, n: number) => host.querySelector<HTMLButtonElement>(`[aria-label^='Reorder queued message ${n}']`)!;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const pointer = (type: string, target: EventTarget, clientY: number, init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0, ...init }));
/** Rows 28px tall every 30px, as in the sidebar, so the drop slot can be computed from the pointer. */
function mockRects(host: HTMLElement) {
  rows(host).forEach((row, i) => {
    row.getBoundingClientRect = () => ({ top: i * 30, bottom: i * 30 + 28, height: 28, left: 0, right: 200, width: 200, x: 0, y: i * 30, toJSON: () => ({}) });
  });
}

describe("QueuePanel design", () => {
  it("shows the header, the sub line and list semantics", () => {
    const host = mount(() => <QueuePanel items={four.slice(0, 2)} note="Sends when the agent finishes" {...base} />);
    expect(text(host.querySelector(".sb-queue-head"))).toContain("Queued · 2");
    expect(text(host.querySelector(".sb-queue-head"))).toContain("Sends when the agent finishes");
    expect(host.querySelector("[role=list]")).not.toBeNull();
    expect(host.querySelectorAll("[role=listitem]")).toHaveLength(2);
    expect(rows(host).map((row) => text(row.querySelector(".sb-queue-num")))).toEqual(["1", "2"]);
  });
  it("gives every row control the design titles and an accessible name", () => {
    const host = mount(() => <QueuePanel items={four.slice(0, 1)} {...base} />);
    const row = rows(host)[0];
    expect(row.querySelector(".sb-queue-text")!.getAttribute("title")).toBe("message 1");
    expect(row.querySelector("[aria-label='Edit queued message 1']")!.getAttribute("title")).toBe("Edit (up arrow)");
    expect(row.querySelector("[aria-label='Remove queued message 1']")!.getAttribute("title")).toBe("Remove");
    expect(row.querySelector("[aria-label='Send queued message 1 now']")!.getAttribute("title")).toBe("Send now: stops the current step");
    expect(grip(host, 1).getAttribute("title")).toBe("Drag to reorder");
    for (const control of row.querySelectorAll("button")) expect(control.getAttribute("aria-label"), control.outerHTML).toBeTruthy();
  });
  it("uses the plain close and pencil icons, never the circled X", () => {
    const host = mount(() => <QueuePanel items={four.slice(0, 1)} {...base} />);
    const mask = (label: string) => host.querySelector<HTMLElement>(`[aria-label='${label}'] .icon`)!.style.getPropertyValue("mask-image");
    expect(mask("Remove queued message 1")).toContain("rounded-linear/cancel.svg");
    expect(mask("Edit queued message 1")).toContain("/icons/Pencil.svg");
    expect(host.innerHTML).not.toContain("close-circle");
  });
  it("renders nothing for an empty queue", () => {
    const host = mount(() => <QueuePanel items={[]} {...base} />);
    expect(host.innerHTML).toBe("");
  });
  it("renumbers after the order changes and keeps the row elements", () => {
    const [items, setItems] = createSignal(four.slice(0, 3));
    const host = mount(() => <QueuePanel items={items()} {...base} />);
    const before = rows(host);
    setItems([items()[2], items()[0], items()[1]]);
    const after = rows(host);
    expect(after.map((row) => text(row.querySelector(".sb-queue-text")))).toEqual(["message 3", "message 1", "message 2"]);
    expect(after.map((row) => text(row.querySelector(".sb-queue-num")))).toEqual(["1", "2", "3"]);
    expect(after.map((row) => row.getAttribute("data-queue-id"))).toEqual(["q3", "q1", "q2"]);
    expect(new Set(after).size).toBe(3);
    expect(before.every((row) => after.includes(row))).toBe(true);
    expect(host.querySelector("[aria-label='Edit queued message 1']")!.closest("li")!.getAttribute("data-queue-id")).toBe("q3");
  });
});

describe("QueuePanel keyboard reorder", () => {
  it("moves a row with Alt+Arrow, announces it politely and keeps focus on the grip", async () => {
    const [items, setItems] = createSignal(four.slice(0, 3));
    const onReorder = vi.fn((from: number, to: number) => {
      const next = [...items()];
      next.splice(to, 0, next.splice(from, 1)[0]);
      setItems(next);
    });
    const host = mount(() => <QueuePanel items={items()} onReorder={onReorder} {...base} />);
    const live = host.querySelector(".sb-visually-hidden[aria-live='polite']")!;
    expect(live).not.toBeNull();
    grip(host, 1).focus();
    expect(key("ArrowDown", { altKey: true }, grip(host, 1))).toBe(false);
    expect(onReorder).toHaveBeenCalledWith(0, 1);
    expect(text(live)).toBe("Moved to position 2 of 3");
    await tick();
    expect(document.activeElement).toBe(host.querySelector("[data-queue-id='q1'] .sb-queue-grip"));
    key("ArrowUp", { altKey: true }, document.activeElement!);
    expect(onReorder).toHaveBeenLastCalledWith(1, 0);
    expect(text(live)).toBe("Moved to position 1 of 3");
  });
  it("does nothing at the ends, without Alt, or while a row is being sent", () => {
    const onReorder = vi.fn();
    const host = mount(() => <QueuePanel items={four.slice(0, 2)} onReorder={onReorder} {...base} />);
    key("ArrowUp", { altKey: true }, grip(host, 1));
    key("ArrowDown", { altKey: true }, grip(host, 2));
    key("ArrowDown", {}, grip(host, 1));
    expect(onReorder).not.toHaveBeenCalled();
    const sending = mount(() => <QueuePanel items={four.slice(0, 2)} onReorder={onReorder} pendingId="q1" {...base} />);
    key("ArrowDown", { altKey: true }, grip(sending, 1));
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("QueuePanel drag reorder", () => {
  it("lifts a row, shows a drop line and reorders on release", () => {
    const onReorder = vi.fn();
    const host = mount(() => <QueuePanel items={four.slice(0, 3)} onReorder={onReorder} {...base} />);
    mockRects(host);
    const g = grip(host, 1);
    pointer("pointerdown", g, 14, { pointerId: 1 } as MouseEventInit);
    pointer("pointermove", g, 80);
    expect(rows(host)[0].classList.contains("dragging")).toBe(true);
    expect(rows(host)[0].style.transform).toBe("translateY(66px)");
    expect(rows(host)[2].getAttribute("data-drop")).toBe("after");
    pointer("pointerup", g, 80);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(0, 2);
    expect(host.querySelector(".dragging")).toBeNull();
    expect(host.querySelector("[data-drop]")).toBeNull();
  });
  it("drags upward and draws the line before the target row", () => {
    const onReorder = vi.fn();
    const host = mount(() => <QueuePanel items={four.slice(0, 3)} onReorder={onReorder} {...base} />);
    mockRects(host);
    const g = grip(host, 3);
    pointer("pointerdown", g, 74);
    pointer("pointermove", g, 5);
    expect(rows(host)[0].getAttribute("data-drop")).toBe("before");
    pointer("pointerup", g, 5);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(2, 0);
  });
  it("does not reorder when released over its own slot, on cancel or on Escape", () => {
    const onReorder = vi.fn();
    const host = mount(() => <QueuePanel items={four.slice(0, 3)} onReorder={onReorder} {...base} />);
    mockRects(host);
    const g = grip(host, 2);
    pointer("pointerdown", g, 44);
    pointer("pointermove", g, 46);
    pointer("pointerup", g, 46);
    pointer("pointerdown", g, 44);
    pointer("pointermove", g, 200);
    pointer("pointercancel", g, 200);
    pointer("pointerdown", g, 44);
    pointer("pointermove", g, 200);
    key("Escape", {}, g);
    pointer("pointerup", g, 200);
    expect(onReorder).not.toHaveBeenCalled();
    expect(host.querySelector(".dragging")).toBeNull();
  });
  it("ignores secondary buttons and any drag while a row is being sent", () => {
    const onReorder = vi.fn();
    const host = mount(() => <QueuePanel items={four.slice(0, 3)} onReorder={onReorder} pendingId="q3" {...base} />);
    mockRects(host);
    const g = grip(host, 1);
    pointer("pointerdown", g, 14);
    pointer("pointermove", g, 80);
    pointer("pointerup", g, 80);
    expect(onReorder).not.toHaveBeenCalled();
    expect(host.querySelector(".dragging")).toBeNull();
    expect(g.disabled).toBe(true);
    const other = mount(() => <QueuePanel items={four.slice(0, 3)} onReorder={onReorder} {...base} />);
    mockRects(other);
    pointer("pointerdown", grip(other, 1), 14, { button: 2 });
    pointer("pointermove", grip(other, 1), 80);
    pointer("pointerup", grip(other, 1), 80);
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("QueuePanel clear", () => {
  it("clears at once with three or fewer messages", () => {
    const onClear = vi.fn();
    const host = mount(() => <QueuePanel items={four.slice(0, 3)} {...base} onClear={onClear} />);
    host.querySelector<HTMLButtonElement>(".sb-queue-head button")!.click();
    expect(onClear).toHaveBeenCalledOnce();
    expect(host.querySelector(".sb-queue-confirm")).toBeNull();
  });
  it("asks inline with four or more, and No keeps the queue", async () => {
    const onClear = vi.fn();
    const host = mount(() => <QueuePanel items={four} {...base} onClear={onClear} />);
    host.querySelector<HTMLButtonElement>("[aria-label='Clear queued messages']")!.click();
    const confirm = host.querySelector(".sb-queue-confirm")!;
    expect(text(confirm)).toContain("Clear all 4?");
    expect(onClear).not.toHaveBeenCalled();
    await tick();
    expect(document.activeElement).toBe(confirm.querySelector("[data-confirm=no]"));
    confirm.querySelector<HTMLButtonElement>("[data-confirm=no]")!.click();
    expect(host.querySelector(".sb-queue-confirm")).toBeNull();
    expect(onClear).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>("[aria-label='Clear queued messages']")!.click();
    host.querySelector<HTMLButtonElement>("[data-confirm=yes]")!.click();
    expect(onClear).toHaveBeenCalledOnce();
  });
  it("cancels the confirmation with Escape", () => {
    const host = mount(() => <QueuePanel items={four} {...base} />);
    host.querySelector<HTMLButtonElement>("[aria-label='Clear queued messages']")!.click();
    key("Escape", {}, host.querySelector("[data-confirm=no]")!);
    expect(host.querySelector(".sb-queue-confirm")).toBeNull();
  });
});

describe("QueuePanel remove and send now", () => {
  it("moves focus to the next row's Remove button, or the last when the end row goes", async () => {
    const [items, setItems] = createSignal(four.slice(0, 3));
    const host = mount(() => <QueuePanel items={items()} {...base} onRemove={(id) => setItems(items().filter((item) => item.id !== id))} />);
    host.querySelector<HTMLButtonElement>("[aria-label='Remove queued message 2']")!.click();
    await tick();
    expect(document.activeElement).toBe(host.querySelector("[data-queue-id='q3'] [aria-label^='Remove queued message']"));
    host.querySelector<HTMLButtonElement>("[aria-label='Remove queued message 2']")!.click();
    await tick();
    expect(document.activeElement).toBe(host.querySelector("[data-queue-id='q1'] [aria-label^='Remove queued message']"));
  });
  it("hands focus back when the last message is removed", async () => {
    const [items, setItems] = createSignal(four.slice(0, 1));
    const onEmptied = vi.fn();
    const host = mount(() => <QueuePanel items={items()} {...base} onEmptied={onEmptied} onRemove={() => setItems([])} />);
    host.querySelector<HTMLButtonElement>("[aria-label='Remove queued message 1']")!.click();
    await tick();
    expect(onEmptied).toHaveBeenCalledOnce();
  });
  it("shows a spinner and disables the row's controls while it is being sent", () => {
    const host = mount(() => <QueuePanel items={four.slice(0, 2)} pendingId="q2" {...base} />);
    const row = rows(host)[1];
    expect(row.querySelector(".sb-spinner")).not.toBeNull();
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(row.querySelector<HTMLButtonElement>("[aria-label='Send queued message 2 now']")!.disabled).toBe(true);
    expect(rows(host)[0].querySelector(".sb-spinner")).toBeNull();
  });
  it("edits the last message when asked to", async () => {
    const [token, setToken] = createSignal(0);
    const host = mount(() => <QueuePanel items={four.slice(0, 3)} editLastToken={token()} {...base} />);
    expect(host.querySelector("input")).toBeNull();
    setToken(1);
    await tick();
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("message 3");
  });
});

describe("QueuePanel held after an error", () => {
  it("keeps the notice, Send queued, Clear and the rows together", () => {
    const onSendAll = vi.fn();
    const host = mount(() => <QueuePanel items={four.slice(0, 2)} held onSendAll={onSendAll} canSendAll {...base} />);
    expect(text(host.querySelector(".sb-queue-held"))).toBe("Not sent: the last turn ended with an error or the agent reconnected.");
    expect(host.querySelector(".sb-queue-held")!.getAttribute("role")).toBe("status");
    const buttons = [...host.querySelectorAll(".sb-queue-head button")].map((button) => text(button));
    expect(buttons).toEqual(["Send queued", "Clear"]);
    host.querySelector<HTMLButtonElement>("[aria-label='Send 2 queued messages']")!.click();
    expect(onSendAll).toHaveBeenCalledOnce();
    expect(rows(host)).toHaveLength(2);
    expect(host.querySelector("section")!.classList.contains("held")).toBe(true);
  });
  it("disables Send queued when it cannot run", () => {
    const host = mount(() => <QueuePanel items={four.slice(0, 2)} held onSendAll={noop} canSendAll={false} {...base} />);
    expect(host.querySelector<HTMLButtonElement>("[aria-label='Send 2 queued messages']")!.disabled).toBe(true);
  });
});
