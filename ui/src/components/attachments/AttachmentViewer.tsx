import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { ImageSource } from '../../bindings';
import Icon from '../Icon';
import { Modal } from '../Modal';
import { formatAssetBytes, safeRasterSource, sanitizeSvg, validateImageDimensions } from '../../lib/asset-preview';
import { bytesToBase64, isInWorkspace, isRasterMime, isSvgMime, previewText, sourceLabels, type Attachment } from '../../lib/attachments';
import { AttachmentIcon, kindLabels } from './AttachmentChips';
import '../../styles/attachments.css';

export interface AttachmentViewerProps {
  item: Attachment;
  onClose: () => void;
  /** Why the connected agent cannot take this item. Shown as a notice. */
  blockedReason?: string;
  /** Set in browser preview. Native actions (save, open in editor) are shown disabled with this reason. */
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
}

type Preview = { state: 'none' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; url: string; bytes: number };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Resolve an image attachment to an inert data URL through the same sanitised paths as AssetPreview. */
export function imagePreviewFromBytes(item: Attachment): { url: string; bytes: number } {
  if (isSvgMime(item.mime)) {
    const source = item.text ?? (item.bytes ? new TextDecoder().decode(item.bytes) : undefined);
    if (source === undefined) throw new Error('SVG source is not available.');
    const clean = sanitizeSvg(source);
    return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean.source)}`, bytes: clean.bytes };
  }
  if (!isRasterMime(item.mime)) throw new Error('Preview supports PNG, JPEG, GIF, WebP and SVG. This format is not supported.');
  if (!item.bytes) throw new Error('Image data is not available.');
  const image = safeRasterSource({ mime: item.mime, dataUrl: `data:${item.mime};base64,${bytesToBase64(item.bytes)}` } as ImageSource);
  return { url: image.url, bytes: image.bytes };
}

export function AttachmentViewer(props: AttachmentViewerProps) {
  const [preview, setPreview] = createSignal<Preview>({ state: 'none' });
  const [dimensions, setDimensions] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal('');
  const [failure, setFailure] = createSignal('');
  let generation = 0;
  createEffect(() => {
    const item = props.item;
    const current = ++generation;
    onCleanup(() => { generation++; });
    setDimensions('');
    if (item.kind !== 'image') { setPreview({ state: 'none' }); return; }
    try { const image = imagePreviewFromBytes(item); setPreview({ state: 'ready', ...image }); return; }
    catch (cause) {
      if (item.bytes || item.text !== undefined || !item.path || !props.loadImage || isSvgMime(item.mime)) { setPreview({ state: 'error', message: message(cause) }); return; }
    }
    setPreview({ state: 'loading' });
    props.loadImage(item.path).then(source => {
      if (current !== generation) return;
      const image = safeRasterSource(source);
      setPreview({ state: 'ready', url: image.url, bytes: image.bytes });
    }).catch(cause => { if (current === generation) setPreview({ state: 'error', message: message(cause) }); });
  });
  const text = createMemo(() => props.item.text !== undefined && props.item.kind !== 'image' ? previewText(props.item.text) : undefined);
  const firstLine = () => props.item.lines?.start ?? 1;
  const canSave = () => !!props.onSaveToWorkspace && !isInWorkspace(props.item);
  const canOpen = () => !!props.onOpenInEditor && isInWorkspace(props.item);
  const canCopy = () => !!props.onCopyPath && !!props.item.path;

  async function run(label: string, action: () => void | Promise<void>) {
    setFailure(''); setStatus(''); setBusy(true);
    try { await action(); setStatus(label); }
    catch (cause) { setFailure(`${label.replace(/^Saved/, 'Could not save')}: ${message(cause)}`); }
    finally { setBusy(false); }
  }

  return <Modal label={`Attachment ${props.item.name}`} class="att-viewer" onClose={props.onClose}>
    <header class="att-viewer-header">
      <AttachmentIcon kind={props.item.kind} size={14} />
      <strong class="att-viewer-title" title={props.item.name}>{props.item.name}</strong>
      <span class="att-viewer-kind">{kindLabels[props.item.kind]}</span>
      <button type="button" class="att-viewer-close" autofocus aria-label="Close attachment viewer" onClick={props.onClose}><Icon name="CloseCircle" size={14} /></button>
    </header>
    <Show when={props.blockedReason}><div class="att-viewer-notice att-viewer-blocked" role="note">Not sent: {props.blockedReason}</div></Show>
    <div class="att-viewer-body">
      <Show when={props.item.kind === 'image'}>
        <div class="att-viewer-image" role="group" aria-label="Image preview">
          <Show when={preview().state === 'loading'}><p class="att-viewer-message" role="status">Loading image</p></Show>
          <Show when={preview().state === 'error'}><p class="att-viewer-message att-viewer-error" role="alert">{(preview() as { message: string }).message}</p></Show>
          <Show when={preview().state === 'ready'}>
            <img src={(preview() as { url: string }).url} alt={props.item.name} draggable={false}
              onLoad={event => { try { validateImageDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight); setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight} px`); } catch (cause) { setPreview({ state: 'error', message: message(cause) }); } }}
              onError={() => setPreview({ state: 'error', message: 'The browser could not decode this image. The file may be damaged or unsupported.' })} />
          </Show>
        </div>
      </Show>
      <Show when={text()}>{lines => <div class="att-viewer-text" role="region" aria-label="Text preview" tabIndex={0}>
        <For each={lines().lines}>{(line, index) => <div class="att-line"><span class="att-line-number" aria-hidden="true">{firstLine() + index()}</span><code>{line || ' '}</code></div>}</For>
        <Show when={lines().truncated}><p class="att-viewer-truncated" role="note">Preview truncated at {lines().lines.length} of {lines().totalLines} lines.</p></Show>
      </div>}</Show>
      <Show when={props.item.kind !== 'image' && text() === undefined}><p class="att-viewer-message" role="note">No inline preview for this file. Details are shown below.</p></Show>
    </div>
    <dl class="att-viewer-meta">
      <dt>Type</dt><dd>{props.item.mime}</dd>
      <Show when={props.item.size}><dt>Size</dt><dd>{formatAssetBytes(props.item.size)}</dd></Show>
      <Show when={dimensions()}><dt>Dimensions</dt><dd>{dimensions()}</dd></Show>
      <dt>Source</dt><dd>{sourceLabels[props.item.source]}</dd>
      <Show when={props.item.path}><dt>Path</dt><dd class="att-viewer-path">{props.item.path}</dd></Show>
      <Show when={props.item.lines}><dt>Lines</dt><dd>{props.item.lines!.start}{props.item.lines!.end !== props.item.lines!.start ? `–${props.item.lines!.end}` : ''}</dd></Show>
      <Show when={isSvgMime(props.item.mime) && props.item.kind === 'image'}><dt>Preview</dt><dd>Isolated SVG preview</dd></Show>
    </dl>
    <Show when={props.nativeUnavailable && (props.onSaveToWorkspace || props.onOpenInEditor)}><div class="att-viewer-notice" role="note">{props.nativeUnavailable}</div></Show>
    <Show when={failure()}><div class="att-viewer-notice att-viewer-blocked" role="alert">{failure()}</div></Show>
    <Show when={status()}><div class="att-viewer-notice" role="status">{status()}</div></Show>
    <footer class="att-viewer-actions">
      <Show when={canSave()}><button type="button" class="att-action" disabled={busy() || !!props.nativeUnavailable} title={props.nativeUnavailable} onClick={() => void run('Saved to workspace', () => props.onSaveToWorkspace!(props.item))}><Icon name="Folder2" size={13} />Save to workspace</button></Show>
      <Show when={canCopy()}><button type="button" class="att-action" onClick={() => void run('Path copied', () => props.onCopyPath!(props.item.path!))}><Icon name="Copy" size={13} />Copy path</button></Show>
      <Show when={canOpen()}><button type="button" class="att-action" disabled={!!props.nativeUnavailable} title={props.nativeUnavailable} onClick={() => props.onOpenInEditor!(props.item)}><Icon name="Code1" size={13} />Open in editor</button></Show>
      <Show when={props.onRemove}><button type="button" class="att-action att-action-danger" onClick={() => { props.onRemove!(props.item); props.onClose(); }}><Icon name="Trash" size={13} />Remove</button></Show>
    </footer>
  </Modal>;
}
