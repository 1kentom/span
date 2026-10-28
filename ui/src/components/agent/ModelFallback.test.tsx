// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignIn } from "./SignIn";
import { mount } from "./test-utils";

beforeEach(() => window.localStorage.clear());

describe("model fallback on a refused prompt", () => {
  it("offers another model and sends the choice back with the retry", () => {
    const onUseModel = vi.fn();
    const host = mount(() => (
      <SignIn name="OpenCode" id="opencode" title="Sign in to OpenCode" methods={[]} onPick={() => undefined} models={[{ value: "opencode/big-pickle", name: "Big Pickle" }, { value: "b", name: "B" }]} onUseModel={onUseModel} />
    ));
    const select = host.querySelector<HTMLSelectElement>("#sb-fallback-model")!;
    expect(select.options).toHaveLength(2);
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    host.querySelector<HTMLButtonElement>(".sb-model-fallback .sb-btn.primary")!.click();
    expect(onUseModel).toHaveBeenCalledWith("b");
  });
  it("shows nothing when the agent has no other model", () => {
    const host = mount(() => <SignIn name="X" title="Sign in" methods={[]} onPick={() => undefined} models={[]} onUseModel={() => undefined} />);
    expect(host.querySelector(".sb-model-fallback")).toBeNull();
  });
});
