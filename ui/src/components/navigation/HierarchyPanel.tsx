import { For, Show } from "solid-js";
import { fileLabel, symbolKindIcon, symbolKindLabel } from "../../lib/lsp-navigation";
import { focusEditor } from "../../lib/navigation-context";
import { collapseNode, expandNode, navigationState, openHierarchyItem, setHierarchyDirection, type HNode } from "../../stores/navigation";
import Icon from "../Icon";
import { handleTreeKey } from "./tree-keys";

function findIn(nodes: HNode[], id: string): HNode | undefined {
  for (const node of nodes) { if (node.id === id) return node; const child = findIn(node.children, id); if (child) return child; }
  return undefined;
}

function Branch(props: { node: HNode; depth: number }) {
  const emptyText = () => navigationState.hierarchy.kind === "call" ? (navigationState.hierarchy.direction === "incoming" ? "No incoming calls" : "No outgoing calls") : (navigationState.hierarchy.direction === "supertypes" ? "No supertypes" : "No subtypes");
  return <div role="none">
    <div data-nav-row data-node={props.node.id} class="nav-row nav-node" role="treeitem" tabIndex={props.depth === 0 ? 0 : -1} aria-level={props.depth + 1} aria-expanded={props.node.expanded} aria-busy={props.node.status === "loading"}
      style={{ "padding-left": `${8 + props.depth * 16}px` }} onClick={() => openHierarchyItem(props.node.item)} title={`${props.node.item.location.displayPath || props.node.item.location.path}:${props.node.item.selectionRange.start.line + 1}`}>
      <button tabIndex={-1} class="nav-twisty" aria-label={props.node.expanded ? `Collapse ${props.node.item.name}` : `Expand ${props.node.item.name}`} onClick={event => { event.stopPropagation(); if (props.node.expanded) collapseNode(props.node.id); else void expandNode(props.node.id); }}><Icon name={props.node.expanded ? "arrow-down4" : "arrow-right4"} size={11} /></button>
      <span title={symbolKindLabel(props.node.item.kind)}><Icon name={symbolKindIcon(props.node.item.kind)} size={14} /></span>
      <strong>{props.node.item.name}</strong>
      <span class="nav-dim nav-folder">{fileLabel(props.node.item.location.displayPath || props.node.item.location.path)}:{props.node.item.selectionRange.start.line + 1}</span>
      <Show when={props.node.ranges.length > 1}><span class="nav-count" title="Call sites">{props.node.ranges.length}</span></Show>
    </div>
    <Show when={props.node.expanded}>
      <div role="group">
        <Show when={props.node.status === "loading"}><div class="nav-row nav-note" role="status" style={{ "padding-left": `${24 + props.depth * 16}px` }}>Loading…</div></Show>
        <Show when={props.node.status === "error"}><div class="nav-row nav-note" role="alert" style={{ "padding-left": `${24 + props.depth * 16}px` }}>{props.node.error}</div></Show>
        <Show when={props.node.status === "done" && !props.node.children.length}><div class="nav-row nav-note" role="status" style={{ "padding-left": `${24 + props.depth * 16}px` }}>{emptyText()}</div></Show>
        <For each={props.node.children}>{child => <Branch node={child} depth={props.depth + 1} />}</For>
      </div>
    </Show>
  </div>;
}

/** Call hierarchy and type hierarchy as one lazy tree. Children are fetched on first expansion. */
export function HierarchyPanel() {
  let tree!: HTMLDivElement;
  const hierarchy = navigationState.hierarchy;
  const directions = () => hierarchy.kind === "call" ? [["incoming", "Incoming calls"], ["outgoing", "Outgoing calls"]] as const : [["supertypes", "Supertypes"], ["subtypes", "Subtypes"]] as const;
  const rowNode = (row: HTMLElement) => findIn(hierarchy.roots, row.dataset.node ?? "");
  return <div class="nav-panel" role="region" aria-label={hierarchy.kind === "call" ? "Call hierarchy" : "Type hierarchy"}>
    <div class="nav-panel-header">
      <span class="nav-panel-title">{hierarchy.kind === "call" ? "Call hierarchy" : "Type hierarchy"}<Show when={hierarchy.title}>: <strong>{hierarchy.title}</strong></Show></span>
      <div class="nav-toggle" role="group" aria-label="Direction"><For each={directions()}>{([value, label]) => <button aria-pressed={hierarchy.direction === value} class={hierarchy.direction === value ? "selected" : ""} onClick={() => setHierarchyDirection(value)}>{label}</button>}</For></div>
    </div>
    <Show when={hierarchy.status === "loading"}><div class="nav-panel-message" role="status">Loading hierarchy…</div></Show>
    <Show when={hierarchy.status === "error"}><div class="nav-panel-message" role="alert">{hierarchy.error}</div></Show>
    <Show when={hierarchy.status === "ready" && !hierarchy.roots.length}><div class="nav-panel-message" role="status">No {hierarchy.kind === "call" ? "callable symbol" : "type"} at the caret.</div></Show>
    <div ref={tree} class="nav-tree" role="tree" aria-label={hierarchy.kind === "call" ? "Call hierarchy tree" : "Type hierarchy tree"} onKeyDown={event => handleTreeKey(event, tree, {
      activate: row => row.click(),
      expand: row => { const node = rowNode(row); if (node && !node.expanded) void expandNode(node.id); else row.nextElementSibling?.querySelector<HTMLElement>("[data-nav-row]")?.focus(); },
      collapse: row => { const node = rowNode(row); if (node?.expanded) collapseNode(node.id); else row.parentElement?.parentElement?.parentElement?.querySelector<HTMLElement>(":scope > [data-nav-row]")?.focus(); },
      escape: () => focusEditor(),
    })}>
      <For each={hierarchy.roots}>{root => <Branch node={root} depth={0} />}</For>
    </div>
  </div>;
}
