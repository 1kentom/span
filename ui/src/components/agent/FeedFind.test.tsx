// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import type { AgentController } from "../../lib/agent-controller";
import { openFeedFind } from "../../lib/feed-find";
import { FeedFind } from "./FeedFind";
import { mount, text } from "./test-utils";

const rect = (top: number) => ({ top, bottom: top + 20, height: 20, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(() => {
  Range.prototype.getBoundingClientRect = () => rect(10);
});

function setup() {
  const reveal = vi.fn();
  const scroller = document.createElement("div");
  scroller.tabIndex = -1;
  scroller.getBoundingClientRect = () => rect(0);
  const [feed, setFeed] = createSignal<unknown[]>([]);
  const agent = { follow: { reveal }, scrollers: { content: scroller }, feed } as unknown as AgentController;
  let scope!: HTMLElement;
  let feedElement!: HTMLDivElement;
  const host = mount(() => (
    <section ref={scope}>
      <div class="agent-feed" ref={feedElement}>
        <div class="agent-message user">Run the build</div>
        <div class="agent-message text">The build failed, so I fixed the build script.</div>
        <div class="agent-message user">Thanks</div>
      </div>
      <textarea class="composer" />
      <div class="cm-editor"><div class="cm-content" contenteditable="true" /></div>
      <FeedFind agent={agent} scope={() => scope} feed={() => feedElement} />
    </section>
  ));
  scope.prepend(scroller);
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const type = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>(".agent-find-input")!;
    input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await Promise.resolve();
    return input;
  };
  return { host, scope, reveal, press, type, setFeed, feedElement, scroller };
}

describe("find in thread", () => {
  it("opens on Ctrl+F from the composer, counts matches, steps with Enter and closes with Escape", async () => {
    const t = setup();
    const composer = t.host.querySelector("textarea")!;
    expect(t.press(composer, "f", { ctrlKey: true }).defaultPrevented).toBe(true);
    await Promise.resolve();
    const input = t.host.querySelector<HTMLInputElement>(".agent-find-input")!;
    expect(document.activeElement).toBe(input);
    await t.type("build");
    expect(text(t.host.querySelector(".agent-find-count"))).toBe("1 of 3");
    expect(t.reveal).toHaveBeenCalledTimes(1);
    t.press(input, "Enter");
    expect(text(t.host.querySelector(".agent-find-count"))).toBe("2 of 3");
    t.press(input, "Enter", { shiftKey: true });
    t.press(input, "Enter", { shiftKey: true });
    expect(text(t.host.querySelector(".agent-find-count"))).toBe("3 of 3");
    expect(t.reveal.mock.calls.at(-1)![0].toString()).toBe("build");
    await t.type("nothing here");
    expect(text(t.host.querySelector(".agent-find-count"))).toBe("No results");
    expect(t.press(input, "Escape").defaultPrevented).toBe(true);
    expect(t.host.querySelector(".agent-find")).toBeNull();
    expect(document.activeElement).toBe(t.scroller);
  });

  it("leaves Find to an editor inside the panel", () => {
    const t = setup();
    const editor = t.host.querySelector(".cm-content")!;
    expect(t.press(editor, "f", { metaKey: true }).defaultPrevented).toBe(false);
    expect(t.host.querySelector(".agent-find")).toBeNull();
    expect(openFeedFind(editor)).toBe(false);
  });

  it("opens when the app routes the native Find shortcut while focus is in the panel", async () => {
    const t = setup();
    t.scroller.focus();
    expect(openFeedFind(document.activeElement)).toBe(true);
    await Promise.resolve();
    expect(t.host.querySelector(".agent-find")).not.toBeNull();
  });

  it("Cmd+Down and Cmd+Up jump between your messages, not while typing", () => {
    const t = setup();
    const [first, second] = [...t.feedElement.querySelectorAll<HTMLElement>(".agent-message.user")];
    first.getBoundingClientRect = () => rect(-300);
    second.getBoundingClientRect = () => rect(500);
    expect(t.press(t.scroller, "ArrowDown", { metaKey: true }).defaultPrevented).toBe(true);
    expect(t.reveal).toHaveBeenLastCalledWith(second, "start");
    expect(t.press(t.scroller, "ArrowUp", { metaKey: true }).defaultPrevented).toBe(true);
    expect(t.reveal).toHaveBeenLastCalledWith(first, "start");
    t.reveal.mockClear();
    t.press(t.host.querySelector("textarea")!, "ArrowUp", { metaKey: true });
    expect(t.reveal).not.toHaveBeenCalled();
  });
});
