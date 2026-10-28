// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { applyCompletion, convertSnippet, decideDiagnostics, definitionOrAddCursor, editsToChanges, formatWithLanguageServer, lspExtension, lspMarks, mapDiagnostics, renderHoverMarkdown, replyIsCurrent, type LspBinding } from "./lsp-codemirror";
import type { LspSession } from "./lsp-client";

// Fixture tests: a fake session stands in for the Tauri commands. No real language server is involved.
const caps = { completion: true, hover: true, definition: true, formatting: true, rangeFormatting: false, rename: false, references: false };
function make(doc: string, over: Partial<LspBinding> = {}, session: Partial<LspSession> = {}) {
  const notify = vi.fn();
  const binding: LspBinding = {
    server: "vtsls", createSession: () => ({ completion: vi.fn(), hover: vi.fn(), definition: vi.fn(), format: vi.fn(), dispose: vi.fn(), ...session }) as LspSession,
    getRevision: () => 1, isSynchronized: () => true, isActive: () => true, getWorkspaceGeneration: () => 0, getEpoch: () => 0,
    getCapabilities: () => caps, subscribeDiagnostics: () => () => undefined, subscribeReset: () => () => undefined, openLocation: vi.fn(), notify, ...over,
  };
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [EditorState.allowMultipleSelections.of(true), lspExtension("a.ts", binding)] }), parent: document.body });
  return { view, binding, notify };
}
const edit = (l: number, c: number, l2: number, c2: number, newText: string) => ({ range: { start: { line: l, character: c }, end: { line: l2, character: c2 } }, newText });

describe("fixture: stale discard", () => {
  const base = { isActive: () => true, getRevision: () => 1, getEpoch: () => 0, getWorkspaceGeneration: () => 0 };
  const doc = {};
  const snap = { doc, epoch: 0, generation: 0 };
  it("accepts a matching reply", () => expect(replyIsCurrent(base, snap, doc, { revision: 1, epoch: 0 })).toBe(true));
  it("rejects an edit between request and reply", () => expect(replyIsCurrent(base, snap, {}, { revision: 1, epoch: 0 })).toBe(false));
  it("rejects a revision that moved", () => expect(replyIsCurrent({ ...base, getRevision: () => 2 }, snap, doc, { revision: 1, epoch: 0 })).toBe(false));
  it("rejects a tab switch", () => expect(replyIsCurrent({ ...base, isActive: () => false }, snap, doc, { revision: 1, epoch: 0 })).toBe(false));
  it("rejects a workspace change", () => expect(replyIsCurrent({ ...base, getWorkspaceGeneration: () => 1 }, snap, doc, { revision: 1, epoch: 0 })).toBe(false));
  it("rejects an epoch change", () => expect(replyIsCurrent({ ...base, getEpoch: () => 1 }, snap, doc, { revision: 1, epoch: 1 })).toBe(false));
});

describe("fixture: diagnostics mapping", () => {
  const doc = Text.of(["a😀b", "line2"]);
  it("maps severities and clamps ranges", () => {
    const marks = mapDiagnostics(doc, [
      { severity: "warning", message: "w", range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } } },
      { severity: "hint", message: "h", range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } } },
      { message: "none", range: { start: { line: 1, character: 99 }, end: { line: 1, character: 99 } } },
    ]);
    expect(marks[0]).toMatchObject({ from: 1, to: 3, severity: "warning" });
    expect(marks[1].severity).toBe("info");
    expect(marks[2].severity).toBe("error");
    for (const m of marks) { expect(m.from).toBeGreaterThanOrEqual(0); expect(m.to).toBeLessThanOrEqual(doc.length); expect(m.to).toBeGreaterThan(m.from); }
  });
  it("drops older revisions and waits for newer or unsynchronized ones", () => {
    expect(decideDiagnostics({ revision: 1 }, 2, true)).toBe("drop");
    expect(decideDiagnostics({ revision: 3 }, 2, true)).toBe("wait");
    expect(decideDiagnostics({ revision: 2 }, 2, false)).toBe("wait");
    expect(decideDiagnostics({ revision: 2 }, 2, true)).toBe("apply");
    expect(decideDiagnostics({ revision: null }, 2, true)).toBe("apply");
  });
  it("shows diagnostics, ignores stale ones and clears on reset", () => {
    let push!: (e: any) => void; let reset!: () => void;
    const { view } = make("const x = 1;\n", { subscribeDiagnostics: l => { push = l; return () => undefined; }, subscribeReset: l => { reset = l; return () => undefined; } });
    const d = [{ severity: "error", message: "bad", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } }];
    push({ path: "a.ts", revision: 0, diagnostics: d });
    expect(lspMarks(view.state)).toHaveLength(0);
    push({ path: "other.ts", revision: 1, diagnostics: d });
    expect(lspMarks(view.state)).toHaveLength(0);
    push({ path: "a.ts", revision: 1, diagnostics: d });
    expect(lspMarks(view.state)).toEqual([expect.objectContaining({ from: 6, to: 7, severity: "error" })]);
    reset();
    expect(lspMarks(view.state)).toHaveLength(0);
    view.destroy();
  });
});

describe("fixture: capability gating", () => {
  it("contributes no completion source without the capability", () => {
    const on = make("x");
    expect(on.view.state.languageDataAt("autocomplete", 0)).toHaveLength(1);
    on.view.destroy();
    const off = make("x", { getCapabilities: () => ({ ...caps, completion: false }) });
    expect(off.view.state.languageDataAt("autocomplete", 0)).toHaveLength(0);
    off.view.destroy();
  });
});

describe("fixture: snippets", () => {
  it("strips tabstops and placeholders safely", () => {
    expect(convertSnippet("foo($1)$0")).toMatchObject({ text: "foo()", template: "foo(${1})${0}", finalCursor: 5 });
    expect(convertSnippet("for (${1:item} of ${2|a,b|}) {\n\t$0\n}").text).toBe("for (item of a) {\n\t\n}");
    expect(convertSnippet("a ${TM_FILENAME:x} \\$ b").text).toBe("a x $ b");
    expect(convertSnippet("plain")).toMatchObject({ template: null, hasStops: false });
  });
  it("falls back to plain text for unsafe templates", () => {
    expect(convertSnippet("${1:{x}}").template).toBeNull();
  });
  it("applies a plain text edit range when the document is unchanged", () => {
    const { view } = make("foo.ba");
    const doc = view.state.doc;
    applyCompletion(view, { label: "bar" }, 4, 6, { label: "bar", kind: 5, detail: null, insertText: "bar", insertTextFormat: "plainText", textEdit: edit(0, 4, 0, 6, "bar"), sortText: null }, doc, doc);
    expect(view.state.doc.toString()).toBe("foo.bar");
    view.destroy();
  });
});

describe("fixture: hover rendering", () => {
  it("renders code and prose as text, never HTML", () => {
    const dom = renderHoverMarkdown("```ts\nconst a: <b>x</b>\n```\n\nUse `a` <img src=x onerror=1> [link](http://x)");
    expect(dom.querySelector("pre code")!.textContent).toBe("const a: <b>x</b>");
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector("a")).toBeNull();
    expect(dom.querySelector("p code")!.textContent).toBe("a");
  });
});

describe("fixture: format", () => {
  it("applies all edits as one transaction", async () => {
    const dispatch = vi.fn();
    const { view } = make("a  b\nc", {}, { format: async () => ({ kind: "ok", response: { revision: 1, epoch: 0, data: [edit(0, 1, 0, 3, " "), edit(1, 0, 1, 1, "cc")] } }) });
    const original = view.dispatch.bind(view);
    view.dispatch = ((...a: any[]) => { dispatch(); return (original as any)(...a); }) as any;
    expect(await formatWithLanguageServer(view)).toEqual({ status: "applied" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe("a b\ncc");
    view.destroy();
  });
  it("leaves the doc untouched when it changed during the request", async () => {
    let release!: () => void;
    const { view, notify } = make("a  b", {}, { format: () => new Promise(r => { release = () => r({ kind: "ok", response: { revision: 1, epoch: 0, data: [edit(0, 1, 0, 3, " ")] } }); }) });
    const run = formatWithLanguageServer(view);
    await Promise.resolve(); await new Promise(r => setTimeout(r, 0));
    view.dispatch({ changes: { from: 0, insert: "x" } });
    release();
    expect((await run).status).toBe("stale");
    expect(view.state.doc.toString()).toBe("xa  b");
    expect(notify).toHaveBeenCalled();
    view.destroy();
  });
  it("surfaces failures and overlapping edits without changing the doc", async () => {
    const failing = make("a  b", {}, { format: async () => ({ kind: "error", error: { kind: "other", message: "nope" }, message: "nope" }) });
    expect((await formatWithLanguageServer(failing.view)).status).toBe("failed");
    expect(failing.view.state.doc.toString()).toBe("a  b");
    expect(failing.notify).toHaveBeenCalledWith("Formatting failed: nope");
    failing.view.destroy();
    expect(() => editsToChanges(Text.of(["abcd"]), [edit(0, 0, 0, 3, "x"), edit(0, 2, 0, 4, "y")])).toThrow();
    const overlap = make("abcd", {}, { format: async () => ({ kind: "ok", response: { revision: 1, epoch: 0, data: [edit(0, 0, 0, 3, "x"), edit(0, 2, 0, 4, "y")] } }) });
    expect((await formatWithLanguageServer(overlap.view)).status).toBe("failed");
    expect(overlap.view.state.doc.toString()).toBe("abcd");
    overlap.view.destroy();
  });
  it("is unsupported without the capability", async () => {
    const m = make("a", { getCapabilities: () => ({ ...caps, formatting: false }) });
    expect((await formatWithLanguageServer(m.view)).status).toBe("unsupported");
    m.view.destroy();
  });
});

describe("fixture: diagnostics replay on a new view", () => {
  const d = [{ severity: "error", message: "bad", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } }];
  it("shows the latest published set when a view is created, through the revision check", async () => {
    const { view } = make("const x = 1;\n", { getLatestDiagnostics: () => ({ path: "a.ts", revision: 1, diagnostics: d } as any) });
    await new Promise(r => setTimeout(r, 20));
    expect(lspMarks(view.state)).toHaveLength(1);
    view.destroy();
  });
  it("drops a replayed set older than the buffer", async () => {
    const { view } = make("const x = 1;\n", { getRevision: () => 5, getLatestDiagnostics: () => ({ path: "a.ts", revision: 1, diagnostics: d } as any) });
    await new Promise(r => setTimeout(r, 20));
    expect(lspMarks(view.state)).toHaveLength(0);
    view.destroy();
  });
});

describe("fixture: Cmd/Ctrl-click definition versus add cursor", () => {
  const where = { path: "b.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  it("opens the definition and adds no cursor when the token has one", async () => {
    const openLocation = vi.fn();
    const { view } = make("foo bar", { openLocation }, { definition: vi.fn(async () => ({ kind: "ok", response: { revision: 1, epoch: 0, data: [where] } })) as any });
    expect(await definitionOrAddCursor(view, 5)).toBe("opened");
    expect(openLocation).toHaveBeenCalledWith(where);
    expect(view.state.selection.ranges).toHaveLength(1);
    view.destroy();
  });
  it("falls back to adding a cursor when there is no definition, without a toast", async () => {
    const { view, notify } = make("foo bar", {}, { definition: vi.fn(async () => ({ kind: "ok", response: { revision: 1, epoch: 0, data: [] } })) as any });
    expect(await definitionOrAddCursor(view, 5)).toBe("none");
    expect(view.state.selection.ranges.map(r => r.head)).toEqual([0, 5]);
    expect(notify).not.toHaveBeenCalled();
    view.destroy();
  });
  it("also falls back to adding a cursor when the request fails", async () => {
    const { view } = make("foo bar", {}, { definition: vi.fn(async () => ({ kind: "error", error: { kind: "other", message: "x" }, message: "x" })) as any });
    expect(await definitionOrAddCursor(view, 4)).toBe("failed");
    expect(view.state.selection.ranges).toHaveLength(2);
    view.destroy();
  });
  it("leaves the click to CodeMirror when no server can answer", async () => {
    const { view } = make("foo bar", { getCapabilities: () => undefined });
    expect(await definitionOrAddCursor(view, 5)).toBe("unavailable");
    expect(view.state.selection.ranges).toHaveLength(1);
    view.destroy();
  });
});
