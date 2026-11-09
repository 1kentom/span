// @vitest-environment jsdom
// The Outline panel is driven by derived state, not by a server: NavigationLayer refreshes it from the active
// Markdown document, and the panel lists headings, jumps with the shared reveal, and marks the heading at the caret.
import { EditorState } from "@codemirror/state";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitiesDto, PositionDto } from "../bindings";
import { createNavigationSession, type NavigationPort } from "../lib/lsp-navigation";
import { jumpHistory } from "../lib/navigation-context";
import { NavigationPanels, NavigationTabs } from "../components/navigation/NavigationLayer";
import { configureNavigation, navigationState, refreshOutline, setCaretPosition } from "./navigation";

const everything: CapabilitiesDto = { completion: false, hover: false, definition: true, formatting: false, rangeFormatting: false, rename: true, prepareRename: true, references: true, implementation: true, typeDefinition: true, documentSymbol: true, workspaceSymbol: true, callHierarchy: true, typeHierarchy: true, documentHighlight: false } as CapabilitiesDto;

const DOC = [
  "---", "title: t", "---",
  "# Intro", "",
  "## Setup", "",
  "```bash", "# not a heading", "```", "",
  "Later", "=====", "",
  "## Usage", "",
  "#",
].join("\n");
// Headings: Intro (1, line 4), Setup (2, line 6), Later (1, line 12, Setext), Usage (2, line 15), untitled (1, line 17).
const keypad = (line: number): PositionDto => ({ line: line - 1, character: 0 });

let dispose: (() => void) | undefined; let stop: (() => void) | undefined;
function setup(options: { text?: string; activePath?: string; withReveal?: boolean } = {}) {
  const open = vi.fn(); const revealInEditor = vi.fn(); const notify = vi.fn();
  // Never used by outline code paths; the shape only needs to type as a stub.
  const port = { cancel: async () => null } as unknown as NavigationPort;
  const text = options.text ?? DOC;
  const activePath = options.activePath ?? "notes.md";
  stop = configureNavigation({
    port, session: createNavigationSession(port), activePath: () => activePath, workspaceRoot: () => "/w", workspaceGeneration: () => 1,
    revision: () => 1, revisions: () => ({}), synchronized: () => true, epoch: () => 1, server: () => ({ label: "markdown", capabilities: everything }),
    isReadOnly: () => false, isOpen: () => true, documentText: () => EditorState.create({ doc: text }).doc,
    open, ...(options.withReveal === false ? {} : { revealInEditor }), openFile: async () => true, applyEdits: () => true, notify,
    revealBottomPanel: () => {}, openQuickOpen: () => {},
  });
  refreshOutline();
  navigationState.setBottomTab("outline");
  return { open, revealInEditor };
}
const rows = () => [...document.body.querySelectorAll<HTMLElement>(".nav-outline-row")];
const rowTexts = () => rows().map(row => row.querySelector(".nav-outline-text")!.textContent);

beforeEach(() => { document.body.replaceChildren(); jumpHistory.clear(); });
afterEach(() => { dispose?.(); dispose = undefined; stop?.(); stop = undefined; setCaretPosition(undefined); navigationState.setBottomTab("terminal"); });

describe("the Outline panel", () => {
  it("lists ATX and Setext headings in order, never inside fences or front matter", () => {
    setup();
    dispose = render(() => <NavigationPanels />, document.body);
    expect(rowTexts()).toEqual(["Intro", "Setup", "Later", "Usage", "Untitled heading"]);
    const numbers = rows().map(row => row.querySelector(".nav-line-number")!.textContent!.trim());
    expect(numbers).toEqual(["4", "6", "12", "15", "17"]);
  });

  it("jumps on click through the same reveal the app gives other navigation", () => {
    const { revealInEditor, open } = setup();
    dispose = render(() => <NavigationPanels />, document.body);
    rows()[1].click();
    expect(revealInEditor).toHaveBeenCalledWith("notes.md", 6);
    expect(open).not.toHaveBeenCalled();
  });

  it("falls back to open when the app does not implement the reveal", () => {
    const { open, revealInEditor } = setup({ withReveal: false });
    dispose = render(() => <NavigationPanels />, document.body);
    rows()[0].click();
    expect(open).toHaveBeenCalledWith("notes.md", 4, 1);
    expect(revealInEditor).not.toHaveBeenCalled();
  });

  it("activates a row with Enter over the tree keys", () => {
    const { revealInEditor } = setup();
    dispose = render(() => <NavigationPanels />, document.body);
    const row = rows()[2];
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(revealInEditor).toHaveBeenCalledWith("notes.md", 12);
  });

  it("marks the heading at the caret and keeps it", async () => {
    setup();
    dispose = render(() => <NavigationPanels />, document.body);
    setCaretPosition(keypad(12));
    expect(rows()[2].getAttribute("aria-current")).toBe("location");
    expect(rows()[1].getAttribute("aria-current")).toBeNull();
    setCaretPosition(keypad(4));
    expect(rows()[0].getAttribute("aria-current")).toBe("location");
    setCaretPosition(keypad(17));
    expect(rows()[4].getAttribute("aria-current")).toBe("location");
  });

  it("shows the no-headings state for a Markdown document without headings", () => {
    setup({ text: "only prose here" });
    dispose = render(() => <NavigationPanels />, document.body);
    expect(document.body.querySelector(".nav-panel-message")!.textContent).toContain("no headings yet");
    expect(rowTexts()).toEqual([]);
  });

  it("clears the panel and tab row for a non-Markdown active document", () => {
    setup({ activePath: "src/Main.ts" });
    dispose = render(() => <><NavigationTabs showPanel={() => {}} /><NavigationPanels /></>, document.body);
    expect(navigationState.outline()).toBeUndefined();
    expect(document.body.querySelector(".nav-panel-message")!.textContent).toContain("Open a Markdown file");
    expect(rows()).toEqual([]);
    expect([...document.body.querySelectorAll<HTMLElement>("[role='tab']")].some(row => row.textContent === "Outline")).toBe(false);
  });

  it("shows the Outline tab while a Markdown document is active and opens the panel from it", () => {
    setup();
    const showPanel = vi.fn();
    dispose = render(() => <NavigationTabs showPanel={showPanel} />, document.body);
    const tab = document.body.querySelector<HTMLElement>("[role='tab']")!;
    expect(tab.textContent).toBe("Outline");
    navigationState.setBottomTab("outline");
    tab.click();
    expect(navigationState.bottomTab()).toBe("outline");
    expect(showPanel).toHaveBeenCalled();
  });
});
