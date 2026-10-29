import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: { agentInstalled: vi.fn(), agentRegistry: vi.fn(), agentInstall: vi.fn() },
  agentPresets: vi.fn(),
}));
vi.mock("../client", () => ({ isDesktop: true, api: mocks.api, agentPresets: mocks.agentPresets }));

import { agentCatalog } from "./catalog";

const agent = (id: string) => ({ id, launch: { command: id, args: [], env: {} } }) as never;
const held = () => createRoot((dispose) => ({ catalog: agentCatalog.use(), dispose }));

describe("agent catalog store", () => {
  it("is one instance for every holder, fresh after the last one leaves", async () => {
    mocks.api.agentInstalled.mockResolvedValue([agent("a")]);
    mocks.api.agentRegistry.mockResolvedValue([{ id: "r", name: "Reg" }]);
    mocks.agentPresets.mockResolvedValue([]);
    const sidebar = held();
    const page = held();
    expect(page.catalog).toBe(sidebar.catalog);
    await sidebar.catalog.loadAgents(vi.fn());
    expect(page.catalog.installed().map((entry) => entry.id)).toEqual(["a"]);
    expect(page.catalog.registryName("r")).toBe("Reg");
    sidebar.dispose();
    page.dispose();
    const next = held();
    expect(next.catalog.installed()).toEqual([]);
    next.dispose();
  });

  it("drops an installed read that started before an install finished", async () => {
    let finishRead!: (value: unknown) => void;
    mocks.api.agentInstalled.mockReturnValue(new Promise((resolve) => (finishRead = resolve)));
    mocks.api.agentRegistry.mockResolvedValue([{ id: "b", name: "B" }]);
    mocks.agentPresets.mockResolvedValue([]);
    mocks.api.agentInstall.mockResolvedValue(agent("b"));
    const { catalog, dispose } = held();
    const loading = catalog.loadAgents(vi.fn());
    await vi.waitFor(() => expect(mocks.api.agentRegistry).toHaveBeenCalled());
    finishRead([]);
    await loading;
    await catalog.install("b", vi.fn());
    expect(catalog.installed().map((entry) => entry.id)).toEqual(["b"]);
    const token = catalog.beginInstalledRead();
    catalog.commitInstalledMutation((list) => list);
    expect(catalog.applyInstalledSnapshot(token, [])).toBe(false);
    expect(catalog.installed().map((entry) => entry.id)).toEqual(["b"]);
    dispose();
  });

  it("reports a failed install on its row and through the caller", async () => {
    mocks.api.agentInstalled.mockResolvedValue([]);
    mocks.api.agentRegistry.mockResolvedValue([{ id: "c", name: "C" }]);
    mocks.agentPresets.mockResolvedValue([]);
    mocks.api.agentInstall.mockRejectedValue(new Error("offline"));
    const { catalog, dispose } = held();
    await catalog.loadAgents(vi.fn());
    const fail = vi.fn();
    await catalog.install("c", fail);
    expect(catalog.installErrors()).toEqual({ c: "offline" });
    expect(catalog.installingIds()).toEqual([]);
    expect(fail).toHaveBeenCalledWith({ phase: "connect", message: "Could not install C: offline" });
    dispose();
  });
});
