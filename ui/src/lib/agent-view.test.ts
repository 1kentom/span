import { describe, expect, it } from "vitest";
import type { FeedItem, PermissionEvent, ToolEvent } from "./agent-session";
import { buildBlocks, buildPrompt, changedFiles, classifyFailure, coerceAnswer, configViews, diffLines, formFields, levelOf, permissionDetails, saveName, slashGroups, splitCommandLine, stopView, toStep, warningParts, workSummary } from "./agent-view";
import { createFileAttachment, createPastedText, createWorkspaceFile } from "./attachments";

const tool = (id: string, patch: Partial<ToolEvent> = {}): ToolEvent => ({ kind: "tool", sessionId: "s", toolCallId: id, title: id, status: "completed", toolKind: "read", parentToolCallId: null, contentJson: "{}", ...patch });
const png = () => createFileAttachment({ name: "shot.png", mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), source: "pasted" });

describe("feed blocks", () => {
  it("groups consecutive tools, keeps subagent calls nested and puts a turn's proposals at its end", () => {
    const proposal = (id: number, path: string): FeedItem => ({ id, kind: "proposal", proposal: { id: `p${id}`, path, baseRevision: 1, hunks: [] } });
    const feed: FeedItem[] = [
      { id: 1, kind: "user", text: "go" },
      { id: 2, kind: "tool", event: tool("a") },
      { id: 3, kind: "tool", event: tool("child", { parentToolCallId: "a" }) },
      proposal(4, "src/a.ts"),
      { id: 5, kind: "tool", event: tool("b") },
      { id: 6, kind: "permission", event: { kind: "permission", sessionId: "s", requestId: "r", toolCallId: "b", title: "t", options: [] }, resolved: false },
      { id: 7, kind: "text", text: "done" },
      { id: 8, kind: "user", text: "next" },
    ];
    const blocks = buildBlocks(feed);
    expect(blocks.map((block) => block.key)).toEqual(["item-1", "work-2", "item-7", "changes-4", "item-8"]);
    const work = blocks[1];
    expect(work.type === "work" && work.tools.map((event) => event.toolCallId)).toEqual(["a", "b"]);
  });

  it("maps a diff tool call to a step with counts and a diff detail", () => {
    const step = toStep(
      tool("e", { toolKind: "edit", title: "Edit", contentJson: JSON.stringify({ content: [{ type: "diff", path: "/w/src/a.ts", oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" }] }) }),
      [],
      "/w",
    );
    expect(step).toMatchObject({ kind: "edit", verb: "Edit", status: "completed", delta: { add: 2, del: 1 } });
    expect(step.detail).toMatchObject({ type: "diff", path: "src/a.ts" });
  });

  it("maps an execute call to a terminal detail from the reported command and output", () => {
    const step = toStep(tool("x", { toolKind: "execute", status: "in_progress", contentJson: JSON.stringify({ rawInput: { command: ["npm", "test"] }, rawOutput: { stdout: "ok\n", stderr: "warn", exit_code: 1 } }) }), [tool("c", { status: "in_progress", title: "child" })]);
    expect(step.detail).toEqual({ type: "terminal", lines: [{ kind: "cmd", text: "npm test" }, { kind: "out", text: "ok" }, { kind: "out", text: "" }, { kind: "err", text: "warn" }], exitCode: 1, running: true });
    expect(step.children).toEqual([{ id: "c", kind: "read", verb: "child", target: undefined, meta: "in progress" }]);
  });

  it("adds no detail when the agent sent none", () => {
    expect(toStep(tool("r"), []).detail).toBeUndefined();
  });

  it("summarises work by kind", () => {
    expect(workSummary([toStep(tool("a"), []), toStep(tool("b"), []), toStep(tool("c", { toolKind: "edit", status: "in_progress" }), [])])).toEqual({ headline: "Working", counts: "2 reads, 1 edit" });
  });

  it("diffs only the changed region with context", () => {
    expect(diffLines("1\n2\n3\n4\n5", "1\n2\nX\n4\n5", 1)).toEqual([
      { kind: "ctx", n: 2, text: "2" },
      { kind: "del", n: 3, text: "3" },
      { kind: "add", n: 3, text: "X" },
      { kind: "ctx", n: 4, text: "4" },
    ]);
  });

  it("lists one changed file per proposal with line counts and state", () => {
    const files = changedFiles([{ id: 1, kind: "proposal", proposal: { id: "p1", path: "src/app/a.ts", baseRevision: 1, hunks: [{ id: "h", from: 0, to: 1, before: "x", after: "y\nz" }] }, resolution: "accepted" }]);
    expect(files).toEqual([{ path: "p1", name: "a.ts", dir: "src/app", add: 2, del: 1, state: "accepted" }]);
  });
});

describe("failures and stop reasons", () => {
  it("names real failure messages and keeps the raw text", () => {
    expect(classifyFailure({ phase: "connect", message: "Executable was not found: foo" })).toMatchObject({ kind: "missing-binary", text: "Executable was not found: foo" });
    expect(classifyFailure({ phase: "connect", message: "Agent negotiated an unsupported protocol version" }).kind).toBe("protocol");
    expect(classifyFailure({ phase: "auth", message: "bad token" })).toMatchObject({ kind: "auth", title: "Sign-in failed" });
    expect(classifyFailure({ phase: "prompt", message: "Internal error: 429 Too Many Requests" })).toMatchObject({ kind: "provider", level: "warn" });
    expect(classifyFailure({ phase: "exit", message: "Agent process disconnected" }).kind).toBe("exit");
    expect(classifyFailure({ phase: "connect", message: "Agent initialization timed out after 45 seconds" }).kind).toBe("timeout");
    expect(classifyFailure({ phase: "prompt", message: "Something odd" })).toMatchObject({ kind: "other", title: "Agent error" });
  });

  it("has stop cards only for the reasons that need one", () => {
    expect(stopView("max_tokens")?.title).toBe("Response hit the token limit");
    expect(stopView("refusal")).toBeDefined();
    expect(stopView("max_turn_requests")).toBeDefined();
    expect(stopView("end_turn")).toBeUndefined();
  });
});

describe("composer helpers", () => {
  it("splits a custom command line with quotes and escapes", () => {
    expect(splitCommandLine(`my-agent --acp "a b" 'c d' e\\ f`)).toEqual(["my-agent", "--acp", "a b", "c d", "e f"]);
    expect(splitCommandLine('agent ""')).toEqual(["agent", ""]);
    expect(() => splitCommandLine('agent "open')).toThrow(/unclosed quote/);
  });

  it("orders config options and reads the level without naming it", () => {
    const views = configViews([
      { id: "m", name: "Mode", category: "mode", currentValue: "a", groups: [{ name: "", choices: [{ value: "a", name: "A" }] }] },
      { id: "t", name: "Effort", category: "thought_level", currentValue: "y", groups: [{ name: "", choices: [{ value: "x", name: "X" }] }, { name: "More", choices: [{ value: "y", name: "Y" }, { value: "z", name: "Z" }] }] },
      { id: "o", name: "Model", category: "model", currentValue: "q", groups: [] },
    ]);
    expect(views.map((view) => view.id)).toEqual(["o", "t", "m"]);
    expect(views[1].choices.map((choice) => choice.value)).toEqual(["x", "y", "z"]);
    expect(levelOf(views[1])).toEqual({ index: 2, count: 3 });
  });

  it("filters agent and Span slash commands by prefix", () => {
    const groups = slashGroups("/re", "Agent", [{ name: "review", description: "Review", inputHint: "path" }, { name: "compact", description: "Compact", inputHint: null }], [{ name: "resume", description: "x" }, { name: "log", description: "y" }]);
    expect(groups).toEqual([
      { label: "Agent", items: [{ name: "/review", hint: "path", description: "Review", source: "agent" }] },
      { label: "Span", items: [{ name: "/resume", description: "x", source: "span" }] },
    ]);
  });

  it("reads form fields and coerces answers to their types", () => {
    const fields = formFields(JSON.stringify({ properties: { env: { type: "string", enum: ["a", "b"], enumNames: ["Alpha"] }, count: { type: "integer", title: "Count" }, ok: { type: "boolean" }, tags: { type: "array" } }, required: ["env"] }));
    expect(fields.map((field) => [field.key, field.type, field.required, field.options.map((option) => option.label)])).toEqual([
      ["env", "string", true, ["Alpha", "b"]],
      ["count", "integer", false, []],
      ["ok", "boolean", false, ["Yes", "No"]],
      ["tags", "unsupported", false, []],
    ]);
    expect(coerceAnswer(fields[0], { optionId: "b" })).toEqual({ value: "b" });
    expect(coerceAnswer(fields[1], { text: "3" })).toEqual({ value: 3 });
    expect(coerceAnswer(fields[1], { text: "3.5" })).toEqual({ error: "Count must be a whole number." });
    expect(coerceAnswer(fields[2], { optionId: "false" })).toEqual({ value: false });
  });
});

describe("prompt attachments", () => {
  const caps = { image: true, audio: false, embeddedContext: true };

  it("sends images and embedded text when the agent supports them", () => {
    const paste = createPastedText("x\n".repeat(20));
    const built = buildPrompt("hi", [png(), paste], caps, "/w");
    expect(built.blocked).toEqual([]);
    expect(built.text).toBe("hi");
    expect(built.attachments).toEqual([
      { kind: "image", data: "iVBORw==", mimeType: "image/png", uri: null },
      { kind: "resource", uri: `attachment:${encodeURIComponent(paste.name)}`, mimeType: "text/plain", text: paste.text, blob: null },
    ]);
  });

  it("blocks images for agents without the image capability and inlines text without embedded context", () => {
    const paste = createPastedText("const a = 1;\n".repeat(12));
    const built = buildPrompt("look", [png(), paste], { image: false, audio: false, embeddedContext: false });
    expect(built.blocked.map((entry) => entry.reason)).toEqual(["This agent does not accept images."]);
    expect(built.attachments).toEqual([]);
    expect(built.text).toContain("look\n\nAttached:\n\nPasted text, 13 lines:\n```\nconst a = 1;");
  });

  it("links workspace files and blocks audio even when the agent claims audio support", () => {
    const audio = createFileAttachment({ name: "a.wav", mime: "audio/wav", bytes: new Uint8Array([1]), source: "picked" });
    const built = buildPrompt("", [createWorkspaceFile("docs/My File.md"), audio], { ...caps, audio: true }, "/w");
    expect(built.attachments).toEqual([{ kind: "resourceLink", uri: "file:///w/docs/My%20File.md", name: "My File.md", mimeType: "text/markdown", description: null }]);
    expect(built.blocked.map((entry) => entry.reason)).toEqual(["Span cannot send audio to agents yet."]);
  });
});

describe("workspaceRelative and toolLocations", () => {
  it("accepts paths inside the root and rejects everything that leaves it", async () => {
    const { workspaceRelative } = await import("./agent-view");
    expect(workspaceRelative("/w", "/w/src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelative("/w/", "src/./a.ts")).toBe("src/a.ts");
    expect(workspaceRelative("/w", "/w/src/../b.ts")).toBe("b.ts");
    expect(workspaceRelative("C:\\w", "C:\\w\\src\\a.ts")).toBe("src/a.ts");
    for (const bad of ["/etc/passwd", "/wx/a.ts", "/w", "/w/", "../a.ts", "/w/../a.ts", "src/../../a.ts", "", "file:///w/a.ts", "/w/a\0.ts"]) expect(workspaceRelative("/w", bad), bad).toBeUndefined();
    expect(workspaceRelative(undefined, "/w/a.ts")).toBeUndefined();
  });
  it("reads path and line from tool locations and skips malformed entries", async () => {
    const { toolLocations } = await import("./agent-view");
    expect(toolLocations(JSON.stringify({ locations: [{ path: "/w/a.ts", line: 4 }, { path: "b.ts", line: -1 }, { line: 3 }, null, { path: " " }] }))).toEqual([{ path: "/w/a.ts", line: 4 }, { path: "b.ts", line: undefined }]);
    expect(toolLocations("not json")).toEqual([]);
    expect(toolLocations("{}")).toEqual([]);
  });
});

describe("toStep click targets", () => {
  it("opens a located tool target at its line, and a diff with unknown line context at the top of the file", () => {
    const open = (path: string, line?: number) => calls.push([path, line]);
    const calls: [string, number | undefined][] = [];
    const read = toStep(tool("r", { contentJson: JSON.stringify({ locations: [{ path: "/w/a.ts", line: 9 }] }) }), [], "/w", open);
    read.onOpen!();
    expect(calls).toEqual([["/w/a.ts", 9]]);
    expect(toStep(tool("n"), [], "/w", open).onOpen).toBeUndefined();
    const edit = toStep(tool("e", { toolKind: "edit", contentJson: JSON.stringify({ content: [{ type: "diff", path: "/w/b.ts", oldText: "a\nb\nc", newText: "a\nB\nc" }] }) }), [], "/w", open);
    expect(edit.detail?.type === "diff" && edit.detail.onOpen).toBeTruthy();
    if (edit.detail?.type === "diff") edit.detail.onOpen!();
    // oldText may be only the replaced snippet and no location gives a line, so the diff does not claim line 2.
    expect(calls.at(-1)).toEqual(["b.ts", undefined]);
  });
});

describe("diff line numbers only when the line context is known", () => {
  const edit = (oldText: string | null, newText: string, locations?: { path: string; line?: number }[]) =>
    tool("e", { toolKind: "edit", locations, diffs: [{ path: "/w/src/a.ts", resolved: true, change: oldText ? "modify" : "add", oldText, newText }] } as Partial<ToolEvent>);
  it("hides gutter numbers and opens at the first location line when the old text may be only a snippet", () => {
    const calls: [string, number | undefined][] = [];
    const step = toStep(edit("const b = 1;\n", "const b = 2;\n", [{ path: "/w/src/a.ts", line: 40 }]), [], "/w", (path, line) => calls.push([path, line]));
    expect(step.detail?.type).toBe("diff");
    if (step.detail?.type !== "diff") return;
    expect(step.detail.lines.length).toBeGreaterThan(0);
    expect(step.detail.lines.every((line) => line.n === undefined)).toBe(true);
    step.detail.onOpen!();
    expect(calls).toEqual([["src/a.ts", 40]]);
  });
  it("opens a snippet diff without a line when no location line is known", () => {
    const calls: [string, number | undefined][] = [];
    const step = toStep(edit("x\n", "y\n"), [], "/w", (path, line) => calls.push([path, line]));
    if (step.detail?.type !== "diff") throw new Error("no diff");
    expect(step.detail.lines.every((line) => line.n === undefined)).toBe(true);
    step.detail.onOpen!();
    expect(calls).toEqual([["src/a.ts", undefined]]);
  });
  it("keeps numbers for a new file and when the location line matches the first changed line", () => {
    const added = toStep(edit(null, "one\ntwo"), [], "/w", () => undefined);
    if (added.detail?.type !== "diff") throw new Error("no diff");
    expect(added.detail.lines.map((line) => line.n)).toEqual([1, 2]);
    const matched = toStep(edit("a\nb\nc\n", "a\nB\nc\n", [{ path: "/w/src/a.ts", line: 2 }]), [], "/w", () => undefined);
    if (matched.detail?.type !== "diff") throw new Error("no diff");
    expect(matched.detail.lines.find((line) => line.kind === "add")?.n).toBe(2);
  });
  it("applies the same rule to permission previews", () => {
    const event = { kind: "permission", sessionId: "s", requestId: "r", toolCallId: "t", title: "Edit", options: [], locations: [{ path: "/w/src/a.ts", line: 40 }], diffs: [{ path: "/w/src/a.ts", resolved: true, change: "modify", oldText: "b\n", newText: "B\n" }] } as unknown as PermissionEvent;
    const calls: [string, number | undefined][] = [];
    const details = permissionDetails(event, "/w", (path, line) => calls.push([path, line]));
    expect(details.diffs[0].lines.every((line) => line.n === undefined)).toBe(true);
    details.diffs[0].onOpen!();
    expect(calls).toEqual([["/w/src/a.ts", 40]]);
  });
});

describe("paths outside the workspace", () => {
  it("renders step targets and diff headers outside the root as plain text, with no open action", () => {
    const open = () => undefined;
    expect(toStep(tool("r", { locations: [{ path: "/etc/passwd", line: 1 }] } as Partial<ToolEvent>), [], "/w", open).onOpen).toBeUndefined();
    expect(toStep(tool("u", { locations: [{ path: "/w/../secret.txt" }] } as Partial<ToolEvent>), [], "/w", open).onOpen).toBeUndefined();
    const diff = toStep(tool("e", { toolKind: "edit", diffs: [{ path: "/etc/hosts", resolved: true, change: "modify", oldText: "a", newText: "b" }] } as Partial<ToolEvent>), [], "/w", open);
    expect(diff.detail?.type === "diff" && diff.detail.onOpen).toBeFalsy();
    expect(toStep(tool("in", { locations: [{ path: "/w/a.ts" }] } as Partial<ToolEvent>), [], "/w", open).onOpen).toBeDefined();
  });
});

describe("saveName", () => {
  const named = (name: string) => saveName({ ...createPastedText("x"), name });
  it("replaces every character core save_attachment rejects", () => {
    expect(named("a?b.png")).toBe("a-b.png");
    expect(named('<a>:b"c|d*e.txt')).toBe("-a--b-c-d-e.txt");
    expect(named("tab\there.md")).toBe("tab-here.md");
    expect(named("dir/sub\\x.md")).toBe("dir-sub-x.md");
  });
  it("drops trailing dots and spaces and avoids reserved Windows names and protected folders", () => {
    expect(named("notes. ")).toBe("notes.txt");
    expect(named("report.pdf. ")).toBe("report.pdf");
    expect(named("CON.txt")).toBe("_CON.txt");
    expect(named("com1.log")).toBe("_com1.log");
    expect(named(".git")).toBe("_.git");
    expect(named("...")).toBe("attachment.txt");
  });
  it("keeps ordinary names and adds .txt to pasted text without an extension", () => {
    expect(named("shot.png")).toBe("shot.png");
    expect(named("Pasted text, 31 lines")).toBe("Pasted text, 31 lines.txt");
  });
});

describe("permission waits in the step view", () => {
  it("shows the OpenCode read as pending while its permission is open, then running once answered", async () => {
    const { initialAgentState, reduceAgentEvent } = await import("./agent-session");
    const events = [
      { kind: "session", sessionId: "s" },
      tool("t1", { status: "pending", title: "read" }),
      tool("t1", { status: "in_progress", title: "read" }),
      { kind: "permission", sessionId: "s", requestId: "r1", toolCallId: "t1", title: "present.txt", options: [] },
    ] as const;
    const waiting = events.reduce((state, event) => reduceAgentEvent(state, event as never), initialAgentState(true));
    const stepOf = (state: typeof waiting) => {
      const item = state.feed.find((entry) => entry.kind === "tool");
      return toStep((item as Extract<FeedItem, { kind: "tool" }>).event, []);
    };
    expect(stepOf(waiting).status).toBe("pending");
    const answered = reduceAgentEvent(waiting, { kind: "permissionResolved", sessionId: "s", requestId: "r1" });
    expect(stepOf(answered).status).toBe("in_progress");
  });
});

describe("warningParts", () => {
  it("splits at the first sentence and shortens home folders", () => {
    const parts = warningParts("Codex is ignoring 2 unrecognized configuration settings. Check for typos.", "user (/Users/someone/.codex/config.toml): `a` is ignored.");
    expect(parts.summary).toBe("Codex is ignoring 2 unrecognized configuration settings.");
    expect(parts.detail).toContain("~/.codex/config.toml");
    expect(parts.detail).not.toContain("/Users/");
  });
  it("keeps a single sentence whole", () => {
    expect(warningParts("Only one sentence.")).toEqual({ summary: "Only one sentence." });
  });
});
