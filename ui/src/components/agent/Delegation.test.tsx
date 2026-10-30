// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("shows the child's model next to the agent name only when reported", () => {
    const host = mount(() => <DelegationCard agent="OpenCode" model="Claude Haiku 4.5" status="running" />);
    const head = host.querySelector(".sb-delegation-head")!;
    expect(text(head.querySelector(".sb-delegation-name"))).toBe("OpenCode");
    expect(text(head.querySelector(".sb-delegation-model"))).toBe("Claude Haiku 4.5");
    expect(host.querySelector(".sb-delegation")!.getAttribute("aria-label")).toBe("Delegated to OpenCode (Claude Haiku 4.5): Running");
    const plain = mount(() => <DelegationCard agent="OpenCode" status="running" />);
    expect(plain.querySelector(".sb-delegation-model")).toBeNull();
    expect(plain.querySelector(".sb-delegation")!.getAttribute("aria-label")).toBe("Delegated to OpenCode: Running");
  });
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
  it("shows an after-the-fact token overrun as a quiet note on a completed card, not a failure", () => {
    const host = mount(() => <DelegationCard agent="Claude Agent" status="completed" budget="1 turn, 31,690 tokens in context" budgetNote="Used about 400 tokens, over the 300 token budget" />);
    expect(text(host.querySelector(".sb-delegation-status"))).toBe("Completed");
    expect(host.querySelector(".sb-delegation.failed")).toBeNull();
    expect(host.querySelector(".sb-delegation-note")).toBeNull();
    expect(text(host.querySelector(".sb-delegation-budget-note"))).toBe("Used about 400 tokens, over the 300 token budget");
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

describe("DelegationCard details", () => {
  afterEach(() => vi.useRealTimers());
  const artifact = (path: string) => ({ path, mimeType: "text/plain", bytes: 1, sha256: "x", uri: `file:///w/${path}`, source: "disk" });

  it("shows nothing extra when the backend reported nothing", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="completed" />);
    for (const name of ["elapsed", "progress", "result", "files", "budget"]) expect(host.querySelector(`.sb-delegation-${name}`)).toBeNull();
  });
  it("shows finish minus start as the elapsed time for a finished task", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="completed" startedAtMs={1000} finishedAtMs={76000} />);
    expect(text(host.querySelector(".sb-delegation-elapsed"))).toBe("Elapsed 1m 15s");
  });
  it("counts live elapsed time while running, then stops", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const host = mount(() => <DelegationCard agent="Codex" status="running" startedAtMs={4000} />);
    expect(text(host.querySelector(".sb-delegation-elapsed"))).toBe("Elapsed 6s");
    vi.advanceTimersByTime(3000);
    expect(text(host.querySelector(".sb-delegation-elapsed"))).toBe("Elapsed 9s");
  });
  it("shows progress while running but not once finished", () => {
    const running = mount(() => <DelegationCard agent="Codex" status="running" progressText="Reading files" />);
    expect(text(running.querySelector(".sb-delegation-progress"))).toBe("Reading files");
    const done = mount(() => <DelegationCard agent="Codex" status="completed" progressText="Reading files" />);
    expect(done.querySelector(".sb-delegation-progress")).toBeNull();
  });
  it("shows the result as bounded plain text, never as HTML", () => {
    const html = "<img src=x onerror=alert(1)><b>bold</b>";
    const host = mount(() => <DelegationCard agent="Codex" status="completed" resultSummary={html + "y".repeat(900)} />);
    const result = host.querySelector(".sb-delegation-result")!;
    expect(result.querySelector("img, b")).toBeNull();
    expect(result.textContent!.startsWith(html)).toBe(true);
    expect(result.textContent!.length).toBeLessThanOrEqual(603);
    expect(result.textContent!.endsWith("...")).toBe(true);
  });
  it("lists artifacts as links that open the workspace-relative path on click only", () => {
    const open = vi.fn(() => true);
    const host = mount(() => <DelegationCard agent="Codex" status="completed" artifacts={[artifact("out/a.md"), artifact("img/b.png")]} onOpenArtifact={open} />);
    const links = [...host.querySelectorAll<HTMLButtonElement>(".sb-delegation-files button")];
    expect(links.map((link) => link.textContent)).toEqual(["out/a.md", "img/b.png"]);
    expect(open).not.toHaveBeenCalled();
    links[1].click();
    expect(open).toHaveBeenCalledWith("img/b.png");
    expect(host.querySelector("[role=alert]")).toBeNull();
  });
  it("says so inline when a path will not open", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="completed" artifacts={[artifact("../etc/passwd")]} onOpenArtifact={() => false} />);
    host.querySelector<HTMLButtonElement>(".sb-delegation-files button")!.click();
    expect(text(host.querySelector("[role=alert]"))).toBe("Could not open ../etc/passwd");
  });
  it("shows the budget used when given", () => {
    const host = mount(() => <DelegationCard agent="Codex" status="completed" budget="2 turns, 1,500 tokens" />);
    expect(text(host.querySelector(".sb-delegation-budget"))).toBe("Used 2 turns, 1,500 tokens");
  });
});

describe("DelegationCard cancel", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  it("offers Cancel on a running task and calls the handler with the task id on click only", async () => {
    const cancel = vi.fn(async () => undefined);
    const host = mount(() => <DelegationCard agent="Codex" status="running" taskId="t7" onCancel={cancel} />);
    const button = host.querySelector<HTMLButtonElement>(".sb-delegation-actions button")!;
    expect(button.textContent).toBe("Cancel");
    await settle();
    expect(cancel).not.toHaveBeenCalled();
    button.click();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("t7");
  });
  it("is disabled while pending and ignores a second click", async () => {
    let finish!: () => void;
    const cancel = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const host = mount(() => <DelegationCard agent="Codex" status="running" taskId="t7" onCancel={cancel} />);
    const button = host.querySelector<HTMLButtonElement>(".sb-delegation-actions button")!;
    button.click();
    expect(button.disabled).toBe(true);
    button.click();
    expect(cancel).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    expect(button.disabled).toBe(false);
  });
  it("shows a refusal inline and lets the user try again", async () => {
    const cancel = vi.fn(async () => { throw new Error("task already finished"); });
    const host = mount(() => <DelegationCard agent="Codex" status="running" taskId="t7" onCancel={cancel} />);
    host.querySelector<HTMLButtonElement>(".sb-delegation-actions button")!.click();
    await settle();
    expect(text(host.querySelector(".sb-delegation-error"))).toBe("Could not cancel: task already finished");
    expect(host.querySelector<HTMLButtonElement>(".sb-delegation-actions button")!.disabled).toBe(false);
  });
  it("shows no Cancel on a finished task or without a handler", () => {
    for (const status of ["completed", "failed", "cancelled", "unknown"] as const) {
      const host = mount(() => <DelegationCard agent="Codex" status={status} taskId="t7" onCancel={async () => undefined} />);
      expect(host.querySelector(".sb-delegation-actions")).toBeNull();
    }
    expect(mount(() => <DelegationCard agent="Codex" status="running" taskId="t7" />).querySelector(".sb-delegation-actions")).toBeNull();
  });
});

describe("opening the child session from its card", () => {
  afterEach(() => vi.useRealTimers());
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  const transcript = (text: string, status = "completed") => ({
    text,
    task: { taskId: "task-1", lead: { connectionId: "c1", sessionId: "lead" }, child: { connectionId: "c2", sessionId: "child-session-1234" }, agentName: "Codex", status, stopReason: null, reason: null, detail: null, startedAtMs: 1, finishedAtMs: 2, progressText: null, resultSummary: null, artifacts: [], budgetUsed: { turns: 1, tokens: null, contextSize: null, cost: null, currency: null, elapsedSeconds: 1 } },
  }) as never;

  it("offers Open session only with a task id and a reader, and not while starting", () => {
    const load = vi.fn();
    expect(mount(() => <DelegationCard agent="Codex" status="completed" onOpenSession={load} />).querySelector(".sb-delegation-open")).toBeNull();
    expect(mount(() => <DelegationCard agent="Codex" status="completed" taskId="task-1" />).querySelector(".sb-delegation-open")).toBeNull();
    expect(mount(() => <DelegationCard agent="Codex" status="starting" taskId="task-1" onOpenSession={load} />).querySelector(".sb-delegation-open")).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("opens the child's full text read only, and closes again", async () => {
    const load = vi.fn(async () => transcript("Wrote **out.txt** and checked it."));
    const host = mount(() => <DelegationCard agent="Codex" status="completed" taskId="task-1" onOpenSession={load} />);
    const toggle = host.querySelector<HTMLButtonElement>(".sb-delegation-open")!;
    expect(text(toggle)).toBe("Open session");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await flush();
    expect(load).toHaveBeenCalledWith("task-1");
    const view = host.querySelector(".sb-child-session")!;
    expect(view.getAttribute("aria-label")).toBe("Codex session");
    expect(text(view.querySelector(".sb-child-session-head"))).toContain("Session child-sessio on Codex. Read only");
    expect(text(view.querySelector(".sb-child-session-text"))).toBe("Wrote **out.txt** and checked it.");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(text(toggle)).toBe("Close session");
    toggle.click();
    expect(host.querySelector(".sb-child-session")).toBeNull();
  });

  it("renders through the given renderer and says when nothing was written", async () => {
    const host = mount(() => <DelegationCard agent="Codex" status="completed" taskId="task-1" onOpenSession={async () => transcript("  ")} renderText={(value) => <em>{value}</em>} />);
    host.querySelector<HTMLButtonElement>(".sb-delegation-open")!.click();
    await flush();
    expect(text(host.querySelector(".sb-child-session"))).toContain("The agent wrote no text for this task.");
    const rendered = mount(() => <DelegationCard agent="Codex" status="completed" taskId="task-1" onOpenSession={async () => transcript("done")} renderText={(value) => <em>{value}</em>} />);
    rendered.querySelector<HTMLButtonElement>(".sb-delegation-open")!.click();
    await flush();
    expect(rendered.querySelector(".sb-child-session-text em")?.textContent).toBe("done");
  });

  it("refreshes while the task runs and shows a read failure", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const load = vi.fn(async () => { calls += 1; if (calls === 3) throw new Error("Unknown task"); return transcript(`part ${calls}`, "running"); });
    const host = mount(() => <DelegationCard agent="Codex" status="running" taskId="task-1" onOpenSession={load} />);
    host.querySelector<HTMLButtonElement>(".sb-delegation-open")!.click();
    await flush();
    expect(text(host.querySelector(".sb-child-session-text"))).toBe("part 1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(text(host.querySelector(".sb-child-session-text"))).toBe("part 2");
    await vi.advanceTimersByTimeAsync(2000);
    expect(text(host.querySelector(".sb-child-session [role=alert]"))).toBe("Could not open the session: Unknown task");
    expect(load).toHaveBeenCalledTimes(3);
  });
});
