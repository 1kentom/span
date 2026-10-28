// @vitest-environment jsdom
// Every entry point that turns a language server location into a visible place must send a library location
// (here the exact jdt URI of the bug report) to the read-only viewer and never to the workspace file commands.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitiesDto, LocationDto, LspResponse } from "../bindings";
import { REPORTED_JDT_URI } from "../lib/lsp-location.testkit";
import { lspExtension, resolveDefinition, type LspBinding } from "../lib/lsp-codemirror";
import { createNavigationSession, type NavigationPort } from "../lib/lsp-navigation";
import { navigationExtension, openPeek, openPeekTarget } from "../lib/lsp-peek";
import { runNavigationAction, setNavigationNotifier } from "../lib/navigation-actions";
import { jumpHistory } from "../lib/navigation-context";
import { LibraryViewer, NavigationPanels } from "../components/navigation/NavigationLayer";
import { closeLibrary, configureNavigation, createSymbolSource, navigationState, openHierarchyItem, openLocation, openSymbol, type HierarchyItem } from "./navigation";

const everything: CapabilitiesDto = { completion: false, hover: false, definition: true, formatting: false, rangeFormatting: false, rename: true, prepareRename: true, references: true, implementation: true, typeDefinition: true, documentSymbol: true, workspaceSymbol: true, callHierarchy: true, typeHierarchy: true, documentHighlight: false } as CapabilitiesDto;
const range = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });
const jdt: LocationDto = { path: REPORTED_JDT_URI, range: range(41, 13, 24), external: true, displayPath: "javafx.fxml/FXMLLoader.java" };
const inside: LocationDto = { path: "src/Main.java", range: range(2, 0, 3), external: false, displayPath: "src/Main.java" };
const reply = <T,>(data: T): LspResponse<T> => ({ revision: 1, epoch: 1, data });
const source = vi.fn(async (location: LocationDto) => ({ path: location.path, displayPath: location.displayPath, language: "java", startLine: 0, text: "public class FXMLLoader {}\n", highlightRange: location.range, external: true, readOnly: true }));

Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

let views: EditorView[] = []; let dispose: (() => void) | undefined; let stop: (() => void) | undefined;
const mount = (text = "FXMLLoader") => { const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: text, extensions: [navigationExtension("src/Main.java")] }) }); views.push(view); return view; };
function setup(overrides: Partial<NavigationPort> = {}) {
  const open = vi.fn(); const openToSide = vi.fn(); const openFile = vi.fn(async () => true); const notify = vi.fn();
  const port = { cancel: async () => null, readSource: source, ...overrides } as NavigationPort;
  stop = configureNavigation({
    port, session: createNavigationSession(port), activePath: () => "src/Main.java", workspaceRoot: () => "/Users/user/projects/Java Projects/todo", workspaceGeneration: () => 1,
    revision: () => 1, revisions: () => ({}), synchronized: () => true, epoch: () => 1, server: () => ({ label: "jdtls", capabilities: everything }),
    isReadOnly: () => false, isOpen: () => true, documentText: () => undefined, open, openToSide, openFile, applyEdits: () => true, notify, revealBottomPanel: () => {}, openQuickOpen: vi.fn(),
  });
  setNavigationNotifier(notify);
  return { open, openToSide, openFile, notify };
}
const showsLibrary = async (title = "javafx.fxml/FXMLLoader.java") => {
  await vi.waitFor(() => expect(navigationState.library.docs.some(doc => doc.location.path === REPORTED_JDT_URI)).toBe(true));
  await vi.waitFor(() => expect(navigationState.library.docs[0].status).toBe("ready"));
  expect(navigationState.library.docs[0].title).toBe(title);
};
beforeEach(() => { document.body.replaceChildren(); jumpHistory.clear(); source.mockClear(); });
afterEach(() => { views.forEach(view => view.destroy()); views = []; dispose?.(); dispose = undefined; stop?.(); stop = undefined; setNavigationNotifier(undefined); });

describe("openLocation", () => {
  it("sends a workspace location to the workspace and nothing to the viewer", async () => {
    const { open, openToSide } = setup();
    await openLocation(inside);
    expect(open).toHaveBeenCalledWith("src/Main.java", 3, 1);
    expect(navigationState.library.docs).toHaveLength(0);
    await openLocation(inside, { side: true });
    expect(openToSide).toHaveBeenCalledWith("src/Main.java", 3, 1);
  });
  it("sends the reported jdt URI to the viewer, to the side too, and never to the workspace", async () => {
    const { open, openToSide, openFile } = setup();
    await openLocation(jdt);
    await showsLibrary();
    expect(source).toHaveBeenCalledWith(expect.objectContaining({ path: REPORTED_JDT_URI }), expect.any(Number));
    expect(source.mock.calls[0][0].path).toBe(REPORTED_JDT_URI);
    expect(navigationState.library.docs[0].side).toBe(false);
    await openLocation(jdt, { side: true });
    expect(navigationState.library.docs).toHaveLength(1);
    expect(navigationState.library.docs[0].side).toBe(true);
    expect([open, openToSide, openFile].map(fn => fn.mock.calls.length)).toEqual([0, 0, 0]);
  });
  it("routes a URI, a Windows path and an escaping path to the viewer even when the server did not mark them external", async () => {
    const { open, openToSide } = setup();
    for (const path of ["jar:file:///x.jar!/A.class", "C:\\Users\\x\\lib\\Foo.java", "\\\\?\\C:\\Users\\x\\lib\\Foo.java", "../Foo.java", "/usr/lib/Foo.java"]) await openLocation({ ...inside, path, displayPath: path });
    expect(navigationState.library.docs).toHaveLength(5);
    expect(open).not.toHaveBeenCalled(); expect(openToSide).not.toHaveBeenCalled();
  });
});

describe("entry points with a jdt location never call the workspace navigate", () => {
  it("F12 and Cmd/Ctrl+click: the editor binding's definition result goes through openLocation", async () => {
    const { open, openToSide } = setup();
    const caps = { definition: true, hover: false, completion: false } as CapabilitiesDto;
    const binding: LspBinding = {
      server: "jdtls", createSession: () => ({ completion: vi.fn(), hover: vi.fn(), definition: vi.fn(async () => ({ kind: "ok", response: reply([jdt]) })), format: vi.fn(), dispose: vi.fn() }) as never,
      getRevision: () => 1, isSynchronized: () => true, isActive: () => true, getWorkspaceGeneration: () => 0, getEpoch: () => 0, getCapabilities: () => caps,
      subscribeDiagnostics: () => () => undefined, subscribeReset: () => () => undefined, notify: vi.fn(),
      // The same wiring App.tsx uses for the editor.
      openLocation: location => void openLocation(location), openLocationToSide: location => void openLocation(location, { side: true }),
    };
    const view = new EditorView({ state: EditorState.create({ doc: "FXMLLoader", extensions: [lspExtension("src/Main.java", binding)] }), parent: document.body });
    views.push(view);
    expect(await resolveDefinition(view, 5, false)).toBe("opened");
    await showsLibrary();
    expect(open).not.toHaveBeenCalled(); expect(openToSide).not.toHaveBeenCalled();
    binding.openLocationToSide!(jdt);
    await vi.waitFor(() => expect(navigationState.library.docs[0].side).toBe(true));
    expect(openToSide).not.toHaveBeenCalled();
  });
  it("go to definition, type definition and implementation", async () => {
    for (const [action, feature] of [["goToDefinition", "definition"], ["goToTypeDefinition", "typeDefinition"], ["goToImplementation", "implementation"]] as const) {
      const { open, openToSide } = setup({ [feature]: async () => reply([jdt]) } as Partial<NavigationPort>);
      mount();
      runNavigationAction(action);
      await showsLibrary();
      expect(open).not.toHaveBeenCalled(); expect(openToSide).not.toHaveBeenCalled();
      closeLibrary(REPORTED_JDT_URI); views.forEach(view => view.destroy()); views = []; stop?.(); stop = undefined; source.mockClear();
    }
  });
  it("peek Open in editor", async () => {
    const { open } = setup({ readSource: source });
    const view = mount(); view.focus();
    openPeek(view, [jdt], "Definition");
    expect(openPeekTarget(view)).toBe(true);
    await showsLibrary();
    expect(open).not.toHaveBeenCalled();
  });
  it("references panel rows", async () => {
    const { open } = setup({ references: async () => reply([jdt]) });
    mount();
    runNavigationAction("findReferences");
    await vi.waitFor(() => expect(navigationState.references.status).toBe("ready"));
    dispose = render(() => <NavigationPanels />, document.body);
    const row = await vi.waitFor(() => { const found = document.body.querySelector<HTMLElement>(".nav-item"); expect(found).not.toBeNull(); return found!; });
    row.click();
    await showsLibrary();
    expect(open).not.toHaveBeenCalled();
  });
  it("hierarchy rows", async () => {
    const { open } = setup();
    openHierarchyItem({ name: "FXMLLoader", kind: "class", location: jdt, selectionRange: jdt.range, range: jdt.range } as unknown as HierarchyItem);
    await showsLibrary();
    expect(open).not.toHaveBeenCalled();
  });
  it("the workspace symbol picker", async () => {
    const { open } = setup();
    const symbols = createSymbolSource()!;
    symbols.open({ id: "1", name: "FXMLLoader", kind: "class", container: "", depth: 0, path: jdt.path, line: 42, column: 14, location: jdt });
    await showsLibrary();
    expect(open).not.toHaveBeenCalled();
  });
  it("a breadcrumb symbol stays in the current file", () => {
    const { open } = setup();
    openSymbol({ name: "main", kind: "method", detail: null, range: range(1, 0, 9), selectionRange: range(1, 4, 8), children: [] } as never);
    expect(open).toHaveBeenCalledWith("src/Main.java", 2, 5);
    expect(navigationState.library.docs).toHaveLength(0);
  });
});

describe("the viewer", () => {
  it("shows the clean name, the jar, the banner and a full-text tooltip, and Escape closes it", async () => {
    setup();
    dispose = render(() => <LibraryViewer />, document.body);
    await openLocation(jdt);
    await showsLibrary();
    await vi.waitFor(() => expect(document.body.querySelector(".nav-library")).not.toBeNull());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Read-only library source");
    expect(document.body.querySelector(".nav-library-name")?.textContent).toBe("javafx.fxml/FXMLLoader.java");
    expect(document.body.querySelector(".nav-library-name")?.getAttribute("title")).toBe(REPORTED_JDT_URI);
    expect(document.body.querySelector(".nav-library-origin")?.textContent).toBe("javafx-fxml-21.0.2-mac-aarch64.jar");
    document.body.querySelector<HTMLElement>(".nav-library")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(document.body.querySelector(".nav-library")).toBeNull());
  });
});
