// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { AgentPopover } from "./AgentPopover";
import { ConnectScreen } from "./ConnectScreen";
import { HealthDot } from "./HealthDot";
import { LiveAgents } from "./LiveAgents";
import { mount, text } from "./test-utils";
import { agentKey, ago, findHealth, healthText, healthTone, type AgentHealth } from "../../lib/agent-health";
import { liveAgentsOf, type LiveAgent } from "../../lib/live-agents";
import type { DelegationTaskState } from "../../lib/agent-delegation";

const NOW = 1_800_000_000_000;
const minutes = (n: number) => NOW - n * 60_000;
const result = (agentId: string, state: AgentHealth["state"], extra: Partial<AgentHealth> = {}): AgentHealth => ({
  agentId,
  state,
  latencyMs: state === "live" || state === "slow" ? 1200 : null,
  checkedAtMs: minutes(4),
  detail: null,
  ...extra,
});
const task = (taskId: string, agentName: string, status: DelegationTaskState["status"], extra: Partial<DelegationTaskState> = {}): DelegationTaskState => ({
  taskId,
  child: { connectionId: "c2", sessionId: `child-${taskId}` },
  agentName,
  status,
  ...extra,
});

describe("health wording", () => {
  it("words each result for the tooltip like the design", () => {
    expect(healthText(result("codex-acp", "live"), NOW)).toBe("Replied OK in 1.2 s, 4 min ago");
    expect(healthText(result("codex-acp", "slow", { latencyMs: 9400 }), NOW)).toBe("Slow: replied in 9.4 s, 4 min ago");
    expect(healthText(result("codex-acp", "unreachable", { checkedAtMs: minutes(2) }), NOW)).toBe("No reply, checked 2 min ago");
    expect(healthText(result("codex-acp", "signedOut"), NOW)).toBe("Signed out, checked 4 min ago");
    expect(healthText(undefined, NOW)).toBe("Not checked yet");
    expect(ago(NOW - 20_000, NOW)).toBe("just now");
    expect(ago(minutes(150), NOW)).toBe("2 h ago");
  });

  it("maps states to dot tones: grey for signed out and unknown", () => {
    expect(healthTone(result("a", "live"))).toBe("live");
    expect(healthTone(result("a", "slow"))).toBe("slow");
    expect(healthTone(result("a", "unreachable"))).toBe("unreachable");
    expect(healthTone(result("a", "signedOut"))).toBe("unknown");
    expect(healthTone(undefined)).toBe("unknown");
  });

  it("finds a result by installed id or by the agent's reported or display name", () => {
    const list = [result("codex-acp", "live"), result("gemini-cli", "slow"), result("claude-acp", "unreachable")];
    expect(agentKey("Codex")).toBe(agentKey("codex-acp"));
    expect(findHealth(list, "CODEX-ACP")?.state).toBe("live");
    expect(findHealth(list, undefined, "Gemini CLI")?.state).toBe("slow");
    expect(findHealth(list, "Claude Code")?.state).toBe("unreachable");
    expect(findHealth(list, "opencode")).toBeUndefined();
  });

  it("has no em dash anywhere in the copy", () => {
    const copy = [healthText(result("a", "live"), NOW), healthText(result("a", "slow"), NOW), healthText(result("a", "signedOut"), NOW), healthText(result("a", "unreachable"), NOW), healthText(undefined, NOW)];
    for (const line of copy) expect(line).not.toContain("—");
  });
});

describe("health dot", () => {
  it("carries the tone and the tooltip, and changes tone in place", () => {
    const [health, setHealth] = createSignal<AgentHealth | undefined>(result("codex-acp", "live"));
    const host = mount(() => <HealthDot health={health()} now={NOW} />);
    const dot = host.querySelector<HTMLElement>(".sb-health")!;
    expect(dot.dataset.tone).toBe("live");
    expect(dot.title).toBe("Replied OK in 1.2 s, 4 min ago");
    expect(dot.getAttribute("aria-label")).toBe("Health check: Replied OK in 1.2 s, 4 min ago");
    setHealth(result("codex-acp", "unreachable", { checkedAtMs: minutes(2) }));
    // The same element: the tone fades through the CSS transition instead of a new node popping in.
    expect(host.querySelector(".sb-health")).toBe(dot);
    expect(dot.dataset.tone).toBe("unreachable");
    expect(dot.title).toBe("No reply, checked 2 min ago");
  });
});

describe("dots in the agent popover and on Found rows", () => {
  const agents = [
    { id: "codex-acp", name: "Codex", subtitle: "2.3.0" },
    { id: "claude-acp", name: "Claude Agent", subtitle: "0.99.0" },
  ];
  const health = [result("codex-acp", "live")];

  it("shows one dot per installed agent in the popover, grey when not checked", () => {
    const host = mount(() => <AgentPopover agents={agents} health={health} healthNow={NOW} onSelect={() => {}} onCheckUpdates={() => {}} onAdd={() => {}} onClose={() => {}} />);
    const dots = [...host.querySelectorAll<HTMLElement>(".sb-option .sb-health")];
    expect(dots.map((dot) => dot.dataset.tone)).toEqual(["live", "unknown"]);
    expect(dots[0].title).toBe("Replied OK in 1.2 s, 4 min ago");
    expect(dots[1].title).toBe("Not checked yet");
  });

  it("shows no dots at all while the health check is off", () => {
    const host = mount(() => <AgentPopover agents={agents} onSelect={() => {}} onCheckUpdates={() => {}} onAdd={() => {}} onClose={() => {}} />);
    expect(host.querySelector(".sb-health")).toBeNull();
  });

  it("puts the dot next to the name on the connect screen's Found rows", () => {
    const props = { registry: [], onConnect: () => {}, onInstall: () => {}, onCustom: () => {} };
    const host = mount(() => <ConnectScreen {...props} found={agents} health={health} healthNow={NOW} />);
    const row = host.querySelector<HTMLElement>('.sb-found-entry[data-agent-id="codex-acp"]')!;
    const dot = row.querySelector<HTMLElement>(".sb-agent-name-line .sb-health")!;
    expect(dot.dataset.tone).toBe("live");
    expect(dot.title).toBe("Replied OK in 1.2 s, 4 min ago");
    const off = mount(() => <ConnectScreen {...props} found={agents} />);
    expect(off.querySelector(".sb-health")).toBeNull();
  });
});

describe("live agents of the current chat", () => {
  const health = [result("codex-acp", "live"), result("gemini-cli", "slow")];

  it("lists the lead first, then delegated agents and earlier segments, one entry per agent", () => {
    const list = liveAgentsOf({
      lead: { id: "codex-acp", name: "Codex", state: "Working", detail: "gpt-5" },
      tasks: [task("t1", "gemini-cli", "completed"), task("t2", "gemini-cli", "running", { progressText: "Reading files" }), task("t3", "OpenCode", "starting", { agentName: undefined, startingAgentId: "opencode" })],
      waiting: (entry) => entry.taskId === "t9",
      earlier: [{ id: "claude-acp", name: "Claude Agent" }, { id: "codex-acp", name: "Codex" }],
      health,
    });
    expect(list.map((entry) => [entry.name, entry.state])).toEqual([
      ["Codex", "Working"],
      ["Gemini CLI", "Working"],
      ["OpenCode", "Starting"],
      ["Claude Agent", "Done"],
    ]);
    expect(list[0].detail).toBe("gpt-5");
    expect(list[1].taskId).toBe("t2");
    expect(list[1].detail).toBe("Reading files");
    expect(list[1].health?.state).toBe("slow");
    expect(list[0].health?.state).toBe("live");
  });

  it("names a delegated installed agent by its display name and brand id", () => {
    const list = liveAgentsOf({
      lead: { id: "codex-acp", name: "Codex", state: "Idle" },
      tasks: [task("t1", "claude-acp", "running")],
      health: [result("claude-acp", "live")],
      resolve: (name) => (name === "claude-acp" ? { id: "claude-acp", name: "Claude Agent" } : undefined),
    });
    expect(list[1]).toMatchObject({ id: "claude-acp", name: "Claude Agent", state: "Working" });
    expect(list[1].health?.state).toBe("live");
  });

  it("never shows a scoped package name for an unknown delegated agent", () => {
    const list = liveAgentsOf({ lead: { name: "Codex", state: "Idle" }, tasks: [task("t1", "@agentclientprotocol/claude-agent-acp", "running")], health: [] });
    expect(list[1].name).toBe("Claude Agent");
  });

  it("says Waiting for you while a child's permission request is open, Failed on failure and Done once finished", () => {
    const waiting = liveAgentsOf({ lead: { name: "Codex", state: "Idle" }, tasks: [task("t1", "Gemini CLI", "running")], waiting: () => true, health: [] });
    expect(waiting[1].state).toBe("Waiting for you");
    const failed = liveAgentsOf({ lead: { name: "Codex", state: "Idle" }, tasks: [task("t1", "Gemini CLI", "failed", { detail: "Crashed" })], health: [] });
    expect(failed[1]).toMatchObject({ state: "Failed", detail: "Crashed" });
    const done = liveAgentsOf({ lead: { name: "Codex", state: "Idle" }, tasks: [task("t1", "Gemini CLI", "completed")], health: [] });
    expect(done[1].state).toBe("Done");
  });

  it("shows nothing for a single-agent chat", () => {
    const single = liveAgentsOf({ lead: { id: "codex-acp", name: "Codex", state: "Working" }, tasks: [], health });
    expect(single).toHaveLength(1);
    const host = mount(() => <LiveAgents agents={single} now={NOW} showHealth />);
    expect(host.querySelector(".sb-live-agents")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("is one row: label, overlapping avatars most urgent first with state badges, and a summary; a child opens its task", () => {
    const onOpen = vi.fn();
    const agents: LiveAgent[] = liveAgentsOf({ lead: { id: "codex-acp", name: "Codex", state: "Idle", detail: "gpt-5" }, tasks: [task("t1", "gemini-cli", "running")], health });
    const host = mount(() => <LiveAgents agents={agents} now={NOW} showHealth onOpen={onOpen} />);
    const strip = host.querySelector<HTMLElement>("section.sb-drawer.sb-live-agents")!;
    expect(strip.getAttribute("aria-label")).toBe("Active agents");
    expect(strip.querySelector(".sb-live-title")?.textContent).toBe("Active agents");
    expect(strip.querySelector(".sb-live-summary")?.textContent).toBe("1 working");
    const avatars = [...strip.querySelectorAll<HTMLElement>(".sb-live-avatar")];
    expect(avatars.map((entry) => entry.getAttribute("aria-label"))).toEqual(["Gemini CLI, Working. Show its task", "Codex (lead), Idle"]);
    expect([...strip.querySelectorAll<HTMLElement>(".sb-live-avatar .sb-live-badge")].map((badge) => badge.dataset.tone)).toEqual(["working", "idle"]);
    expect(avatars.every((entry) => entry.querySelector(".brand-icon"))).toBe(true);
    // Each avatar is described by its card: full name, state, model or task, and the health check.
    const tip = document.getElementById(avatars[1].getAttribute("aria-describedby")!)!;
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(text(tip.querySelector(".sb-live-tip-name"))).toBe("Codex Lead");
    expect(tip.querySelector(".sb-live-tip-detail")?.textContent).toBe("gpt-5");
    expect(tip.querySelector(".sb-live-tip-health")?.textContent).toBe("Replied OK in 1.2 s, 4 min ago");
    // The lead is not a button; the child is and opens its delegation card.
    expect(avatars[1].tagName).toBe("SPAN");
    expect(avatars[1].tabIndex).toBe(0);
    expect(avatars[0].tagName).toBe("BUTTON");
    (avatars[0] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1" }));
  });

  it("folds agents past five into a +N chip that names them", () => {
    const tasks = ["claude-acp", "gemini-cli", "opencode", "qwen-code", "cursor-agent", "copilot-cli"].map((name, index) => task(`t${index}`, name, "completed"));
    const agents = liveAgentsOf({ lead: { id: "codex-acp", name: "Codex", state: "Working" }, tasks, health: [] });
    const host = mount(() => <LiveAgents agents={agents} now={NOW} showHealth={false} />);
    expect(host.querySelectorAll(".sb-live-avatar")).toHaveLength(4);
    const more = host.querySelector<HTMLElement>(".sb-live-more")!;
    expect(more.textContent).toBe("+3");
    expect(more.getAttribute("aria-label")).toBe("3 more: Qwen Code, Done; Cursor Agent, Done; Copilot CLI, Done");
    expect(host.querySelector(".sb-live-summary")?.textContent).toBe("1 working");
  });

  it("drops the health line while the health check is off", () => {
    const agents = liveAgentsOf({ lead: { id: "codex-acp", name: "Codex", state: "Idle" }, tasks: [task("t1", "gemini-cli", "running")], health });
    const host = mount(() => <LiveAgents agents={agents} now={NOW} showHealth={false} />);
    expect(host.querySelector(".sb-live-agents")).not.toBeNull();
    expect(host.querySelector(".sb-live-tip-health")).toBeNull();
  });
});
