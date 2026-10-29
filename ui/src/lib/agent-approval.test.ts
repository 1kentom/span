import { describe, expect, it } from "vitest";
import { approvalHeading, clampState, estimateLines } from "./agent-approval";

const LONG = "cd /workspace/projects/demo-app && pnpm install --frozen-lockfile && pnpm run build --filter web && pnpm exec vitest run --reporter dot";

describe("approvalHeading", () => {
  it("gives an execute request a short title and drops the agent title that repeats the command", () => {
    expect(approvalHeading({ kind: "execute", title: LONG, command: LONG })).toEqual({ heading: "Run command" });
    expect(approvalHeading({ kind: "execute", title: `\`${LONG}\``, command: LONG })).toEqual({ heading: "Run command" });
  });

  it("maps edit and read kinds and drops a title that only names a listed file", () => {
    expect(approvalHeading({ kind: "edit", title: "Edit src/a.ts", locations: ["src/a.ts"] })).toEqual({ heading: "Edit file" });
    expect(approvalHeading({ kind: "read", title: "read", command: "README.md" })).toEqual({ heading: "Read file" });
  });

  it("keeps an agent title that adds something as a body note", () => {
    expect(approvalHeading({ kind: "execute", title: "Publish the package", command: "pnpm publish" })).toEqual({ heading: "Run command", note: "Publish the package" });
  });

  it("falls back to a short agent title, else to Run command or a generic title, never to a long command", () => {
    expect(approvalHeading({ title: "Run ls" })).toEqual({ heading: "Run ls" });
    expect(approvalHeading({ title: LONG, command: LONG })).toEqual({ heading: "Run command" });
    expect(approvalHeading({ title: LONG })).toEqual({ heading: "Allow tool call", note: LONG });
    expect(approvalHeading({ title: "WebFetch" })).toEqual({ heading: "Web fetch" });
  });

  it("keeps the title of agent housekeeping as is", () => {
    expect(approvalHeading({ kind: "read", title: "resolve-prompt-1", internal: true })).toEqual({ heading: "resolve-prompt-1" });
  });
});

describe("clampState", () => {
  it("estimates wrapped lines", () => {
    expect(estimateLines("ls")).toBe(1);
    expect(estimateLines("a\nb\nc\nd")).toBe(4);
    expect(estimateLines("x".repeat(81), 40)).toBe(3);
  });

  it("offers no toggle for a short command and keeps it clamped", () => {
    expect(clampState({ text: "git status", expanded: false })).toEqual({ long: false, clamped: true, toggle: undefined });
    expect(clampState({ text: "git status", expanded: true }).clamped).toBe(true);
  });

  it("clamps a long command to three lines with Show more, and Show less once expanded", () => {
    expect(clampState({ text: LONG, expanded: false })).toEqual({ long: true, clamped: true, toggle: { label: "Show more", icon: "arrow-down4", expanded: false } });
    expect(clampState({ text: LONG, expanded: true })).toEqual({ long: true, clamped: false, toggle: { label: "Show less", icon: "arrow-up3", expanded: true } });
  });

  it("lets measured overflow win over the estimate", () => {
    expect(clampState({ text: LONG, expanded: false, measured: false }).long).toBe(false);
    expect(clampState({ text: "short", expanded: false, measured: true }).long).toBe(true);
  });
});
