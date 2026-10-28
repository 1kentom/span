// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConnectScreen } from "./ConnectScreen";
import { mount, text } from "./test-utils";

const css = readFileSync(resolve(__dirname, "../../styles/agent-sidebar.css"), "utf8");
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};
const base = { registry: [], onConnect: () => {}, onInstall: () => {}, onCustom: () => {} };
const preset = { id: "opencode", name: "OpenCode", description: "Open source coding agent", command: "opencode acp" };

afterEach(() => vi.useRealTimers());

describe("command chip", () => {
  it("draws the command and an icon-only copy button on one line inside the text column", () => {
    const host = mount(() => <ConnectScreen {...base} found={[]} presets={[preset]} />);
    const chip = host.querySelector(".sb-command-chip")!;
    expect(chip.closest(".sb-agent-text")).not.toBeNull();
    expect(chip.children[0].matches("code.sb-preset-command")).toBe(true);
    expect(text(chip.children[0])).toBe("opencode acp");
    expect(chip.children[0].getAttribute("title")).toBe("opencode acp");
    const copy = chip.querySelector<HTMLButtonElement>("button")!;
    expect(copy.getAttribute("aria-label")).toBe("Copy command");
    expect(copy.textContent).toBe("");
    expect(copy.querySelector(".icon")).not.toBeNull();
  });

  it("keeps the chip one line that fills the width, with no border and a field background", () => {
    const chip = rule(".sb-command-chip");
    expect(chip).toContain("display: flex");
    expect(chip).toContain("width: 100%");
    expect(chip).toContain("min-width: 0");
    expect(chip).toContain("height: 28px");
    expect(chip).toContain("border-radius: 6px");
    expect(chip).toContain("background: var(--sb-field)");
    expect(chip).not.toContain("border:");
    expect(chip).not.toContain("flex-direction: column");
    const code = rule(".sb-command-chip .sb-preset-command");
    expect(code).toContain("white-space: nowrap");
    expect(code).toContain("text-overflow: ellipsis");
    expect(code).toContain("min-width: 0");
  });

  it("copies the exact command and shows Copied for 1.5 seconds through the title and a live region", async () => {
    vi.useFakeTimers();
    const onCopy = vi.fn(async () => undefined);
    const host = mount(() => <ConnectScreen {...base} found={[]} presets={[preset]} onCopyCommand={onCopy} />);
    const copy = host.querySelector<HTMLButtonElement>("[aria-label='Copy command']")!;
    const live = host.querySelector(".sb-command-chip [aria-live='polite']")!;
    expect(live.textContent).toBe("");
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(onCopy).toHaveBeenCalledWith("opencode acp");
    expect(copy.getAttribute("title")).toBe("Copied");
    expect(copy.getAttribute("aria-label")).toBe("Copy command");
    expect(live.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(1500);
    expect(copy.getAttribute("title")).toBe("Copy command");
    expect(live.textContent).toBe("");
  });
});
