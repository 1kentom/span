// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../bindings";
import { ModePopover } from "./ModePopover";
import { FullAccessConfirm, ModeMismatchBanner, PlanReadyCard, PolicyRow } from "./PermissionMode";
import type { ConfigOptionView } from "./types";
import { mount, text } from "./test-utils";
import { initialAgentState, reduceAgentEvent, type AgentState } from "../../lib/agent-session";
import { cycleNext, downgrade, rememberedMode, SPAN_MODE_KEY } from "../../lib/permission-modes";
import { chooseRestores } from "../../lib/last-config";

const codex: ConfigOptionView[] = [
  { id: "mode", name: "Mode", category: "mode", currentValue: "agent", choices: [{ value: "agent", name: "Auto review" }, { value: "agent-full-access", name: "Full access" }] },
  { id: "collaboration_mode", name: "Collaboration mode", currentValue: "default", choices: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  { id: "speed", name: "Speed", currentValue: "normal", choices: [{ value: "normal", name: "Normal" }, { value: "turbo", name: "Turbo" }] },
];
const all = ["ask", "acceptEdits", "plan", "auto", "full"] as const;
const spanMode = { mode: "ask" as const, supported: [...all], child: false, managed: ["mode", "collaboration_mode"] };
const radio = (host: Element, mode: string) => host.querySelector<HTMLButtonElement>(`[data-mode='${mode}']`)!;

describe("mode popover with Span permission modes", () => {
  it("lists the five Span modes first with descriptions and risk labels, and hides the agent options Span manages", () => {
    const host = mount(() => <ModePopover agentName="Codex" options={codex} spanMode={spanMode} onSelect={() => {}} onClose={() => {}} />);
    const groups = [...host.querySelectorAll("[role=radiogroup]")].map((group) => group.getAttribute("aria-label"));
    expect(groups).toEqual(["Permissions", "Speed"]);
    for (const label of ["Ask every time", "Accept edits", "Plan (read only)", "Auto (safe commands)", "Full access", "No prompts", "Read only"]) expect(text(host)).toContain(label);
    expect(text(host)).not.toContain("Auto review");
    expect(text(host)).not.toContain("Collaboration mode");
    expect(radio(host, "ask").getAttribute("aria-checked")).toBe("true");
    // Full has the warning treatment.
    expect(radio(host, "full").querySelector(".sb-option-lead.warn")).not.toBeNull();
    expect(radio(host, "full").querySelector(".sb-perm-risk.warn")).not.toBeNull();
  });

  it("disables unsupported modes with the reason, and a delegated child past Ask", () => {
    const gemini = { ...spanMode, supported: ["ask", "acceptEdits", "auto", "full"] as typeof spanMode.supported, managed: ["mode"] };
    const host = mount(() => <ModePopover agentName="Gemini" options={[]} spanMode={gemini} onSelect={() => {}} onClose={() => {}} />);
    expect(radio(host, "plan").disabled).toBe(true);
    expect(radio(host, "plan").textContent).toContain("no plan mode");
    const child = { ...spanMode, supported: ["ask", "plan"] as typeof spanMode.supported, child: true };
    const childHost = mount(() => <ModePopover agentName="Claude" options={[]} spanMode={child} onSelect={() => {}} onClose={() => {}} />);
    for (const mode of ["acceptEdits", "auto", "full"]) {
      expect(radio(childHost, mode).disabled).toBe(true);
      expect(radio(childHost, mode).textContent).toContain("never runs looser than Ask");
    }
    expect(radio(childHost, "plan").disabled).toBe(false);
  });

  it("reports the picked Span mode", () => {
    const onSpanMode = vi.fn();
    const host = mount(() => <ModePopover agentName="Codex" options={codex} spanMode={spanMode} onSpanMode={onSpanMode} onSelect={() => {}} onClose={() => {}} />);
    radio(host, "plan").click();
    expect(onSpanMode).toHaveBeenCalledWith("plan");
  });
});

describe("Shift+Tab cycle and fallbacks", () => {
  it("cycles Ask, Accept edits, Plan and never into Auto or Full", () => {
    expect(cycleNext("ask", all)).toBe("acceptEdits");
    expect(cycleNext("acceptEdits", all)).toBe("plan");
    expect(cycleNext("plan", all)).toBe("ask");
    expect(cycleNext("full", all)).toBe("ask");
    expect(cycleNext("auto", all)).toBe("ask");
    expect(cycleNext("acceptEdits", ["ask", "acceptEdits", "auto", "full"])).toBe("ask");
    let mode: (typeof all)[number] = "ask";
    for (let step = 0; step < 9; step += 1) {
      mode = cycleNext(mode, all);
      expect(["ask", "acceptEdits", "plan"]).toContain(mode);
    }
  });

  it("downgrades an unsupported mode to Ask, never to a looser one", () => {
    expect(downgrade("plan", ["ask", "full"])).toBe("ask");
    expect(downgrade("full", ["ask"])).toBe("ask");
    expect(downgrade("acceptEdits", all)).toBe("acceptEdits");
  });

  it("remembers the last Span mode per agent, and reads a bypass value remembered before Span modes as Full", () => {
    expect(rememberedMode({ [SPAN_MODE_KEY]: "plan" })).toBe("plan");
    expect(rememberedMode({ mode: "bypassPermissions" })).toBe("full");
    expect(rememberedMode({ mode: "default" })).toBeUndefined();
    expect(rememberedMode({ [SPAN_MODE_KEY]: "yolo" })).toBeUndefined();
  });

  it("never restores a managed agent option through the raw option path", () => {
    const options = [
      { id: "mode", name: "Mode", category: "mode", currentValue: "default", description: null, groups: [{ name: "", choices: [{ value: "default", name: "Default", description: null }, { value: "bypassPermissions", name: "Bypass", description: null }] }] },
      { id: "model", name: "Model", category: "model", currentValue: "a", description: null, groups: [{ name: "", choices: [{ value: "a", name: "A", description: null }, { value: "b", name: "B", description: null }] }] },
    ];
    const restores = chooseRestores(options as never, { mode: "bypassPermissions", model: "b" });
    expect(restores).toEqual([["model", "b"]]);
    expect(chooseRestores(options as never, { mode: "bypassPermissions" }, [])).toEqual([["mode", "bypassPermissions"]]);
  });
});

const run = (events: AgentEvent[], from: AgentState = { ...initialAgentState(true), sessionId: "s" }) => events.reduce(reduceAgentEvent, from);

describe("permission mode events", () => {
  it("keeps the Span mode, logs blocked and allowed requests and turns ExitPlanMode into a Plan ready card", () => {
    const state = run([
      { kind: "permissionMode", sessionId: "s", mode: "plan", supported: [...all], child: false, managed: ["mode"] },
      { kind: "permissionAuto", sessionId: "s", toolCallId: "e1", title: "Edit a.rs", toolKind: "edit", decision: "rejected", reason: "plan_mode_read_only" },
      { kind: "permissionAuto", sessionId: "s", toolCallId: "p1", title: "Ready to code?", toolKind: "switch_mode", decision: "rejected", reason: "plan_mode_read_only", rawInput: { plan: "1. Add it" } },
    ]);
    expect(state.permissionMode?.mode).toBe("plan");
    expect(state.feed.map((item) => item.kind)).toEqual(["policy", "planReady"]);
    const card = state.feed[1];
    expect(card.kind === "planReady" && card.plan).toBe("1. Add it");
  });

  it("adds a Plan ready card when a Plan mode turn ends with an answer, once per turn", () => {
    const state = run([
      { kind: "permissionMode", sessionId: "s", mode: "plan", supported: [...all], child: false, managed: [] },
      { kind: "user", sessionId: "s", text: "plan it" },
      { kind: "text", sessionId: "s", text: "Step 1. Step 2." },
      { kind: "complete", sessionId: "s", stopReason: "end_turn" },
      { kind: "complete", sessionId: "s", stopReason: "end_turn" },
    ]);
    expect(state.feed.filter((item) => item.kind === "planReady")).toHaveLength(1);
    const ask = run([
      { kind: "permissionMode", sessionId: "s", mode: "ask", supported: [...all], child: false, managed: [] },
      { kind: "text", sessionId: "s", text: "Done." },
      { kind: "complete", sessionId: "s", stopReason: "end_turn" },
    ]);
    expect(ask.feed.some((item) => item.kind === "planReady")).toBe(false);
  });

  it("raises and clears the mode mismatch", () => {
    const raised = run([{ kind: "modeMismatch", sessionId: "s", mode: "plan", configId: "mode", expected: "plan", actual: "default", resolved: false }]);
    expect(raised.modeMismatch?.actual).toBe("default");
    const cleared = run([{ kind: "modeMismatch", sessionId: "s", mode: "plan", configId: "mode", expected: "plan", actual: "plan", resolved: true }], raised);
    expect(cleared.modeMismatch).toBeUndefined();
    // Another session's events never touch this thread.
    expect(run([{ kind: "modeMismatch", sessionId: "other", mode: "ask", configId: "mode", expected: "a", actual: "b", resolved: false }]).modeMismatch).toBeUndefined();
  });
});

describe("permission mode parts", () => {
  it("the mismatch banner names both modes and offers a retry", () => {
    const onRetry = vi.fn();
    const host = mount(() => <ModeMismatchBanner agent="Claude" mismatch={{ mode: "plan", configId: "mode", expected: "plan", actual: "default" }} onRetry={onRetry} />);
    expect(host.querySelector("[role=alert]")).not.toBeNull();
    expect(text(host)).toContain("Claude switched its mode to default");
    expect(text(host)).toContain("Plan (read only)");
    host.querySelector<HTMLButtonElement>(".sb-btn.primary")!.click();
    expect(onRetry).toHaveBeenCalled();
  });

  it("the Full access confirm says what it allows", () => {
    const onConfirm = vi.fn();
    const host = mount(() => <FullAccessConfirm onConfirm={onConfirm} onCancel={() => {}} />);
    expect(text(host)).toContain("Full access lets the agent run commands and edit files without asking");
    host.querySelector<HTMLButtonElement>(".sb-btn.danger")!.click();
    expect(onConfirm).toHaveBeenCalled();
  });

  it("a blocked row reads Blocked in Plan mode", () => {
    const host = mount(() => <PolicyRow item={{ decision: "rejected", reason: "plan_mode_read_only", title: "Edit a.rs" }} />);
    expect(text(host)).toContain("Blocked in Plan mode: Edit a.rs");
  });

  it("the Plan ready card implements with the chosen mode or refines", () => {
    const onImplement = vi.fn();
    const onRefine = vi.fn();
    const host = mount(() => <PlanReadyCard plan="1. Do it" status="ready" active supported={[...all]} renderPlan={(plan) => plan} onImplement={onImplement} onRefine={onRefine} />);
    expect(text(host)).toContain("Plan ready");
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
    button("Implement plan").click();
    expect(onImplement).toHaveBeenLastCalledWith("acceptEdits");
    button("Ask every time").click();
    button("Implement plan").click();
    expect(onImplement).toHaveBeenLastCalledWith("ask");
    button("Refine plan").click();
    expect(onRefine).toHaveBeenCalled();
    const idle = mount(() => <PlanReadyCard plan="x" status="implementing" active supported={[...all]} renderPlan={(plan) => plan} onImplement={onImplement} onRefine={onRefine} />);
    expect(idle.querySelector("button")).toBeNull();
  });
});
