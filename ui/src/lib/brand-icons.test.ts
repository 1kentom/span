import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { brandIconFor, brandIconSource } from "./brand-icons";

describe("brand identity", () => {
  it("resolves registry names and known agent IDs without changing identity", () => {
    expect(brandIconFor({ id: "claude-code-acp" })?.id).toBe("claude");
    expect(brandIconFor({ id: "@zed-industries/codex-acp" })?.id).toBe("codex");
    expect(brandIconFor({ name: "Gemini CLI" })?.id).toBe("gemini");
    expect(brandIconFor({ id: "openai" })?.id).toBe("openai");
    expect(brandIconFor({ id: "cargo" })?.id).toBe("rust");
  });
  it("resolves every real Claude identity, and the other agent registry ids", () => {
    for (const identity of [
      { id: "claude-acp" },
      { id: "claude-acp", name: "Claude Agent" },
      { name: "Claude Agent" },
      { name: "Claude Code" },
      { name: "@agentclientprotocol/claude-agent-acp" },
      { name: "@zed-industries/claude-code-acp" },
      { name: "Claude Agent ACP" },
      { name: "Claude Code ACP adapter" },
    ]) {
      const expected = identity.name === "Claude Code ACP adapter" ? undefined : "claude";
      expect(brandIconFor(identity)?.id, JSON.stringify(identity)).toBe(expected);
    }
    const ids: Record<string, string> = {
      "codex-acp": "codex", opencode: "opencode", gemini: "gemini", "github-copilot": "copilot", "copilot-acp": "copilot",
      "qwen-code": "qwen", "mistral-vibe": "mistral", "cursor-agent": "cursor", "grok-cli": "grok", "glm-acp-agent": "glm",
      "@agentclientprotocol/codex-acp": "codex", "gemini-cli": "gemini", "grok-build": "grok", "Cursor": "cursor",
    };
    for (const [id, brand] of Object.entries(ids)) expect(brandIconFor({ id })?.id, id).toBe(brand);
  });
  it("applies the suffix fallback only to agent brands", () => {
    expect(brandIconFor({ id: "gemini-agent" })?.id).toBe("gemini");
    expect(brandIconFor({ id: "node-cli" })).toBeUndefined();
    expect(brandIconFor({ id: "go-acp" })).toBeUndefined();
    expect(brandIconFor({ id: "agent" })).toBeUndefined();
    expect(brandIconFor({ id: "claude-acp-extra" })).toBeUndefined();
    expect(brandIconFor({ id: "my-claude-acp" })).toBeUndefined();
  });
  it("keeps unknown providers neutral instead of inventing logos", () => {
    expect(brandIconFor({ id: "sap" })).toBeUndefined();
    expect(brandIconFor({ name: "Custom ACP command" })).toBeUndefined();
    expect(brandIconFor({ id: "not-claude" })).toBeUndefined();
  });
  it("uses the supplied contrast variant for light and dark themes", () => {
    const codex = brandIconFor({ id: "codex" })!;
    expect(brandIconSource(codex, "Light")).toBe("/brands/codex-light.svg");
    expect(brandIconSource(codex, "Dark")).toBe("/brands/codex-dark.svg");
    expect(brandIconSource(codex, "Purple")).toBe("/brands/codex-dark.svg");
    const claude = brandIconFor({ id: "claude" })!;
    expect(claude.light).toBe(claude.dark);
  });
  it("ships only verified local SVG files from the pinned source record", () => {
    const provenance = JSON.parse(readFileSync(resolve("public/brands/provenance.json"), "utf8"));
    for (const asset of provenance.assets) {
      const brand = brandIconFor({ id: asset.key })!;
      for (const theme of ["light", "dark"] as const) {
        const record = asset.files[theme];
        const contents = readFileSync(resolve("public/brands", record.file), "utf8");
        expect(brand[theme]).toBe(`/brands/${record.file}`);
        expect(createHash("sha256").update(contents).digest("hex")).toBe(record.sha256);
        expect(contents).not.toMatch(/<(?:script|foreignObject|image|iframe|object|embed)\b|\bon\w+\s*=|javascript:/i);
        expect(contents).not.toMatch(/(?:href|xlink:href)\s*=\s*["'](?!#)/i);
      }
    }
  });
});


it("preserves the SVGL Apple platform artwork and its source hash", () => {
  const record = JSON.parse(readFileSync(resolve("public/brands/platform-provenance.json"), "utf8")).assets[0];
  const file = record.files.mono;
  const contents = readFileSync(resolve("public/brands", file.file), "utf8");
  expect(record.registry.title).toBe("Apple");
  expect(file.source).toBe("https://svgl.app/library/apple.svg");
  expect(createHash("sha256").update(contents).digest("hex")).toBe(file.sha256);
  expect(contents).not.toMatch(/<(?:script|foreignObject|image|iframe|object|embed)\b|\bon\w+\s*=|javascript:/i);
  expect(contents).not.toMatch(/(?:href|xlink:href)\s*=\s*["'](?!#)/i);
});
