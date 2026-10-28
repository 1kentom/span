import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { ImageSource } from '../../bindings';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { safeRasterSource } from '../../lib/asset-preview';
import { isInWorkspace, isSvgMime, type Attachment } from '../../lib/attachments';
import { FileViewer, type ViewerContent, type ViewerSource } from '../viewer';
import { AttachmentIcon, kindLabels } from './AttachmentChips';
import '../../styles/attachments.css';

export interface AttachmentViewerProps {
  item: Attachment;
  onClose: () => void;
  /** Why the connected agent cannot take this item. Shown as a notice. */
  blockedReason?: string;
  /** Set in browser preview. Native actions (save, open in editor) are withheld and this reason is shown instead. */
  nativeUnavailable?: string;
  /** Composer only. Omit for sent messages. The viewer closes after removing. */
  onRemove?: (item: Attachment) => void;
  /** Shown only when provided and the item is not already in the workspace. May be async. */
  onSaveToWorkspace?: (item: Attachment) => void | Promise<void>;
  /** Shown when provided and the item has a path. */
  onCopyPath?: (path: string) => void | Promise<void>;
  /** Shown for workspace items when provided. */
  onOpenInEditor?: (item: Attachment) => void;
  /** Loads a path-only workspace image. Without it such images show as unavailable. */
  loadImage?: (path: string) => Promise<ImageSource>;
  /** Sent-message attachments only. Agent brand, session title and time, each only when known. */
  source?: ViewerSource;
  /** Sent-message attachments only. Scrolls the feed to the message. The caller decides whether to close the viewer. */
  onShowInSession?: (item: Attachment) => void | Promise<void>;
  /** Action of the "gone" state. */
  onShowSessionList?: () => void;
}

/** Props of the inline view. Without `onClose` there is no close button: a workbench tab closes from its own tab strip. */
export type AttachmentViewProps = Omit<AttachmentViewerProps, 'onClose'> & { onClose?: () => void };
/** What the agent panel hands the workbench for one attachment tab. Fields may be getters that track live state. */
export type AttachmentTabView = Omit<AttachmentViewProps, 'onClose'>;

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

function dataUrlBytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Thin adapter from an Attachment to the shared FileViewer. What each kind opens as is decided by
 * FileViewer from the file name and mime: pasted text and editor selections open as text with the
 * read-only banner (they carry text/plain; a selection is a snapshot, so it is read-only even though
 * its file is in the workspace), images and SVG through ImageView, audio and video
 * through MediaPlayer (blob playback, so the Tauri CSP needs media-src blob:), and unknown binary
 * content through the hex view. Items with no content and no path (history entries) show as gone.
 * "Open with system app" is intentionally absent: no client command opens a file path (openExternal
 * is for URLs only), so it needs a backend command first.
 */
export function AttachmentViewer(props: AttachmentViewerProps) {
  return <Modal label={`Attachment ${props.item.name}`} class="att-viewer" onClose={props.onClose}>
    <AttachmentBody {...props} closable />
  </Modal>;
}

/** The same viewer laid out inside a workbench tab instead of a dialog. */
export function AttachmentView(props: AttachmentViewProps) {
  return <section class="att-viewer att-viewer-tab" aria-label={`Attachment ${props.item.name}`}>
    <AttachmentBody {...props} closable={false} />
  </section>;
}

function AttachmentBody(props: AttachmentViewProps & { closable: boolean }) {
  const [loaded, setLoaded] = createSignal<ViewerContent>({ status: 'loading' });
  const hasData = () => props.item.bytes !== undefined || props.item.text !== undefined;
  // Path-only workspace rasters are fetched through the supplied loader. Nothing else is read lazily.
  const lazy = () => !hasData() && props.item.status === 'ready' && props.item.kind === 'image' && !!props.item.path && !isSvgMime(props.item.mime) && !!props.loadImage;
  createEffect(() => {
    if (!lazy()) return;
    const path = props.item.path!;
    let live = true;
    onCleanup(() => { live = false; });
    setLoaded({ status: 'loading' });
    props.loadImage!(path).then(source => {
      if (!live) return;
      const image = safeRasterSource(source);
      setLoaded({ status: 'ready', bytes: dataUrlBytes(image.url) });
    }).catch(cause => { if (live) setLoaded({ status: 'error', message: message(cause) }); });
  });

  const content = createMemo<ViewerContent>(() => {
    const item = props.item;
    if (item.status === 'loading') return { status: 'loading' };
    if (item.status === 'error') return { status: 'error', message: item.error ?? 'This attachment could not be read.' };
    if (item.bytes) return { status: 'ready', bytes: item.bytes };
    if (item.text !== undefined) return { status: 'ready', text: item.text };
    if (lazy()) return loaded();
    if (!item.path) return { status: 'gone', reason: 'The content of this attachment is no longer available.' };
    return { status: 'error', message: 'The content of this file is not available here. Open it in the editor instead.' };
  });

  const canSave = () => !!props.onSaveToWorkspace && !isInWorkspace(props.item) && !props.nativeUnavailable;
  const canOpen = () => !!props.onOpenInEditor && isInWorkspace(props.item);
  const nativeNotice = () => props.nativeUnavailable && ((props.onSaveToWorkspace && !isInWorkspace(props.item)) || canOpen()) ? props.nativeUnavailable : undefined;

  return <>
    <header class="att-viewer-header">
      <AttachmentIcon kind={props.item.kind} size={14} />
      <strong class="att-viewer-title" title={props.item.name}>{props.item.name}</strong>
      <span class="att-viewer-kind">{kindLabels[props.item.kind]}</span>
      <Show when={props.closable && props.onClose}>{close => <button type="button" class="att-viewer-close" autofocus aria-label="Close attachment viewer" onClick={() => close()()}><Icon name="CloseCircle" size={14} /></button>}</Show>
    </header>
    <Show when={props.blockedReason}><div class="att-viewer-notice att-viewer-blocked" role="note">Not sent: {props.blockedReason}</div></Show>
    <div class="att-viewer-stage">
      <FileViewer
        name={props.item.name}
        mime={props.item.mime}
        size={props.item.size || undefined}
        content={content()}
        source={props.source}
        inWorkspace={props.item.source === 'workspace-file' && !!props.item.path}
        onSaveToWorkspace={canSave() ? () => props.onSaveToWorkspace!(props.item) : undefined}
        onCopyPath={props.onCopyPath && props.item.path ? () => props.onCopyPath!(props.item.path!) : undefined}
        onShowInSession={props.onShowInSession ? () => props.onShowInSession!(props.item) : undefined}
        onRemove={props.onRemove ? () => { props.onRemove!(props.item); props.onClose?.(); } : undefined}
        onShowSessionList={props.onShowSessionList}
      />
    </div>
    <Show when={nativeNotice()}><div class="att-viewer-notice" role="note">{nativeNotice()}</div></Show>
    <Show when={canOpen()}>
      <footer class="att-viewer-actions">
        <button type="button" class="att-action" disabled={!!props.nativeUnavailable} title={props.nativeUnavailable} onClick={() => props.onOpenInEditor!(props.item)}><Icon name="Code1" size={13} />Open in editor</button>
      </footer>
    </Show>
  </>;
}
