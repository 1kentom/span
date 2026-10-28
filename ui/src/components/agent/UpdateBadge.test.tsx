// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUpdate_Serialize as AgentUpdate } from "../../bindings";
import { ConnectScreen } from "./ConnectScreen";
import { UpdateBadge, UpdatePanel } from "./UpdateBadge";
import { mount, text } from "./test-utils";

const agent = (patch: Partial<AgentUpdate>): AgentUpdate => ({ id: "pi", name: "Pi", installedVersion: "0.0.30", latestVersion: "0.0.34", status: "updateAvailable", managed: true, howToUpdate: null, repository: null, note: null, ...patch });
const registryText = "Install it again from the ACP registry in Span. Span runs: `npm install --prefix <agent cache> -- pi-acp@0.0.34`";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("update pill", () => {
  it("leads with the up chevron and keeps the label text exact", () => {
    const root = mount(() => <UpdateBadge update={agent({ howToUpdate: registryText })} expanded={false} onToggle={() => {}} />);
    expect(text(root)).toBe("Update available: 0.0.30 to 0.0.34");
    const pill = root.querySelector(".sb-update-pill")!;
    expect(pill.firstElementChild!.innerHTML).toContain("arrow-up3");
    expect(pill.innerHTML).not.toMatch(/arrow-up2|arrow-up\.svg|arrow-circle|arrow-square/);
  });
  it("toggles with a trailing chevron that states its expanded state", () => {
    const onToggle = vi.fn();
    const root = mount(() => <UpdateBadge update={agent({ howToUpdate: registryText })} expanded={false} onToggle={onToggle} />);
    const toggle = root.querySelector<HTMLButtonElement>("button[aria-label='How to update Pi']")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.innerHTML).toContain("arrow-down4");
    toggle.click();
    expect(onToggle).toHaveBeenCalledOnce();
  });
  it("draws no toggle when the update carries nothing to show", () => {
    const root = mount(() => <UpdateBadge update={agent({})} expanded={false} onToggle={() => {}} />);
    expect(root.querySelector("button")).toBeNull();
    expect(text(root)).toBe("Update available: 0.0.30 to 0.0.34");
  });
});

describe("update panel", () => {
  it("shows the backticked command in a code block with a copy button and the never-runs note", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const root = mount(() => <UpdatePanel update={agent({ howToUpdate: registryText })} />);
    expect(text(root.querySelector("h4"))).toBe("How to update");
    const codes = [...root.querySelectorAll("code")];
    expect(codes.map((code) => code.textContent)).toEqual(["npm install --prefix <agent cache> -- pi-acp@0.0.34"]);
    expect(text(root)).toContain("Install it again from the ACP registry in Span.");
    expect(text(root)).toContain("Span never runs this for you");
    const copy = root.querySelector<HTMLButtonElement>("button[aria-label='Copy command']")!;
    expect(copy.innerHTML).toContain("copy.svg");
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith("npm install --prefix <agent cache> -- pi-acp@0.0.34");
    expect(text(copy)).toBe("Copied");
    await vi.advanceTimersByTimeAsync(1500);
    expect(text(copy)).toBe("Copy");
  });
  it("survives a clipboard that refuses", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const root = mount(() => <UpdatePanel update={agent({ howToUpdate: registryText })} />);
    const copy = root.querySelector<HTMLButtonElement>("button[aria-label='Copy command']")!;
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(text(copy)).toBe("Copy");
  });
  it("links release notes only when the update has a repository, through the given opener", () => {
    const opened: string[] = [];
    const without = mount(() => <UpdatePanel update={agent({ howToUpdate: registryText })} onOpenExternal={(url) => opened.push(url)} />);
    expect(without.textContent).not.toContain("Release notes");
    const withRepo = mount(() => <UpdatePanel update={agent({ howToUpdate: registryText, repository: "https://github.com/example/pi" })} onOpenExternal={(url) => opened.push(url)} />);
    [...withRepo.querySelectorAll("button")].find((button) => text(button) === "Release notes")!.click();
    expect(opened).toEqual(["https://github.com/example/pi"]);
  });
  it("invents no command for a local program without one", () => {
    const root = mount(() => <UpdatePanel update={agent({ id: "opencode", name: "OpenCode", managed: false, repository: "https://github.com/sst/opencode", note: null })} onOpenExternal={() => {}} />);
    expect(root.querySelector("code")).toBeNull();
    expect(root.querySelector("button[aria-label='Copy command']")).toBeNull();
    expect(root.textContent).not.toContain("Span never runs this for you");
    expect(root.textContent).toContain("Release notes");
  });
});

describe("connect screen update panel", () => {
  it("expands the panel under the row from the pill chevron", () => {
    const root = mount(() => (
      <ConnectScreen registry={[]} onConnect={() => {}} onInstall={() => {}} onCustom={() => {}} found={[{ id: "pi", name: "Pi", subtitle: "0.0.30" }]} updates={[agent({ howToUpdate: registryText })]} />
    ));
    expect(root.querySelector(".sb-update-panel")).toBeNull();
    root.querySelector<HTMLButtonElement>("button[aria-label='How to update Pi']")!.click();
    expect(root.querySelector(".sb-update-panel")).not.toBeNull();
    expect(root.querySelector("button[aria-label='How to update Pi']")!.getAttribute("aria-expanded")).toBe("true");
  });
});
