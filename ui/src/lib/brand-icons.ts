export type BrandIdentity = { id?: string; name?: string };
export type BrandIconAsset = { id: string; light: string; dark: string };

const assets: Record<string, { variants?: boolean; aliases: string[] }> = {
  claude: {
    aliases: [
      "claude",
      "claude code",
      "claude ai",
      "claude code acp",
      "claude agent acp",
      "anthropic",
    ],
  },
  codex: {
    variants: true,
    aliases: ["codex", "codex cli", "codex acp", "openai codex"],
  },
  openai: { variants: true, aliases: ["openai", "open ai"] },
  gemini: { aliases: ["gemini", "gemini cli", "gemini acp", "google gemini"] },
  copilot: {
    variants: true,
    aliases: ["copilot", "github copilot", "copilot cli", "copilot acp"],
  },
  cursor: { variants: true, aliases: ["cursor", "cursor agent", "cursor cli"] },
  opencode: {
    variants: true,
    aliases: ["opencode", "open code", "opencode acp"],
  },
  qwen: {
    variants: true,
    aliases: ["qwen", "qwen code", "qwen code acp", "qwen acp"],
  },
  mistral: { aliases: ["mistral", "mistral ai", "mistral vibe", "vibe"] },
  zed: { variants: true, aliases: ["zed"] },
  glm: { aliases: ["glm", "glm agent", "glm acp agent", "z.ai"] },
  grok: { variants: true, aliases: ["grok", "grok build", "grok-build"] },
  git: { aliases: ["git"] },
  node: { aliases: ["node", "node js", "nodejs"] },
  npm: { aliases: ["npm"] },
  pnpm: { variants: true, aliases: ["pnpm"] },
  bun: { aliases: ["bun"] },
  deno: { variants: true, aliases: ["deno"] },
  python: { aliases: ["python", "python3"] },
  rust: { variants: true, aliases: ["rust", "rustc", "rustfmt", "cargo"] },
  prettier: { variants: true, aliases: ["prettier"] },
  go: { variants: true, aliases: ["go", "golang"] },
};
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Branding only. Identity never determines agent capabilities or executable availability. */
export function brandIconFor(
  identity: BrandIdentity,
): BrandIconAsset | undefined {
  const values = [identity.id, identity.name]
    .filter((value): value is string => Boolean(value))
    .map(normalize);
  for (const [id, asset] of Object.entries(assets)) {
    if (
      values.some(
        (value) =>
          asset.aliases.includes(value) ||
          asset.aliases.some(
            (alias) =>
              value === `zed industries ${alias}` ||
              value === `agentclientprotocol ${alias}`,
          ),
      )
    ) {
      const base = `/brands/${id}`;
      return {
        id,
        light: `${base}${asset.variants ? "-light" : ""}.svg`,
        dark: `${base}${asset.variants ? "-dark" : ""}.svg`,
      };
    }
  }
  return undefined;
}

export function brandIconSource(
  asset: BrandIconAsset,
  theme: "Dark" | "Light" | "Purple",
) {
  return theme === "Light" ? asset.light : asset.dark;
}
