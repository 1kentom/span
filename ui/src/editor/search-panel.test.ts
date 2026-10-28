// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SearchQuery, openSearchPanel, search, setSearchQuery } from "@codemirror/search";
import { createEditorSearchPanel, openEditorReplacePanel } from "./search-panel";

const views: EditorView[] = [];
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); });
function editor(doc: string) {
  const parent = document.createElement("div"); document.body.append(parent);
  const editability = new Compartment();
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [search({ top: true, createPanel: createEditorSearchPanel }), editability.of(EditorState.readOnly.of(false))] }) });
  views.push(view); openSearchPanel(view);
  return { view, editability, panel: view.dom.querySelector<HTMLElement>(".span-find")! };
}

describe("editor search panel", () => {
  it("opens replace and dynamically disables mutation in a read-only editor", () => {
    const { view, editability, panel } = editor("1kentom 1kentom");
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "1kentom", replace: "span" })) });
    openEditorReplacePanel(view);
    const input = panel.querySelector<HTMLInputElement>('[name="replace"]')!;
    const replace = panel.querySelector<HTMLButtonElement>('[aria-label="Replace all matches"]')!;
    expect(document.activeElement).toBe(input); expect(replace.disabled).toBe(false);
    view.dispatch({ effects: editability.reconfigure(EditorState.readOnly.of(true)) });
    expect(input.disabled).toBe(true); expect(replace.disabled).toBe(true);
    replace.click(); expect(view.state.doc.toString()).toBe("1kentom 1kentom");
    view.dispatch({ effects: editability.reconfigure(EditorState.readOnly.of(false)) });
    expect(input.disabled).toBe(false); expect(replace.disabled).toBe(false);
  });

  it("caps large counts honestly while keeping full-document commands available", () => {
    const { view, panel } = editor("1kentom ".repeat(1_002));
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "1kentom" })) });
    expect(panel.querySelector('[role="status"]')?.textContent).toBe("1,000+ matches");
    expect(panel.querySelector<HTMLButtonElement>('[aria-label="Next match (Enter)"]')!.disabled).toBe(false);
    expect(panel.querySelector('[role="status"]')?.getAttribute("title")).toContain("first 1 MiB");
    panel.querySelector<HTMLButtonElement>('[aria-label="Select all matches"]')!.click();
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Select all supports at most 1,000 matches");
    expect(panel.querySelector<HTMLElement>('[role="alert"]')!.hidden).toBe(false);
    expect(view.state.selection.ranges).toHaveLength(1);
  });

  it("does not scan beyond the count budget or disable unseen later matches", () => {
    const { view, panel } = editor("x".repeat(1_048_576) + " 1kentom");
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "1kentom" })) });
    expect(panel.querySelector('[role="status"]')?.textContent).toBe("Count limited");
    expect(panel.querySelector<HTMLButtonElement>('[aria-label="Next match (Enter)"]')!.disabled).toBe(false);
  });
});
