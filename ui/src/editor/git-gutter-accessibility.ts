import { ViewPlugin, type EditorView } from "@codemirror/view";

/** CodeMirror hides decorative gutters. Expose only our interactive Git lanes. */
export const gitGutterAccessibility = ViewPlugin.fromClass(class {
  private original = new Map<HTMLElement, Map<string, string | null>>();
  constructor(readonly view: EditorView) { this.sync(); }
  update() { this.sync(); }
  private set(element: HTMLElement, name: string, value: string | null) {
    let attributes = this.original.get(element);
    if (!attributes) { attributes = new Map(); this.original.set(element, attributes); }
    if (!attributes.has(name)) attributes.set(name, element.getAttribute(name));
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
  private restore() {
    for (const [element, attributes] of this.original) for (const [name, value] of attributes) {
      if (value === null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    }
    this.original.clear();
  }
  private sync() {
    const containers = this.view.scrollDOM.querySelectorAll<HTMLElement>(":scope > .cm-gutters");
    const interactive = [...containers].some(container => container.querySelector(".cm-git-gutter button.cm-git-marker:not(:disabled)"));
    if (!interactive) { this.restore(); return; }
    for (const container of containers) {
      this.set(container, "aria-hidden", null);
      this.set(container, "role", "group");
      this.set(container, "aria-label", "Git change indicators");
      for (const child of container.children) if (child instanceof HTMLElement && !child.classList.contains("cm-git-gutter")) this.set(child, "aria-hidden", "true");
    }
  }
  destroy() { this.restore(); }
});
