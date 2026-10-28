// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { AgentPopover } from "./AgentPopover";
import { ConnectScreen } from "./ConnectScreen";
import { HealthDot } from "./HealthDot";
import { LiveAgents } from "./LiveAgents";
import { mount } from "./test-utils";
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
      lead: { id: "codex-acp", name: "Codex", state: "Working" },
      tasks: [task("t1", "gemini-cli", "completed"), task("t2", "gemini-cli", "running"), task("t3", "OpenCode", "starting", { agentName: undefined, startingAgentId: "opencode" })],
      waiting: (entry) => entry.taskId === "t9",
      earlier: [{ id: "claude-acp", name: "Claude Agent" }, { id: "codex-acp", name: "Codex" }],
      health,
    });
    expect(list.map((entry) => [entry.name, entry.state])).toEqual([
      ["Codex", "Working"],
      ["gemini-cli", "Working"],
      ["opencode", "Starting"],
      ["Claude Agent", "Done"],
    ]);
    expect(list[1].taskId).toBe("t2");
    expect(list[1].health?.state).toBe("slow");
    expect(list[0].health?.state).toBe("live");
  });

  it("says Waiting for you while a child's permission request is open, and Done once finished", () => {
    const waiting = liveAgentsOf({ lead: { name: "Codex", state: "Idle" }, tasks: [task("t1", "Gemini CLI", "running")], waiting: () => true, health: [] });
    expect(waiting[1].state).toBe("Waiting for you");
    const done = liveAgentsOf({ lead: { name: "Codex", state: "Idle" }, tasks: [task("t1", "Gemini CLI", "failed")], health: [] });
    expect(done[1].state).toBe("Done");
  });

  it("shows nothing for a single-agent chat", () => {
    const single = liveAgentsOf({ lead: { id: "codex-acp", name: "Codex", state: "Working" }, tasks: [], health });
    expect(single).toHaveLength(1);
    const host = mount(() => <LiveAgents agents={single} now={NOW} showHealth />);
    expect(host.querySelector(".sb-live-agents")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("shows brand, name, state and health dot per agent, and a child opens its task", () => {
    const onOpen = vi.fn();
    const agents: LiveAgent[] = liveAgentsOf({ lead: { id: "codex-acp", name: "Codex", state: "Idle" }, tasks: [task("t1", "gemini-cli", "running")], health });
    const host = mount(() => <LiveAgents agents={agents} now={NOW} showHealth onOpen={onOpen} />);
    const strip = host.querySelector<HTMLElement>("section.sb-drawer.sb-live-agents")!;
    expect(strip.getAttribute("aria-label")).toBe("Live agents");
    const entries = [...strip.querySelectorAll<HTMLElement>(".sb-live-entry")];
    expect(entries.map((entry) => entry.querySelector(".sb-live-name")?.textContent)).toEqual(["Codex", "gemini-cli"]);
    expect(entries.map((entry) => entry.querySelector(".sb-live-state")?.textContent)).toEqual(["Idle", "Working"]);
    expect(entries.map((entry) => entry.querySelector<HTMLElement>(".sb-health")?.dataset.tone)).toEqual(["live", "slow"]);
    expect(entries.every((entry) => entry.querySelector(".brand-icon"))).toBe(true);
    // The lead is not a button; the child is and opens its delegation card.
    expect(entries[0].tagName).toBe("SPAN");
    expect(entries[1].tagName).toBe("BUTTON");
    (entries[1] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1" }));
  });

  it("drops the dots while the health check is off", () => {
    const agents = liveAgentsOf({ lead: { id: "codex-acp", name: "Codex", state: "Idle" }, tasks: [task("t1", "gemini-cli", "running")], health });
    const host = mount(() => <LiveAgents agents={agents} now={NOW} showHealth={false} />);
    expect(host.querySelector(".sb-live-agents")).not.toBeNull();
    expect(host.querySelector(".sb-health")).toBeNull();
  });
});
