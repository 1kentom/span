import { For, Show } from "solid-js";
import { fileName } from "../../lib/navigation";
import { directoryLabel, pluralize } from "../../lib/lsp-navigation";
import { focusEditor } from "../../lib/navigation-context";
import { navigationState, openLocation, refreshReferences, setReferencesCollapsed, toggleReferenceGroup } from "../../stores/navigation";
import Icon, { FileIcon } from "../Icon";
import { MatchedText } from "./MatchedText";
import { handleTreeKey } from "./tree-keys";

/** Find All References, grouped by file. Rows are real buttons so the tree works with the keyboard. */
export function ReferencesPanel() {
  let tree!: HTMLDivElement;
  const references = navigationState.references;
  const heading = () => references.status === "loading" ? `Finding references to \`${references.symbol}\`…` : references.status === "error" ? `References to \`${references.symbol}\`` : `${pluralize(references.count, "reference")} to \`${references.symbol}\``;
  const rowGroup = (row: HTMLElement) => references.groups.find(group => group.key === row.dataset.group);
  return <div class="nav-panel" role="region" aria-label="References">
    <div class="nav-panel-header">
      <span class="nav-panel-title" role="status">{heading()}</span>
      <Show when={references.groups.length > 1}>
        <button class="icon-button" aria-label="Collapse all" title="Collapse all" onClick={() => setReferencesCollapsed(true)}><Icon name="arrow-up3" size={13} /></button>
        <button class="icon-button" aria-label="Expand all" title="Expand all" onClick={() => setReferencesCollapsed(false)}><Icon name="arrow-down4" size={13} /></button>
      </Show>
      <button class="icon-button" aria-label="Refresh references" title="Refresh references" disabled={references.status === "loading" || !references.origin} onClick={() => void refreshReferences()}><Icon name="Refresh2" size={13} /></button>
    </div>
    <Show when={references.status === "error"}><div class="nav-panel-message" role="alert">{references.error}</div></Show>
    <Show when={references.status === "loading"}><div class="nav-panel-message" role="status">Searching the workspace…</div></Show>
    <Show when={references.status === "ready" && !references.count}><div class="nav-panel-message" role="status">No references found for `{references.symbol}`.</div></Show>
    <div ref={tree} class="nav-tree" role="tree" aria-label="References by file" onKeyDown={event => handleTreeKey(event, tree, {
      activate: row => { if (row.dataset.group && !row.dataset.item) toggleReferenceGroup(row.dataset.group); else row.click(); },
      expand: row => { const group = rowGroup(row); if (group?.collapsed && !row.dataset.item) toggleReferenceGroup(group.key); },
      collapse: row => { const group = rowGroup(row); if (!group) return; if (!row.dataset.item) { if (!group.collapsed) toggleReferenceGroup(group.key); } else tree.querySelector<HTMLElement>(`[data-group="${CSS.escape(group.key)}"]:not([data-item])`)?.focus(); },
      escape: () => focusEditor(),
    })}>
      <For each={references.groups}>{group => <div role="group">
        <button data-nav-row data-group={group.key} class="nav-row nav-group" role="treeitem" aria-expanded={!group.collapsed} tabIndex={0} onClick={() => toggleReferenceGroup(group.key)}>
          <Icon name={group.collapsed ? "arrow-right4" : "arrow-down4"} size={11} /><Show when={!group.external} fallback={<Icon name="DocumentText" size={14} />}><FileIcon path={group.displayPath} /></Show>
          <strong>{fileName(group.displayPath)}</strong><span class="nav-dim nav-folder">{directoryLabel(group.displayPath)}</span><span class="nav-count" aria-label={pluralize(group.items.length, "reference")}>{group.items.length}</span>
        </button>
        <Show when={!group.collapsed}><For each={group.items}>{item =>
          <button data-nav-row data-group={group.key} data-item={item.id} class="nav-row nav-item" role="treeitem" tabIndex={-1} onClick={() => void openLocation(item.location)} title={`${group.displayPath}:${item.line}`}>
            <span class="nav-line-number">{item.line}</span>
            <code class="nav-line-text"><Show when={item.text !== undefined} fallback={<span class="nav-dim">…</span>}><MatchedText text={item.text!} start={item.matchStart} end={item.matchEnd} /></Show></code>
          </button>}</For></Show>
      </div>}</For>
    </div>
  </div>;
}
