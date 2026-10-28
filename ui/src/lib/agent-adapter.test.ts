import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentHint, PermissionOption } from "../bindings";
import { HINT_TEXT, hintText, splitCode } from "./agent-hint-text";
import { composerHints } from "./agent-hints";
import { toolTarget } from "./agent-feed";
import { initialAgentState, mergeTool, openPermission, reduceAgentEvent, turnTokens, type AgentState, type PermissionEvent, type ToolEvent } from "./agent-session";
import { boundedInput, noticeView, permissionDetails, stopView, toStep, toolImages, workSummary } from "./agent-view";

const apply = (events: AgentEvent[], state: AgentState = initialAgentState(true)) => events.reduce(reduceAgentEvent, state);
const live = () => apply([{ kind: "session", sessionId: "s1" }]);
const tool = (patch: Partial<ToolEvent> = {}): ToolEvent => ({ kind: "tool", sessionId: "s1", toolCallId: "t1", title: null, status: null, toolKind: null, parentToolCallId: null, contentJson: "{}", ...patch }) as ToolEvent;
const permission = (patch: Record<string, unknown> = {}): PermissionEvent => ({ kind: "permission", sessionId: "s1", requestId: "r1", toolCallId: "t1", title: "Edit file", options: [], ...patch }) as PermissionEvent;
const text = (kind: "text" | "thought", value: string, extra: Record<string, unknown> = {}): AgentEvent => ({ kind, sessionId: "s1", text: value, ...extra }) as AgentEvent;
const ALL_HINTS: AgentHint[] = ["turnLimitOrLoop", "noOutputStreamed", "outputUnavailable", "runOpencodeAuthLogin", "retrying", "compacting", "toolPending"];

describe("hint table", () => {
  it("has copy for every backend hint and none for unknown ids", () => {
    for (const hint of ALL_HINTS) expect(hintText(hint), hint).toBeTruthy();
    expect(Object.keys(HINT_TEXT).sort()).toEqual([...ALL_HINTS].sort());
    expect(hintText("somethingNew")).toBeUndefined();
    expect(hintText(undefined)).toBeUndefined();
    expect(hintText("toString")).toBeUndefined();
  });
  it("words the three named conditions", () => {
    expect(hintText("outputUnavailable")).toBe("Output not available from agent");
    expect(hintText("noOutputStreamed")).toBe("Command ran, no output streamed");
    expect(hintText("turnLimitOrLoop")).toBe("Turn limit or loop detected");
  });
  it("splits backticked commands into code parts", () => {
    expect(splitCode(HINT_TEXT.runOpencodeAuthLogin)).toEqual([
      { text: "Run ", code: false },
      { text: "opencode auth login", code: true },
      { text: " in a terminal, then retry", code: false },
    ]);
    expect(splitCode("odd ` tick")).toEqual([{ text: "odd ` tick", code: false }]);
  });
});

describe("message blocks", () => {
  it("appends consecutive chunks of one message and starts a new bubble on newBlock", () => {
    const state = apply([text("text", "Hel", { messageId: "m1" }), text("text", "lo", { messageId: "m1" }), text("text", "Second", { messageId: "m1", newBlock: true })], live());
    expect(state.feed.map((item) => item.kind === "text" && item.text)).toEqual(["Hello", "Second"]);
  });
  it("starts a new bubble when the message id changes, even without newBlock", () => {
    const state = apply([text("text", "a", { messageId: "m1" }), text("text", "b", { messageId: "m2" })], live());
    expect(state.feed).toHaveLength(2);
    expect(state.feed[1]).toMatchObject({ text: "b", messageId: "m2" });
  });
  it("starts a new thought block on newBlock and keeps plain chunks together", () => {
    const state = apply([text("thought", "one"), text("thought", " more"), text("thought", "**Next**", { newBlock: true })], live());
    expect(state.feed.map((item) => item.kind === "thought" && item.text)).toEqual(["one more", "**Next**"]);
  });
});

describe("notices", () => {
  const notice = (patch: Record<string, unknown>): AgentEvent => ({ kind: "notice", sessionId: "s1", severity: "warning", title: "Retrying", description: null, ...patch }) as AgentEvent;
  it("updates a notice with the same noticeId in place and clears it", () => {
    let state = apply([notice({ noticeId: "retry", description: "attempt 1", hint: "retrying" })], live());
    const id = state.feed[0].id;
    state = reduceAgentEvent(state, notice({ noticeId: "retry", description: "attempt 2", hint: "retrying" }));
    expect(state.feed).toHaveLength(1);
    expect(state.feed[0]).toMatchObject({ id, kind: "notice", description: "attempt 2", noticeId: "retry", hint: "retrying" });
    state = reduceAgentEvent(state, { kind: "noticeCleared", sessionId: "s1", noticeId: "retry" });
    expect(state.feed).toEqual([]);
  });
  it("does not merge notices without an id and ignores clearing an unknown id", () => {
    const state = apply([notice({}), notice({}), { kind: "noticeCleared", sessionId: "s1", noticeId: "nope" }], live());
    expect(state.feed).toHaveLength(2);
  });
  it("fills the missing title or body from the hint copy without repeating it", () => {
    expect(noticeView({ title: "", hint: "retrying" })).toEqual({ title: "Retrying", description: undefined });
    expect(noticeView({ title: "Retrying", hint: "retrying" })).toEqual({ title: "Retrying", description: undefined });
    expect(noticeView({ title: "Model error", hint: "retrying" })).toEqual({ title: "Model error", description: "Retrying" });
    expect(noticeView({ title: "Model error", description: "502", hint: "retrying" })).toEqual({ title: "Model error", description: "502" });
  });
});

describe("replayed user attachments", () => {
  it("turns non-text blocks into chips and merges them into the open user turn", () => {
    const state = apply(
      [
        { kind: "user", sessionId: "s1", text: "look", attachments: [{ kind: "image", name: null, uri: null, mimeType: "image/png" }] },
        { kind: "user", sessionId: "s1", text: "", attachments: [{ kind: "resourceLink", uri: "file:///w/My%20notes.md", name: null, mimeType: null }] },
      ] as AgentEvent[],
      live(),
    );
    expect(state.feed).toHaveLength(1);
    const user = state.feed[0];
    expect(user.kind === "user" && user.attachments?.map((item) => [item.kind, item.name])).toEqual([["image", "Image"], ["file", "My notes.md"]]);
  });
  it("never records a path or bytes for a replayed marker, so nothing from the agent is read", () => {
    const state = apply([{ kind: "user", sessionId: "s1", text: "x", attachments: [{ kind: "resource", uri: "file:///etc/passwd", name: "passwd", mimeType: "text/plain" }] }] as AgentEvent[], live());
    const item = state.feed[0].kind === "user" ? state.feed[0].attachments![0] : undefined;
    expect(item?.path).toBeUndefined();
    expect(item?.bytes).toBeUndefined();
  });
});

describe("complete usage fallback", () => {
  const complete = (patch: Record<string, unknown>): AgentEvent => ({ kind: "complete", sessionId: "s1", stopReason: "end_turn", ...patch }) as AgentEvent;
  it("reads turn tokens when no usage update was seen", () => {
    expect(reduceAgentEvent(live(), complete({ usage: { totalTokens: 1200 } })).turnUsage).toEqual({ tokens: 1200 });
    expect(reduceAgentEvent(live(), complete({ usage: { inputTokens: 10, outputTokens: 5 } })).turnUsage).toEqual({ tokens: 15 });
    expect(reduceAgentEvent(live(), complete({ usage: { total_tokens: 7 } })).turnUsage).toEqual({ tokens: 7 });
  });
  it("ignores it once a usage update gave the real context size, and ignores unreadable usage", () => {
    const seen = apply([{ kind: "usage", sessionId: "s1", used: 5, size: 100, costAmount: null, costCurrency: null }, complete({ usage: { totalTokens: 9 } })], live());
    expect(seen.turnUsage).toBeUndefined();
    expect(seen.usage).toMatchObject({ used: 5, size: 100 });
    expect(reduceAgentEvent(live(), complete({ usage: "lots" })).turnUsage).toBeUndefined();
    expect(turnTokens({ totalTokens: -1 })).toBeUndefined();
    expect(turnTokens(null)).toBeUndefined();
  });
  it("turns a silent slash command into a note and a loop hint into a stop card", () => {
    expect(reduceAgentEvent(live(), complete({ hint: "noOutputStreamed" })).feed).toMatchObject([{ kind: "note", text: "Command ran, no output streamed" }]);
    const stopped = reduceAgentEvent(live(), complete({ stopReason: "max_turn_requests", hint: "turnLimitOrLoop" }));
    expect(stopped.feed).toMatchObject([{ kind: "stop", reason: "max_turn_requests", hint: "turnLimitOrLoop" }]);
    expect(stopView("max_turn_requests", "turnLimitOrLoop")?.title).toBe("Turn limit or loop detected");
    expect(stopView("max_turn_requests")?.title).toBe("Turn request limit reached");
  });
});

describe("authRequired hint", () => {
  it("keeps the backend hint with the sign-in state", () => {
    const state = apply([{ kind: "authRequired", message: "needs login", authMethods: [], hint: "runOpencodeAuthLogin" }]);
    expect(state.auth?.hint).toBe("runOpencodeAuthLogin");
  });
});

describe("tool merge of typed fields", () => {
  it("keeps typed fields the later update leaves out and replaces the ones it sends", () => {
    const first = tool({ rawInput: { command: "ls" }, locations: [{ path: "/w/a.ts", line: 3 }], internal: true });
    const second = tool({ status: "completed", rawOutput: { stdout: "a.ts" }, locations: [] });
    const merged = mergeTool(first, second);
    expect(merged).toMatchObject({ rawInput: { command: "ls" }, rawOutput: { stdout: "a.ts" }, locations: [{ path: "/w/a.ts", line: 3 }], internal: true, status: "completed" });
  });
  it("drops the preparing hint once the call is named, but keeps other hints", () => {
    const pending = tool({ hint: "toolPending" });
    expect(mergeTool(pending, tool({ title: "Read file", status: "in_progress" })).hint).toBeUndefined();
    expect("hint" in mergeTool(pending, tool({ title: "Read file" }))).toBe(false);
    expect(mergeTool(tool({ hint: "outputUnavailable" }), tool({ status: "completed" })).hint).toBe("outputUnavailable");
  });
});

describe("tool steps from typed fields", () => {
  it("reads the command and output from typed rawInput and rawOutput, not contentJson", () => {
    const step = toStep(tool({ toolKind: "execute", title: "Shell", status: "completed", rawInput: { command: "pnpm test" }, rawOutput: { stdout: "ok", exit_code: 0 }, contentJson: JSON.stringify({ rawInput: { command: "WRONG" }, rawOutput: "WRONG" }) }), []);
    expect(step.target).toBe("pnpm test");
    expect(step.detail).toMatchObject({ type: "terminal", exitCode: 0, lines: [{ kind: "cmd", text: "pnpm test" }, { kind: "out", text: "ok" }] });
  });
  it("falls back to contentJson only where the typed field is absent", () => {
    const step = toStep(tool({ toolKind: "execute", status: "completed", contentJson: JSON.stringify({ rawInput: { command: "ls" }, rawOutput: "a\nb" }) }), []);
    expect(step.detail).toMatchObject({ type: "terminal", lines: [{ text: "ls" }, { text: "a" }, { text: "b" }] });
  });
  it("uses typed locations to open a file at its line and typed diffs for the detail", () => {
    const opened: [string, number | undefined][] = [];
    const step = toStep(
      tool({ toolKind: "edit", title: "Edit", locations: [{ path: "/w/src/a.ts", line: 4 }], diffs: [{ path: "/w/src/a.ts", resolved: true, change: "modify", oldText: "a\nb\n", newText: "a\nB\n" }] }),
      [],
      "/w",
      (path, line) => opened.push([path, line]),
    );
    step.onOpen?.();
    expect(opened).toEqual([["/w/src/a.ts", 4]]);
    expect(step.delta).toEqual({ add: 1, del: 1 });
    expect(step.detail).toMatchObject({ type: "diff", path: "src/a.ts" });
  });
  it("shows an unresolved diff path but gives it no open action", () => {
    const step = toStep(tool({ toolKind: "edit", diffs: [{ path: "a.ts", resolved: false, change: "add", oldText: null, newText: "x\n" }] }), [], "/w", () => undefined);
    expect(step.detail).toMatchObject({ type: "diff", path: "a.ts", onOpen: undefined });
  });
  it("marks internal steps and keeps them out of the work counts", () => {
    const real = toStep(tool({ toolCallId: "a", toolKind: "read", title: "Read" }), []);
    const hidden = toStep(tool({ toolCallId: "b", toolKind: "read", title: "resolve-prompt-1", internal: true }), []);
    expect(hidden.internal).toBe(true);
    expect(workSummary([real, hidden]).counts).toBe("1 read");
  });
  it("maps hints to short copy through the single table", () => {
    expect(toStep(tool({ toolKind: "execute", title: "Shell", status: "completed", hint: "outputUnavailable" }), []).note).toBe("Output not available from agent");
    const preparing = toStep(tool({ title: null, status: "pending", hint: "toolPending" }), []);
    expect(preparing.verb).toBe("Preparing tool");
    expect(preparing.note).toBeUndefined();
  });
  it("reports savedPath as text only and offers no open action for it", () => {
    const step = toStep(tool({ title: "Generate image", savedPath: "/Users/x/out.png" }), [], "/w", () => undefined);
    expect(step.savedPath).toBe("/Users/x/out.png");
    expect(step.onOpen).toBeUndefined();
  });
  it("builds thumbnails only from raster bytes, never from a uri or svg", () => {
    const png = "iVBORw0KGgo=";
    const event = tool({ toolCallId: "g", images: [{ mimeType: "image/png", data: png, uri: null }, { mimeType: "image/svg+xml", data: png, uri: null }, { mimeType: "image/png", data: null, uri: "file:///etc/passwd" }, { mimeType: "image/png", data: "not base64!!", uri: null }] });
    expect(toolImages(event)).toEqual([{ id: "g:image:0", name: "image-1.png", mime: "image/png", base64: png }]);
    const opened: string[] = [];
    const step = toStep(event, [], "/w", undefined, (id) => opened.push(id));
    expect(step.images).toHaveLength(1);
    expect(step.images![0].src).toBe(`data:image/png;base64,${png}`);
    step.images![0].onOpen?.();
    expect(opened).toEqual(["g:image:0"]);
  });
  it("summarises a target from typed fields first", () => {
    expect(toolTarget({ rawInput: { command: ["git", "status"] }, contentJson: "{}" })).toBe("git status");
    expect(toolTarget({ locations: [{ path: "/w/a.ts" }], contentJson: "{}" })).toBe("/w/a.ts");
    expect(toolTarget({ contentJson: JSON.stringify({ rawInput: { path: "x.ts" } }) })).toBe("x.ts");
  });
});

describe("permission details", () => {
  const root = "/w";
  it("shows the diff preview, locations, kind and input from typed fields", () => {
    const opened: [string, number | undefined][] = [];
    const details = permissionDetails(
      permission({ toolKind: "edit", rawInput: { file_path: "/w/src/a.ts", mode: "x" }, locations: [{ path: "/w/src/a.ts", line: 2 }, { path: "/etc/hosts", line: null }], diffs: [{ path: "/w/src/a.ts", resolved: true, change: "modify", oldText: "a\nb\n", newText: "a\nB\n" }] }),
      root,
      (path, line) => opened.push([path, line]),
    );
    expect(details.kind).toBe("edit");
    expect(details.diffs[0]).toMatchObject({ path: "src/a.ts", change: "modify" });
    expect(details.diffs[0].lines.some((line) => line.kind === "add" && line.text === "B")).toBe(true);
    details.diffs[0].onOpen?.();
    details.locations[0].onOpen?.();
    expect(opened).toEqual([["/w/src/a.ts", 2], ["/w/src/a.ts", 2]]);
    expect(details.locations[1]).toMatchObject({ label: "/etc/hosts", onOpen: undefined });
    expect(details.input).toContain("file_path");
  });
  it("shows the command text for execute and no duplicate input block", () => {
    const details = permissionDetails(permission({ toolKind: "execute", rawInput: { command: "rm -rf build" } }), root);
    expect(details.command).toBe("rm -rf build");
    expect(details.input).toBeUndefined();
  });
  it("joins an array command", () => {
    expect(permissionDetails(permission({ toolKind: "execute", rawInput: { command: ["npm", "run", "x"] } }), root).command).toBe("npm run x");
  });
  it("bounds the input and the diff count", () => {
    expect(boundedInput({ blob: "x".repeat(5000) })!.length).toBeLessThanOrEqual(1200);
    expect(boundedInput({})).toBeUndefined();
    expect(boundedInput(null)).toBeUndefined();
    const diffs = Array.from({ length: 5 }, (_, i) => ({ path: `/w/f${i}.ts`, resolved: true, change: "add", oldText: null, newText: "x" }));
    const details = permissionDetails(permission({ toolKind: "edit", diffs }), root);
    expect(details.diffs).toHaveLength(3);
    expect(details.moreDiffs).toBe(2);
  });
  it("falls back to diff blocks in content and never opens an unresolved path", () => {
    const details = permissionDetails(permission({ toolKind: "edit", content: [{ type: "diff", path: "a.ts", oldText: null, newText: "x" }] }), root, () => undefined);
    expect(details.diffs).toHaveLength(1);
    expect(details.diffs[0].onOpen).toBeUndefined();
  });
  it("flags internal requests and falls back to the tool call for the target", () => {
    expect(permissionDetails(permission({ internal: true }), root).internal).toBe(true);
    const details = permissionDetails(permission({ toolKind: "read" }), root, undefined, tool({ rawInput: { path: "/w/README.md" } }));
    expect(details.command).toBe("README.md");
  });
});

describe("permission options", () => {
  const options = (...kinds: string[]): PermissionOption[] => kinds.map((kind) => ({ optionId: kind, name: kind, kind })) as PermissionOption[];
  it("does not count reject_always as a Reject key hint", () => {
    expect(composerHints({ dockFocused: true, permission: options("allow_once", "reject_always") }).permission).toEqual([{ keys: ["Y"], label: "Allow" }]);
    expect(composerHints({ dockFocused: true, permission: options("allow_once", "reject_once") }).permission).toHaveLength(2);
  });
  it("finds the oldest open request", () => {
    const state = apply([permission(), permission({ requestId: "r2" })], live());
    expect(openPermission(state.feed)?.event.requestId).toBe("r1");
  });
});
