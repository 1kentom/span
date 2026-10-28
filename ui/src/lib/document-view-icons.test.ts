import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { iconAssetPath } from "./menuIcons";

describe("custom document view artwork", () => {
  it("uses the custom split frame with distinct, safe theme-neutral code and page marks", () => {
    const directory = resolve(process.cwd(), "public/icons");
    const assets = ["source", "preview", "both"].map(mode => {
      const asset = `markdown-view-${mode}.svg`;
      expect(iconAssetPath(`markdown-view-${mode}`)).toBe(`/icons/${asset}`);
      const svg = readFileSync(resolve(directory, asset), "utf8");
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain('<rect x="2.5" y="2.5" width="19" height="19" rx="3" stroke="currentColor" stroke-width="1.5"');
      expect(svg).toContain('fill="currentColor"');
      expect(svg).not.toMatch(/<script|foreignObject|<circle|<ellipse|\bon\w+=|(?:href|src)=|<!DOCTYPE|<!ENTITY/i);
      expect(svg).not.toMatch(/(?:stroke|fill)="(?!none|currentColor)[^"]+"/);
      return svg;
    });
    expect(new Set(assets).size).toBe(3);
    const provenance = JSON.parse(readFileSync(resolve(directory, "document-view-provenance.json"), "utf8"));
    expect(provenance.assets).toEqual(["source", "preview", "both"].map(mode => `markdown-view-${mode}.svg`));
    expect(JSON.stringify(provenance)).not.toMatch(/\/Users\/|[A-Z]:\\/);
  });
});
