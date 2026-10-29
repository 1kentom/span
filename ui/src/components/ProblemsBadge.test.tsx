// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ProblemsBadge } from "./ProblemsBadge";
import type { Problem } from "../lib/problems";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(d => d()); document.body.replaceChildren(); });
const err = (line: number, message = "bad"): Problem => ({ severity: "error", message, line, column: 1 });
const warn = (line: number): Problem => ({ severity: "warning", message: "careful", line, column: 1 });
function mount(problems: Problem[], extra: Partial<Parameters<typeof ProblemsBadge>[0]> = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const onJump = vi.fn(); const onAskAgent = vi.fn();
  disposers.push(render(() => <ProblemsBadge path="a.ts" problems={problems} checked={true} onJump={onJump} onAskAgent={onAskAgent} {...extra} />, host));
  return { host, onJump, onAskAgent };
}

describe("ProblemsBadge", () => {
  it("shows the count and the design tooltip, with stacked cards when severities are mixed", () => {
    const { host } = mount([err(1), err(2), warn(3), warn(4)]);
    expect(host.querySelector(".pb")?.textContent).toBe("4");
    expect(host.querySelector(".probs")?.getAttribute("title")).toBe("2 errors, 2 warnings. Open problems");
    expect(host.querySelectorAll(".sl").length).toBe(2);
  });
  it("is amber for warnings only and shows a tick when the file is clean and checked", () => {
    expect(mount([warn(1)]).host.querySelector(".pb.warn")).not.toBeNull();
    document.body.replaceChildren();
    expect(mount([]).host.querySelector(".pb-ok")).not.toBeNull();
    document.body.replaceChildren();
    expect(mount([], { checked: false }).host.querySelector(".probs")).toBeNull();
  });
  it("lists problems, jumps on click, and hands text to the agent", () => {
    const { host, onJump, onAskAgent } = mount([err(7, "Type error"), warn(9)]);
    (host.querySelector(".probs") as HTMLButtonElement).click();
    expect(host.querySelectorAll(".pw-item").length).toBe(2);
    (host.querySelector(".pw-main") as HTMLButtonElement).click();
    expect(onJump).toHaveBeenCalledWith(7, 1);
    (host.querySelector(".pw-agent.ghost") as HTMLButtonElement).click();
    expect(onAskAgent.mock.calls[0][0]).toContain("Explain this problem");
    (host.querySelector(".probs") as HTMLButtonElement).click();
    (host.querySelector(".pw-ai") as HTMLButtonElement).click();
    expect(onAskAgent.mock.calls[1][0]).toContain("Fix these problems.");
    expect(onAskAgent.mock.calls[1][0]).toContain("a.ts:9:1");
  });
  it("filters to errors and closes on Escape", () => {
    const { host } = mount([err(1), warn(2)]);
    (host.querySelector(".probs") as HTMLButtonElement).click();
    (host.querySelector(".mini[aria-label='Show errors only']") as HTMLButtonElement).click();
    expect(host.querySelectorAll(".pw-item").length).toBe(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.querySelector(".pw")).toBeNull();
  });
});
