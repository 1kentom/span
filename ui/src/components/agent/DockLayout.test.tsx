// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionDock, QuestionDock, UrlDock } from "./Docks";
import { mount } from "./test-utils";

const css = (name: string) => readFileSync(resolve(process.cwd(), "src/styles", name), "utf8");
const rule = (source: string, selector: string) => {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) return "";
  return source.slice(start, source.indexOf("}", start));
};

const many = Array.from({ length: 8 }, (_, index) => ({ id: `o${index}`, label: `Option ${index + 1}`, description: `Description ${index + 1}` }));

describe("QuestionDock layout", () => {
  it("keeps the step question, error and Skip inside the one dock card", () => {
    const host = mount(() => (
      <QuestionDock prompt="Please answer. (Recipient)" detail="Which session should I message?" error="That choice is not offered." options={many.slice(0, 3)} onAnswer={() => {}} onCancel={() => {}} />
    ));
    const docks = host.querySelectorAll(".sb-dock");
    expect(docks).toHaveLength(1);
    const dock = docks[0];
    expect(dock.querySelector(".sb-dock-question")?.textContent).toBe("Which session should I message?");
    expect(dock.querySelector("[role=alert]")?.textContent).toBe("That choice is not offered.");
    expect(dock.textContent).toContain("Skip question");
    // Nothing is rendered next to the card: the host holds the dock and nothing else.
    expect(host.children).toHaveLength(1);
    expect(dock.nextElementSibling).toBeNull();
  });

  it("draws the question above the options, in the scroll region", () => {
    const host = mount(() => <QuestionDock prompt="p" detail="Which one?" options={many.slice(0, 3)} onAnswer={() => {}} />);
    const scroll = host.querySelector(".sb-dock-scroll")!;
    const question = scroll.querySelector(".sb-dock-question")!;
    const firstOption = scroll.querySelector(".sb-q-option")!;
    expect(question.compareDocumentPosition(firstOption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("omits the question and error rows when there are none", () => {
    const host = mount(() => <QuestionDock prompt="p" options={many.slice(0, 1)} onAnswer={() => {}} />);
    expect(host.querySelector(".sb-dock-question")).toBeNull();
    expect(host.querySelector("[role=alert]")).toBeNull();
  });

  it("puts 8 options in a scroll region and keeps the answer row and Skip outside it", () => {
    const host = mount(() => <QuestionDock prompt="p" detail="Which one?" allowText options={many} onAnswer={() => {}} onCancel={() => {}} />);
    const dock = host.querySelector(".sb-dock")!;
    const scroll = dock.querySelector(".sb-dock-scroll")!;
    expect(scroll.querySelectorAll(".sb-q-option")).toHaveLength(8);
    const skip = [...dock.querySelectorAll("button")].find((button) => button.textContent === "Skip question")!;
    expect(skip).toBeTruthy();
    expect(scroll.contains(skip)).toBe(false);
    expect(scroll.contains(dock.querySelector("form"))).toBe(false);
    expect(skip.parentElement).toBe(dock);
  });
});

describe("dock CSS frame", () => {
  const sidebar = css("agent-sidebar.css");
  const agent = css("agent.css");

  it("caps the option list height and scrolls it internally", () => {
    const scroll = rule(sidebar, ".sb-dock-scroll");
    expect(scroll).toMatch(/max-height:\s*min\(/);
    expect(scroll).toMatch(/overflow-y:\s*auto/);
    expect(scroll).toMatch(/overflow-x:\s*hidden/);
  });

  it("makes every composer-adjacent dock the same compact tab as the activity bar", () => {
    // Docks share the one stacked-bar rule with the drawers and the activity bar: same inset, same top radius.
    const dock = rule(agent, ".agent-footer > :is(.sb-drawer, .sb-dock, .sb-activity)");
    expect(dock).toMatch(/margin:\s*0\s+\d+px;/);
    const composerRadius = Number(rule(agent, ".agent-composer").match(/border-radius:\s*(\d+)px;/)?.[1]);
    const tabRadius = Number(dock.match(/border-radius:\s*(\d+)px\s+\1px\s+0\s+0/)?.[1]);
    expect(tabRadius).toBeGreaterThan(0);
    expect(tabRadius).toBeLessThan(composerRadius);
  });

  it("caps a tall dock and scrolls inside it, so its answers never slide under the prompt box", () => {
    const dock = rule(agent, ".agent-footer > .sb-dock");
    expect(dock).toMatch(/max-height:/);
    expect(dock).toMatch(/overflow-y:\s*auto/);
  });

  it("does not style a separate strip beside the dock", () => {
    expect(agent).not.toContain("agent-dock-note");
    expect(agent).not.toContain("agent-dock-error");
  });

  it("puts every dock in the same border-box frame", () => {
    expect(sidebar).toMatch(/:is\([^)]*\.sb-dock[^)]*\) \*,/);
    expect(rule(sidebar, ".sb-dock")).not.toMatch(/overflow:\s*hidden/);
  });
});

describe("other docks share the frame", () => {
  it("renders permission and url docks as one sb-dock section with their actions inside", () => {
    const permission = mount(() => (
      <PermissionDock title="Run ls" options={[{ optionId: "a", name: "Allow", kind: "allow_once" }]} onChoose={() => {}} />
    ));
    expect(permission.children).toHaveLength(1);
    expect(permission.querySelector(".sb-dock .sb-actions")).not.toBeNull();
    const url = mount(() => <UrlDock title="Open" href="https://example.com" onOpen={() => {}} onCancel={() => {}} />);
    expect(url.children).toHaveLength(1);
    expect(url.querySelector(".sb-dock .sb-actions")).not.toBeNull();
  });
});
