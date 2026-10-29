// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PermissionDock, QuestionDock, UrlDock } from "./Docks";
import { key, mount, text } from "./test-utils";
import type { PermissionDetails } from "./types";

const LONG = "cd /workspace/projects/demo-app && pnpm install --frozen-lockfile && pnpm run build --filter web && pnpm exec vitest run --reporter dot && git status --short";
const options = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" },
];
const details = (patch: Partial<PermissionDetails> = {}): PermissionDetails => ({ kind: "execute", command: LONG, locations: [], diffs: [], moreDiffs: 0, internal: false, ...patch });
const flush = () => new Promise((done) => setTimeout(done, 0));
const count = (host: HTMLElement, needle: string) => host.textContent!.split(needle).length - 1;

describe("approval dock shows a long command once", () => {
  it("draws the command once, clamped, under a short title with the kind chip and mark in the header", () => {
    const host = mount(() => <PermissionDock title={LONG} brand={{ id: "claude", name: "Claude" }} details={details()} options={options} onChoose={() => undefined} />);
    expect(count(host, LONG)).toBe(1);
    expect(text(host.querySelector(".sb-dock-title"))).toBe("Run command");
    const head = host.querySelector(".sb-dock-head")!;
    expect(head.querySelector(".sb-kind")?.textContent).toBe("execute");
    expect(head.querySelector(".sb-dock-mark")).not.toBeNull();
    const block = host.querySelector(".sb-dock-command")!;
    expect(block.classList.contains("sb-clamped")).toBe(true);
    expect(block.getAttribute("title")).toBe(LONG);
    expect(block.querySelector(".sb-prompt")?.textContent).toBe("$ ");
    expect(host.querySelector(".sb-dock")!.getAttribute("aria-label")).toBe(`Permission requested: ${LONG}`);
  });

  it("expands and collapses in place with the chevron toggle", () => {
    const host = mount(() => <PermissionDock title={LONG} details={details()} options={options} onChoose={() => undefined} />);
    const toggle = host.querySelector<HTMLButtonElement>(".sb-clamp-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(text(toggle)).toBe("Show more");
    expect(toggle.querySelector(".icon, [class*=icon]")).not.toBeNull();
    toggle.click();
    const block = host.querySelector(".sb-dock-command")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(text(toggle)).toBe("Show less");
    expect(block.classList.contains("sb-expanded")).toBe(true);
    expect(block.classList.contains("sb-clamped")).toBe(false);
    expect(toggle.getAttribute("aria-controls")).toBe(block.id);
    toggle.click();
    expect(block.classList.contains("sb-clamped")).toBe(true);
  });

  it("offers no toggle for a short command but still offers Copy", () => {
    const host = mount(() => <PermissionDock title="Run command" command="git status" options={options} onChoose={() => undefined} />);
    expect(host.querySelector(".sb-clamp-toggle")).toBeNull();
    expect(host.querySelector("button[aria-label='Copy command']")).not.toBeNull();
  });

  it("copies the full command", async () => {
    const copied: string[] = [];
    const host = mount(() => <PermissionDock title={LONG} details={details()} options={options} onChoose={() => undefined} onCopy={(value) => void copied.push(value)} />);
    const button = host.querySelector<HTMLButtonElement>("button[aria-label='Copy command']")!;
    button.click();
    await flush();
    expect(copied).toEqual([LONG]);
    expect(text(button)).toBe("Copied");
  });

  it("says when copying failed", async () => {
    const host = mount(() => <PermissionDock title={LONG} details={details()} options={options} onChoose={() => undefined} onCopy={() => Promise.reject(new Error("denied"))} />);
    host.querySelector<HTMLButtonElement>("button[aria-label='Copy command']")!.click();
    await flush();
    expect(text(host.querySelector(".sb-copy-status"))).toBe("Could not copy");
  });

  it("keeps Y and N scoped to the dock, and the toggle and Copy never count as answers", () => {
    const chosen: string[] = [];
    const host = mount(() => <PermissionDock title={LONG} details={details()} options={options} onChoose={(id) => chosen.push(id)} onCopy={() => undefined} />);
    key("y");
    expect(chosen).toEqual([]);
    const dock = host.querySelector<HTMLElement>(".sb-dock")!;
    const toggle = host.querySelector<HTMLButtonElement>(".sb-clamp-toggle")!;
    toggle.focus();
    key("y", {}, toggle);
    key("N", {}, dock);
    toggle.click();
    expect(chosen).toEqual(["yes", "no"]);
    expect([...host.querySelectorAll(".sb-actions kbd")].map((node) => node.textContent)).toEqual(["Y", "N"]);
    expect([...host.querySelectorAll(".sb-actions .sb-btn")].map((node) => node.textContent?.replace(/[YN]$/, ""))).toEqual(["Yes", "No"]);
  });

  it("draws Tab in the hint as a key cap, keeping the hint text", () => {
    const host = mount(() => <PermissionDock title="Run ls" options={options} onChoose={() => undefined} />);
    const hint = host.querySelector(".sb-dock-tabhint")!;
    expect(hint.textContent).toBe("Press Tab to answer, or click an option");
    expect(hint.querySelector("kbd.sb-hint-key")?.textContent).toBe("Tab");
  });

  it("clamps a diff preview to three rows with its own toggle", () => {
    const lines = Array.from({ length: 8 }, (_, n) => ({ kind: "add" as const, n: n + 1, text: `line ${n + 1}` }));
    const host = mount(() => <PermissionDock title="Edit src/a.ts" details={details({ kind: "edit", command: undefined, diffs: [{ path: "src/a.ts", change: "modify", lines }] })} options={options} onChoose={() => undefined} />);
    expect(text(host.querySelector(".sb-dock-title"))).toBe("Edit file");
    const diff = host.querySelector(".sb-dock-diff")!;
    expect(diff.classList.contains("sb-clamped")).toBe(true);
    host.querySelector<HTMLButtonElement>(".sb-clamp-toggle")!.click();
    expect(diff.classList.contains("sb-expanded")).toBe(true);
  });
});

describe("question and URL docks clamp too", () => {
  const LABEL = "Use the managed Postgres instance in the staging account with read replicas and nightly snapshots enabled for every table";
  it("clamps a long question and long option labels, with the full text in the title, and digits still answer", () => {
    const answers: unknown[] = [];
    const host = mount(() => <QuestionDock prompt={`${LABEL}?`} options={[{ id: "pg", label: LABEL }, { id: "sq", label: "SQLite" }]} onAnswer={(answer) => answers.push(answer)} />);
    expect(host.querySelector(".sb-dock-prompt")?.classList.contains("sb-clamped")).toBe(true);
    const first = host.querySelector<HTMLButtonElement>(".sb-q-option")!;
    expect(first.title).toBe(LABEL);
    expect(first.querySelector(".sb-option-name")?.classList.contains("sb-clamp-2")).toBe(true);
    key("2", {}, host.querySelector(".sb-dock")!);
    expect(answers).toEqual([{ optionId: "sq" }]);
  });

  it("clamps the URL request text and the URL line", () => {
    const opened = vi.fn();
    const host = mount(() => <UrlDock title="Sign in" text={`${LABEL}. ${LABEL}. ${LABEL}.`} href="https://example.com/oauth/authorize?client_id=demo&scope=read" onOpen={opened} onCancel={() => undefined} />);
    expect(host.querySelector(".sb-dock .sb-body")?.classList.contains("sb-clamped")).toBe(true);
    expect(host.querySelector(".sb-url-clamp")).not.toBeNull();
  });
});

describe("dock styles", () => {
  const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const dock = strip(readFileSync(resolve("src/styles/agent-dock.css"), "utf8"));
  const sidebar = strip(readFileSync(resolve("src/styles/agent-sidebar.css"), "utf8"));
  const agent = strip(readFileSync(resolve("src/styles/agent.css"), "utf8"));
  const rule = (css: string, selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} is defined`).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };

  it("has no hard-coded hex colours", () => {
    expect(dock).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it("uses no purple fill or gold border on the docks and the stacked bar", () => {
    const purple = /accent-surface|accentDock|accent-fill|accent-border/;
    const gold = /warn-border|warn-surface|amberBorder|amberSurface|--sb-warning/;
    for (const body of [rule(sidebar, ".sb-dock"), rule(agent, ".agent-footer > :is(.sb-dock, .sb-activity)")]) {
      expect(body).not.toMatch(purple);
      expect(body).not.toMatch(gold);
      expect(body).toMatch(/var\(--sb-(raised|border)\)/);
    }
    expect(sidebar).not.toMatch(/\.attention\s*\{[^}]*(warn-border|warn-surface)/);
    expect(dock).not.toMatch(/warn-border|warn-surface|amberBorder|amberSurface/);
    expect(dock).not.toMatch(/accent-fill|accentDock/);
  });

  it("breaks anywhere only in the monospace command block", () => {
    const anywhere = [...dock.matchAll(/([^{}]+)\{[^}]*overflow-wrap:\s*anywhere/g)].map(([, selector]) => selector.trim());
    expect(anywhere).toEqual([".sb-dock .sb-code.sb-dock-command"]);
  });
});
