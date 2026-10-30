// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { render } from "solid-js/web";

// The whole workbench in browser preview mode: the fixtures stand in for the desktop backend.
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as never;
  Range.prototype.getClientRects ??= (() => []) as never;
  Range.prototype.getBoundingClientRect ??= (() => new DOMRect()) as never;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
});
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); localStorage.clear(); });

const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function settle(rounds = 20) { for (let index = 0; index < rounds; index += 1) await wait(5); }
async function mount() {
  const { default: App } = await import("./App");
  const root = document.createElement("div"); document.body.append(root);
  disposers.push(render(() => <App />, root));
  await settle(40);
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const button = (label: string) => $<HTMLButtonElement>(`[aria-label="${label}"]`)!;
/** jsdom reports Linux, so the zen default is Ctrl+Alt+Z (Ctrl+Cmd+Z on macOS). */
function key(init: KeyboardEventInit, target: EventTarget = document.activeElement ?? document.body) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
const toggleZen = () => key({ key: "z", code: "KeyZ", ctrlKey: true, altKey: true });
const escape = (target?: EventTarget) => key({ key: "Escape", code: "Escape" }, target);
const inZen = () => !!$("main.ide.zen");
const display = (selector: string) => $(selector)?.style.display;

async function showPanels() {
  if (button("Toggle project panel").getAttribute("aria-pressed") !== "true") button("Toggle project panel").click();
  if (button("Toggle terminal panel").getAttribute("aria-pressed") !== "true") button("Toggle terminal panel").click();
  if (button("Toggle AI Assistant panel").getAttribute("aria-pressed") !== "true") button("Toggle AI Assistant panel").click();
  await settle();
}

describe("zen mode in the workbench", () => {
  it("shows only the editor and the agent sidebar, then restores the exact previous layout", async () => {
    await mount();
    await showPanels();
    const before = { left: $(".explorer-panel")!.style.width, right: $(".assistant-panel")!.style.width, bottom: $(".run-bottom-panel")!.style.height };
    expect(display(".explorer-panel")).toBe("flex");
    expect(display(".run-bottom-panel")).toBe("flex");
    expect($(".statusbar")).not.toBeNull();
    expect($(".editor-header .editor-tabs")).not.toBeNull();

    toggleZen(); await settle();
    expect(inZen()).toBe(true);
    expect(display(".explorer-panel")).toBe("none");
    expect(display(".run-bottom-panel")).toBe("none");
    expect($(".statusbar")).toBeNull();
    expect($(".breadcrumbs")).toBeNull();
    expect($(".editor-tabs")).toBeNull();
    expect($(".editor-pane")).not.toBeNull();
    expect(display(".assistant-panel")).toBe("flex");
    expect($(".zen-pill button")?.getAttribute("aria-label")).toBe("Exit Zen mode");
    expect($(".zen-live")?.textContent).toContain("Zen mode on");

    // Search opens over the editor as a peek and switches the left view; Escape in it closes back to zen.
    key({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true }); await settle();
    expect(display(".explorer-panel")).toBe("flex");
    expect($(".explorer-panel")!.classList.contains("sidebar-overlay")).toBe(true);
    expect($(".explorer-header .panel-tab.selected")?.textContent).toBe("Search");
    escape($(".explorer-panel")!); await settle();
    expect(display(".explorer-panel")).toBe("none");
    expect(inZen()).toBe(true);

    // The agent sidebar keeps its normal shortcut in zen.
    key({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }); await settle();
    expect(display(".assistant-panel")).toBe("none");

    toggleZen(); await settle();
    expect(inZen()).toBe(false);
    expect(display(".explorer-panel")).toBe("flex");
    expect($(".explorer-panel")!.classList.contains("sidebar-overlay")).toBe(false);
    expect($(".explorer-header .panel-tab.selected")?.textContent).toBe("Files");
    expect(display(".run-bottom-panel")).toBe("flex");
    expect(display(".assistant-panel")).toBe("flex");
    expect({ left: $(".explorer-panel")!.style.width, right: $(".assistant-panel")!.style.width, bottom: $(".run-bottom-panel")!.style.height }).toEqual(before);
    expect($(".statusbar")).not.toBeNull();
    expect($(".editor-tabs")).not.toBeNull();
    expect($(".zen-live")?.textContent).toContain("Zen mode off");
  }, 60_000);

  it("leaves on a double Escape that nothing else answered, never on a single one", async () => {
    await mount();
    toggleZen(); await settle();
    escape(document.body); await settle(4);
    expect(inZen()).toBe(true);
    await wait(600);
    escape(document.body); await settle(4);
    expect(inZen()).toBe(true);

    // An Escape a popover answers resets the sequence, whether it prevents the default or stops propagation.
    const popover = document.createElement("div"); document.body.append(popover);
    popover.addEventListener("keydown", event => { event.preventDefault(); event.stopPropagation(); });
    escape(popover); await settle(2);
    escape(document.body); await settle(2);
    expect(inZen()).toBe(true);
    const handled = document.createElement("div"); document.body.append(handled);
    handled.addEventListener("keydown", event => event.preventDefault());
    escape(handled); await settle(2);
    escape(document.body); await settle(2);
    expect(inZen()).toBe(true);

    escape(document.body); await settle(2);
    expect(inZen()).toBe(false);
  }, 60_000);

  it("exits from the pill button and keeps focus out of hidden panels", async () => {
    await mount();
    await showPanels();
    const hiddenButton = button("New folder");
    hiddenButton.focus();
    expect(document.activeElement).toBe(hiddenButton);
    toggleZen(); await settle();
    expect(document.activeElement?.closest(".explorer-panel")).toBeNull();
    $<HTMLButtonElement>(".zen-pill .zen-exit")!.click(); await settle();
    expect(inZen()).toBe(false);
    expect(display(".explorer-panel")).toBe("flex");
  }, 60_000);

  it("on the Agents page shows only the thread and never opens the editor sidebar", async () => {
    await mount();
    await showPanels();
    key({ key: "A", code: "KeyA", ctrlKey: true, shiftKey: true }); await settle();
    expect($(".agents-view-layer")).not.toBeNull();
    toggleZen(); await settle();
    expect($("main.ide")!.classList.contains("zen-agents")).toBe(true);
    expect(display(".assistant-panel")).toBe("none");
    expect(display(".run-bottom-panel")).toBe("none");
    expect($(".statusbar")).toBeNull();
    key({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }); await settle();
    expect(display(".assistant-panel")).toBe("none");
    toggleZen(); await settle();
    expect(inZen()).toBe(false);
  }, 60_000);
});
