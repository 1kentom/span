import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { iconAssetPath, menuIconAssets } from "./menuIcons";

describe("user-provided Iconsax interface assets", () => {
  it("resolves every menu action to the selected local rounded linear artwork", () => {
    for (const [name, asset] of Object.entries(menuIconAssets)) expect(iconAssetPath(`menu-${name}`)).toBe(`/icons/rounded-linear/${asset}.svg`);
    expect(iconAssetPath("Copy")).toBe("/icons/rounded-linear/copy.svg");
    expect(iconAssetPath("Trash")).toBe("/icons/rounded-linear/trash.svg");
    expect(iconAssetPath("menu-install")).toBe("/icons/rounded-linear/install.svg");
    expect(iconAssetPath("SearchNormal1")).toBe("/icons/SearchNormal1.svg");
    expect(iconAssetPath("../../outside")).toBe("/icons/rounded-linear/file.svg");
  });
  it("uses the copy glyph for path-copy actions and retired folder-route aliases", () => {
    for (const name of ["menu-path", "path", "Path", "FolderRoute", "folder-route", "FolderConnection"]) expect(iconAssetPath(name)).toBe(iconAssetPath("menu-copy"));
  });
  it("does not publish the rejected folder-with-connector geometry under another filename", () => {
    const root = resolve(process.cwd(), "public");
    for (const file of readdirSync(root, { recursive: true }).filter(file => String(file).endsWith(".svg"))) {
      const source = readFileSync(resolve(root, String(file)), "utf8");
      const paths = [...source.matchAll(/<path\b[^>]*\bd=(["'])(.*?)\1/gs)].map(match => match[2]).sort();
      const geometry = createHash("sha256").update(JSON.stringify(paths)).digest("hex");
      expect(geometry, `Rejected connector-folder artwork: ${file}`).not.toBe("8d6961e122f92a1ce268c41b0d87024e86335e532acfb77c58d88e6846d39602");
    }
  });
  it("keeps directional affordances on pure chevrons", () => {
    for (const name of ["arrow-down4", "arrow-up3", "arrow-left4", "arrow-right4"]) expect(iconAssetPath(name)).toBe(`/icons/rounded-linear/${name}.svg`);
    expect(iconAssetPath("ArrowRight")).toBe(iconAssetPath("arrow-right4"));
    expect(iconAssetPath("ArrowDown2")).toBe(iconAssetPath("arrow-down4"));
  });
  it("verifies provenance hashes, inert SVG content, and monochrome currentColor rendering", () => {
    const root = resolve(process.cwd(), "public/icons/rounded-linear");
    const manifest = JSON.parse(readFileSync(resolve(root, "provenance.json"), "utf8")) as { sourceCollection: string; assets: { asset: string; source: string; sourceSha256: string; assetSha256: string }[] };
    expect(manifest.sourceCollection).toContain("icons/rounded/linear"); expect(manifest.assets).toHaveLength(24);
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|[A-Z]:\\/);
    for (const record of manifest.assets) {
      const svg = readFileSync(resolve(root, record.asset), "utf8");
      expect(createHash("sha256").update(svg).digest("hex")).toBe(record.assetSha256);
      expect(record.source).toMatch(/\.svg$/); expect(record.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(svg).not.toMatch(/<script|foreignObject|\bon\w+=|(?:href|src)=|<!DOCTYPE|<!ENTITY/i);
      expect(svg).not.toMatch(/(?:stroke|fill)="(?!none|transparent|currentColor)[^"]+"/);
      expect(svg).toContain('stroke="currentColor"'); expect(svg).toContain('viewBox="0 0 24 24"');
    }
  });
});
