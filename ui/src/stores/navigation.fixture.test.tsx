// @vitest-environment jsdom
// Fixture tests: a fake port and a hand built context stand in for the backend and the workbench.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitiesDto, LocationDto, LspResponse } from "../bindings";
import { navigationExtension, peekState } from "../lib/lsp-peek";
import { createNavigationSession, type NavigationPort } from "../lib/lsp-navigation";
import { NAVIGATION_UNAVAILABLE_MESSAGE, runNavigationAction, setNavigationNotifier } from "../lib/navigation-actions";
import { editorViewFor, jumpHistory } from "../lib/navigation-context";
import { configureNavigation, navigationState } from "./navigation";
import { NavigationPanels } from "../components/navigation/NavigationLayer";

const everything: CapabilitiesDto = { completion: false, hover: false, definition: true, formatting: false, rangeFormatting: false, rename: true, prepareRename: true, references: true, implementation: true, typeDefinition: true, declaration: true, documentSymbol: true, workspaceSymbol: true, callHierarchy: true, typeHierarchy: true, documentHighlight: true, signatureHelp: false };
const range = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });
const place = (path: string, line: number): LocationDto => ({ path, range: range(line, 0, 3), external: false, displayPath: path });
const reply = <T,>(data: T): LspResponse<T> => ({ revision: 1, epoch: 1, data });

// jsdom has no layout, CodeMirror measures through these.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects = emptyRects;
Range.prototype.getBoundingClientRect = () => new DOMRect();

let views: EditorView[] = []; let dispose: (() => void) | undefined; let stop: (() => void) | undefined;
function mount(text: string, path = "a.ts") {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text, extensions: [navigationExtension(path)] }) });
  views.push(view); return view;
}
function setup(overrides: Partial<NavigationPort> = {}, options: { capabilities?: CapabilitiesDto; label?: string; revision?: () => number } = {}) {
  const notify = vi.fn(); const open = vi.fn(); const port = { cancel: async () => null, ...overrides } as NavigationPort;
  stop = configureNavigation({
    port, session: createNavigationSession(port), activePath: () => "a.ts", workspaceRoot: () => "/w", workspaceGeneration: () => 1, revision: options.revision ?? (() => 1), revisions: () => ({}),
    synchronized: () => true, epoch: () => 1, server: () => ({ label: options.label ?? "fixture server", capabilities: options.capabilities }),
    isReadOnly: () => false, isOpen: () => true, documentText: () => undefined, open, openFile: async () => true, applyEdits: () => true, notify, revealBottomPanel: () => {}, openQuickOpen: vi.fn(),
  });
  setNavigationNotifier(notify);
  return { notify, open };
}
beforeEach(() => { document.body.replaceChildren(); jumpHistory.clear(); });
afterEach(() => { views.forEach(view => view.destroy()); views = []; dispose?.(); dispose = undefined; stop?.(); stop = undefined; setNavigationNotifier(undefined); });

describe("navigation handlers (fixture)", () => {
  it("names the server when it does not support the command and never calls it", async () => {
    const definition = vi.fn();
    const { notify } = setup({ definition }, { capabilities: { ...everything, definition: false }, label: "rust-analyzer" });
    mount("let value = 1;");
    runNavigationAction("goToDefinition");
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][0]).toContain(NAVIGATION_UNAVAILABLE_MESSAGE);
    expect(notify.mock.calls[0][0]).toContain("rust-analyzer");
    expect(definition).not.toHaveBeenCalled();
  });
  it("opens a single result directly through the app's open path", async () => {
    const { open } = setup({ definition: async () => reply([place("b.ts", 4)]) }, { capabilities: everything });
    mount("value");
    runNavigationAction("goToDefinition");
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("b.ts", 5, 1));
  });
  it("opens several results as a peek list", async () => {
    setup({ definition: async () => reply([place("b.ts", 1), place("c.ts", 2)]), readSource: async location => ({ path: location.path, displayPath: location.path, language: "typescript", startLine: 0, text: "x", highlightRange: location.range, external: false, readOnly: false }) }, { capabilities: everything });
    const view = mount("value"); view.focus();
    runNavigationAction("goToDefinition");
    await vi.waitFor(() => expect(peekState(view.state)?.entries).toHaveLength(2));
    expect(view.dom.querySelector(".cm-peek-list")).not.toBeNull();
  });
  it("drops a reply when the document changed while the request was in flight", async () => {
    let release!: (value: LspResponse<LocationDto[]>) => void;
    const { open, notify } = setup({ definition: () => new Promise(resolve => { release = resolve; }) }, { capabilities: everything });
    const view = mount("value");
    runNavigationAction("goToDefinition");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    view.dispatch({ changes: { from: 0, insert: "x" } });
    release(reply([place("b.ts", 1)]));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(open).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it("drops a reply stamped with another revision", async () => {
    const { open } = setup({ definition: async () => ({ revision: 9, epoch: 1, data: [place("b.ts", 1)] }) }, { capabilities: everything });
    mount("value");
    runNavigationAction("goToDefinition");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(open).not.toHaveBeenCalled();
  });
  it("a newer request cancels the older one", async () => {
    const cancel = vi.fn(async () => null); const releases: ((value: LspResponse<LocationDto[]>) => void)[] = [];
    const { open } = setup({ cancel, definition: () => new Promise(resolve => { releases.push(resolve); }) }, { capabilities: everything });
    mount("value");
    runNavigationAction("goToDefinition"); await vi.waitFor(() => expect(releases).toHaveLength(1));
    runNavigationAction("goToDefinition"); await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0](reply([place("old.ts", 1)])); releases[1](reply([place("new.ts", 2)]));
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("new.ts", 3, 1));
    expect(open).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalled();
  });
  it("find references fills the panel state and previews lines", async () => {
    setup({
      references: async () => reply([place("a.ts", 0), place("b.ts", 1)]),
      readSource: async location => ({ path: location.path, displayPath: location.path, language: "typescript", startLine: location.range.start.line, text: "let value = 1;", highlightRange: location.range, external: false, readOnly: false }),
    }, { capabilities: everything });
    mount("value");
    runNavigationAction("findReferences");
    await vi.waitFor(() => expect(navigationState.references.status).toBe("ready"));
    expect(navigationState.references.count).toBe(2);
    expect(navigationState.references.groups.map(group => group.key)).toEqual(["a.ts", "b.ts"]);
    expect(navigationState.bottomTab()).toBe("references");
    dispose = render(() => <NavigationPanels />, document.body);
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe("2 references to `value`");
    await vi.waitFor(() => expect(document.body.querySelectorAll(".nav-line-text").length).toBe(2));
  });
  it("shows an empty state when there are no references", async () => {
    setup({ references: async () => reply([]) }, { capabilities: everything });
    mount("value"); runNavigationAction("findReferences");
    await vi.waitFor(() => expect(navigationState.references.status).toBe("ready"));
    dispose = render(() => <NavigationPanels />, document.body);
    expect(document.body.textContent).toContain("No references found");
  });
  it("lists registered views per file", () => {
    setup({}, { capabilities: everything });
    const view = mount("x");
    expect(editorViewFor("a.ts")).toBe(view);
    view.destroy(); views = [];
    expect(editorViewFor("a.ts")).toBeUndefined();
  });
});
