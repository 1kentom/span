// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { CapabilitiesDto } from "../bindings";
import { NO_DEFINITION_TEXT, SERVER_NOTICE_TEXT, lspExtension, tokenAtOffset, type LspBinding } from "./lsp-codemirror";
import { identifierAt } from "./lsp-hover-dom";
import type { LspSession } from "./lsp-client";
import { runNavigationAction } from "./navigation-actions";

const caps: CapabilitiesDto = {
  completion: true, hover: true, definition: true, formatting: true, rangeFormatting: false, rename: true, prepareRename: false, references: true,
  implementation: true, typeDefinition: true, declaration: false, documentSymbol: true, workspaceSymbol: true, callHierarchy: true,
  typeHierarchy: false, documentHighlight: false, signatureHelp: false,
};
const JDT = "```java\nvoid com.kentom.todo.Controller.initialize()\n```\n\nSource: *jdt.ls-java-project*";
const where = { path: "b.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };

const ok = <T,>(data: T) => ({ kind: "ok" as const, response: { revision: 1, epoch: 0, data } });
const flush = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };
const platform = (value: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(value);

interface Rig { view: EditorView; binding: LspBinding; session: Record<string, ReturnType<typeof vi.fn>>; notify: ReturnType<typeof vi.fn>; openLocation: ReturnType<typeof vi.fn> }

/** Pointer coordinates are faked: x = offset * 10, so x = offset * 10 + 2 is the left half of the character at `offset`. */
function make(doc: string, over: Partial<LspBinding> = {}, session: Record<string, ReturnType<typeof vi.fn>> = {}, path = "A.java"): Rig {
  const notify = vi.fn();
  const openLocation = vi.fn();
  const sessions: Record<string, ReturnType<typeof vi.fn>> = { completion: vi.fn(), hover: vi.fn(async () => ok(null)), definition: vi.fn(async () => ok([where])), format: vi.fn(), dispose: vi.fn(), ...session };
  const binding: LspBinding = {
    server: "jdtls", createSession: () => sessions as unknown as LspSession,
    getRevision: () => 1, isSynchronized: () => true, isActive: () => true, getWorkspaceGeneration: () => 0, getEpoch: () => 0,
    getCapabilities: () => caps, subscribeDiagnostics: () => () => undefined, subscribeReset: () => () => undefined, openLocation, notify, ...over,
  };
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [EditorState.allowMultipleSelections.of(true), lspExtension(path, binding)] }), parent: document.body });
  (view as unknown as { posAtCoords: unknown }).posAtCoords = ({ x }: { x: number }) => (x < 0 ? null : Math.min(view.state.doc.length, Math.round(x / 10)));
  (view as unknown as { coordsAtPos: unknown }).coordsAtPos = (pos: number) => ({ left: pos * 10, right: pos * 10, top: 0, bottom: 10 });
  return { view, binding, session: sessions as Rig["session"], notify, openLocation };
}

const at = (offset: number, half: "left" | "right" = "left") => ({ clientX: offset * 10 + (half === "left" ? 2 : 8), clientY: 5 });
const move = (view: EditorView, offset: number, half: "left" | "right" = "left", init: MouseEventInit = {}) => view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...at(offset, half), ...init }));
const popup = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-lsp-hover");
const tipText = (view: EditorView) => view.dom.querySelector(".cm-tooltip")?.textContent ?? "";

// jsdom has no layout. CodeMirror measures text ranges when a focused editor changes its selection.
const noRects = { length: 0, item: () => null, [Symbol.iterator]: function* () { /* empty */ } } as unknown as DOMRectList;
Range.prototype.getClientRects = () => noRects;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

beforeEach(() => { vi.useFakeTimers(); platform("MacIntel"); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

describe("identifierAt", () => {
  it("finds a name from its first, middle and last character", () => {
    const text = "  fooBar(x)";
    for (const index of [2, 4, 7]) expect(identifierAt(text, index), String(index)).toMatchObject({ from: 2, to: 8 });
    expect(identifierAt(text, 8)).toBeNull();
    expect(identifierAt(text, 1)).toBeNull();
    expect(identifierAt(text, 99)).toBeNull();
  });
  it("treats $, underscores and any script as name characters", () => {
    expect(identifierAt("$scope._x", 3)).toMatchObject({ from: 0, to: 6 });
    expect(identifierAt("$scope._x", 8)).toMatchObject({ from: 7, to: 9 });
    expect(identifierAt("let 変数名 = héllo;", 5)).toMatchObject({ from: 4, to: 7 });
    expect(identifierAt("let 変数名 = héllo;", 13)).toMatchObject({ from: 10, to: 15 });
    expect(identifierAt("x 𝒜bc y", 3)).toMatchObject({ from: 2, to: 6 });
    expect(identifierAt("x 𝒜bc y", 2)).toMatchObject({ from: 2, to: 6 });
  });
  it("finds the type inside a generic argument", () => {
    const text = "ComboBox<String> box;";
    expect(identifierAt(text, 2)).toMatchObject({ from: 0, to: 8 });
    expect(identifierAt(text, 8)).toBeNull();
    expect(identifierAt(text, 9)).toMatchObject({ from: 9, to: 15 });
    expect(identifierAt(text, 14)).toMatchObject({ from: 9, to: 15 });
    expect(identifierAt(text, 15)).toBeNull();
  });
  it("includes the @ of an annotation and asks inside the name", () => {
    const text = "  @Override";
    expect(identifierAt(text, 2)).toEqual({ from: 2, to: 11, at: 3 });
    expect(identifierAt(text, 3)).toEqual({ from: 2, to: 11, at: 3 });
    expect(identifierAt(text, 7)).toEqual({ from: 2, to: 11, at: 7 });
    expect(identifierAt("a @ b", 2)).toBeNull();
  });
  it("splits a qualified import path at the dots", () => {
    const text = "import com.kentom.todo.Controller;";
    expect(identifierAt(text, 7)).toMatchObject({ from: 7, to: 10 });
    expect(identifierAt(text, 12)).toMatchObject({ from: 11, to: 17 });
    expect(identifierAt(text, 25)).toMatchObject({ from: 23, to: 33 });
    expect(identifierAt(text, 10)).toBeNull();
  });
  it("does not treat numbers as tokens", () => {
    expect(identifierAt("x = 42;", 5)).toBeNull();
    expect(identifierAt("x = 0x1F;", 6)).toBeNull();
    expect(identifierAt("v2 = 1", 1)).toMatchObject({ from: 0, to: 2 });
  });
});

describe("hover request path", () => {
  it("asks about the character under the pointer, both halves of the first and last character", async () => {
    const { view, session } = make("ComboBox<String> box;");
    for (const [offset, half, expected] of [[0, "left", 0], [7, "right", 7], [3, "left", 3], [9, "left", 9], [14, "right", 14]] as const) {
      session.hover.mockClear();
      move(view, offset === 0 ? 0 : offset, half);
      await flush(300);
      expect(session.hover, `${offset}${half}`).toHaveBeenCalledTimes(1);
      expect(session.hover.mock.calls[0][1]).toEqual({ line: 0, character: expected });
      move(view, 19); await flush(400);
    }
    view.destroy();
  });
  it("does not ask on punctuation, spaces or numbers", async () => {
    const { view, session } = make("a < b, 42");
    for (const offset of [1, 2, 3, 5, 6, 7, 8]) { move(view, offset); await flush(400); }
    expect(session.hover).not.toHaveBeenCalled();
    view.destroy();
  });
  it("asks for annotations and import path segments", async () => {
    const { view, session } = make("@Override\nimport com.kentom.Todo;");
    move(view, 0); await flush(300);
    expect(session.hover.mock.calls[0][1]).toEqual({ line: 0, character: 1 });
    move(view, 19); await flush(300);
    expect(session.hover.mock.calls[1][1]).toEqual({ line: 1, character: 9 });
    view.destroy();
  });
  it("waits about 300 ms and asks once while the pointer stays on the token", async () => {
    const { view, session } = make("hello world");
    move(view, 1); await flush(250);
    expect(session.hover).not.toHaveBeenCalled();
    move(view, 2); move(view, 3); await flush(60);
    expect(session.hover).toHaveBeenCalledTimes(1);
    view.destroy();
  });
  it("discards a stale reply when the pointer moved to another token", async () => {
    let releaseFirst!: () => void;
    const hover = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = () => resolve(ok({ markdown: "```ts\nfirst\n```", range: null })); }))
      .mockImplementationOnce(async () => ok({ markdown: "```ts\nsecond\n```", range: null }));
    const { view } = make("hello world", {}, { hover });
    move(view, 1); await flush(300);
    move(view, 8); await flush(300);
    releaseFirst(); await flush(0);
    expect(popup(view)?.textContent).toContain("second");
    expect(tipText(view)).not.toContain("first");
    view.destroy();
  });
  it("cancels a reply that arrives after the pointer left every token", async () => {
    let release!: () => void;
    const { view } = make("hello world", {}, { hover: vi.fn(() => new Promise(resolve => { release = () => resolve(ok({ markdown: "docs", range: null })); })) });
    move(view, 1); await flush(300);
    move(view, 5); await flush(10);
    release(); await flush(400);
    expect(popup(view)).toBeNull();
    view.destroy();
  });
  it("shows nothing when the server answers null or only noise", async () => {
    const { view } = make("hello world", {}, { hover: vi.fn(async () => ok(null)) });
    move(view, 1); await flush(400);
    expect(view.dom.querySelector(".cm-tooltip")).toBeNull();
    view.destroy();
    const noise = make("hello world", {}, { hover: vi.fn(async () => ok({ markdown: "Source: *jdt.ls-java-project*", range: null })) });
    move(noise.view, 1); await flush(400);
    expect(noise.view.dom.querySelector(".cm-tooltip")).toBeNull();
    noise.view.destroy();
  });
  it("waits for edits to reach the backend before asking", async () => {
    let synchronized = false;
    const { view, session } = make("hello world", { isSynchronized: () => synchronized });
    move(view, 1); await flush(320);
    expect(session.hover).not.toHaveBeenCalled();
    synchronized = true; await flush(60);
    expect(session.hover).toHaveBeenCalledTimes(1);
    view.destroy();
  });
});

describe("hover while the server is not ready", () => {
  it("says the server is still starting, once per hover, without sending a request", async () => {
    const { view, session } = make("hello world", { getCapabilities: () => undefined, getServerNotice: () => "starting" });
    move(view, 1); await flush(300);
    expect(tipText(view)).toBe(SERVER_NOTICE_TEXT.starting);
    expect(session.hover).not.toHaveBeenCalled();
    move(view, 2); move(view, 3); await flush(1000);
    expect(view.dom.querySelectorAll(".cm-lsp-notice")).toHaveLength(1);
    view.destroy();
  });
  it("says results may be incomplete when an indexing server answers nothing", async () => {
    const { view } = make("hello world", { getServerNotice: () => "indexing" }, { hover: vi.fn(async () => ok(null)) });
    move(view, 1); await flush(300);
    expect(tipText(view)).toBe("Indexing project, results may be incomplete");
    view.destroy();
  });
  it("prefers real content over the indexing note", async () => {
    const { view } = make("hello world", { getServerNotice: () => "indexing" }, { hover: vi.fn(async () => ok({ markdown: "```java\nint x\n```", range: null })) });
    move(view, 1); await flush(300);
    expect(tipText(view)).toContain("int x");
    expect(tipText(view)).not.toContain("Indexing");
    view.destroy();
  });
  it("shows nothing for a ready, idle server that has no answer", async () => {
    const { view } = make("hello world", { getServerNotice: () => undefined });
    move(view, 1); await flush(400);
    expect(view.dom.querySelector(".cm-tooltip")).toBeNull();
    view.destroy();
  });
});

describe("hover popup", () => {
  const withJdt = (over: Partial<LspBinding> = {}) => make("controller.initialize();", { getShortcut: id => ({ peekDefinition: "Alt+F12", goToDefinition: "F12", quickInfo: "Cmd+Shift+I" })[id], ...over }, { hover: vi.fn(async () => ok({ markdown: JDT, range: null })) });
  it("renders the JDT sample without raw markdown or the synthetic project", async () => {
    const { view } = withJdt();
    move(view, 2); await flush(300);
    const dom = popup(view)!;
    expect(dom.querySelector(".cm-lsp-signature")?.textContent).toBe("void com.kentom.todo.Controller.initialize()");
    expect(dom.textContent).not.toContain("*");
    expect(dom.textContent).not.toMatch(/jdt\.ls-java-project|Source:/);
    view.destroy();
  });
  it("has a footer with Go to Definition (click hint) and Peek Definition (bound key)", async () => {
    const { view, openLocation } = withJdt();
    move(view, 2); await flush(300);
    const buttons = [...popup(view)!.querySelectorAll<HTMLButtonElement>(".cm-lsp-hover-actions button")];
    expect(buttons.map(button => button.textContent)).toEqual(["Go to DefinitionCmd+click", "Peek DefinitionAlt+F12"]);
    buttons[0].click(); await flush(0);
    expect(openLocation).toHaveBeenCalledWith(where);
    view.destroy();
  });
  it("uses Ctrl+click off macOS and omits Peek when definitions are unsupported", async () => {
    platform("Win32");
    const { view } = withJdt({ getCapabilities: () => ({ ...caps, definition: false }) });
    move(view, 2); await flush(300);
    expect(popup(view)!.querySelector(".cm-lsp-hover-actions")).toBeNull();
    view.destroy();
    const windows = withJdt();
    move(windows.view, 2); await flush(300);
    expect(popup(windows.view)!.querySelector(".cm-lsp-hover-actions button kbd")?.textContent).toBe("Ctrl+click");
    windows.view.destroy();
  });
  it("peek moves the caret to the token and runs the peek action", async () => {
    const { view } = withJdt();
    const { registerNavigationHandler } = await import("./navigation-actions");
    const peek = vi.fn();
    const stop = registerNavigationHandler("peekDefinition", peek);
    move(view, 14); await flush(300);
    popup(view)!.querySelector<HTMLButtonElement>('[data-action="peekDefinition"]')!.click();
    expect(peek).toHaveBeenCalledTimes(1);
    expect(view.state.selection.main.head).toBe(14);
    stop(); view.destroy();
  });
  it("stays open while the pointer is inside it and closes on Escape", async () => {
    const { view } = withJdt();
    move(view, 2); await flush(300);
    view.contentDOM.dispatchEvent(new MouseEvent("mouseleave"));
    const tip = view.dom.querySelector(".cm-tooltip")!;
    tip.dispatchEvent(new MouseEvent("mouseenter"));
    popup(view)!.dispatchEvent(new MouseEvent("mouseenter"));
    await flush(2000);
    expect(popup(view)).not.toBeNull();
    popup(view)!.dispatchEvent(new MouseEvent("mouseleave"));
    await flush(400);
    expect(popup(view)).toBeNull();
    move(view, 2); await flush(300);
    expect(popup(view)).not.toBeNull();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popup(view)).toBeNull();
    view.destroy();
  });
  it("closes when the pointer leaves for good, and when the document changes", async () => {
    const { view } = withJdt();
    move(view, 2); await flush(300);
    view.contentDOM.dispatchEvent(new MouseEvent("mouseleave"));
    await flush(400);
    expect(popup(view)).toBeNull();
    move(view, 2); await flush(300);
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(popup(view)).toBeNull();
    view.destroy();
  });
  it("shows the problems at that position with severity, message, source and code", async () => {
    let push!: (event: never) => void;
    const { view } = make("let value = 1;", { subscribeDiagnostics: listener => { push = listener as never; return () => undefined; } }, { hover: vi.fn(async () => ok({ markdown: "```ts\nlet value: number\n```", range: null })) }, "a.ts");
    push({ path: "a.ts", revision: 1, diagnostics: [{ severity: "warning", message: "'value' is never reassigned.", source: "ts", code: "6133", range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } }] } as never);
    await flush(10);
    move(view, 5); await flush(300);
    const row = popup(view)!.querySelector(".cm-lsp-diagnostic-warning")!;
    expect(row.querySelector(".cm-lsp-diagnostic-message")?.textContent).toBe("'value' is never reassigned.");
    expect(row.querySelector(".cm-lsp-diagnostic-source")?.textContent).toBe("ts (6133)");
    expect(row.querySelector(".cm-lsp-severity")?.getAttribute("aria-label")).toBe("Warning");
    expect(popup(view)!.textContent).toContain("let value: number");
    view.destroy();
  });
  it("shows a problem even where the server has no hover", async () => {
    let push!: (event: never) => void;
    const { view } = make("let value = 1", { subscribeDiagnostics: listener => { push = listener as never; return () => undefined; } }, {}, "a.ts");
    push({ path: "a.ts", revision: 1, diagnostics: [{ severity: "error", message: "';' expected.", range: { start: { line: 0, character: 13 }, end: { line: 0, character: 13 } } }] } as never);
    await flush(10);
    move(view, 12); await flush(300);
    expect(popup(view)!.querySelector(".cm-lsp-diagnostic-error")?.textContent).toContain("';' expected.");
    expect(popup(view)!.querySelector(".cm-lsp-hover-actions")).toBeNull();
    view.destroy();
  });
  it("renders a hover hint from the hub with its action", async () => {
    const run = vi.fn();
    const hoverHint = vi.fn((pos: number) => pos >= 0 ? { text: "Dependencies are not loaded.", actionLabel: "Trust project", onAction: run } : undefined);
    const { view } = withJdt({ hoverHint });
    move(view, 2); await flush(300);
    const hint = popup(view)!.querySelector(".cm-lsp-hover-hint")!;
    expect(hint.textContent).toContain("Dependencies are not loaded.");
    hint.querySelector("button")!.click();
    expect(run).toHaveBeenCalled();
    view.destroy();
    const plain = withJdt({ hoverHint: () => "Open the project to resolve this." });
    move(plain.view, 2); await flush(300);
    expect(popup(plain.view)!.querySelector(".cm-lsp-hover-hint")?.textContent).toBe("Open the project to resolve this.");
    plain.view.destroy();
  });
  it("quick info shows the hover at the caret and moves focus into it", async () => {
    const { view } = withJdt();
    view.dispatch({ selection: { anchor: 3 } });
    expect(runNavigationAction("quickInfo")).toBe(true);
    await flush(20);
    const dom = popup(view)!;
    expect(dom.textContent).toContain("Controller.initialize()");
    expect(document.activeElement).toBe(dom);
    dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popup(view)).toBeNull();
    view.destroy();
  });
  it("quick info at the end of a name still finds the name", async () => {
    const { view } = withJdt();
    view.dispatch({ selection: { anchor: 10 } });
    runNavigationAction("quickInfo"); await flush(20);
    expect(popup(view)).not.toBeNull();
    view.destroy();
  });
});

describe("tokenAtOffset", () => {
  it("returns identifiers with a stable key", () => {
    const state = EditorState.create({ doc: "foo(bar)" });
    expect(tokenAtOffset(state, 5)).toMatchObject({ from: 4, to: 7, kind: "identifier" });
    expect(tokenAtOffset(state, 3)).toBeNull();
  });
});

describe("Cmd/Ctrl-click go to definition", () => {
  const mouse = (type: string, init: MouseEventInit & { clientX: number; clientY: number }) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  const press = (view: EditorView, offset: number, init: MouseEventInit = {}) => { const event = mouse("mousedown", { ...at(offset), ...init }); view.contentDOM.dispatchEvent(event); return event; };
  const contextMenu = (view: EditorView, offset: number, init: MouseEventInit = {}) => { const event = mouse("contextmenu", { ...at(offset), button: 2, ...init }); view.contentDOM.dispatchEvent(event); return event; };
  const reachedPage = () => { const spy = vi.fn(); document.addEventListener("contextmenu", spy); return spy; };

  it("on macOS, Ctrl+click goes to the definition and swallows the context menu that follows", async () => {
    const { view, openLocation } = make("foo bar");
    const page = reachedPage();
    const down = press(view, 5, { ctrlKey: true });
    expect(down.defaultPrevented).toBe(true);
    const menu = contextMenu(view, 5, { ctrlKey: true });
    expect(menu.defaultPrevented).toBe(true);
    expect(page).not.toHaveBeenCalled();
    await flush(0);
    expect(openLocation).toHaveBeenCalledWith(where);
    expect(view.state.selection.ranges).toHaveLength(1);
    document.removeEventListener("contextmenu", page);
    view.destroy();
  });
  it("on macOS, Cmd+click does the same", async () => {
    const { view, openLocation } = make("foo bar");
    const down = press(view, 5, { metaKey: true });
    expect(down.defaultPrevented).toBe(true);
    await flush(0);
    expect(openLocation).toHaveBeenCalledTimes(1);
    expect(view.state.selection.ranges).toHaveLength(1);
    view.destroy();
  });
  it("on Windows and Linux, Ctrl+click goes to the definition", async () => {
    platform("Linux x86_64");
    const { view, openLocation } = make("foo bar");
    expect(press(view, 5, { ctrlKey: true }).defaultPrevented).toBe(true);
    await flush(0);
    expect(openLocation).toHaveBeenCalledTimes(1);
    view.destroy();
  });
  it("a real right click still opens the context menu and puts the caret on the symbol", async () => {
    const { view } = make("foo bar baz");
    const page = reachedPage();
    const menu = contextMenu(view, 5);
    expect(menu.defaultPrevented).toBe(false);
    expect(page).toHaveBeenCalledTimes(1);
    expect(view.state.selection.main.head).toBe(5);
    document.removeEventListener("contextmenu", page);
    view.destroy();
  });
  it("right click inside a selection keeps the selection", () => {
    const { view } = make("foo bar baz");
    view.dispatch({ selection: { anchor: 0, head: 7 } });
    contextMenu(view, 5);
    expect(view.state.selection.main).toMatchObject({ anchor: 0, head: 7 });
    view.destroy();
  });
  it("lets a context menu through once the gesture window has passed", async () => {
    const { view } = make("foo bar");
    press(view, 5, { ctrlKey: true });
    await flush(500);
    expect(contextMenu(view, 5, { ctrlKey: true }).defaultPrevented).toBe(false);
    view.destroy();
  });
  it("shows No definition found, still swallows the menu, and adds no cursor", async () => {
    const { view, openLocation } = make("foo bar", {}, { definition: vi.fn(async () => ok([])) });
    const page = reachedPage();
    expect(press(view, 5, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(contextMenu(view, 5, { ctrlKey: true }).defaultPrevented).toBe(true);
    await flush(0);
    expect(tipText(view)).toBe(NO_DEFINITION_TEXT);
    expect(openLocation).not.toHaveBeenCalled();
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(page).not.toHaveBeenCalled();
    await flush(2500);
    expect(view.dom.querySelector(".cm-tooltip")).toBeNull();
    document.removeEventListener("contextmenu", page);
    view.destroy();
  });
  it("leaves everything to the browser while no server is ready", () => {
    const { view, session } = make("foo bar", { getCapabilities: () => undefined });
    const page = reachedPage();
    press(view, 5, { ctrlKey: true });
    expect(contextMenu(view, 5, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(page).toHaveBeenCalledTimes(1);
    expect(session.definition).not.toHaveBeenCalled();
    document.removeEventListener("contextmenu", page);
    view.destroy();
  });
  it("ignores clicks off a name, plain clicks, Alt+click and right button presses", () => {
    const { view, session } = make("foo bar");
    press(view, 3, { ctrlKey: true });
    press(view, 5);
    press(view, 5, { altKey: true });
    press(view, 5, { ctrlKey: true, button: 2 });
    expect(session.definition).not.toHaveBeenCalled();
    // None of these started a gesture, so a context menu that follows is not swallowed.
    expect(contextMenu(view, 5, { ctrlKey: true }).defaultPrevented).toBe(false);
    view.destroy();
  });
  it("Cmd+Alt+click opens the definition in the other group, falling back to the same group", async () => {
    const openLocationToSide = vi.fn();
    const side = make("foo bar", { openLocationToSide });
    expect(press(side.view, 5, { metaKey: true, altKey: true }).defaultPrevented).toBe(true);
    await flush(0);
    expect(openLocationToSide).toHaveBeenCalledWith(where);
    expect(side.openLocation).not.toHaveBeenCalled();
    side.view.destroy();
    platform("Win32");
    const win = make("foo bar", { openLocationToSide });
    openLocationToSide.mockClear();
    press(win.view, 5, { ctrlKey: true, altKey: true });
    await flush(0);
    expect(openLocationToSide).toHaveBeenCalledTimes(1);
    win.view.destroy();
    const plain = make("foo bar");
    press(plain.view, 5, { ctrlKey: true, altKey: true });
    await flush(0);
    expect(plain.openLocation).toHaveBeenCalledWith(where);
    plain.view.destroy();
  });
  it("Alt+click adds a cursor, and Cmd/Ctrl+click does not while definitions are available", () => {
    const ready = make("foo bar");
    const adds = ready.view.state.facet(EditorView.clickAddsSelectionRange)[0];
    expect(adds(new MouseEvent("mousedown", { altKey: true }))).toBe(true);
    expect(adds(new MouseEvent("mousedown", { metaKey: true }))).toBe(false);
    expect(adds(new MouseEvent("mousedown", { ctrlKey: true }))).toBe(false);
    ready.view.destroy();
    const idle = make("foo bar", { getCapabilities: () => undefined });
    const fallback = idle.view.state.facet(EditorView.clickAddsSelectionRange)[0];
    expect(fallback(new MouseEvent("mousedown", { metaKey: true }))).toBe(true);
    expect(fallback(new MouseEvent("mousedown", { altKey: true }))).toBe(false);
    idle.view.destroy();
  });
});

describe("link affordance", () => {
  const key = (type: "keydown" | "keyup", init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, ...init }));
  const held = { metaKey: true };
  const link = (view: EditorView) => view.dom.querySelector(".cm-lsp-link");

  it("underlines a token with a definition while Cmd is held, and removes it on release", async () => {
    const { view, session } = make("foo bar");
    move(view, 5);
    key("keydown", { key: "Meta", metaKey: true });
    await flush(200);
    expect(link(view)?.textContent).toBe("bar");
    expect(session.definition).toHaveBeenCalledTimes(1);
    key("keyup", { key: "Meta" });
    expect(link(view)).toBeNull();
    view.destroy();
  });
  it("also reacts to Ctrl on macOS, and only to Ctrl elsewhere", async () => {
    const mac = make("foo bar");
    move(mac.view, 5);
    key("keydown", { key: "Control", ctrlKey: true }); await flush(200);
    expect(link(mac.view)).not.toBeNull();
    mac.view.destroy();
    platform("Win32");
    const win = make("foo bar");
    move(win.view, 5);
    key("keydown", { key: "Meta", metaKey: true }); await flush(200);
    expect(link(win.view)).toBeNull();
    key("keyup", { key: "Meta" });
    key("keydown", { key: "Control", ctrlKey: true }); await flush(200);
    expect(link(win.view)?.textContent).toBe("bar");
    win.view.destroy();
  });
  it("follows the pointer to the next token and caches each answer", async () => {
    const { view, session } = make("foo bar");
    key("keydown", { key: "Meta", metaKey: true });
    move(view, 1, "left", held); await flush(200);
    expect(link(view)?.textContent).toBe("foo");
    move(view, 5, "left", held); await flush(200);
    expect(link(view)?.textContent).toBe("bar");
    move(view, 1, "left", held); await flush(200);
    expect(link(view)?.textContent).toBe("foo");
    expect(session.definition).toHaveBeenCalledTimes(2);
    view.destroy();
  });
  it("shows no underline where the server has no definition", async () => {
    const { view } = make("foo bar", {}, { definition: vi.fn(async () => ok([])) });
    move(view, 5);
    key("keydown", { key: "Control", ctrlKey: true }); await flush(200);
    expect(link(view)).toBeNull();
    view.destroy();
  });
  it("removes the underline when the pointer leaves, and never shows it without a ready server", async () => {
    const { view } = make("foo bar");
    move(view, 5);
    key("keydown", { key: "Meta", metaKey: true }); await flush(200);
    expect(link(view)).not.toBeNull();
    view.contentDOM.dispatchEvent(new MouseEvent("mouseleave"));
    expect(link(view)).toBeNull();
    view.destroy();
    const idle = make("foo bar", { getCapabilities: () => undefined });
    move(idle.view, 5);
    key("keydown", { key: "Meta", metaKey: true }); await flush(200);
    expect(link(idle.view)).toBeNull();
    key("keyup", { key: "Meta" });
    idle.view.destroy();
  });
  it("does not wait for a pointer rest when the modifier is pressed before the pointer moves", async () => {
    const { view } = make("foo bar");
    key("keydown", { key: "Meta", metaKey: true });
    move(view, 5, "left", held); await flush(130);
    expect(link(view)?.textContent).toBe("bar");
    key("keyup", { key: "Meta" });
    view.destroy();
  });
});

describe("declaration preview", () => {
  const snippet = { path: "b.java", displayPath: "src/b.java", language: "java", startLine: 0, text: "class B {\n  void run() {}\n}\n", highlightRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, external: false, readOnly: true };
  const held = { metaKey: true };
  it("shows the declaration source while the modifier is held and removes it on release", async () => {
    const readSource = vi.fn(async () => snippet);
    const { view } = make("foo bar", { readSource });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    move(view, 5, "left", held); await flush(300);
    const preview = view.dom.querySelector(".cm-lsp-preview");
    expect(preview?.querySelector(".cm-lsp-preview-path")?.textContent).toBe("src/b.java:1");
    expect(preview?.textContent).toContain("void run() {}");
    expect(preview?.querySelector(".cm-lsp-hover-actions")).toBeNull();
    expect(readSource).toHaveBeenCalledWith(where, 4);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
    expect(view.dom.querySelector(".cm-lsp-preview")).toBeNull();
    view.destroy();
  });
  it("shows no preview without a definition, and the plain hover is not requested while previewing", async () => {
    const readSource = vi.fn(async () => snippet);
    const none = make("foo bar", { readSource }, { definition: vi.fn(async () => ok([])) });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    move(none.view, 5, "left", held); await flush(400);
    expect(none.view.dom.querySelector(".cm-tooltip")).toBeNull();
    expect(readSource).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
    none.view.destroy();
    const ready = make("foo bar", { readSource });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    move(ready.view, 5, "left", held); await flush(400);
    expect(ready.session.hover).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
    ready.view.destroy();
  });
});
