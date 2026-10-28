import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, selectMatches, setSearchQuery } from "@codemirror/search";
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import { iconAssetPath } from "../lib/menuIcons";
import "./search-panel.css";

const countMatchLimit = 1_000;
const countCharacterLimit = 1_048_576;

function icon(name: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = "icon";
  element.setAttribute("aria-hidden", "true");
  element.style.maskImage = `url('${iconAssetPath(name)}')`;
  return element;
}

function button(label: string, action: () => void, artwork?: string, text?: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "span-find-button";
  element.title = label;
  element.setAttribute("aria-label", label);
  if (artwork) element.append(icon(artwork));
  else element.textContent = text || "";
  element.addEventListener("click", action);
  return element;
}

/** A compact view over CodeMirror's search state and replacement commands. */
export class EditorSearchPanel implements Panel {
  readonly dom = document.createElement("form");
  readonly top = true;
  private query: SearchQuery;
  private find = document.createElement("input");
  private replacement = document.createElement("input");
  private replaceRow = document.createElement("div");
  private count = document.createElement("span");
  private error = document.createElement("div");
  private expanded = false;
  private matches: { from: number; to: number }[] = [];
  private truncated = false;
  private expand: HTMLButtonElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private all: HTMLButtonElement;
  private replace: HTMLButtonElement;
  private replaceAll: HTMLButtonElement;
  private toggles: { key: "caseSensitive" | "wholeWord" | "regexp"; button: HTMLButtonElement }[];

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.dom.className = "cm-search span-find";
    this.dom.setAttribute("role", "search");
    this.dom.setAttribute("aria-label", "Find and replace");
    this.dom.addEventListener("submit", event => event.preventDefault());
    this.dom.addEventListener("keydown", event => this.keydown(event));
    this.find.name = "search";
    this.find.placeholder = "Find";
    this.find.setAttribute("aria-label", "Find");
    this.find.setAttribute("main-field", "true");
    this.replacement.name = "replace";
    this.replacement.placeholder = "Replace";
    this.replacement.setAttribute("aria-label", "Replace");
    for (const input of [this.find, this.replacement]) {
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.addEventListener("input", () => this.commit());
    }
    this.expand = button("Toggle replace", () => this.showReplace(!this.expanded), "arrow-right4");
    this.expand.setAttribute("aria-expanded", "false");
    this.expand.dataset.findReplaceToggle = "true";
    this.previous = button("Previous match (Shift+Enter)", () => { findPrevious(view); }, "arrow-up3");
    this.next = button("Next match (Enter)", () => { findNext(view); }, "arrow-down4");
    this.all = button("Select all matches", () => {
      if (!selectMatches(view)) {
        this.error.textContent = "Select all supports at most 1,000 matches. Narrow the search and try again.";
        this.error.hidden = false;
      }
    }, "TaskSquare");
    const close = button("Close find (Escape)", () => { closeSearchPanel(view); view.focus(); }, "menu-cancel");
    this.toggles = [
      { key: "caseSensitive", button: button("Match case", () => this.toggle("caseSensitive"), undefined, "Aa") },
      { key: "wholeWord", button: button("Match whole word", () => this.toggle("wholeWord"), undefined, "ab") },
      { key: "regexp", button: button("Use regular expression", () => this.toggle("regexp"), undefined, ".*") },
    ];
    this.toggles[1].button.classList.add("span-find-word");
    const field = document.createElement("div");
    field.className = "span-find-field";
    field.append(this.find, ...this.toggles.map(toggle => toggle.button));
    this.count.className = "span-find-count";
    this.count.setAttribute("role", "status");
    this.count.setAttribute("aria-live", "polite");
    const row = document.createElement("div");
    row.className = "span-find-row";
    row.append(this.expand, field, this.count, this.previous, this.next, this.all, close);
    const replaceField = document.createElement("div");
    replaceField.className = "span-find-field";
    replaceField.append(this.replacement);
    this.replace = button("Replace current match", () => { replaceNext(view); }, "menu-rename");
    this.replaceAll = button("Replace all matches", () => { replaceAll(view); }, "menu-duplicate");
    this.replaceRow.className = "span-find-replace-row";
    this.replaceRow.hidden = true;
    this.replaceRow.append(replaceField, this.replace, this.replaceAll);
    this.error.className = "span-find-error";
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    this.dom.append(row, this.replaceRow, this.error);
    this.synchronize();
    this.recount();
  }

  private toggle(key: "caseSensitive" | "wholeWord" | "regexp") {
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...this.query, [key]: !this.query[key] })) });
  }

  private commit() {
    const query = new SearchQuery({ ...this.query, search: this.find.value, replace: this.replacement.value });
    if (!query.eq(this.query)) this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private synchronize() {
    this.find.value = this.query.search;
    this.replacement.value = this.query.replace;
    for (const toggle of this.toggles) toggle.button.setAttribute("aria-pressed", String(this.query[toggle.key]));
  }

  showReplace(expanded: boolean, focus = false) {
    this.expanded = expanded;
    this.replaceRow.hidden = !expanded;
    this.expand.setAttribute("aria-expanded", String(expanded));
    this.expand.replaceChildren(icon(expanded ? "arrow-down4" : "arrow-right4"));
    if (focus) this.replacement.focus();
    this.view.requestMeasure();
  }

  private recount() {
    this.matches = [];
    this.truncated = this.view.state.doc.length > countCharacterLimit;
    if (this.query.valid) {
      const cursor = this.query.getCursor(this.view.state, 0, Math.min(this.view.state.doc.length, countCharacterLimit));
      for (let match = cursor.next(); !match.done; match = cursor.next()) {
        if (this.matches.length === countMatchLimit) { this.truncated = true; break; }
        this.matches.push(match.value);
      }
    }
    this.feedback();
  }

  private feedback() {
    const invalid = Boolean(this.query.search && !this.query.valid);
    const selection = this.view.state.selection.main;
    const current = this.matches.findIndex(match => match.from === selection.from && match.to === selection.to);
    const count = this.matches.length;
    this.count.textContent = invalid ? "Invalid regex" : !this.query.search ? "" : this.truncated ? count ? `${count.toLocaleString()}+ matches` : "Count limited" : !count ? "No results" : current >= 0 ? `${current + 1} of ${count}` : `${count} ${count === 1 ? "match" : "matches"}`;
    this.count.title = this.truncated ? "Count limited to 1,000 matches in the first 1 MiB. Find and replace search the full document." : "";
    this.count.classList.toggle("is-empty", Boolean(this.query.search && !count && !this.truncated));
    this.find.setAttribute("aria-invalid", String(invalid));
    this.error.hidden = !invalid;
    this.error.textContent = invalid ? "Invalid regular expression" : "";
    const available = this.query.valid && (count > 0 || this.truncated);
    for (const control of [this.previous, this.next, this.all]) control.disabled = !available;
    const readOnly = this.view.state.readOnly;
    this.replacement.disabled = readOnly;
    this.replace.disabled = this.replaceAll.disabled = readOnly || !available;
  }

  update(update: ViewUpdate) {
    const query = getSearchQuery(update.state);
    const changed = !query.eq(this.query);
    if (changed) { this.query = query; this.synchronize(); }
    if (changed || update.docChanged) this.recount();
    else this.feedback();
  }

  private keydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearchPanel(this.view); this.view.focus(); }
    else if (event.key === "Enter" && (event.target === this.find || event.target === this.replacement)) {
      event.preventDefault();
      if (!this.query.valid) return;
      if (event.target === this.replacement) { if (!this.view.state.readOnly) (event.shiftKey ? replaceAll : replaceNext)(this.view); }
      else (event.shiftKey ? findPrevious : findNext)(this.view);
    } else if (runScopeHandlers(this.view, event, "search-panel")) event.preventDefault();
  }

  mount() { this.find.focus(); this.find.select(); }
}

export function createEditorSearchPanel(view: EditorView): Panel { return new EditorSearchPanel(view); }

export function openEditorReplacePanel(view: EditorView) {
  openSearchPanel(view);
  const toggle = view.dom.querySelector<HTMLButtonElement>("[data-find-replace-toggle]");
  if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
  view.dom.querySelector<HTMLInputElement>('.span-find [name="replace"]')?.focus();
}
