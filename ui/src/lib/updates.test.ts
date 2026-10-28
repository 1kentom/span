import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ agentUpdateStatus: vi.fn(), appUpdateCheck: vi.fn() }));
vi.mock("./client", () => ({ isDesktop: true, agentUpdateStatus: mocks.agentUpdateStatus, appUpdateCheck: mocks.appUpdateCheck }));
import { agentUpdateError, agentUpdates, appUpdate, checkAgentUpdates, checkAllUpdates, checkAppUpdate, resetUpdateChecks } from "./updates";

beforeEach(() => { resetUpdateChecks(); mocks.agentUpdateStatus.mockReset(); mocks.appUpdateCheck.mockReset(); });
describe("update check cache", () => {
  it("does nothing until asked and reuses a result for the session", async () => {
    mocks.appUpdateCheck.mockResolvedValue({ status: "upToDate" });
    expect(mocks.appUpdateCheck).not.toHaveBeenCalled();
    await checkAppUpdate();
    await checkAppUpdate();
    expect(mocks.appUpdateCheck).toHaveBeenCalledOnce();
    await checkAppUpdate(true);
    expect(mocks.appUpdateCheck).toHaveBeenCalledTimes(2);
    expect(appUpdate()?.status).toBe("upToDate");
  });
  it("keeps the real error and earlier results when a check fails", async () => {
    mocks.agentUpdateStatus.mockResolvedValueOnce([{ id: "a" }]);
    await checkAgentUpdates();
    mocks.agentUpdateStatus.mockRejectedValueOnce("Fetch ACP registry: offline");
    await checkAgentUpdates(true);
    expect(agentUpdateError()).toBe("Fetch ACP registry: offline");
    expect(agentUpdates()).toEqual([{ id: "a" }]);
  });
  it("turns a thrown app check into an error result, not silence", async () => {
    mocks.appUpdateCheck.mockRejectedValue(new Error("boom"));
    await checkAppUpdate();
    expect(appUpdate()).toMatchObject({ status: "error", message: "boom" });
  });
  it("checks both together", async () => {
    mocks.appUpdateCheck.mockResolvedValue({ status: "upToDate" });
    mocks.agentUpdateStatus.mockResolvedValue([]);
    await checkAllUpdates();
    expect(mocks.appUpdateCheck).toHaveBeenCalledOnce();
    expect(mocks.agentUpdateStatus).toHaveBeenCalledOnce();
  });
});
