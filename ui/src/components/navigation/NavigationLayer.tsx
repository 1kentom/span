import { Show, createEffect, createMemo, on, onCleanup } from "solid-js";
import { navigationContext } from "../../lib/navigation-context";
import {
  dismissToast, dropTransientNavigation, dropWorkspaceNavigation, navigationState, refreshDocumentSymbols, setCaretPosition, type BottomTab,
} from "../../stores/navigation";
import { HierarchyPanel } from "./HierarchyPanel";
import { ReferencesPanel } from "./ReferencesPanel";
import { RenameInput } from "./RenameInput";
import { LibraryViewer } from "./LibraryViewer";
import "../../styles/navigation.css";

/** Floating pieces: the result picker, the rename box and the toast. It also keeps the breadcrumb symbols fresh. */
export function NavigationLayer(props: { line: number; column: number }) {
  const ctx = () => navigationContext();
  // A tab or workspace change drops anything still in flight for the old file.
  createEffect(on(() => ctx()?.activePath(), () => { dropTransientNavigation(); refreshDocumentSymbols(true); }, { defer: true }));
  createEffect(on(() => ctx()?.workspaceGeneration(), () => dropWorkspaceNavigation(), { defer: true }));
  createEffect(() => { const path = ctx()?.activePath(); if (path) { ctx()?.revision(path); refreshDocumentSymbols(); } });
  createEffect(() => setCaretPosition({ line: props.line - 1, character: props.column - 1 }));
  onCleanup(() => setCaretPosition(undefined));
  return <>
    <Show when={navigationState.rename()}>{rename => <RenameInput rename={rename()} />}</Show>
    <Show when={navigationState.toast()}>{toast => <div class="nav-toast" role="status" aria-live="polite"><span>{toast().message}</span><button class="close-button" aria-label="Dismiss message" onClick={dismissToast}>×</button></div>}</Show>
  </>;
}

const tabs: { id: BottomTab; label: string }[] = [{ id: "references", label: "References" }, { id: "hierarchy", label: "Hierarchy" }];

/** Extra tabs next to Terminal. A tab appears once its feature has been used. */
export function NavigationTabs(props: { showPanel: () => void }) {
  const visible = createMemo(() => tabs.filter(tab => tab.id === "references" ? navigationState.references.status !== "idle" : navigationState.hierarchy.status !== "idle"));
  return <>{visibleTabs(visible())}</>;
  function visibleTabs(list: typeof tabs) {
    return list.map(tab => <button class={`panel-tab ${navigationState.bottomTab() === tab.id ? "selected" : ""}`} role="tab" aria-selected={navigationState.bottomTab() === tab.id} onClick={() => { navigationState.setBottomTab(tab.id); props.showPanel(); }}>{tab.label}</button>);
  }
}

/** The body of the bottom panel when a navigation tab is selected. */
export function NavigationPanels() {
  return <Show when={navigationState.bottomTab() === "hierarchy"} fallback={<ReferencesPanel />}><HierarchyPanel /></Show>;
}

export { LibraryViewer };
