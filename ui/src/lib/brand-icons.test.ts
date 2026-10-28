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
