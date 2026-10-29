import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { modelBrandFor } from "./model-brands";

const brand = (value: string, name = value) => modelBrandFor({ value, name })?.id;

describe("model brands", () => {
  it("maps OpenCode ids by the part after the provider prefix", () => {
    expect(brand("opencode/claude-opus-5-5", "Claude Opus 5.5")).toBe("claude");
    expect(brand("opencode-go/glm-5", "GLM 5")).toBe("glm");
    expect(brand("opencode/gpt-5.5-codex", "GPT 5.5 Codex")).toBe("openai");
    expect(brand("opencode/qwen4-coder", "Qwen4 Coder")).toBe("qwen");
    expect(brand("opencode/gemini-3-pro", "Gemini 3 Pro")).toBe("gemini");
    expect(brand("opencode/mistral-large-3", "Mistral Large 3")).toBe("mistral");
  });
  it("follows the source rule table for vendor-prefixed ids", () => {
    expect(brand("openrouter/anthropic/claude-sonnet")).toBe("claude");
    expect(brand("opencode/z-ai/air")).toBe("glm");
    expect(brand("opencode/poolside/laguna")).toBe("poolside");
    expect(brand("opencode/ibm-granite/granite-5")).toBe("granite");
    expect(brand("opencode/amazon/nova-pro")).toBe("amazon-nova");
    expect(brand("opencode/groq/compound")).toBe("groq");
    expect(brand("opencode/inclusionai/ling-2")).toBe("inclusionai");
    expect(brand("opencode/nex-agi/nex-n2")).toBe("nex-agi");
    expect(brand("opencode/dots-studio/dots-llm")).toBe("dots-studio");
    expect(brand("opencode/cohere-command-a")).toBe("cohere");
    expect(modelBrandFor({ value: "opencode/ministral-8b", name: "Ministral 8B" })?.name).toBe("Ministral");
    expect(modelBrandFor({ value: "opencode/gemma-4", name: "Gemma 4" })?.name).toBe("Gemma");
  });
  it("maps DeepSeek, NVIDIA, Meta Llama and MiniMax to their own marks", () => {
    expect(brand("opencode/deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash Free")).toBe("deepseek");
    expect(brand("deepseek/deepseek-chat")).toBe("deepseek");
    expect(brand("opencode/nemotron-3.5-super-vl-free", "Nemotron 3.5 Super VL Free")).toBe("nvidia");
    expect(brand("nvidia/some-model")).toBe("nvidia");
    expect(brand("opencode/llama-4-maverick", "Llama 4 Maverick")).toBe("meta");
    expect(brand("opencode/meta-llama/llama-3.3-70b")).toBe("meta");
    expect(brand("opencode/minimax-m3", "MiniMax M3")).toBe("minimax");
    expect(modelBrandFor({ value: "opencode/minimax-m3", name: "MiniMax M3" })).toMatchObject({ name: "MiniMax", light: "/brands/models/minimax.svg", mono: true });
  });
  it("matches on the display name when the id is opaque", () => {
    expect(brand("opencode/x1", "Claude Haiku 5")).toBe("claude");
  });
  it("never guesses a logo for models it cannot map", () => {
    for (const [value, name] of [
      ["opencode/big-pickle", "Big Pickle"],
      ["opencode/beam-free", "opencode/Beam Free"],
      ["opencode/flint-free", "Flint Free"],
      ["opencode-go/iceman-contributor-free", "Iceman Free"],
      ["opencode/nova-lite-free", "Nova Lite Free"],
      ["ollama/some-local-model", "Some Local Model"],
      ["default", "Default"],
    ]) expect(modelBrandFor({ value, name }), value).toBeUndefined();
  });
  it("reuses the agent marks and returns light and dark sources", () => {
    const qwen = modelBrandFor({ value: "opencode/qwen4", name: "Qwen 4" })!;
    expect(qwen).toMatchObject({ id: "qwen", name: "Qwen", light: "/brands/qwen-light.svg", dark: "/brands/qwen-dark.svg" });
    const granite = modelBrandFor({ value: "opencode/granite-5", name: "Granite 5" })!;
    expect(granite).toMatchObject({ light: "/brands/models/granite.svg", dark: "/brands/models/granite.svg", mono: true });
  });
  it("points every new mark at a verified local file from the provenance record", () => {
    const provenance = JSON.parse(readFileSync(resolve("public/brands/models/provenance.json"), "utf8"));
    expect(provenance.license).toMatch(/not cover/);
    for (const asset of provenance.assets) {
      const path = resolve("public/brands/models", asset.file);
      expect(existsSync(path), asset.file).toBe(true);
      const bytes = readFileSync(path);
      expect(createHash("sha256").update(bytes).digest("hex"), asset.file).toBe(asset.sha256);
      if (asset.file.endsWith(".svg")) {
        const svg = bytes.toString("utf8");
        expect(svg).not.toMatch(/<(?:script|foreignObject|image|iframe|object|embed)\b|\bon\w+\s*=|javascript:/i);
        expect(svg).not.toMatch(/(?:href|xlink:href)\s*=\s*["'](?!#)/i);
        if (asset.colour === "currentColor") expect(svg).toContain('fill="currentColor"');
      }
    }
    for (const [value, file] of [["opencode/amazon/nova", "amazon-nova.png"], ["cohere", "cohere.svg"], ["poolside/x", "poolside.svg"], ["groq/x", "groq.png"], ["deepseek/x", "deepseek.svg"], ["nvidia/x", "nvidia.svg"], ["llama-4", "meta.svg"], ["minimax-m3", "minimax.svg"]]) {
      expect(modelBrandFor({ value, name: value })?.light).toBe(`/brands/models/${file}`);
    }
  });
});
