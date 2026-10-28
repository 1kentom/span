import { For, Show, createEffect, onCleanup } from "solid-js";
import type { EditorView } from "@codemirror/view";
import { createSourceView } from "../../lib/lsp-peek";
import { closeLibrary, navigationState, selectLibrary, type LibraryDoc } from "../../stores/navigation";
import Icon from "../Icon";

function SourceBody(props: { doc: LibraryDoc }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  createEffect(() => {
    const doc = props.doc;
    view?.destroy(); view = undefined;
    if (doc.status !== "ready") return;
    view = createSourceView(host, { path: doc.location.path, displayPath: doc.title, language: doc.language, startLine: doc.startLine, text: doc.text, highlightRange: doc.location.range, external: true, readOnly: true }, { dark: !host.closest(".theme-light") });
  });
  onCleanup(() => view?.destroy());
  return <div class="nav-library-body" ref={host} />;
}

/**
 * Library and JDK sources open here, never as a buffer. The viewer has no save, no edit and no
 * language server: the text comes from the backend read-only source command.
 */
export function LibraryViewer() {
  let section: HTMLElement | undefined;
  // Focus moves into the viewer when it opens so Escape closes it.
  createEffect(() => { if (navigationState.library.active) queueMicrotask(() => section?.focus()); });
  const active = () => navigationState.library.docs.find(doc => doc.id === navigationState.library.active);
  return <Show when={active()}>{doc => <section ref={section} tabIndex={-1} class="nav-library" aria-label="Read-only library source" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closeLibrary(doc().id); } }}>
    <div class="nav-library-tabs" role="tablist" aria-label="Library sources">
      <For each={navigationState.library.docs}>{item => <div class={`nav-library-tab ${item.id === doc().id ? "active" : ""}`}>
        <button role="tab" aria-selected={item.id === doc().id} title={item.title} onClick={() => selectLibrary(item.id)}><Icon name="DocumentText" size={14} /><span>{item.title}</span><span class="nav-badge">read-only</span></button>
        <button class="close-button" aria-label={`Close ${item.title}`} onClick={() => closeLibrary(item.id)}>×</button>
      </div>}</For>
    </div>
    <div class="nav-library-banner" role="note"><Icon name="Eye" size={14} /><strong>Read-only library source</strong><span>{doc().title}. It cannot be edited or saved. Press Escape to close.</span></div>
    <Show when={doc().status === "ready"} fallback={<div class="nav-panel-message" role={doc().status === "error" ? "alert" : "status"}>{doc().status === "error" ? doc().error || "Could not read this source." : "Loading source…"}</div>}><SourceBody doc={doc()} /></Show>
  </section>}</Show>;
}
