import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { iconAssetPath } from "./menuIcons";

const dir = resolve(process.cwd(), "public/icons");
const manifest = JSON.parse(readFileSync(resolve(dir, "status-provenance.json"), "utf8")) as { assets: { asset: string; source: string; sourceSha256: string; assetSha256: string }[] };
const src = (rel: string) => readFileSync(resolve(process.cwd(), "src", rel), "utf8");

describe("owner-chosen rounded outline action icons", () => {
  const files = ["Shuffle.svg", "ActionDownload.svg", "ActionUpload.svg", "ActionNewFile.svg", "ActionRename.svg"];
  for (const file of files) {
    it(`${file} is the unmodified library file recorded with its hash`, () => {
      const entry = manifest.assets.find((asset) => asset.asset === file)!;
      const bytes = readFileSync(resolve(dir, file));
      const hash = createHash("sha256").update(bytes).digest("hex");
      expect(entry.source.startsWith("rounded/outline/")).toBe(true);
      expect(entry.sourceSha256).toBe(hash);
      expect(entry.assetSha256).toBe(hash);
      const svg = bytes.toString("utf8");
      expect(svg).not.toMatch(/<script|href=|<image/i);
      expect(svg).toMatch(/<path\b/);
      expect(svg).not.toMatch(/(fill|stroke)-opacity|\bopacity=/);
    });
  }
  it("resolves through the Icon wrapper names", () => {
    for (const [name, file] of [["menu-install", "ActionDownload"], ["menu-newFile", "ActionNewFile"], ["ActionDownload", "ActionDownload"], ["ActionUpload", "ActionUpload"], ["ActionRename", "ActionRename"], ["Shuffle", "Shuffle"]]) expect(iconAssetPath(name)).toBe(`/icons/${file}.svg`);
  });
  it("call sites use the intended icons", () => {
    expect(src("components/agent/AgentStatusBar.tsx")).toContain('name="Shuffle"');
    expect(src("components/agent/AgentCatalog.tsx")).toContain('<MenuIcon name="install"');
    expect(src("components/agent/ConnectScreen.tsx")).toContain('<MenuIcon name="install"');
    expect(src("components/viewer/FileViewer.tsx")).toContain('name="ActionDownload"');
    expect(src("components/uploads/upload-model.ts")).toContain("icon: 'ActionDownload'");
    expect(src("components/uploads/upload-model.ts")).toContain("icon: 'ActionRename'");
    expect(src("components/uploads/UploadsPanel.tsx")).toContain('name="ActionUpload"');
    expect(src("components/uploads/UploadsWorkspace.tsx")).toContain('name="ActionUpload"');
    expect(src("components/attachments/AttachMenu.tsx")).toContain("icon: 'ActionUpload'");
    expect(src("components/agent/HistoryList.tsx")).toContain('name="ActionRename"');
    expect(src("App.tsx")).toContain('label: "Rename…", icon: "ActionRename"');
    expect(src("App.tsx")).toContain('<MenuIcon name="newFile"');
  });
});
