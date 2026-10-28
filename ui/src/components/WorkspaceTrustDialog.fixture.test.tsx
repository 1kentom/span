// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Show, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { WorkspaceTrustDialog } from "./WorkspaceTrustDialog";
import { Modal } from "./Modal";
import { createWorkspaceTrust, createTrustPreview, parentFolderName, type TrustPort, type TrustState } from "../lib/workspace-trust";

// Fixture tests: the port is a fake, nothing here talks to the backend.
const prompt: TrustState = { decision: "undecided", inherited: false, source: null, needsPrompt: true, reason: "Maven", buildFiles: ["pom.xml", "Cargo.toml"] };
const decided: TrustState = { decision: "restricted", inherited: false, source: "/home/me/code/app", needsPrompt: false, reason: null, buildFiles: ["pom.xml"] };
const quiet: TrustState = { ...prompt, needsPrompt: false, buildFiles: [], reason: null };
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });

function setup(initial: TrustState, root = "/home/me/code/app") {
  let current = initial;
  const decide = vi.fn(async (decision: "trusted" | "restricted") => { current = { ...decided, decision, needsPrompt: false }; return current; });
  const port: TrustPort = { state: async () => current, decide, onChanged: async () => () => undefined };
  const trust = createRoot(dispose => { disposers.push(dispose); return createWorkspaceTrust(port); });
  const host = document.createElement("div"); document.body.append(host);
  disposers.push(render(() => <WorkspaceTrustDialog trust={trust} root={() => root} />, host));
  return { trust, decide, host, root };
}
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.textContent === label)!;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("fixture: workspace trust dialog", () => {
  it("asks the question with the build files, once", async () => {
    const m = setup(prompt);
    await m.trust.check(m.root); await flush();
    expect(dialog()!.getAttribute("aria-label")).toBe("Do you trust this folder?");
    expect(dialog()!.querySelector("h2")!.textContent).toBe("Do you trust this folder?");
    expect(dialog()!.textContent).toContain("Language support can run this project's build tool (Maven, Gradle or Cargo) to load its libraries. Trust it only if you trust where it came from.");
    expect(document.querySelector("[data-testid=trust-build-files]")!.textContent).toBe("pom.xml, Cargo.toml");
    expect(button("Trust folder").classList.contains("primary")).toBe(true);
    button("Trust folder").click(); await flush();
    expect(m.decide).toHaveBeenCalledWith("trusted", "folder");
    expect(dialog()).toBeNull();
    // Opening the same folder again in this session never asks again.
    await m.trust.check(m.root); await flush();
    expect(dialog()).toBeNull();
  });

  it("never appears for a decided folder or a folder without build files", async () => {
    const a = setup(decided);
    await a.trust.check(a.root); await flush();
    expect(dialog()).toBeNull();
    expect(a.trust.decision()).toBe("restricted");
    const b = setup(quiet, "/home/me/code/plain");
    await b.trust.check(b.root); await flush();
    expect(dialog()).toBeNull();
  });

  it("Don't trust stores restricted for the folder", async () => {
    const m = setup(prompt);
    await m.trust.check(m.root); await flush();
    button("Don't trust").click(); await flush();
    expect(m.decide).toHaveBeenCalledWith("restricted", "folder");
    expect(m.trust.decision()).toBe("restricted");
    expect(dialog()).toBeNull();
  });

  it("the checkbox trusts all folders in the parent", async () => {
    const m = setup(prompt);
    await m.trust.check(m.root); await flush();
    const box = dialog()!.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(box.closest("label")!.textContent).toBe("Trust all folders in code");
    box.click(); await flush();
    button("Trust folder").click(); await flush();
    expect(m.decide).toHaveBeenCalledWith("trusted", "parent");
  });

  it("has no checkbox when the parent would be too broad", async () => {
    const m = setup(prompt, "/home/app");
    await m.trust.check(m.root); await flush();
    expect(dialog()!.querySelector("input[type=checkbox]")).toBeNull();
    expect(parentFolderName("/app")).toBeNull();
    expect(parentFolderName("C:\\Users\\me\\code\\app")).toBe("code");
    expect(parentFolderName("\\\\?\\C:\\Work\\app")).toBeNull();
  });

  it("Escape counts as neither: undecided, no decision stored, not asked again this session", async () => {
    const m = setup(prompt);
    await m.trust.check(m.root); await flush();
    dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(dialog()).toBeNull();
    expect(m.decide).not.toHaveBeenCalled();
    expect(m.trust.decision()).toBe("undecided");
    await m.trust.check(m.root); await flush();
    expect(dialog()).toBeNull();
  });

  it("waits behind another modal and then appears", async () => {
    const [other, setOther] = createRoot(dispose => { disposers.push(dispose); return createSignal(true); });
    const host = document.createElement("div"); document.body.append(host);
    disposers.push(render(() => <Show when={other()}><Modal label="Other" onClose={() => setOther(false)}><p>other</p></Modal></Show>, host));
    const m = setup(prompt);
    await m.trust.check(m.root); await flush();
    expect(m.trust.pending()).toBeDefined();
    expect([...document.querySelectorAll("[role=dialog]")].map(item => item.getAttribute("aria-label"))).toEqual(["Other"]);
    setOther(false); await flush(); await flush();
    expect([...document.querySelectorAll("[role=dialog]")].map(item => item.getAttribute("aria-label"))).toEqual(["Do you trust this folder?"]);
  });

  it("shows a refusal from the backend inside the dialog and keeps asking", async () => {
    const m = setup(prompt);
    m.decide.mockRejectedValueOnce(new Error("The parent folder is too broad to trust as a whole."));
    await m.trust.check(m.root); await flush();
    button("Trust folder").click(); await flush();
    expect(dialog()!.querySelector("[role=alert]")!.textContent).toContain("too broad");
    expect(m.trust.pending()).toBeDefined();
  });
});

describe("fixture: preview trust port", () => {
  it("is quiet by default and asks with ?trust=prompt", async () => {
    expect((await createTrustPreview("").state()).needsPrompt).toBe(false);
    const port = createTrustPreview("?trust=prompt");
    expect((await port.state()).needsPrompt).toBe(true);
    const next = await port.decide("trusted", "parent");
    expect(next).toMatchObject({ decision: "trusted", needsPrompt: false });
  });
});
