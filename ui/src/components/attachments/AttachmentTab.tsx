import { Show, createSignal, untrack } from 'solid-js';
import { viewerTabId, viewerTabPath } from '../../lib/viewer-tabs';
import { ViewerState } from '../viewer';
import { AttachmentView, type AttachmentTabView } from './AttachmentViewer';
import '../../styles/viewer.css';

/**
 * Views of the attachments open as workbench tabs, keyed by tab path. The workbench keeps only the
 * path; the view (live getters from the agent panel) lives here until no group shows the tab.
 */
export function createAttachmentTabs() {
  const [views, setViews] = createSignal<Record<string, AttachmentTabView>>({});
  /** Returns the tab path. An attachment that already has a tab keeps it, with the newer view. */
  function register(view: AttachmentTabView): string {
    const id = view.item.id;
    const path = Object.keys(views()).find(open => viewerTabId(open) === id) ?? viewerTabPath(id, view.item.name);
    setViews(current => ({ ...current, [path]: view }));
    return path;
  }
  const view = (path: string): AttachmentTabView | undefined => views()[path];
  function prune(openPaths: readonly string[]) {
    const open = new Set(openPaths);
    const current = untrack(views);
    if (Object.keys(current).every(path => open.has(path))) return;
    setViews(Object.fromEntries(Object.entries(current).filter(([path]) => open.has(path))));
  }
  return { register, view, prune };
}

/** Body of one attachment tab. Without a view, for example after a restart, it says so instead of guessing. */
export function AttachmentTab(props: { view?: AttachmentTabView; onClose: () => void }) {
  return <Show when={props.view} fallback={
    <section class="att-viewer att-viewer-tab" aria-label="Attachment no longer available">
      <ViewerState kind="gone" text="This attachment is no longer available. Open it again from the chat." actions={[{ label: 'Close tab', onClick: props.onClose }]} />
    </section>
  }>{view => <AttachmentView {...view()} onClose={props.onClose} />}</Show>;
}
