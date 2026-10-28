// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { RunApprovalRequest } from "../bindings";
import { api } from "../lib/client";
import { createRunApprovals } from "./run-approvals";
const cleanups: (() => void)[] = [];
let receive: (pending: RunApprovalRequest[]) => void;
const request = (id: string): RunApprovalRequest => ({ id, action: "run", lead: { connectionId: "connection", sessionId: "lead" }, agentName: "Fixture", name: "Example", executable: "node", args: ["app.js"], cwd: "/workspace", envKeys: [], envReferences: {}, envChanges: {}, executionResolved: true, configRevision: "revision", expiresAt: 1999999999 });
const settle = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
beforeEach(() => {
  vi.spyOn(api, "runToolsEnabled").mockResolvedValue(false);
  vi.spyOn(api, "runToolsSetEnabled").mockResolvedValue(undefined);
  vi.spyOn(api, "onRunApprovalsChanged").mockImplementation(async callback => { receive = callback; return () => {}; });
  vi.spyOn(api, "pendingRunApprovals").mockResolvedValue([]);
  vi.spyOn(api, "resolveRunApproval").mockResolvedValue(undefined);
});
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks(); });
function setup(available = true) {
  const [generation, setGeneration] = createSignal(1);
  const store = createRoot(dispose => { cleanups.push(dispose); return createRunApprovals({ available, generation, blocked: () => false }); });
  return { store, setGeneration };
}
describe("agent run approval state", () => {
  it("does not overwrite a new approval event with an older snapshot or approve while loading", async () => {
    let release!: (values: RunApprovalRequest[]) => void;
    vi.mocked(api.pendingRunApprovals).mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const view = setup(); await settle(); receive([request("latest")]); release([request("older")]); await settle();
    expect(view.store.pending().map(value => value.id)).toEqual(["latest"]); expect(api.resolveRunApproval).not.toHaveBeenCalled();
    await view.store.resolve("latest", false); expect(api.resolveRunApproval).toHaveBeenCalledWith("latest", false);
  });
  it("keeps a separate user opt-in and applies it only after the native save succeeds", async () => {
    const view = setup(); await settle(); expect(view.store.enabled()).toBe(false);
    let release!: () => void; vi.mocked(api.runToolsSetEnabled).mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const enabling = view.store.setAllowed(true); expect(view.store.enabled()).toBe(false); expect(view.store.busy()).toBe(true);
    release(); await enabling; expect(view.store.enabled()).toBe(true); expect(api.resolveRunApproval).not.toHaveBeenCalled();
  });
  it("ignores late resolution after workspace replacement and preserves the new request", async () => {
    const view = setup(); await settle(); receive([request("old")]);
    let release!: () => void; vi.mocked(api.resolveRunApproval).mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
    const resolving = view.store.resolve("old", true); view.setGeneration(2); await settle(); receive([request("new")]); release(); await resolving;
    expect(view.store.pending().map(value => value.id)).toEqual(["new"]); expect(view.store.resolving()).toBeUndefined();
  });
  it("does not call native approval or preference APIs in browser preview", async () => {
    const view = setup(false); await settle(); await view.store.setAllowed(true); await view.store.resolve("missing", true);
    expect(api.runToolsEnabled).not.toHaveBeenCalled(); expect(api.runToolsSetEnabled).not.toHaveBeenCalled(); expect(api.resolveRunApproval).not.toHaveBeenCalled();
  });
});
