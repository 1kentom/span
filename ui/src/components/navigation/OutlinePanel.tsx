import { For, Show, createEffect, createMemo } from "solid-js";
import type { OutlineHeading } from "../../editor/markdown-outline";
import { fileName } from "../../lib/navigation";
import { pluralize } from "../../lib/lsp-navigation";
import { currentPlace, focusEditor, jumpHistory, navigationContext } from "../../lib/navigation-context";
import { caretPosition, navigationState } from "../../stores/navigation";
import { handleTreeKey } from "./tree-keys";

/** One indent step per heading level below 1, after the row's base padding. */
const indent = (level: number) => `${34 + (Math.min(Math.max(level, 1), 6) - 1) * 13}px`;

/**
 * The headings of the active Markdown document. Rows are buttons like the other navigation trees; clicking one
 * reveals the heading line in the editor, and the heading at the caret carries the current marker.
 */
export function OutlinePanel() {
  let tree!: HTMLDivElement;
  const outline = () => navigationState.outline();
  const rows = () => outline()?.headings ?? [];
  const label = () => {
    const active = outline();
    if (!active) return "Outline";
    return active.headings.length
      ? `${pluralize(active.headings.length, "heading")} in ${fileName(active.path)}`
      : `Headings in ${fileName(active.path)}`;
  };
  /** Index of the heading at or before the caret line, or -1 before the first heading or with no caret. */
  const current = createMemo(() => {
    const headingLine = (caretPosition()?.line ?? -2) + 1;
    if (headingLine < 1) return -1;
    let index = -1;
    for (let at = 0; at < rows().length; at++) {
      if (rows()[at].line <= headingLine) index = at;
      else break;
    }
    return index;
  });
  // Keep the row for the heading at the caret in view while the caret moves through the document.
  createEffect(() => {
    const index = current();
    if (index >= 0) tree.querySelectorAll<HTMLElement>("[data-nav-row]")[index]?.scrollIntoView?.({ block: "nearest" });
  });
  function jump(heading: OutlineHeading): void {
    const active = outline();
    const ctx = navigationContext();
    if (!active || !ctx) return;
    jumpHistory.record(currentPlace());
    if (ctx.revealInEditor) void ctx.revealInEditor(active.path, heading.line);
    else void ctx.open(active.path, heading.line, 1);
  }
  return <div class="nav-panel" role="region" aria-label="Outline">
    <div class="nav-panel-header"><span class="nav-panel-title" role="status">{label()}</span></div>
    <Show when={!outline()}><div class="nav-panel-message" role="status">Open a Markdown file to see its outline.</div></Show>
    <Show when={outline() && !rows().length}><div class="nav-panel-message" role="status">This document has no headings yet.</div></Show>
    <div ref={tree} class="nav-tree nav-outline" role="tree" aria-label="Headings" onKeyDown={event => handleTreeKey(event, tree, {
      activate: row => row.click(),
      escape: () => focusEditor(),
    })}>
      <For each={rows()}>{(heading, index) =>
        <button data-nav-row class="nav-row nav-outline-row" role="treeitem" tabIndex={index() === 0 ? 0 : -1}
          aria-current={current() === index() ? "location" : undefined}
          style={{ "padding-left": indent(heading.level) }}
          title={`${outline()!.path}:${heading.line}`}
          onClick={() => jump(heading)}>
          <span class="nav-outline-text">{heading.text || "Untitled heading"}</span>
          <span class="nav-line-number" aria-label="Line">{heading.line}</span>
        </button>}</For>
    </div>
  </div>;
}
