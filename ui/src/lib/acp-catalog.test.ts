import { describe, expect, it } from "vitest";
import type { InstalledAgent, RegistryAgent } from "../bindings";
import {
  CURATED_AGENTS,
  agentFailureMessage,
  buildAgentCatalog,
  removalBlockReason,
} from "./acp-catalog";
const registry = (id: string, installable = true): RegistryAgent => ({
  id,
  name: id === "claude-acp" ? "Claude Agent" : id,
  description: "Registry entry",
  version: "1.0.0",
  repository: null,
  icon: null,
  installable,
  package: null,
});
describe("curated ACP catalog", () => {
  it("keeps all eight approved agents in user order and explicitly labels Claude Code", () => {
    const entries = [
      ...Array.from({ length: 80 }, (_, i) => registry(`other-${i}`)),
      registry("claude-acp"),
    ];
    const rows = buildAgentCatalog(entries, []);
    expect(rows.map((row) => row.definition.name)).toEqual([
      "Codex",
      "Cursor",
      "Claude Code",
      "Gemini CLI",
      "Copilot",
      "GLM Agent",
      "Grok Build",
      "OpenCode",
    ]);
    expect(
      rows.find((row) => row.definition.name === "Claude Code")?.action,
    ).toBe("install");
    expect(rows).toHaveLength(CURATED_AGENTS.length);
  });
  it("searches friendly names and user terminology without exposing unrelated registry entries", () => {
    expect(
      buildAgentCatalog(
        [registry("agoragentic-acp"), registry("claude-acp")],
        [],
        "cloud code",
      ).map((row) => row.definition.id),
    ).toEqual(["claude-acp"]);
    expect(buildAgentCatalog([], [], "casa")[0].definition.id).toBe("cursor");
    expect(buildAgentCatalog([], [], "not present")).toEqual([]);
  });
  it("offers local setup rather than fake managed installation for binary distributions", () => {
    const rows = buildAgentCatalog(
      [registry("cursor", false), registry("opencode", false)],
      [],
    );
    expect(rows.find((row) => row.definition.id === "cursor")?.action).toBe(
      "local",
    );
    expect(rows.find((row) => row.definition.id === "opencode")?.action).toBe(
      "local",
    );
    expect(rows.find((row) => row.definition.id === "grok-build")?.action).toBe(
      "unavailable",
    );
  });
  it("does not remove or mutate an existing unapproved installation", () => {
    const installed: InstalledAgent[] = [
      {
        id: "agoragentic-acp",
        version: "1",
        launch: { command: "node", args: [], env: {} },
      },
    ];
    const before = JSON.stringify(installed);
    expect(
      buildAgentCatalog([], installed).every((row) => !row.installed),
    ).toBe(true);
    expect(JSON.stringify(installed)).toBe(before);
  });
  it("protects connected pending work and makes incompatible ACP errors actionable", () => {
    expect(removalBlockReason(true, false, 1, false)).toContain(
      "Review or reject",
    );
    expect(removalBlockReason(true, true, 0, false)).toContain("Stop");
    expect(removalBlockReason(true, false, 0, true)).toContain("permission");
    expect(removalBlockReason(false, true, 1, true)).toBe("");
    expect(
      agentFailureMessage("session/new: Method not found (-32601)"),
    ).toContain("Choose a supported agent");
    expect(agentFailureMessage("session/new: Method not found")).not.toContain(
      "Method not found",
    );
  });
});
