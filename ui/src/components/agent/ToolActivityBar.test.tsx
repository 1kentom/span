// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSignal } from "solid-js";
import { ToolActivityBar } from "./ToolActivityBar";
import { mount, text } from "./test-utils";
import type { ToolBarView } from "../../lib/agent-tool-bar";

const view = (patch: Partial<ToolBarView> = {}): ToolBarView => ({ tone: "running", label: "Execute", summary: "pnpm test", command: true, elapsed: "0:08", turn: "0:23", more: [], stoppable: true, announce: "Running command: pnpm test", toolCallId: "t1", ...patch });

describe("ToolActivityBar", () => {
  it("is one stacked bar with the title, monospace summary, one timer and the Esc key cap", () => {
    const host = mount(() => <ToolActivityBar view={view()} />);
    const bars = host.querySelectorAll(".sb-activity");
    expect(bars).toHaveLength(1);
    const bar = bars[0];
    expect(text(bar.querySelector(".agent-toolbar-label"))).toBe("Execute");
    const summary = bar.querySelector(".agent-toolbar-summary")!;
    expect(summary.classList.contains("sb-mono")).toBe(true);
    expect(summary.getAttribute("title")).toBe("pnpm test");
    expect(bar.querySelectorAll(".agent-toolbar-elapsed")).toHaveLength(1);
    expect(text(bar.querySelector(".agent-toolbar-elapsed"))).toBe("0:08");
    expect(bar.querySelector(".agent-toolbar-elapsed")!.getAttribute("title")).toBe("This step 0:08, turn 0:23");
    expect(text(bar.querySelector(".agent-toolbar-hint kbd.sb-hint-key"))).toBe("Esc");
    expect(bar.querySelector(".sb-spinner")).not.toBeNull();
    // Never "Running: execute" twice: the label appears once.
    expect(bar.textContent!.match(/Execute/g)).toHaveLength(1);
  });

  it("keeps the timer out of the polite status region", () => {
    const host = mount(() => <ToolActivityBar view={view()} />);
    const status = host.querySelector("[role=status]")!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(text(status)).toBe("Running command: pnpm test");
    expect(status.contains(host.querySelector(".agent-toolbar-elapsed"))).toBe(false);
    expect(host.querySelector(".sb-activity")!.closest("[aria-live], [role=status]")).toBeNull();
  });

  it("shows a +N more chip listing the other tools", () => {
    const host = mount(() => <ToolActivityBar view={view({ more: ["Read a.ts", "Execute pnpm lint"] })} />);
    const chip = host.querySelector(".agent-toolbar-more")!;
    expect(text(chip)).toBe("+2 more");
    expect(chip.getAttribute("title")).toBe("Read a.ts\nExecute pnpm lint");
  });

  it("hides the Esc hint while waiting, and marks the attention, stopping, done and failed tones", () => {
    const [current, setCurrent] = createSignal(view({ tone: "attention", label: "Waiting for your approval", stoppable: false }));
    const host = mount(() => <ToolActivityBar view={current()} />);
    const bar = () => host.querySelector(".sb-activity")!;
    expect(bar().classList.contains("attention")).toBe(true);
    expect(host.querySelector(".agent-toolbar-hint")).toBeNull();
    setCurrent(view({ tone: "stopping", label: "Stopping…", stoppable: false }));
    expect(text(host.querySelector(".agent-toolbar-label"))).toBe("Stopping…");
    setCurrent(view({ tone: "done" }));
    expect(bar().classList.contains("done")).toBe(true);
    expect(host.querySelector(".sb-spinner")).toBeNull();
    setCurrent(view({ tone: "failed", reason: "1 test failed" }));
    expect(bar().classList.contains("failed")).toBe(true);
    const reason = host.querySelector(".agent-toolbar-reason")!;
    expect(text(reason)).toBe("1 test failed");
    expect(reason.getAttribute("title")).toBe("1 test failed");
  });

  it("shows the running output tail with the full output toggle and the still-running line", () => {
    const host = mount(() => <ToolActivityBar view={view()} lines={["[INFO] Tests run: 12", "[INFO] BUILD"]} hidden={30} full={["all", "lines"]} still="Still running, no new output for 35s" />);
    expect(text(host.querySelector(".agent-toolbar-output"))).toContain("[INFO] BUILD");
    expect(text(host.querySelector(".agent-toolbar-still"))).toBe("Still running, no new output for 35s");
    const toggle = host.querySelector<HTMLButtonElement>(".agent-toolbar-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect([...host.querySelectorAll(".agent-toolbar-line")].map((line) => line.textContent)).toEqual(["all", "lines"]);
  });
});

describe("tool bar CSS", () => {
  const sidebar = readFileSync(resolve("src/styles/agent-sidebar.css"), "utf8");
  const block = (selector: string) => {
    const start = sidebar.indexOf(`${selector} {`);
    expect(start, `${selector} is defined`).toBeGreaterThanOrEqual(0);
    return sidebar.slice(start, sidebar.indexOf("}", start));
  };
  const section = sidebar.slice(sidebar.indexOf("/* Tool activity bar"));

  it("keeps the row one line high and the timer from shifting the layout", () => {
    expect(block(".agent-toolbar-row")).toMatch(/height:\s*30px/);
    expect(block(".agent-toolbar-elapsed")).toMatch(/tabular-nums/);
  });

  it("uses theme tokens only, never a literal colour", () => {
    expect(section.length).toBeGreaterThan(100);
    expect(section).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it("never sets its own margin or radius on the stacked bar, which the shared rule owns", () => {
    expect(block(".sb-activity.agent-toolbar")).not.toMatch(/(^|;|\s)(margin|border-radius)\s*:/);
  });
});
