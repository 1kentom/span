// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createPermissionModeControl } from "./agent-permission-mode";
import { initialAgentState, type AgentState } from "./agent-session";
import { SPAN_MODE_KEY } from "./permission-modes";

const all = ["ask", "acceptEdits", "plan", "auto", "full"] as const;

function setup(meta: Record<string, string> = {}) {
  return createRoot(() => {
    const [state, setState] = createSignal<AgentState>({ ...initialAgentState(true), sessionId: "s", permissionMode: { mode: "ask", supported: [...all], child: false, managed: [] } });
    const apply = vi.fn(async (mode: (typeof all)[number]) => setState((previous) => ({ ...previous, permissionMode: { ...previous.permissionMode!, mode } })));
    const recorded: unknown[] = [];
    const sent: string[] = [];
    const control = createPermissionModeControl({
      state, sessionId: () => "s", agentId: () => "claude", running: () => false, apply,
      recordSessionMeta: (patch) => recorded.push(patch),
      sessionMetaOf: (id) => (meta[id] ? ({ permissionMode: meta[id] } as never) : undefined),
      sendText: (text) => sent.push(text), setPrompt: () => {}, focusPrompt: () => {}, markPlan: () => {}, fail: () => {},
    });
    return { control, apply, state, setState, recorded, sent };
  });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("permission mode control", () => {
  it("Shift+Tab cycles through Ask, Accept edits and Plan, records the mode name and remembers it per agent", async () => {
    window.localStorage.clear();
    const { control, apply, recorded } = setup();
    control.cycle();
    await tick();
    expect(apply).toHaveBeenLastCalledWith("acceptEdits");
    control.cycle();
    await tick();
    control.cycle();
    await tick();
    expect(apply.mock.calls.map((call) => call[0])).toEqual(["acceptEdits", "plan", "ask"]);
    expect(recorded).toContainEqual({ agentId: "claude", sessionId: "s", permissionMode: "plan" });
    expect(JSON.parse(window.localStorage.getItem("span.agent.lastConfig")!).claude[SPAN_MODE_KEY]).toBe("ask");
  });

  it("asks before Full access the first time in a thread, then not again", async () => {
    const { control, apply } = setup();
    await control.choose("full");
    expect(apply).not.toHaveBeenCalled();
    expect(control.confirming()).toBe("s");
    await control.confirmFull();
    expect(apply).toHaveBeenLastCalledWith("full");
    await control.choose("ask");
    await control.choose("full");
    expect(control.confirming()).toBeUndefined();
    expect(apply).toHaveBeenLastCalledWith("full");
  });

  it("restores the mode stored with a resumed thread, falling back to Ask when unsupported", async () => {
    const { control, apply, setState } = setup({ s: "plan" });
    setState((previous) => ({ ...previous, permissionMode: { ...previous.permissionMode!, supported: ["ask", "full"] } }));
    control.restoreThread("s");
    await tick();
    expect(apply).not.toHaveBeenCalled();
    const second = setup({ s: "plan" });
    second.control.restoreThread("s");
    await tick();
    expect(second.apply).toHaveBeenCalledWith("plan");
  });

  it("Implement plan switches to the chosen mode then asks the agent to implement", async () => {
    const { control, apply, sent, setState } = setup();
    setState((previous) => ({ ...previous, permissionMode: { ...previous.permissionMode!, mode: "plan" } }));
    await control.implementPlan(1, "acceptEdits");
    expect(apply).toHaveBeenCalledWith("acceptEdits");
    expect(sent).toEqual(["Implement the plan"]);
  });
});
