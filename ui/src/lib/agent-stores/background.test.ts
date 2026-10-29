import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { agentWarmStart: vi.fn(), agentHealth: vi.fn(), onAgentHealth: vi.fn() },
}));
vi.mock("../client", () => ({ isDesktop: true, api: mocks.api }));

import { agentBackground } from "./background";
import { setAgentHealth } from "../agent-health";

const held = () => createRoot((dispose) => ({ store: agentBackground.use(), dispose }));
const live = { agentId: "codex", state: "live", checkedAtMs: 1 } as never;

afterEach(() => {
  setAgentHealth([]);
  vi.clearAllMocks();
});

describe("agent background store", () => {
  it("is shared by every holder", () => {
    const one = held();
    const two = held();
    expect(two.store).toBe(one.store);
    one.dispose();
    two.dispose();
    expect(agentBackground.peek()).toBeUndefined();
  });

  it("hides health results while the setting is off and refetches when it comes back on", async () => {
    mocks.api.agentHealth.mockResolvedValue([live]);
    const { store, dispose } = held();
    setAgentHealth([live]);
    expect(store.health()).toHaveLength(1);
    store.setHealthOn(false);
    expect(store.health()).toEqual([]);
    expect(mocks.api.agentHealth).not.toHaveBeenCalled();
    store.setHealthOn(true);
    expect(mocks.api.agentHealth).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("unsubscribes from health changes when the last holder leaves", async () => {
    const unsubscribe = vi.fn();
    mocks.api.onAgentHealth.mockResolvedValue(unsubscribe);
    mocks.api.agentHealth.mockResolvedValue([]);
    const { store, dispose } = held();
    store.startHealth();
    await vi.waitFor(() => expect(mocks.api.onAgentHealth).toHaveBeenCalled());
    await Promise.resolve();
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("warm starts only with a folder open", async () => {
    mocks.api.agentWarmStart.mockResolvedValue(undefined);
    const { store, dispose } = held();
    store.warmStart(undefined);
    store.warmStart("/work");
    await vi.waitFor(() => expect(mocks.api.agentWarmStart).toHaveBeenCalledTimes(1));
    dispose();
  });
});
