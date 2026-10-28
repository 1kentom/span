// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignIn } from "./SignIn";
import { key, mount, text } from "./test-utils";

beforeEach(() => window.localStorage.clear());

const models = [
  { value: "opencode/big-pickle", name: "opencode/Big Pickle" },
  { value: "opencode/beam-free", name: "opencode/Beam Free" },
  { value: "opencode-go/beam-free", name: "opencode-go/Beam Free" },
  { value: "opencode-go/glm-5", name: "opencode-go/GLM 5" },
  { value: "opencode/claude-opus-5-5", name: "opencode/Claude Opus 5.5" },
];
const view = (props: { models?: { value: string; name: string }[]; busy?: boolean; onUseModel?: (value: string) => void } = {}) =>
  mount(() => <SignIn name="OpenCode" id="opencode" title="Sign in to OpenCode" methods={[]} onPick={() => undefined} models={props.models ?? models} busy={props.busy} onUseModel={props.onUseModel ?? (() => undefined)} />);
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[role='radiogroup'] [role='radio']")];
const checked = (host: HTMLElement) => rows(host).findIndex((row) => row.getAttribute("aria-checked") === "true");
const use = (host: HTMLElement) => host.querySelector<HTMLButtonElement>(".sb-model-fallback .sb-btn.primary")!;

describe("model fallback on a refused prompt", () => {
  it("lists the models as radio rows, no native select, with the first free one chosen", () => {
    const host = view();
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector("[role='radiogroup']")?.getAttribute("aria-label")).toBe("Use a free model instead");
    expect(text(host.querySelector(".sb-model-fallback .sb-eyebrow"))).toBe("Use a free model instead");
    expect(rows(host).map((row) => text(row.querySelector(".sb-option-name")))).toEqual(["Big Pickle", "Beam Free", "Beam Free", "GLM 5", "Claude Opus 5.5"]);
    expect(rows(host).map((row) => text(row.querySelector(".sb-cost-chip")))).toEqual(["Free", "Free", "Free", "Subscription", "Paid"]);
    expect([...host.querySelectorAll(".sb-model-fallback .sb-provider-tag")].map((node) => node.textContent)).toEqual(["opencode", "opencode-go"]);
    expect(rows(host)[0].querySelector(".sb-model-icon")).not.toBeNull();
    expect(checked(host)).toBe(0);
    expect(use(host).disabled).toBe(false);
  });
  it("sends the chosen model back with the retry", () => {
    const onUseModel = vi.fn();
    const host = view({ onUseModel });
    rows(host)[3].click();
    expect(checked(host)).toBe(3);
    use(host).click();
    expect(onUseModel).toHaveBeenCalledWith("opencode-go/glm-5");
  });
  it("moves with arrows, Home and End, keeps one tab stop, and selects with Space and Enter", () => {
    const host = view();
    const tabStops = () => rows(host).filter((row) => row.tabIndex === 0);
    expect(tabStops()).toEqual([rows(host)[0]]);
    rows(host)[0].focus();
    key("ArrowDown", {}, rows(host)[0]);
    expect(document.activeElement).toBe(rows(host)[1]);
    expect(checked(host)).toBe(1);
    expect(tabStops()).toEqual([rows(host)[1]]);
    key("End", {}, rows(host)[1]);
    expect(document.activeElement).toBe(rows(host)[4]);
    key("ArrowDown", {}, rows(host)[4]);
    expect(document.activeElement).toBe(rows(host)[0]);
    key("ArrowUp", {}, rows(host)[0]);
    expect(document.activeElement).toBe(rows(host)[4]);
    key("Home", {}, rows(host)[4]);
    expect(document.activeElement).toBe(rows(host)[0]);
    expect(checked(host)).toBe(0);
    rows(host)[2].focus();
    key(" ", {}, rows(host)[2]);
    expect(checked(host)).toBe(2);
    rows(host)[3].focus();
    key("Enter", {}, rows(host)[3]);
    expect(checked(host)).toBe(3);
  });
  it("waits for a choice when no model is free, and while busy", () => {
    const paid = [{ value: "opencode/claude-opus-5-5", name: "Claude Opus 5.5" }, { value: "opencode-go/glm-5", name: "GLM 5" }];
    const host = view({ models: paid });
    expect(text(host.querySelector(".sb-model-fallback .sb-eyebrow"))).toBe("Use another model");
    expect(checked(host)).toBe(-1);
    expect(use(host).disabled).toBe(true);
    expect(rows(host)[0].tabIndex).toBe(0);
    rows(host)[1].click();
    expect(use(host).disabled).toBe(false);
    const busy = view({ busy: true });
    expect(use(busy).disabled).toBe(true);
  });
  it("staggers the rows by index for the fade in", () => {
    const host = view();
    expect(rows(host).map((row) => row.style.getPropertyValue("--i"))).toEqual(["0", "1", "2", "3", "4"]);
  });
  it("shows nothing when the agent has no other model", () => {
    const host = mount(() => <SignIn name="X" title="Sign in" methods={[]} onPick={() => undefined} models={[]} onUseModel={() => undefined} />);
    expect(host.querySelector(".sb-model-fallback")).toBeNull();
  });
});
