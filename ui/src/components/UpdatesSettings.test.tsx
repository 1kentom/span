// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { AgentUpdate_Serialize as AgentUpdate, AppUpdate_Serialize as AppUpdate } from "../bindings";
import { UpdatesSettings, type UpdatesSettingsProps } from "./UpdatesSettings";
import { ConnectScreen } from "./agent/ConnectScreen";
import { UpdateBadge } from "./agent/UpdateBadge";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach((dispose) => dispose()); document.body.replaceChildren(); });
function mount(view: () => any) {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(render(view, root));
  return root;
}
const app = (patch: Partial<AppUpdate>): AppUpdate => ({ currentVersion: "0.1.0-nightly.20261028.7", channel: "nightly", latestVersion: null, newer: false, releaseUrl: null, status: "upToDate", message: null, ...patch });
const agent = (patch: Partial<AgentUpdate>): AgentUpdate => ({ id: "opencode", name: "OpenCode", installedVersion: "2.0.32", latestVersion: "2.2.0", status: "updateAvailable", managed: false, howToUpdate: null, repository: null, note: null, ...patch });

describe("update badge", () => {
  it("shows a badge only for a confirmed newer version", () => {
    const root = mount(() => <UpdateBadge update={agent({})} />);
    expect(root.textContent).toBe("Update available: 2.0.32 to 2.2.0");
    expect(root.querySelector('[aria-label="OpenCode. Update available: 2.0.32 to 2.2.0"]')).not.toBeNull();
  });
  it.each(["upToDate", "unknown", "notInstalled"] as const)("shows nothing for %s", (status) => {
    const root = mount(() => <UpdateBadge update={agent({ status })} />);
    expect(root.textContent).toBe("");
  });
  it("shows nothing when a version is missing even if the status says available", () => {
    expect(mount(() => <UpdateBadge update={agent({ latestVersion: null })} />).textContent).toBe("");
    expect(mount(() => <UpdateBadge />).textContent).toBe("");
  });
});

describe("connect screen updates", () => {
  const props = { registry: [], onConnect: () => {}, onInstall: () => {}, onCustom: () => {} };
  it("puts badges on the matching rows and checks only on click", () => {
    const onCheckUpdates = vi.fn();
    const root = mount(() => (
      <ConnectScreen {...props} found={[{ id: "gemini", name: "Gemini CLI", subtitle: "0.60.0" }]} presets={[{ id: "opencode", name: "OpenCode", description: "d", command: "opencode acp" }]}
        updates={[agent({}), agent({ id: "gemini", name: "Gemini CLI", status: "unknown", installedVersion: null })]} onCheckUpdates={onCheckUpdates} />
    ));
    expect(onCheckUpdates).not.toHaveBeenCalled();
    expect(root.textContent).toContain("Update available: 2.0.32 to 2.2.0");
    expect(root.querySelectorAll(".sb-update-badge")).toHaveLength(1);
    root.querySelector<HTMLButtonElement>("button[aria-label='Connect Gemini CLI']")!.click();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Check agents for updates")!.click();
    expect(onCheckUpdates).toHaveBeenCalledOnce();
  });
  it("shows the real error text", () => {
    const root = mount(() => <ConnectScreen {...props} found={[]} onCheckUpdates={() => {}} updateError="Fetch ACP registry: offline" />);
    expect(root.querySelector("[role=alert]")!.textContent).toBe("Fetch ACP registry: offline");
  });
});

function updates(overrides: Partial<UpdatesSettingsProps> = {}) {
  const onCheck = vi.fn();
  const onOpenRelease = vi.fn();
  const root = mount(() => <UpdatesSettings desktop onCheck={onCheck} onOpenRelease={onOpenRelease} {...overrides} />);
  return { root, onCheck, onOpenRelease };
}
describe("updates settings", () => {
  it("does nothing on mount and checks on click", () => {
    const { root, onCheck } = updates();
    expect(onCheck).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>("button")!.click();
    expect(onCheck).toHaveBeenCalledOnce();
  });
  it("says plainly that checks are not configured", () => {
    const { root } = updates({ app: app({ channel: "development", status: "notConfigured", message: "Update checks are not configured for this build. Development builds are not compared with published releases." }) });
    expect(root.textContent).toContain("Update checks are not configured for this build.");
  });
  it("shows errors as errors, never as up to date", () => {
    const { root } = updates({ app: app({ status: "error", message: "GitHub rate limit reached for unauthenticated requests. Try again later." }) });
    expect(root.querySelector("[role=alert]")!.textContent).toContain("rate limit");
    expect(root.textContent).not.toContain("up to date");
  });
  it("opens the release page only from a click and installs nothing", () => {
    const { root, onOpenRelease } = updates({ app: app({ status: "updateAvailable", newer: true, latestVersion: "0.1.0-nightly.20261029.3", releaseUrl: "https://github.com/1kentom/span/releases/tag/v0.1.0-nightly.20261029.3" }) });
    expect(root.textContent).toContain("Update available: 0.1.0-nightly.20261028.7 to 0.1.0-nightly.20261029.3");
    expect(onOpenRelease).not.toHaveBeenCalled();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "View release page")!.click();
    expect(onOpenRelease).toHaveBeenCalledWith("https://github.com/1kentom/span/releases/tag/v0.1.0-nightly.20261029.3");
    expect(root.textContent).toContain("never downloads or installs");
  });
  it("reports an up to date build with its version and channel", () => {
    const { root } = updates({ app: app({ latestVersion: "0.1.0-nightly.20261028.7" }) });
    expect(root.textContent).toContain("is up to date on the nightly channel");
    expect(root.querySelector('[aria-label="This build"]')!.textContent).toContain("0.1.0-nightly.20261028.7");
  });
  it("shows the launch setting as text, not a control, and why", () => {
    const { root } = updates({ checkOnLaunch: true });
    expect(root.querySelector('input[type="checkbox"], [role="switch"]')).toBeNull();
    expect(root.textContent).toContain("updates.checkOnLaunch");
    expect(root.textContent).toContain("On.");
    expect(root.textContent).toContain("user settings file");
  });
  it("lists agents without inventing unknown or missing ones", () => {
    const { root } = updates({ agents: [agent({ managed: true, howToUpdate: "Install it again from the ACP registry in Span." }), agent({ id: "claude", name: "Claude Code", status: "unknown", installedVersion: "2.0.32", latestVersion: null, note: "Not comparable." }), agent({ id: "codex", name: "Codex", status: "notInstalled", installedVersion: null, latestVersion: null })] });
    const text = root.textContent!;
    expect(text).toContain("Install it again from the ACP registry in Span.");
    expect(text).toContain("Version unknown");
    expect(text).not.toContain("Codex");
  });
  it("is honest in the browser preview", () => {
    const { root, onCheck } = updates({ desktop: false });
    expect(root.textContent).toContain("browser preview cannot check for updates");
    root.querySelector<HTMLButtonElement>("button")!.click();
    expect(onCheck).not.toHaveBeenCalled();
  });
});
