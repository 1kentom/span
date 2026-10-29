// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentFeatures } from "../../bindings";
import { createAgentController, type AgentController } from "../../lib/agent-controller";
import { agentLimit, classifyAgentError } from "../../lib/agent-errors";
import { LimitCard, type LimitCardProps } from "./LimitCard";
import { ModelPopover } from "./ModelPopover";
import { mount, text } from "./test-utils";

const mocks = vi.hoisted(() => {
  const listeners: ((event: AgentEvent) => void)[] = [];
  return {
    listeners,
    emit: (...events: AgentEvent[]) => events.forEach((event) => listeners.forEach((listener) => listener(event))),
    api: {
      onAgentEvent: vi.fn(async (listener: (event: AgentEvent) => void) => (listeners.push(listener), () => undefined)),
      agentInstalled: vi.fn(async (): Promise<unknown[]> => []),
      agentRegistry: vi.fn(async () => []),
      agentConnect: vi.fn(),
      agentPrompt: vi.fn((_message: string, _attachments: unknown[]): Promise<unknown> => new Promise(() => undefined)),
      agentCancel: vi.fn(async () => undefined),
      agentDisconnect: vi.fn(async () => undefined),
      agentListSessions: vi.fn(async () => []),
      agentNewSession: vi.fn(),
      agentResumeSession: vi.fn(),
      agentSetConfig: vi.fn(async (_id: string, _value: string) => undefined),
      agentAuthenticate: vi.fn(async () => "s1"),
      openBuffer: vi.fn(),
    },
    agentPresets: vi.fn(async (): Promise<unknown[]> => []),
  };
});
vi.mock("../../lib/client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets, agentAuthenticateWith: vi.fn() }));

const OPENCODE_FREE =
  "Agent could not complete session/prompt: Internal error: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go";
const features: AgentFeatures = { loadSession: true, image: true, audio: false, embeddedContext: true, mcpHttp: false, mcpSse: false, canListSessions: false, canResumeSessions: true, canCloseSessions: false, canDeleteSessions: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const agent = (id: string) => ({ id, version: "1", launch: { command: id, args: ["acp"], env: {} } });
const model = { id: "model", name: "Model", description: null, category: "model", currentValue: "opencode/big-pickle", groups: [{ name: "", choices: [{ value: "opencode/big-pickle", name: "Big Pickle", description: null }, { value: "opencode/grok-code-free", name: "Grok Code Free", description: null }, { value: "opencode/claude-sonnet", name: "Claude Sonnet", description: null }] }] };
const complete = (session: string) => ({ kind: "complete", sessionId: session, stopReason: "end_turn" }) as unknown as AgentEvent;
const userTexts = (a: AgentController) => a.feed().flatMap((item) => (item.kind === "user" ? [item.text] : []));
const willConnect = (title: string, session: string) =>
  mocks.api.agentConnect.mockImplementationOnce(async () => {
    mocks.emit(
      { kind: "ready", agentName: title.toLowerCase(), agentTitle: title, agentVersion: "1", features, authMethods: [] },
      { kind: "session", sessionId: session } as AgentEvent,
      { kind: "config", sessionId: session, options: [model] } as unknown as AgentEvent,
    );
    return session;
  });
/** The next prompt fails the way the backend reports it: an error event, then the rejected call. */
const willFail = (message: string) =>
  mocks.api.agentPrompt.mockImplementationOnce(async () => {
    mocks.emit({ kind: "error", sessionId: "s1", message } as unknown as AgentEvent);
    throw message;
  });

function start(): AgentController {
  let a!: AgentController;
  mount(() => {
    a = createAgentController({ workspacePath: "/w", workspaceGeneration: 1 });
    return <div />;
  });
  return a;
}
async function refusedOnOpenCode(message = OPENCODE_FREE, earlier = false) {
  const a = start();
  await tick();
  willConnect("OpenCode", "s1");
  a.connectInstalled("opencode");
  await tick();
  if (earlier) {
    mocks.emit({ kind: "user", sessionId: "s1", text: "earlier ask" } as AgentEvent, { kind: "text", sessionId: "s1", text: "earlier answer" } as AgentEvent);
    await tick();
  }
  willFail(message);
  a.setPrompt("fix the tests");
  a.send();
  await tick();
  await tick();
  return a;
}

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  window.localStorage.clear();
  mocks.listeners.splice(0);
  mocks.api.agentConnect.mockReset();
  mocks.api.agentPrompt.mockReset();
  mocks.api.agentPrompt.mockImplementation(() => new Promise(() => undefined));
  mocks.api.agentSetConfig.mockClear();
  mocks.api.agentInstalled.mockResolvedValue([agent("opencode"), agent("codex")]);
});

describe("a usage limit in the controller", () => {
  it("keeps the refused turn, marks the model and says it on the status line", async () => {
    const a = await refusedOnOpenCode();
    expect(a.limitTurn()).toMatchObject({ kind: "quota", provider: "OpenCode", freeTier: true });
    expect(a.state().statusMessage).toBe("Free limit reached");
    expect([...a.limitedModelValues()]).toEqual(["opencode/big-pickle"]);
    expect(agentLimit()).toMatchObject({ kind: "quota", provider: "OpenCode", agentId: "opencode", model: "opencode/big-pickle" });
    // The turn is not lost: the composer has it back.
    expect(a.prompt()).toBe("fix the tests");
    expect(a.canRetryModel()).toBe(false);
  });

  it("resends the refused turn once with another model, and a successful turn clears the mark", async () => {
    const a = await refusedOnOpenCode();
    await a.retryWithModel("opencode/grok-code-free");
    await tick();
    expect(mocks.api.agentSetConfig).toHaveBeenCalledWith("model", "opencode/grok-code-free");
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.api.agentPrompt.mock.calls[1][0]).toBe("fix the tests");
    expect(userTexts(a)).toEqual(["fix the tests"]);
    expect(a.prompt()).toBe("");
    expect(a.state().failure).toBeUndefined();
    mocks.emit({ kind: "config", sessionId: "s1", options: [{ ...model, currentValue: "opencode/big-pickle" }] } as unknown as AgentEvent, complete("s1"));
    await tick();
    expect(a.limitedModelValues().size).toBe(0);
    expect(agentLimit()).toBeUndefined();
  });

  it("retries a rate-limited turn only when asked", async () => {
    const a = await refusedOnOpenCode("Internal error: 429 Too Many Requests");
    expect(a.limitTurn()?.kind).toBe("rate_limit");
    expect(a.state().statusMessage).toBe("Rate limited");
    expect(a.limitedModelValues().size).toBe(0);
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(1);
    a.retryLimited();
    await tick();
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.api.agentPrompt.mock.calls[1][0]).toBe("fix the tests");
  });

  it("continues on another agent through the handoff and resends the turn there", async () => {
    const a = await refusedOnOpenCode(OPENCODE_FREE, true);
    willConnect("Codex", "s2");
    await a.switchAgentAndResend("codex");
    await tick();
    expect(a.state().sessionId).toBe("s2");
    expect(mocks.api.agentPrompt).toHaveBeenCalledTimes(2);
    expect(mocks.api.agentPrompt.mock.calls[1][0]).toContain("fix the tests");
    // The chat's context goes with it, and the refused turn is not part of that context twice.
    expect(mocks.api.agentPrompt.mock.calls[1][0]).toContain("earlier answer");
    expect(mocks.api.agentPrompt.mock.calls[1][0].split("fix the tests")).toHaveLength(2);
    expect(userTexts(a).filter((entry) => entry === "fix the tests")).toHaveLength(1);
    expect(a.feed().some((item) => item.kind === "handoff")).toBe(true);
  });

  it("routes a pick in the picker the card opened, and only that picker", async () => {
    const a = await refusedOnOpenCode();
    a.openResendPicker("model");
    expect(a.menu()).toBe("model");
    expect(a.resendArmed()).toBe("model");
    a.setMenu(null);
    expect(a.resendArmed()).toBeUndefined();
  });

  it("leaves ordinary errors on the plain error card", async () => {
    const a = await refusedOnOpenCode("Agent could not complete session/prompt: Internal error: tool crashed");
    expect(a.limitTurn()).toBeUndefined();
    expect(a.state().statusMessage).toBe("Prompt failed");
  });
});

const props = (overrides: Partial<LimitCardProps> = {}): LimitCardProps => ({
  info: classifyAgentError({ message: OPENCODE_FREE }),
  raw: OPENCODE_FREE,
  canResend: true,
  alternatives: [{ id: "codex-acp", name: "Codex", readiness: "live" }, { id: "gemini", name: "Gemini", readiness: "signedOut", note: "Signed out" }],
  freeModels: [{ value: "opencode/grok-code-free", name: "Grok Code Free" }],
  hasModels: true,
  onTryModel: vi.fn(),
  onUseModel: vi.fn(),
  onSwitchAgent: vi.fn(),
  onMoreAgents: vi.fn(),
  onRetry: vi.fn(),
  onOpenLink: vi.fn(),
  onShowLog: vi.fn(),
  onDismiss: vi.fn(),
  ...overrides,
});
const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")];
const button = (host: HTMLElement, label: string) => buttons(host).find((entry) => text(entry)?.startsWith(label))!;
/** The visible row: buttons outside any open menu. */
const rowButtons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>(".sb-limit-actions > button, .sb-limit-actions > .sb-limit-menu-wrap > button")];
/** Menu item labels, without their chips. */
const menuItems = (host: HTMLElement, name: string) => [...host.querySelectorAll(`[data-menu="${name}"] [role=menuitem] .sb-menu-label`)].map((label) => text(label));
const openMore = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-menu-trigger=more]")!.click();
const openModels = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-menu-trigger=models]")!.click();

describe("LimitCard", () => {
  it("leads with one quiet action on the neutral card, in a single row of at most three controls", () => {
    const p = props();
    const host = mount(() => <LimitCard {...p} />);
    const card = host.querySelector("[role=alert]")!;
    // Neutral surface: no tinted warn or error card classes, the tone is the icon only.
    expect(card.classList.contains("warn")).toBe(false);
    expect(card.classList.contains("alert")).toBe(false);
    expect(card.querySelector(".sb-glyph.warn")).not.toBeNull();
    expect(text(card.querySelector(".sb-limit-title"))).toBe("OpenCode free usage limit reached");
    expect(card.getAttribute("aria-labelledby")).toBe(card.querySelector(".sb-limit-title")!.id);
    expect(text(card.querySelector(".sb-limit-body"))).toBe("This model's free usage is used up.");
    expect(text(card)).not.toContain("Free models still listed");
    expect(text(card)).not.toContain("Internal error");
    expect(text(card)).not.toContain("opencode/");
    // One lead, one secondary, one overflow: nothing else in the row, and no wrapping classes.
    expect(rowButtons(host).map((entry) => entry.getAttribute("aria-label") ?? text(entry))).toEqual(["Continue with Codex", "Try another model", "More actions"]);
    expect(host.querySelectorAll(".sb-limit-lead")).toHaveLength(1);
    expect(host.querySelector(".sb-btn.primary")).toBeNull();
    expect(host.querySelector(".sb-actions")).toBeNull();
    button(host, "Continue with Codex").click();
    expect(p.onSwitchAgent).toHaveBeenCalledWith("codex-acp");
    expect(button(host, "Retry")).toBeUndefined();
  });

  it("keeps the other agents, the plan link, the log, Details and Dismiss in the overflow menu", async () => {
    const p = props();
    const host = mount(() => <LimitCard {...p} />);
    const more = host.querySelector<HTMLButtonElement>("[data-menu-trigger=more]")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    openMore(host);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("[data-menu=more]")!.getAttribute("role")).toBe("menu");
    expect(text(host.querySelector("[data-menu=more] .sb-limit-note"))).toBe("Signed out");
    expect(menuItems(host, "more")).toEqual(["Continue with Gemini", "More agents", "Open OpenCode Go", "Show ACP log", "Details", "Dismiss"]);
    await Promise.resolve();
    expect(document.activeElement).toBe(host.querySelector("[data-menu=more] [role=menuitem]"));
    const link = button(host, "Open OpenCode Go");
    expect(link.getAttribute("title")).toBe("https://opencode.ai/go");
    expect(link.querySelector(".icon")).not.toBeNull();
    link.click();
    expect(p.onOpenLink).toHaveBeenCalledWith("https://opencode.ai/go");
    expect(host.querySelector("[data-menu=more]")).toBeNull();

    openMore(host);
    button(host, "Continue with Gemini").click();
    expect(p.onSwitchAgent).toHaveBeenCalledWith("gemini");
    openMore(host);
    button(host, "More agents").click();
    expect(p.onMoreAgents).toHaveBeenCalled();
    openMore(host);
    button(host, "Show ACP log").click();
    expect(p.onShowLog).toHaveBeenCalled();

    openMore(host);
    const details = button(host, "Details");
    expect(details.getAttribute("aria-expanded")).toBe("false");
    details.click();
    expect(text(host.querySelector(".sb-limit-raw"))).toBe(OPENCODE_FREE);
    openMore(host);
    expect(button(host, "Hide details").getAttribute("aria-expanded")).toBe("true");
    button(host, "Dismiss").click();
    expect(p.onDismiss).toHaveBeenCalled();
  });

  it("closes a menu with Escape and returns focus to its trigger", async () => {
    const host = mount(() => <LimitCard {...props()} />);
    openMore(host);
    await Promise.resolve();
    const menu = host.querySelector("[data-menu=more]")!;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(menu.querySelectorAll("[role=menuitem]")[1]);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.querySelector("[data-menu=more]")).toBeNull();
    expect(document.activeElement).toBe(host.querySelector("[data-menu-trigger=more]"));
  });

  it("lists the free models with clean names and cost chips under Try another model", () => {
    const p = props({ freeModels: [{ value: "opencode/beam-free", name: "opencode/Beam Free" }, { value: "opencode/grok-code-free", name: "Grok Code Free" }] });
    const host = mount(() => <LimitCard {...p} />);
    const trigger = host.querySelector<HTMLButtonElement>("[data-menu-trigger=models]")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    openModels(host);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menuItems(host, "models")).toEqual(["Beam Free", "Grok Code Free", "All models"]);
    expect([...host.querySelectorAll("[data-menu=models] .sb-limit-cost")].map((chip) => text(chip))).toEqual(["Free", "Free"]);
    // Opening one menu closes the other.
    openMore(host);
    expect(host.querySelector("[data-menu=models]")).toBeNull();
    openModels(host);
    button(host, "Beam Free").click();
    expect(p.onUseModel).toHaveBeenCalledWith("opencode/beam-free");
    openModels(host);
    button(host, "All models").click();
    expect(p.onTryModel).toHaveBeenCalledTimes(1);
  });

  it("opens the full model picker directly when no free model can take the turn", () => {
    const p = props({ freeModels: [] });
    const host = mount(() => <LimitCard {...p} />);
    const trigger = button(host, "Try another model");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    trigger.click();
    expect(p.onTryModel).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-menu=models]")).toBeNull();
  });

  it("uses short agent names and no lead when every other agent needs attention", () => {
    const host = mount(() => <LimitCard {...props({ alternatives: [{ id: "claude-acp", name: "Claude Agent", readiness: "signedOut", note: "Signed out" }] })} />);
    expect(host.querySelector(".sb-limit-lead")).toBeNull();
    expect(rowButtons(host).map((entry) => entry.getAttribute("aria-label") ?? text(entry))).toEqual(["Try another model", "More actions"]);
    openMore(host);
    expect(menuItems(host, "more")[0]).toBe("Continue with Claude");
    expect(text(host.querySelector("[data-menu=more] .sb-limit-note"))).toBe("Signed out");
  });

  it("counts down a rate limit on the Retry lead and enables it when the wait is over", async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const p = props({ info: classifyAgentError({ message: "Rate limit reached. Please try again in 2s." }, start), freeModels: [], alternatives: [{ id: "codex-acp", name: "Codex", readiness: "live" }] });
      const host = mount(() => <LimitCard {...p} />);
      // The Retry button carries the countdown, so the title does not repeat it.
      expect(text(host.querySelector(".sb-limit-title"))).toBe("Rate limited");
      const retry = () => button(host, "Retry");
      expect(retry().classList.contains("sb-limit-lead")).toBe(true);
      expect(retry().disabled).toBe(true);
      expect(text(retry())).toBe("Retry in 2s");
      expect(retry().getAttribute("aria-label")).toBe("Retry available in 2s");
      // Retry replaces the agent as the lead; the agent moves into the overflow menu.
      expect(button(host, "Continue with Codex")).toBeUndefined();
      openMore(host);
      expect(menuItems(host, "more")).toContain("Continue with Codex");
      await vi.advanceTimersByTimeAsync(2100);
      expect(retry().disabled).toBe(false);
      expect(retry().getAttribute("aria-label")).toBe("Retry");
      retry().click();
      expect(p.onRetry).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names Switch agent in the menu when no other agent is installed", () => {
    const host = mount(() => <LimitCard {...props({ alternatives: [], info: classifyAgentError({ message: "Overloaded" }) })} />);
    openMore(host);
    expect(menuItems(host, "more")[0]).toBe("Switch agent");
  });

  it("offers no resend actions when the turn cannot be sent again", () => {
    const p = props({ canResend: false, info: classifyAgentError({ message: "Overloaded" }) });
    const host = mount(() => <LimitCard {...p} />);
    expect(text(host.querySelector(".sb-limit-title"))).toBe("Provider overloaded");
    expect(button(host, "Retry")).toBeUndefined();
    // No free model resend: Try another model goes straight to the picker.
    expect(button(host, "Try another model").getAttribute("aria-haspopup")).toBe("dialog");
  });
});

describe("model picker after a limit", () => {
  const options = [{ ...model, choices: model.groups[0].choices }] as never;
  it("marks the limited model and can open with Free models only off", () => {
    window.localStorage.setItem("span.agent.freeModelsOnly", "true");
    const host = mount(() => <ModelPopover agentName="OpenCode" options={options} limited={new Set(["opencode/big-pickle"])} freeOnly={false} onSelect={() => undefined} onClose={() => undefined} />);
    const rows = [...host.querySelectorAll("[role=radio]")];
    expect(rows.map((row) => row.querySelector(".sb-limit-chip")?.textContent ?? "")).toEqual(["Limit reached", "", ""]);
    // Free-only off: the paid model is listed too.
    expect(text(host)).toContain("Claude Sonnet");
    expect(host.querySelector("[role=switch]")!.getAttribute("aria-checked")).toBe("false");
  });
});
