import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { agentConnection, NO_STATES } from "./connection";

const held = () => createRoot((dispose) => ({ connection: agentConnection.use(), dispose }));

describe("agent connection store", () => {
  it("is one focused connection for every holder", () => {
    const sidebar = held();
    const page = held();
    expect(page.connection).toBe(sidebar.connection);
    sidebar.connection.setAgentId("codex");
    sidebar.connection.setAgentName("Codex");
    expect(page.connection.agentId()).toBe("codex");
    expect(page.connection.agentName()).toBe("Codex");
    sidebar.dispose();
    page.dispose();
    const next = held();
    expect(next.connection.agentName()).toBe("Select agent");
    expect(next.connection.sessionStates()).toBe(NO_STATES);
    next.dispose();
  });

  it("answers runtime and liveness from the backend states", () => {
    const { connection, dispose } = held();
    connection.setSessionStates({
      connectionId: "c1",
      sessions: [
        { sessionId: "idle", state: "idle", queued: 0 },
        { sessionId: "queued", state: "idle", queued: 2 },
        { sessionId: "busy", state: "running", queued: 0 },
      ],
    } as never);
    expect(connection.runtimeOf("busy")?.state).toBe("running");
    expect(connection.runtimeOf(undefined)).toBeUndefined();
    expect(connection.isLive("idle")).toBe(false);
    expect(connection.isLive("queued")).toBe(true);
    expect(connection.isLive("busy")).toBe(true);
    expect(connection.isLive("missing")).toBe(false);
    dispose();
  });

  it("hands out distinct local stand-in keys", () => {
    const { connection, dispose } = held();
    expect(connection.localKey()).toBe("local-1");
    expect(connection.localKey()).toBe("local-2");
    dispose();
  });
});
