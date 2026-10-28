// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DecisionCard } from "./DecisionCard";
import { DelegationCard } from "./DelegationCard";
import { PermissionDock } from "./Docks";
import { key, mount, text } from "./test-utils";

describe("DecisionCard", () => {
  it("shows the choice and reason, with alternatives collapsed until asked for", () => {
    const host = mount(() => <DecisionCard by="Claude" chosen="Strip separators" why="Small and safe" alternatives={["Use realpath", "Leave as is"]} />);
    expect(text(host.querySelector(".sb-decision-eyebrow"))).toBe("Decision · Claude");
    expect(text(host)).toContain("Strip separators");
    expect(text(host)).toContain("Small and safe");
    const toggle = host.querySelector<HTMLButtonElement>(".sb-decision-toggle")!;
    expect(text(toggle)).toBe("2 alternatives considered");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".sb-decision-alts")).toBeNull();
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect([...host.querySelectorAll(".sb-decision-alts li")].map((li) => li.textContent)).toEqual(["Use realpath", "Leave as is"]);
    toggle.click();
    expect(host.querySelector(".sb-decision-alts")).toBeNull();
  });
  it("uses the singular for one alternative and omits the toggle for none", () => {
    expect(text(mount(() => <DecisionCard by="A" chosen="x" why="y" alternatives={["z"]} />).querySelector(".sb-decision-toggle"))).toBe("1 alternative considered");
    const none = mount(() => <DecisionCard by="A" chosen="x" why="" alternatives={[]} />);
    expect(none.querySelector(".sb-decision-toggle")).toBeNull();
  });
});

describe("DelegationCard", () => {
  it("shows a spinner and no result claims while running", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="running" />);
    expect(text(host.querySelector(".sb-delegation-head"))).toContain("Codex");
    expect(text(host.querySelector(".sb-delegation-status"))).toBe("Running");
    expect(host.querySelector(".sb-spinner")).not.toBeNull();
    expect(host.querySelector(".sb-delegation-note")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });
  it("shows completed with a success glyph", () => {
    const host = mount(() => <DelegationCard agent="Gemini" status="completed" />);
    expect(text(host.querySelector(".sb-delegation-status"))).toBe("Completed");
    expect(host.querySelector(".sb-spinner")).toBeNull();
    expect(host.querySelector(".sb-delegation-status .sb-ok")).not.toBeNull();
  });
  it("shows a failure with its reason text", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="failed" note="The task timed out. No reply" />);
    expect(host.querySelector(".sb-delegation.failed")).not.toBeNull();
    expect(text(host.querySelector(".sb-delegation-status"))).toBe("Failed");
    expect(text(host.querySelector(".sb-delegation-note"))).toBe("The task timed out. No reply");
  });
  it("shows cancelled and the waiting-for-approval line", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="cancelled" waiting />);
    expect(text(host.querySelector(".sb-delegation-status"))).toBe("Cancelled");
    expect(text(host.querySelector(".sb-delegation-wait"))).toBe("Needs your approval below");
  });
});

describe("PermissionDock for a delegated agent", () => {
  const options = [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }];
  it("names the delegated agent and answers only on a user action", () => {
    const choose = vi.fn();
    const host = mount(() => <PermissionDock title="Run pnpm test" from="Codex" options={options} onChoose={choose} />);
    expect(host.querySelector("section")!.getAttribute("aria-label")).toBe("Codex asks permission: Run pnpm test");
    expect(text(host.querySelector(".sb-dock-from"))).toBe("Codex (delegated agent) asks to run this");
    expect(choose).not.toHaveBeenCalled();
    key("y");
    expect(choose).not.toHaveBeenCalled();
    key("y", {}, host.querySelector(".sb-dock")!);
    expect(choose).toHaveBeenCalledWith("ok");
  });
  it("keeps the plain label for the lead's own request", () => {
    const host = mount(() => <PermissionDock title="Run ls" options={options} onChoose={() => undefined} />);
    expect(host.querySelector("section")!.getAttribute("aria-label")).toBe("Permission requested: Run ls");
    expect(host.querySelector(".sb-dock-from")).toBeNull();
  });
});
