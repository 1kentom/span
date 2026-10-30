// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DelegationCard } from "./DelegationCard";
import { deliverablesText, failureText, mergeTask } from "../../lib/agent-delegation";
import { mount, text } from "./test-utils";

const child = { connectionId: "c", sessionId: "s" };

describe("DelegationCard deliverables (ADR 0014)", () => {
  it("shows what the lead expects back only when it asked for something", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="running" deliverables={deliverablesText({ files: ["out/review.md", "src/a.rs"], format: "summary" })} />);
    expect(text(host.querySelector(".sb-delegation-deliverables"))).toBe("Expects Summary, files: out/review.md, src/a.rs");
    const plain = mount(() => <DelegationCard agent="Codex" status="running" deliverables={deliverablesText(undefined)} />);
    expect(plain.querySelector(".sb-delegation-deliverables")).toBeNull();
    expect(deliverablesText({ files: [], format: null })).toBeUndefined();
    expect(deliverablesText({ files: [], format: "diff" })).toBe("Diff");
  });
  it("keeps deliverables from the delegated event when a later poll omits them", () => {
    const first = mergeTask(undefined, { taskId: "task-1", child, deliverables: { files: ["a.md"], format: "json" } });
    const polled = mergeTask(first, { taskId: "task-1", child, status: "running", deliverables: null });
    expect(polled.deliverables).toEqual({ files: ["a.md"], format: "json" });
  });
  it("names the new failure reasons in words", () => {
    expect(failureText("permission_required")).toContain("permission request");
    expect(failureText("lost")).toBe("The child session is gone");
    expect(failureText("worktree_unavailable")).toBe("Worktrees are not available yet");
  });
});
