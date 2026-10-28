import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { iconAssetPath } from "./menuIcons";

describe("Markdown action Iconsax artwork", () => {
  it("preserves selected supplied SVG bytes and safe relative provenance", () => {
    const directory = resolve(process.cwd(), "public/icons");
    const manifest = JSON.parse(readFileSync(resolve(directory, "markdown-provenance.json"), "utf8")) as { assets: { asset: string; source: string; sourceSha256: string; assetSha256: string }[] };
    expect(manifest.assets.map(asset => asset.asset)).toEqual(["markdown-source.svg", "markdown-preview.svg", "markdown-both.svg", "markdown-run.svg", "markdown-terminal.svg"]);
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|[A-Z]:\\/);
    for (const asset of manifest.assets) {
      const text = readFileSync(resolve(directory, asset.asset), "utf8");
      expect(iconAssetPath(asset.asset.replace(/\.svg$/, ""))).toBe(`/icons/${asset.asset}`);
      expect(createHash("sha256").update(text).digest("hex")).toBe(asset.sourceSha256);
      expect(asset.assetSha256).toBe(asset.sourceSha256);
      expect(text).not.toMatch(/<script|foreignObject|\bon\w+=|(?:href|src)=|<!DOCTYPE|<!ENTITY/i);
      expect(text).not.toMatch(/(?:stroke|fill)="(?!none|transparent|currentColor)[^"]+"/);
    }
  });
});
