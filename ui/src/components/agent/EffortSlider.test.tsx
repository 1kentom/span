// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Show, createSignal } from "solid-js";
import {
  EffortSlider, REPEAT_MS, SETTLE_MS, defaultLevel, effortColor, indexFromPointer, isPeak, keyTarget, levelIndex, levelPosition,
  levelText, modelNameOf, repeatCount, stepIndex, type EffortLevel,
} from "./EffortSlider";
import { key, mount, text } from "./test-utils";

const levels = (names: string[]): EffortLevel[] => names.map((name, index) => ({ value: `v${index}`, name }));
const codex = levels(["minimal", "low", "medium", "high", "ultra"]);
const claude = [{ value: "default", name: "Default", description: "Let the model decide" }, ...levels(["Low", "Medium", "High", "Higher", "Max"]).map((level, index) => ({ ...level, value: `c${index}` }))];

const pointer = (target: Element, type: string, clientX = 0) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));
const keyup = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("effort level math", () => {
  it("finds, steps and clamps indexes without knowing level names", () => {
    expect(levelIndex(codex, "v2")).toBe(2);
    expect(levelIndex(codex, "nope")).toBe(-1);
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(-1, 1, 5)).toBe(0);
    expect(stepIndex(-1, -1, 5)).toBe(0);
    expect(levelPosition(0, 4)).toBe(0);
    expect(levelPosition(3, 4)).toBe(1);
    expect(levelPosition(1, 3)).toBe(0.5);
    expect(levelPosition(-1, 3)).toBe(0);
    expect(isPeak(4, 5)).toBe(true);
    expect(isPeak(0, 1)).toBe(false);
  });

  it("maps slider keys", () => {
    expect(["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "Home", "End", "PageUp", "PageDown"].map((name) => keyTarget(name, 2, 6))).toEqual([3, 3, 1, 1, 0, 5, 4, 0]);
    expect(keyTarget("PageUp", 5, 6)).toBe(5);
    expect(keyTarget("Enter", 2, 6)).toBeUndefined();
  });

  it("snaps a pointer x to the nearest level", () => {
    // 200 px track, 12 px edges: levels sit at 12, 100 and 188 for three levels.
    expect(indexFromPointer(0, 0, 200, 3)).toBe(0);
    expect(indexFromPointer(55, 0, 200, 3)).toBe(0);
    expect(indexFromPointer(57, 0, 200, 3)).toBe(1);
    expect(indexFromPointer(150, 0, 200, 3)).toBe(2);
    expect(indexFromPointer(999, 0, 200, 3)).toBe(2);
    expect(indexFromPointer(110, 10, 200, 8)).toBe(4);
    expect(indexFromPointer(50, 0, 200, 1)).toBe(0);
  });

  it("builds the colour ramp from tokens: calm, amber in the middle, accent, then the peak", () => {
    expect(effortColor(0, 5)).toBe("var(--fx-calm)");
    expect(effortColor(1, 5)).toBe("color-mix(in oklab, var(--fx-amber) 50%, var(--fx-calm))");
    expect(effortColor(2, 5)).toBe("var(--fx-amber)");
    expect(effortColor(3, 5)).toBe("color-mix(in oklab, var(--fx-high) 50%, var(--fx-amber))");
    expect(effortColor(4, 5)).toBe("var(--fx-peak)");
    expect(effortColor(1, 2)).toBe("var(--fx-peak)");
    expect(effortColor(-1, 4)).toBe("var(--fx-neutral)");
    for (let count = 2; count <= 8; count++) for (let index = 0; index < count; index++) expect(effortColor(index, count)).not.toMatch(/#[0-9a-f]{3}/i);
  });

  it("writes label text and finds a default only when the agent names one", () => {
    expect(levelText(claude[0])).toBe("Default, Let the model decide");
    expect(levelText(codex[1])).toBe("low");
    expect(levelText(undefined)).toBe("Unknown level");
    expect(defaultLevel(claude)).toBe("default");
    expect(defaultLevel(levels(["Fast", "Recommended", "Slow"]))).toBe("v1");
    expect(defaultLevel(codex)).toBeUndefined();
  });

  it("repeats one step per interval while held", () => {
    expect(REPEAT_MS).toBe(250);
    expect([0, 249, 250, 999, 1000].map(repeatCount)).toEqual([1, 1, 2, 4, 5]);
  });

  it("reads the model name from the model option", () => {
    expect(modelNameOf([{ id: "m", name: "Model", category: "model", currentValue: "b", choices: [{ value: "a", name: "A" }, { value: "b", name: "Opus" }] }])).toBe("Opus");
    expect(modelNameOf([])).toBeUndefined();
  });
});

function setup(options: EffortLevel[], initial: string, extra: Partial<Parameters<typeof EffortSlider>[0]> = {}) {
  const [value, setValue] = createSignal(initial);
  const changes: string[] = [];
  const host = mount(() => <EffortSlider label="Effort" options={options} value={value()} onChange={(next) => { changes.push(next); setValue(next); }} {...extra} />);
  const slider = host.querySelector<HTMLElement>("[role=slider]");
  return { host, slider: slider!, changes, setValue, label: () => text(host.querySelector(".fx-label:not(.fx-label-out)")) };
}

describe("EffortSlider", () => {
  it("exposes slider semantics with the agent's level names", () => {
    const { slider, label } = setup(claude, "default");
    expect(slider.getAttribute("aria-orientation")).toBe("horizontal");
    expect([slider.getAttribute("aria-valuemin"), slider.getAttribute("aria-valuemax"), slider.getAttribute("aria-valuenow")]).toEqual(["0", "5", "0"]);
    expect(slider.getAttribute("aria-valuetext")).toBe("Default, Let the model decide");
    expect(slider.tabIndex).toBe(0);
    expect(label()).toBe("Default");
  });

  it.each([2, 3, 4, 6, 8])("renders one tick per level for %i levels and marks the peak only at the end", (count) => {
    const names = Array.from({ length: count }, (_, index) => `L${index}`);
    const { host, slider, setValue } = setup(levels(names), "v0");
    expect(host.querySelectorAll(".fx-tick")).toHaveLength(count);
    expect(host.querySelectorAll(".fx-tick.passed")).toHaveLength(1);
    expect(host.querySelector(".fx-sparkles")).toBeNull();
    setValue(`v${count - 1}`);
    expect(slider.getAttribute("aria-valuenow")).toBe(String(count - 1));
    expect(host.querySelector(".fx")!.classList.contains("fx-peak")).toBe(true);
    expect(host.querySelectorAll(".fx-sparkle")).toHaveLength(5);
    expect(host.querySelectorAll(".fx-tick.passed")).toHaveLength(count);
  });

  it("shows a single level as a chip without a slider", () => {
    const { host } = setup(levels(["Only"]), "v0");
    expect(host.querySelector("[role=slider]")).toBeNull();
    expect(text(host.querySelector(".fx-chip"))).toBe("Only");
  });

  it("renders nothing without levels", () => {
    const { host } = setup([], "");
    expect(host.querySelector(".fx")).toBeNull();
  });

  it("steps with the keyboard and sends one change when the key is released", () => {
    vi.useFakeTimers();
    const { slider, changes, label } = setup(codex, "v1");
    key("ArrowRight", {}, slider);
    key("ArrowRight", {}, slider);
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    expect(label()).toBe("high");
    expect(changes).toEqual([]);
    keyup(slider, "ArrowRight");
    expect(changes).toEqual(["v3"]);
    key("Home", {}, slider);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(changes).toEqual(["v3", "v0"]);
    key("End", {}, slider); keyup(slider, "End");
    key("PageDown", {}, slider); keyup(slider, "PageDown");
    key("ArrowUp", {}, slider); keyup(slider, "ArrowUp");
    key("ArrowDown", {}, slider); key("ArrowLeft", {}, slider); keyup(slider, "ArrowLeft");
    expect(changes).toEqual(["v3", "v0", "v4", "v2", "v3", "v1"]);
  });

  it("stops arrow keys from reaching the popover's focus handling", () => {
    const outer = vi.fn();
    const host = mount(() => <div onKeyDown={outer}><EffortSlider options={codex} value="v1" onChange={() => {}} /></div>);
    const slider = host.querySelector<HTMLElement>("[role=slider]")!;
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    slider.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    key("Tab", {}, slider);
    expect(outer).toHaveBeenCalledOnce();
  });

  it("announces politely only when a change is committed", () => {
    const { slider, host } = setup(codex, "v1");
    const live = host.querySelector(".fx-live")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    key("ArrowRight", {}, slider);
    key("ArrowRight", {}, slider);
    expect(text(live)).toBe("");
    keyup(slider, "ArrowRight");
    expect(text(live)).toBe("high");
  });

  it("drags with snapping, scales the knob while dragging and commits on release", () => {
    const { slider, host, changes } = setup(codex, "v0");
    slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 24, right: 200, bottom: 24, x: 0, y: 0, toJSON: () => ({}) });
    pointer(slider, "pointerdown", 100);
    expect(host.querySelector(".fx")!.classList.contains("fx-dragging")).toBe(true);
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    pointer(slider, "pointermove", 150);
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    expect(changes).toEqual([]);
    pointer(slider, "pointerup", 150);
    expect(changes).toEqual(["v3"]);
    expect(host.querySelector(".fx")!.classList.contains("fx-dragging")).toBe(false);
    pointer(slider, "pointerdown", 5);
    pointer(slider, "pointerup", 5);
    expect(changes).toEqual(["v3", "v0"]);
  });

  it("pulses the ticks the knob passes", () => {
    const { slider, host } = setup(codex, "v0");
    key("End", {}, slider);
    const pulsing = [...host.querySelectorAll(".fx-tick")].map((tick) => tick.classList.contains("fx-pulse-a") || tick.classList.contains("fx-pulse-b"));
    expect(pulsing).toEqual([false, true, true, true, true]);
  });

  it("steps with plus and minus, disables them at the ends without removing focus, and repeats while held", () => {
    vi.useFakeTimers();
    const { host, slider, changes } = setup(codex, "v3");
    const lower = host.querySelector<HTMLButtonElement>("[aria-label='Lower effort']")!;
    const higher = host.querySelector<HTMLButtonElement>("[aria-label='Higher effort']")!;
    higher.click(); // keyboard activation arrives as a click with detail 0
    expect(changes).toEqual(["v4"]);
    expect(higher.getAttribute("aria-disabled")).toBe("true");
    expect(higher.disabled).toBe(false);
    higher.focus();
    higher.click();
    expect(changes).toEqual(["v4"]);
    expect(document.activeElement).toBe(higher);
    pointer(lower, "pointerdown");
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    vi.advanceTimersByTime(REPEAT_MS);
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    vi.advanceTimersByTime(REPEAT_MS * 2);
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    expect(changes).toEqual(["v4"]);
    vi.advanceTimersByTime(REPEAT_MS); // the next repeat finds the end and sends the change
    expect(changes).toEqual(["v4", "v0"]);
    expect(lower.getAttribute("aria-disabled")).toBe("true");
    pointer(lower, "pointerup");
    expect(changes).toEqual(["v4", "v0"]);
  });

  it("commits a held stepper on release", () => {
    vi.useFakeTimers();
    const { host, changes } = setup(codex, "v0");
    const higher = host.querySelector<HTMLButtonElement>("[aria-label='Higher effort']")!;
    pointer(higher, "pointerdown");
    vi.advanceTimersByTime(REPEAT_MS);
    pointer(higher, "pointerup");
    expect(changes).toEqual(["v2"]);
  });

  it("hides the bolt and reset when the data does not support them", () => {
    const { host } = setup(codex, "v1");
    expect(host.querySelector(".fx-fast")).toBeNull();
    expect(host.querySelector(".fx-reset")).toBeNull();
    expect(host.querySelector(".fx-model")).toBeNull();
  });

  it("shows the bolt only when a fast option is passed and toggles it", () => {
    const toggled = vi.fn();
    const { host } = setup(codex, "v1", { fast: { on: true, onToggle: toggled } });
    const bolt = host.querySelector<HTMLButtonElement>(".fx-fast")!;
    expect(bolt.getAttribute("aria-pressed")).toBe("true");
    bolt.click();
    expect(toggled).toHaveBeenCalledOnce();
  });

  it("resets to a knowable default", () => {
    const { host, changes } = setup(claude, "c3", { defaultValue: defaultLevel(claude) });
    const reset = host.querySelector<HTMLButtonElement>(".fx-reset")!;
    expect(reset.getAttribute("aria-label")).toBe("Reset to Default");
    reset.click();
    expect(changes).toEqual(["default"]);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    reset.click();
    expect(changes).toEqual(["default"]);
  });

  it("shows the model line and calls back from its chevron", () => {
    const clicked = vi.fn();
    const { host } = setup(codex, "v1", { modelName: "gpt-5", onModelClick: clicked });
    const model = host.querySelector<HTMLButtonElement>(".fx-model")!;
    expect(text(model)).toBe("gpt-5");
    model.click();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("shows a neutral state for an unknown current value", () => {
    const { host, slider, label } = setup(codex, "mystery");
    expect(host.querySelector(".fx")!.classList.contains("fx-unknown")).toBe(true);
    expect(slider.hasAttribute("aria-valuenow")).toBe(false);
    expect(slider.getAttribute("aria-valuetext")).toBe("Unknown level");
    expect(label()).toBe("mystery");
    expect(host.querySelectorAll(".fx-tick.passed")).toHaveLength(0);
  });

  it("ignores input while disabled", () => {
    const { host, slider, changes } = setup(codex, "v1", { disabled: true });
    expect(slider.getAttribute("aria-disabled")).toBe("true");
    key("ArrowRight", {}, slider); keyup(slider, "ArrowRight");
    host.querySelector<HTMLButtonElement>("[aria-label='Higher effort']")!.click();
    expect(changes).toEqual([]);
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
  });

  it("truncates long level names with a title", () => {
    const long = "An extremely long effort level name that will never fit in a narrow popover";
    const { host } = setup(levels(["Low", long]), "v1");
    expect(host.querySelector(".fx-label-wrap")!.getAttribute("title")).toBe(long);
  });

  it("cross-fades the label when the level changes", () => {
    const { host, slider } = setup(codex, "v1");
    expect(host.querySelector(".fx-label-out")).toBeNull();
    key("ArrowRight", {}, slider);
    expect(text(host.querySelector(".fx-label-out"))).toBe("low");
    expect(host.querySelector(".fx-label-in")?.textContent).toBe("medium");
  });

  it("adds the reduced motion class when the user prefers reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener: () => {}, removeEventListener: () => {} }));
    const { host } = setup(codex, "v4");
    expect(host.querySelector(".fx")!.classList.contains("fx-reduced")).toBe(true);
  });

  it("drops the local preview when the agent reports a different value", () => {
    const { slider, setValue } = setup(codex, "v1");
    key("ArrowRight", {}, slider); keyup(slider, "ArrowRight");
    setValue("v0");
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
  });
});

describe("EffortSlider remount", () => {
  it("keeps focus on the same control when the popover rebuilds it after a change", () => {
    const [options, setOptions] = createSignal(codex.map((level) => ({ ...level })));
    const [value, setValue] = createSignal("v1");
    const host = mount(() => <Show when={options()} keyed>{(list) => <EffortSlider label="Effort" options={list} value={value()} onChange={setValue} />}</Show>);
    const first = host.querySelector<HTMLElement>("[role=slider]")!;
    first.focus();
    key("ArrowRight", {}, first); keyup(first, "ArrowRight");
    setOptions(codex.map((level) => ({ ...level })));
    const second = host.querySelector<HTMLElement>("[role=slider]")!;
    expect(second).not.toBe(first);
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-valuenow")).toBe("2");
  });
});
