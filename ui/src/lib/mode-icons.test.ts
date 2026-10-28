import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MODE_ICON_NAMES, modeIconFor } from "./mode-icons";

describe("modeIconFor", () => {
  it.each([
    ["read-only", "ModeReadOnly", false], ["readonly", "ModeReadOnly", false], ["Read_Only", "ModeReadOnly", false],
    ["workspace", "ModeWorkspace", false], ["workspace-write", "ModeWorkspace", false], ["acceptEdits", "ModeWorkspace", false], ["accept-edits", "ModeWorkspace", false],
    ["auto", "ModeAuto", false], ["agent", "ModeAuto", false], ["auto-review", "ModeAuto", false],
    ["agent-full-access", "ModeDanger", true], ["full-access", "ModeDanger", true], ["bypassPermissions", "ModeDanger", true], ["danger-full-access", "ModeDanger", true],
    ["default", "ModeDefault", false], ["plan", "ModePlan", false],
    ["something-new", "ModeOther", false], ["", "ModeOther", false],
  ])("maps %s to %s (danger %s)", (value, icon, danger) => {
    expect(modeIconFor(value)).toEqual({ icon, danger });
  });

  it("never returns an icon that is missing, unsafe or unrecorded in the provenance note", () => {
    const directory = resolve(process.cwd(), "public/icons");
    const manifest = JSON.parse(readFileSync(resolve(directory, "mode-provenance.json"), "utf8")) as { assets: { asset: string; source: string; sourceSha256: string; assetSha256: string }[] };
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|[A-Z]:\\/);
    expect(manifest.assets.map((asset) => asset.asset).sort()).toEqual(MODE_ICON_NAMES.map((name) => `${name}.svg`).sort());
    for (const asset of manifest.assets) {
      expect(asset.source).toMatch(/^[a-z-]+\/iconsax-[a-z0-9-]+-\.svg$/);
      const text = readFileSync(resolve(directory, asset.asset), "utf8");
      expect(createHash("sha256").update(text).digest("hex")).toBe(asset.sourceSha256);
      expect(text).not.toMatch(/<script|foreignObject|\bon\w+=|(?:href|src)=|<!DOCTYPE|<!ENTITY/i);
    }
    for (const name of MODE_ICON_NAMES) expect(existsSync(resolve(directory, `${name}.svg`)), name).toBe(true);
  });
});
