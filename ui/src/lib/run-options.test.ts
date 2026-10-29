import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_FILE_OPTION, commandLine, detectedHeading, groupRunOptions, runOptions } from "./run-options";

const configuration = { id: "saved", name: "Application", executable: "node", args: ["app.js"], cwd: ".", env: {} };
describe("run configuration options", () => {
  it("formats the argv for reading without implying a shell", () => {
    expect(commandLine({ executable: "mvn", args: ["package"], cwd: "." })).toBe("mvn package");
    expect(commandLine({ executable: "node", args: ["file with spaces.js", ""], cwd: "." })).toBe('node "file with spaces.js" ""');
    expect(commandLine({ executable: "cargo", args: ["run", "--bin", "tool"], cwd: "crates/app" })).toBe("cargo run --bin tool  (in crates/app)");
  });
  it("names detected groups by their manifest", () => {
    expect(detectedHeading("pom.xml")).toBe("Detected from pom.xml");
    expect(detectedHeading("package.json")).toBe("Detected from package.json scripts");
    expect(detectedHeading("Makefile")).toBe("Detected from Makefile targets");
    expect(detectedHeading("Cargo.toml")).toBe("Detected from Cargo.toml");
  });
  it("puts the current file first, saved next, then one Auto group per manifest", () => {
    const options = runOptions({ workspaceRoot: "/w", configurations: [configuration], detected: [
      { configuration: { ...configuration, id: "detected:cargo:cargo-test", name: "Cargo test", executable: "cargo", args: ["test"] }, source: "Cargo.toml" },
      { configuration: { ...configuration, id: "detected:cargo:cargo-run", name: "Cargo run", executable: "cargo", args: ["run"] }, source: "Cargo.toml" },
      { configuration: { ...configuration, id: "detected:make:build", name: "make build", executable: "make", args: ["build"] }, source: "Makefile" },
    ] }, undefined, false);
    const groups = groupRunOptions(options);
    expect(groups.map(group => [group.key, group.heading, group.auto, group.options.length])).toEqual([
      ["current-file", undefined, false, 1], ["saved", "Saved configurations", false, 1], ["detected:Cargo.toml", "Detected from Cargo.toml", true, 2], ["detected:Makefile", "Detected from Makefile targets", true, 1],
    ]);
    expect(options[0]).toMatchObject({ id: CURRENT_FILE_OPTION, disabled: true, detail: "Open a file to run it." });
    expect(options[1].detail).toBe("node app.js");
  });
  it("explains why the current file cannot run, or shows its command when it can", () => {
    const catalog = { workspaceRoot: "/w", configurations: [], detected: [] };
    expect(runOptions(catalog, { path: "a.md", configuration: null, reason: "No runner for .md files." }, true)[0]).toMatchObject({ disabled: true, detail: "No runner for .md files." });
    expect(runOptions(catalog, undefined, true, false)[0].detail).toBe("Running files requires the desktop app.");
    expect(runOptions(catalog, { path: "a.py", configuration: { ...configuration, id: "current-file", name: "Run a.py", executable: "python3", args: ["a.py"] }, reason: null }, true)[0]).toMatchObject({ disabled: false, detail: "python3 a.py", triggerLabel: "Run a.py" });
  });
  it("vendors the dropdown icons byte-identical with recorded provenance", () => {
    const directory = resolve(process.cwd(), "public/icons");
    const manifest = JSON.parse(readFileSync(resolve(directory, "run-provenance.json"), "utf8")) as { assets: { asset: string; source: string; sourceSha256: string; assetSha256: string }[] };
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|[A-Z]:\\/);
    expect(manifest.assets.map(asset => asset.asset).sort()).toEqual(["RunCheck.svg", "RunCurrentFile.svg"]);
    for (const asset of manifest.assets) {
      const text = readFileSync(resolve(directory, asset.asset), "utf8");
      const digest = createHash("sha256").update(text).digest("hex");
      expect(digest).toBe(asset.sourceSha256); expect(digest).toBe(asset.assetSha256);
      expect(asset.source).toMatch(/^[a-z0-9-]+\/iconsax-[a-z0-9-]+-\.svg$/);
      expect(text).not.toMatch(/<script|foreignObject|\bon\w+=|(?:href|src)=|<!DOCTYPE|<!ENTITY/i);
    }
  });
});
