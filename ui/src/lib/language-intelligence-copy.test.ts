import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as copy from "./language-intelligence-copy";

const MB = 1024 * 1024;

describe("language intelligence copy", () => {
  const allStrings = () => {
    const strings: string[] = [];
    const walk = (value: unknown) => { if (typeof value === "string") strings.push(value); else if (value && typeof value === "object") Object.values(value).forEach(walk); };
    walk(copy.hubText); walk(copy.trustPrompt); walk(copy.languageNames); walk(copy.shortLanguageNames); walk(copy.featureSpecs);
    strings.push(copy.startingLine, copy.startingTip, copy.workLine, copy.workTip, copy.crashedLine, copy.disabledLine, copy.idleLine, copy.checkingLine, copy.startFailedLine, copy.nonRetryable, copy.hubText.restarting("Java"));
    for (const id of copy.serverOrder) {
      strings.push(copy.needsInstallLine(120 * MB), copy.needsInstallTip(false), copy.needsInstallTip(true), copy.installFailedLine(true), copy.installFailedLine(false), copy.runtimeMissingLine(id, { requiredVersion: 20, foundList: [] }), copy.runtimeMissingLine(id, { requiredVersion: 25, foundVersion: "21" }), copy.runtimeMissingTip(id, { requiredVersion: 25, foundPath: "/jdk" }), copy.chooseRuntimeLabel(id));
      for (const phase of ["downloading", "verifying", "extracting", "finalizing", "reused", "waitingForLock", "cancelled", undefined]) strings.push(copy.installPhaseLine(phase, 128 * MB, 320 * MB));
      for (const kind of ["ready", "working", "installing", "starting", "needs-install", "runtime-missing", "install-failed", "failed", "crashed", "disabled", "idle", "unavailable", "unknown"]) strings.push(copy.statusBarText(id, kind, 40), copy.buttonSummary(id, kind, 40), copy.rowWord(kind, 40), copy.headerWord(kind), copy.stateName(kind));
    }
    return strings;
  };
  it("never uses an em dash, the word JDT LS without a human name, a build number or server jargon in a sentence", () => {
    for (const text of allStrings()) {
      expect(text).not.toContain("\u2014");
      expect(text).not.toMatch(/JDT LS/);
      expect(text).not.toMatch(/\d{9,}/);
      expect(text.replace(copy.hubText.settingsLink, "")).not.toMatch(/language server/i);
    }
  });
  it("keeps every sentence short: no sentence is longer than 60 characters", () => {
    const long = allStrings().filter(text => text.split(/(?<=[.?!])\s+/).some(sentence => sentence.length > 60));
    expect(long).toEqual([]);
    expect(copy.trustPrompt.explain.split(/(?<=\.)\s+/).every(sentence => sentence.length <= 60)).toBe(true);
  });
  it("names the Java card the way the design asks, without a build number", () => {
    expect(copy.languageNames.jdtls).toBe("Java");
    expect(copy.technicalLabel("jdtls", "v1.62")).toBe("Eclipse JDT LS 1.62");
    expect(copy.technicalLabel("jdtls", "1.62.0-202610131109")).toBe("Eclipse JDT LS 1.62");
    expect(copy.technicalLabel("jdtls", "1.62.0")).toBe("Eclipse JDT LS 1.62");
    expect(copy.technicalLabel("rust-analyzer", "2026-10-12")).toBe("rust-analyzer 2026-10-12");
    expect(copy.technicalLabel("vtsls", null)).toBe("vtsls");
    expect(copy.languageNames.vtsls).toBe("TypeScript and JavaScript");
    expect(copy.languageNames.css).toBe("CSS, SCSS and Less");
    expect(copy.supportName("jdtls")).toBe("Java support");
  });
  it("formats sizes and percentages", () => {
    expect(copy.formatBytes(42 * MB)).toBe("42 MB");
    expect(copy.formatBytes(1.5 * 1024 * MB)).toBe("1.5 GB");
    expect(copy.formatBytes(300 * 1024)).toBe("300 KB");
    expect(copy.percentOf(42, 320)).toBe(13);
    expect(copy.percentOf(320, 320)).toBe(100);
    expect(copy.percentOf(999, 320)).toBe(100);
    expect(copy.percentOf(5, undefined)).toBeUndefined();
    expect(copy.percentOf(5, 0)).toBeUndefined();
  });
  it("writes a percent as digits and one sign, empty when unknown, clamped to 0 to 100", () => {
    expect(copy.percentText(40)).toBe("40%");
    expect(copy.percentText(0)).toBe("0%");
    expect(copy.percentText(100.4)).toBe("100%");
    expect(copy.percentText(140)).toBe("100%");
    expect(copy.percentText(undefined)).toBe("");
  });
  it("gives the percent text a fixed width and tabular digits in the stylesheet, so digits never jiggle", () => {
    const css = readFileSync(resolve(__dirname, "../styles/language-servers.css"), "utf8");
    const rule = /\.hub-percent\{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/width:\d+px/);
    expect(rule).not.toMatch(/min-width/);
    expect(rule).toContain("font-variant-numeric:tabular-nums");
    expect(/\.lsp-status-button\{[^}]*[^-]width:\d+px/.test(css)).toBe(true);
  });
  it("describes each install phase in a few words", () => {
    expect(copy.installPhaseLine("downloading", 42 * MB, 320 * MB)).toBe("Downloading 42 of 320 MB");
    expect(copy.installPhaseLine("downloading", 320 * MB, 320 * MB)).toBe("Downloading 320 of 320 MB");
    expect(copy.installPhaseLine("downloading", 900 * MB, 1.5 * 1024 * MB)).toBe("Downloading 900 MB of 1.5 GB");
    expect(copy.installPhaseLine("downloading", 42 * MB, null)).toBe("Downloading 42 MB");
    expect(copy.installPhaseLine("verifying")).toBe("Checking the download");
    expect(copy.installPhaseLine("extracting")).toBe("Unpacking");
    expect(copy.installPhaseLine("finalizing")).toBe("Finishing");
  });
  it("words install, start, work and failure as one short line each", () => {
    expect(copy.needsInstallLine(120 * MB)).toBe("Install for completions and errors (about 120 MB)");
    expect(copy.needsInstallLine(null)).toBe("Install for completions and errors");
    expect(copy.needsInstallTip(false)).toContain("Automatic install is off");
    expect(copy.needsInstallTip(true)).not.toContain("Automatic install");
    expect(copy.startingLine).toBe("The first start can take a minute");
    expect(copy.installFailedLine(true)).toBe("Couldn't install. Check your connection");
    expect(copy.crashedLine).toBe("Stopped unexpectedly");
  });
  it("states the missing runtime with the found and required versions", () => {
    expect(copy.runtimeMissingLine("jdtls", { requiredVersion: 25, foundVersion: "21", foundPath: "/jdk/21" })).toBe("Needs JDK 25 or newer. Found JDK 21");
    expect(copy.runtimeMissingTip("jdtls", { requiredVersion: 25, foundVersion: "21", foundPath: "/jdk/21" })).toBe("Found at /jdk/21. Install a newer JDK, or choose one.");
    expect(copy.runtimeMissingLine("jdtls", { requiredVersion: 25, foundList: ["17"] })).toBe("Needs JDK 25 or newer. Found JDK 17");
    expect(copy.runtimeMissingLine("jdtls", { requiredVersion: 25 })).toBe("Needs JDK 25 or newer. No JDK found");
    expect(copy.runtimeMissingLine("vtsls", { requiredVersion: 20, foundVersion: "18" })).toBe("Needs Node.js 20 or newer. Found Node.js 18");
    expect(copy.chooseRuntimeLabel("jdtls")).toBe("Choose JDK");
  });
  it("lists only the features that are on", () => {
    expect(copy.featuresLine(["completion", "diagnostics", "hover", "definition", "references", "rename", "format"])).toBe("Completions, errors, hover, go to definition, references, rename, format");
    expect(copy.featuresLine(["hover", "completion"])).toBe("Completions, hover");
    expect(copy.featuresLine([])).toBe("Ready");
  });
  it("shows a header word only where it adds information", () => {
    expect(copy.headerWord("ready")).toBe("");
    expect(copy.headerWord("needs-install")).toBe("");
    expect(copy.headerWord("installing")).toBe("Installing");
    expect(copy.headerWord("working")).toBe("Indexing");
    expect(copy.stateName("ready")).toBe("Ready");
    expect(copy.rowWord("ready")).toBe("");
    expect(copy.rowWord("installing", 42)).toBe("Installing 42%");
    expect(copy.rowWord("needs-install")).toBe("Not installed");
  });
  it("keeps the status bar, button and row wording consistent for the same state", () => {
    expect(copy.statusBarText("jdtls", "installing", 42)).toBe("Java 42%");
    expect(copy.statusBarText("jdtls", "working", 35)).toBe("Java 35%");
    expect(copy.statusBarText("jdtls", "ready")).toBe("Java");
    expect(copy.statusBarText("jdtls", "ready", undefined, true)).toBe("Java \u00b7 Trust");
    expect(copy.statusBarText("jdtls", "needs-install")).toBe("Java \u00b7 Install");
    expect(copy.statusBarText("jdtls", "install-failed")).toBe("Java \u00b7 Failed");
    expect(copy.statusBarText("vtsls", "starting")).toBe("TypeScript \u00b7 Starting");
    expect(copy.buttonSummary("jdtls", "installing", 42)).toBe("Installing Java (42%)");
    expect(copy.rowWord("installing", 42)).toBe("Installing 42%");
    expect(copy.buttonSummary(undefined, "unknown")).toBe("No language support for this file");
  });
  it("has the trust wording from the design", () => {
    expect(copy.trustPrompt.question).toBe("Trust this folder to load its dependencies?");
    expect(copy.trustPrompt.explain).toContain("Only trust folders from a source you trust.");
    expect(copy.hubText.hoverTrustHint).toBe("Library types are not loaded until this folder is trusted.");
    expect(copy.hubText.restarting("Java")).toBe("Restarting Java with its dependencies");
  });
});
