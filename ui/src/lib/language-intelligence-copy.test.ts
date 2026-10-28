import { describe, expect, it } from "vitest";
import * as copy from "./language-intelligence-copy";

const MB = 1024 * 1024;

describe("language intelligence copy", () => {
  it("never uses an em dash and never names JDT LS without a human name", () => {
    const strings: string[] = [];
    const walk = (value: unknown) => { if (typeof value === "string") strings.push(value); else if (value && typeof value === "object") Object.values(value).forEach(walk); };
    walk(copy.hubText); walk(copy.trustBanner); walk(copy.languageNames); walk(copy.shortLanguageNames); walk(copy.featureChipSpecs);
    for (const id of copy.serverOrder) {
      strings.push(copy.needsInstallDetail(id, 120 * MB, false), copy.startingDetail(id), copy.installingKeepEditing(id), copy.crashedDetail(id), copy.disabledDetail(id), copy.idleDetail(id), copy.runtimeMissingDetail(id, { requiredVersion: 20, foundList: [] }));
      for (const kind of ["ready", "working", "installing", "starting", "needs-install", "runtime-missing", "install-failed", "failed", "crashed", "disabled", "idle", "unavailable", "unknown"]) strings.push(copy.statusBarText(id, kind, 40), copy.buttonSummary(id, kind, 40), copy.rowStateText(kind, 40));
    }
    for (const text of strings) { expect(text).not.toContain("—"); expect(text).not.toMatch(/JDT LS/); }
  });
  it("names the Java card the way the design asks", () => {
    expect(copy.languageNames.jdtls).toBe("Java");
    expect(copy.technicalLabel("jdtls", "v1.62")).toBe("Eclipse JDT LS 1.62");
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
  it("describes each install phase in human terms", () => {
    expect(copy.installPhaseLine("downloading", 42 * MB, 320 * MB)).toBe("Downloading… 42 MB of 320 MB");
    expect(copy.installPhaseLine("downloading", 42 * MB, null)).toBe("Downloading… 42 MB so far");
    expect(copy.installPhaseLine("verifying")).toBe("Checking the download…");
    expect(copy.installPhaseLine("extracting")).toBe("Unpacking…");
    expect(copy.installPhaseLine("finalizing")).toBe("Finishing…");
  });
  it("explains install, with the size and the automatic install note", () => {
    expect(copy.needsInstallDetail("jdtls", 120 * MB, true)).toBe("Java support is not installed. Install it to get completions, error checking and go to definition. About 120 MB. You can keep editing while it downloads.");
    expect(copy.needsInstallDetail("jdtls", null, false)).toContain("Automatic install is off");
    expect(copy.installingKeepEditing("jdtls")).toBe("You can keep editing. Java features switch on by themselves when it is ready.");
    expect(copy.startingDetail("jdtls")).toBe("Starting Java support. The first start can take a minute while it reads your project.");
    expect(copy.readyDetail).toBe("Ready. Completions, errors, hover and go to definition are on for this file.");
  });
  it("states the missing runtime with the found and required versions", () => {
    expect(copy.runtimeMissingDetail("jdtls", { requiredVersion: 25, foundVersion: "21", foundPath: "/jdk/21" })).toBe("Java support needs JDK 25 or newer. Found: JDK 21 at /jdk/21. Install a newer JDK, or choose one.");
    expect(copy.runtimeMissingDetail("jdtls", { requiredVersion: 25, foundList: ["17"] })).toContain("Found: JDK 17.");
    expect(copy.runtimeMissingDetail("jdtls", { requiredVersion: 25 })).toContain("Found: no JDK on this computer.");
    expect(copy.runtimeMissingDetail("vtsls", { requiredVersion: 20, foundVersion: "18" })).toBe("TypeScript and JavaScript support needs Node.js 20 or newer. Found: Node.js 18. Install a newer Node.js, or choose one.");
    expect(copy.chooseRuntimeLabel("jdtls")).toBe("Choose JDK folder…");
  });
  it("words indexing from the server's own report", () => {
    expect(copy.workHeadline("Indexing project", 35)).toBe("Indexing your project… 35%");
    expect(copy.workHeadline(undefined, undefined)).toBe("Indexing your project…");
    expect(copy.workHeadline("Importing Maven project…", 12.4)).toBe("Importing Maven project… 12%");
  });
  it("keeps the status bar, button and row wording consistent for the same state", () => {
    expect(copy.statusBarText("jdtls", "installing", 42)).toBe("Java: installing 42%");
    expect(copy.buttonSummary("jdtls", "installing", 42)).toBe("Installing Java support (42%)");
    expect(copy.rowStateText("installing", 42)).toBe("Installing 42%");
    expect(copy.statusBarText("jdtls", "ready", undefined, true)).toBe("Java: ready (restricted)");
    expect(copy.buttonSummary(undefined, "unknown")).toBe("No language support for this file");
  });
  it("has the trust wording from the design", () => {
    expect(copy.trustBanner.title).toBe("Trust this folder to load project dependencies?");
    expect(copy.trustBanner.body).toContain("Only trust projects you got from a source you trust.");
    expect(copy.hubText.hoverTrustHint).toBe("Library types are not loaded until this folder is trusted.");
    expect(copy.hubText.restarting("Java support")).toBe("Restarting Java support with project dependencies…");
  });
});
