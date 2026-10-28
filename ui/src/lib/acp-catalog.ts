import type { InstalledAgent, RegistryAgent } from "../bindings";

export type CuratedAgent = {
  id: string;
  name: string;
  brand: string;
  aliases: string[];
  detail: string;
  docs: string;
  localCommand?: { command: string; args: string[] };
};

// These are presentation labels, not executable contracts. The live registry owns installation metadata.
export const CURATED_AGENTS: readonly CuratedAgent[] = [
  {
    id: "codex-acp",
    name: "Codex",
    brand: "codex",
    aliases: ["openai"],
    detail: "Codex through the ACP adapter",
    docs: "https://github.com/agentclientprotocol/codex-acp",
  },
  {
    id: "cursor",
    name: "Cursor",
    brand: "cursor",
    aliases: ["casa", "cursor agent"],
    detail: "Native ACP in Cursor CLI",
    docs: "https://cursor.com/docs/cli/acp",
    localCommand: { command: "cursor-agent", args: ["acp"] },
  },
  {
    id: "claude-acp",
    name: "Claude Code",
    brand: "claude",
    aliases: ["claude agent", "anthropic", "cloud code"],
    detail: "Claude Agent SDK through the ACP adapter",
    docs: "https://github.com/agentclientprotocol/claude-agent-acp",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    brand: "gemini",
    aliases: ["google"],
    detail: "Native ACP in Gemini CLI",
    docs: "https://geminicli.com/docs/cli/acp-mode/",
  },
  {
    id: "github-copilot-cli",
    name: "Copilot",
    brand: "copilot",
    aliases: ["github", "copilot cli"],
    detail: "GitHub Copilot CLI, ACP preview",
    docs: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
  },
  {
    id: "glm-acp-agent",
    name: "GLM Agent",
    brand: "glm",
    aliases: ["z.ai", "zhipu", "glm agents"],
    detail: "Community ACP adapter for Z.ai models",
    docs: "https://github.com/stefandevo/glm-acp-agent",
  },
  {
    id: "grok-build",
    name: "Grok Build",
    brand: "grok",
    aliases: ["xai", "x.ai"],
    detail: "Native ACP in xAI's Grok CLI",
    docs: "https://docs.x.ai/build/cli/reference",
  },
  {
    id: "opencode",
    name: "OpenCode",
    brand: "opencode",
    aliases: ["open code"],
    detail: "Native ACP in OpenCode",
    docs: "https://dev.opencode.ai/docs/cli/acp/",
    localCommand: { command: "opencode", args: ["acp"] },
  },
];
export type CatalogRow = {
  definition: CuratedAgent;
  registry?: RegistryAgent;
  installed?: InstalledAgent;
  action: "connect" | "install" | "local" | "unavailable";
};
export function curatedAgent(id: string) {
  return CURATED_AGENTS.find((agent) => agent.id === id);
}
export function buildAgentCatalog(
  registry: readonly RegistryAgent[],
  installed: readonly InstalledAgent[],
  search = "",
): CatalogRow[] {
  const query = search.trim().toLowerCase();
  return CURATED_AGENTS.filter(
    (agent) =>
      !query ||
      [agent.id, agent.name, ...agent.aliases].some((value) =>
        value.toLowerCase().includes(query),
      ),
  ).map((definition) => {
    const entry = registry.find((agent) => agent.id === definition.id);
    const existing = installed.find((agent) => agent.id === definition.id);
    return {
      definition,
      registry: entry,
      installed: existing,
      action: existing
        ? "connect"
        : entry?.installable
          ? "install"
          : entry && definition.localCommand
            ? "local"
            : "unavailable",
    };
  });
}
export function agentFailureMessage(message: string) {
  if (/method\s*(not\s*found|not\s*supported)|-32601/i.test(message))
    return "This command could not start an ACP session. Choose a supported agent or check that the command starts its ACP mode. You can inspect the technical details in ACP log.";
  return message;
}
export function removalBlockReason(
  connected: boolean,
  running: boolean,
  proposalCount: number,
  permissionPending: boolean,
) {
  if (!connected) return "";
  if (proposalCount)
    return "Review or reject the pending edits before removing the connected agent.";
  if (permissionPending)
    return "Resolve the pending permission request before removing the connected agent.";
  if (running)
    return "Stop the current turn before removing the connected agent.";
  return "";
}
