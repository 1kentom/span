import { Match, Show, Switch, createEffect, createMemo, createSignal, on } from 'solid-js';
import { MAX_IMAGE_BYTES, MAX_SVG_BYTES, formatAssetBytes, safeRasterSource, sanitizeSvg } from '../../lib/asset-preview';
import {
  TEXT_PREVIEW_BYTES, bytesToDataUrl, classifyFile, decodeTextPreview, formatDuration, isLikelyBinary, lineEnding, mediaMime, modeLabels, parseJson,
  rasterMime, splitLines, supportedModes, type ViewerMode,
} from '../../lib/viewer';
import type { ImageSource } from '../../bindings';
import { BrandIcon } from '../BrandIcon';
import Icon from '../Icon';
import { MarkdownPreview } from '../MarkdownPreview';
import { ActionsMenu, type MenuAction } from './ActionsMenu';
import { HexView } from './HexView';
import { ImageView } from './ImageView';
import { JsonView } from './JsonView';
import { MediaPlayer } from './MediaPlayer';
import { TextView } from './TextView';
import { ViewerState, type StateAction } from './ViewerStates';
// Document viewers (docx, pptx, xlsx, pdf, archives): OfficeView loads each viewer as a lazy chunk.
import { officeKindOf, type OfficeKind } from '../../lib/office/kind';
import { OfficeView } from './office/OfficeView';
import '../../styles/viewer.css';

export type ViewerContent =
  | { status: 'loading' }
  /** The attachment no longer exists, for example its session was deleted. */
  | { status: 'gone'; reason?: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; bytes?: Uint8Array; text?: string };

export interface ViewerSource {
  /** Agent brand, resolved by BrandIcon from id or name. */
  agent?: { id?: string; name?: string };
  /** Leading label, for example "Attachment from" or "Created by". */
  verb?: string;
  session?: string;
  /** Preformatted, for example "you, 14:02". */
  time?: string;
}

export interface FileViewerProps {
  name: string;
  mime?: string;
  /** Byte size. Falls back to the loaded content length. */
  size?: number;
  content: ViewerContent;
  source?: ViewerSource;
  /** Workspace files are not read-only attachments: the banner and footer tag are hidden. */
  inWorkspace?: boolean;
  /** Initial mode for kinds that have one. Reset when the file changes. */
  defaultMode?: ViewerMode;
  onModeChange?: (mode: ViewerMode) => void;
  /** Each action is shown only when its handler is given. Handlers may be async, failures are shown. */
  onSaveToWorkspace?: () => void | Promise<void>;
  onOpenWithSystem?: () => void | Promise<void>;
  onShowInSession?: () => void | Promise<void>;
  onCopyPath?: () => void | Promise<void>;
  onRemove?: () => void | Promise<void>;
  /** Action of the "gone" state. */
  onShowSessionList?: () => void;
}

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const encoder = new TextEncoder();

type View =
  | { t: 'loading' } | { t: 'gone'; text: string } | { t: 'damaged'; text: string }
  | { t: 'unsupported'; title: string; text: string }
  | { t: 'too-large'; text: string; canShow: boolean }
  | { t: 'image'; src: string } | { t: 'svg'; src?: string; error?: string; source: string }
  | { t: 'media'; kind: 'audio' | 'video'; bytes: Uint8Array; mime: string }
  | { t: 'text'; text: string; truncated: string }
  | { t: 'markdown'; text: string; truncated: string }
  | { t: 'json'; text: string; value?: unknown; error?: string; truncated: string }
  | { t: 'hex'; bytes: Uint8Array; binary: boolean }
  | { t: 'office'; kind: OfficeKind; bytes: Uint8Array };

export function FileViewer(props: FileViewerProps) {
  const [mode, setMode] = createSignal<ViewerMode>(props.defaultMode ?? 'preview');
  const [asBinary, setAsBinary] = createSignal(false);
  const [showLarge, setShowLarge] = createSignal(false);
  const [damaged, setDamaged] = createSignal('');
  const [dimensions, setDimensions] = createSignal('');
  const [duration, setDuration] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal('');
  const [failure, setFailure] = createSignal('');
  const identity = () => [props.name, props.content] as const;
  // Document viewers report their own footer facts (pages, words, slides, sheets).
  const [officeMeta, setOfficeMeta] = createSignal<string[]>([]);
  createEffect(on(identity, () => setOfficeMeta([])));
  createEffect(on(identity, () => { setMode(props.defaultMode ?? 'preview'); setAsBinary(false); setShowLarge(false); setDamaged(''); setDimensions(''); setDuration(0); setStatus(''); setFailure(''); }));

  const classification = createMemo(() => classifyFile(props.name, props.mime));
  const bytes = createMemo(() => {
    const content = props.content;
    if (content.status !== 'ready') return undefined;
    return content.bytes ?? (content.text !== undefined ? encoder.encode(content.text) : undefined);
  });
  const size = () => props.size ?? bytes()?.length ?? 0;
  const modes = createMemo(() => supportedModes(classification().kind));

  const view = createMemo<View>(() => {
    const content = props.content;
    if (content.status === 'loading') return { t: 'loading' };
    if (content.status === 'gone') return { t: 'gone', text: content.reason ?? 'This attachment is no longer available. Its session was deleted.' };
    if (content.status === 'error') return { t: 'damaged', text: content.message };
    if (damaged()) return { t: 'damaged', text: damaged() };
    const data = bytes();
    const { kind, reason, label } = classification();
    if (asBinary()) return data ? { t: 'hex', bytes: data, binary: false } : { t: 'damaged', text: 'File data is not available.' };
    const office = officeKindOf(props.name, props.mime);
    if (office) return data ? { t: 'office', kind: office, bytes: data } : { t: 'damaged', text: 'File data is not available.' };
    if (kind === 'unsupported') {
      return reason === 'format'
        ? { t: 'unsupported', title: 'Format not supported', text: 'Preview supports PNG, JPEG, GIF, WebP and SVG. This format is not supported.' }
        : { t: 'unsupported', title: 'Preview not available yet', text: `${label} files cannot be previewed here yet. Nothing is shown rather than an approximation.` };
    }
    if (kind === 'image') {
      if (!data) return { t: 'damaged', text: 'Image data is not available.' };
      if (size() > MAX_IMAGE_BYTES) return { t: 'too-large', text: `This image is ${formatAssetBytes(size())}. Image preview is limited to 8 MiB.`, canShow: false };
      try { const image = safeRasterSource({ mime: rasterMime(props.name, props.mime), dataUrl: bytesToDataUrl(data, rasterMime(props.name, props.mime)) } as ImageSource); return { t: 'image', src: image.url }; }
      catch (cause) { return { t: 'damaged', text: errorMessage(cause) }; }
    }
    if (kind === 'audio' || kind === 'video') {
      if (!data) return { t: 'damaged', text: 'Media data is not available.' };
      return { t: 'media', kind, bytes: data, mime: mediaMime(props.name, props.mime) };
    }
    if (!data) return { t: 'damaged', text: 'File data is not available.' };
    if (kind === 'svg') {
      const preview = decodeTextPreview(data);
      const source = preview?.text ?? '';
      if (data.length > MAX_SVG_BYTES) return { t: 'svg', source, error: 'SVG preview is limited to 1 MiB. Source is shown instead.' };
      if (!preview) return { t: 'damaged', text: 'This SVG is not valid text.' };
      try { return { t: 'svg', source, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvg(source).source)}` }; }
      catch (cause) { return { t: 'svg', source, error: errorMessage(cause) }; }
    }
    if (isLikelyBinary(data)) return { t: 'hex', bytes: data, binary: true };
    const preview = decodeTextPreview(data);
    if (!preview) return { t: 'hex', bytes: data, binary: true };
    if (preview.truncated && !showLarge()) return { t: 'too-large', text: `This file is ${formatAssetBytes(preview.totalBytes)}. Showing the first 2 MiB keeps the viewer responsive.`, canShow: true };
    const truncated = preview.truncated ? `Showing the first ${formatAssetBytes(TEXT_PREVIEW_BYTES)} of ${formatAssetBytes(preview.totalBytes)}.` : '';
    if (kind === 'markdown') return { t: 'markdown', text: preview.text, truncated };
    if (kind === 'json') {
      if (preview.truncated) return { t: 'json', text: preview.text, error: 'Only the first 2 MiB is loaded, so it cannot be parsed as JSON. Showing text.', truncated };
      const parsed = parseJson(preview.text);
      return parsed.ok ? { t: 'json', text: preview.text, value: parsed.value, truncated } : { t: 'json', text: preview.text, error: `Not valid JSON (${parsed.message}). Showing text.`, truncated };
    }
    return { t: 'text', text: preview.text, truncated };
  });

  const textInfo = createMemo(() => { const v = view(); return v.t === 'text' || v.t === 'markdown' || v.t === 'json' ? v.text : undefined; });
  const readOnlyBanner = () => !props.inWorkspace && ['text', 'markdown', 'json', 'hex'].includes(view().t) && !(view() as { binary?: boolean }).binary;
  const kindLabel = () => ({ image: 'Image', svg: 'SVG', markdown: 'Markdown', json: 'JSON', text: 'Text', audio: 'Audio', video: 'Video', unsupported: 'File' })[classification().kind];

  async function run(label: string, action: () => void | Promise<void>) {
    setFailure(''); setStatus(''); setBusy(true);
    try { await action(); setStatus(`${label} done`); }
    catch (cause) { setFailure(`${label} failed: ${errorMessage(cause)}`); }
    finally { setBusy(false); }
  }
  const menuActions = createMemo<MenuAction[]>(() => {
    const list: MenuAction[] = [];
    if (props.onOpenWithSystem) list.push({ id: 'open', label: 'Open with system app', icon: 'ExportSquare', run: () => void run('Open with system app', props.onOpenWithSystem!) });
    if (props.onShowInSession) list.push({ id: 'session', label: 'Show in session', icon: 'Message', run: () => void run('Show in session', props.onShowInSession!) });
    if (props.onCopyPath) list.push({ id: 'copy', label: 'Copy path', icon: 'Copy', run: () => void run('Copy path', props.onCopyPath!) });
    if (props.onRemove) list.push({ id: 'remove', label: 'Remove', icon: 'Trash', danger: true, run: () => void run('Remove', props.onRemove!) });
    return list;
  });
  const asBinaryAction = (label: string): StateAction => ({ label, onClick: () => { setDamaged(''); setAsBinary(true); } });
  const externalAction = (): StateAction[] => props.onOpenWithSystem ? [{ label: 'Open with system app', onClick: () => void run('Open with system app', props.onOpenWithSystem!), primary: true }] : [];
  const changeMode = (next: ViewerMode) => { setMode(next); props.onModeChange?.(next); };

  const footer = createMemo(() => {
    const parts: string[] = [];
    if (dimensions()) parts.push(dimensions());
    if (duration()) parts.push(formatDuration(duration()));
    if (size()) parts.push(formatAssetBytes(size()));
    const text = textInfo();
    if (text !== undefined) parts.push(`${splitLines(text).length} lines`, 'UTF-8', lineEnding(text) === 'none' ? 'LF' : lineEnding(text));
    if (view().t === 'office') parts.push(...officeMeta());
    else if (props.mime) parts.push(props.mime);
    else parts.push(kindLabel());
    return parts;
  });
  const preview = () => mode() !== 'source';
  const source = () => mode() !== 'preview';

  return <section class="vw" aria-label={`Viewer for ${props.name}`} data-kind={view().t}>
    <header class="vw-source">
      <Show when={props.source?.agent}><BrandIcon {...props.source!.agent} size={14} /></Show>
      <Show when={props.source}>
        <span class="vw-dim">{props.source!.verb ?? 'Attachment from'}</span>
        <Show when={props.source!.session}><strong class="vw-session" title={props.source!.session}>{props.source!.session}</strong></Show>
        <Show when={props.source!.time}><span class="vw-dim">· {props.source!.time}</span></Show>
      </Show>
      <span class="vw-spacer" />
      <Show when={modes().length > 1 && ['svg', 'markdown', 'json'].includes(view().t)}>
        <div class="vw-group vw-modes" role="group" aria-label="View mode">
          {modes().map(item => <button type="button" class="vw-btn" aria-pressed={mode() === item} onClick={() => changeMode(item)}>{modeLabels[item]}</button>)}
        </div>
      </Show>
      <Show when={props.onSaveToWorkspace && !props.inWorkspace}><button type="button" class="vw-btn vw-btn-outline" disabled={busy()} onClick={() => void run('Save to workspace', props.onSaveToWorkspace!)}>Save to workspace</button></Show>
      <Show when={menuActions().length}><ActionsMenu actions={menuActions()} /></Show>
    </header>
    <Show when={readOnlyBanner()}><div class="vw-banner" role="note"><Icon name="Eye" size={12} /><strong>Read-only attachment</strong><span class="vw-dim">, not in the workspace</span></div></Show>
    <Show when={failure()}><div class="vw-banner vw-banner-error" role="alert">{failure()}</div></Show>
    <Show when={status()}><div class="vw-banner" role="status">{status()}</div></Show>
    <div class="vw-body">
      <Switch>
        <Match when={view().t === 'loading'}><ViewerState kind="loading" text={`Loading ${props.name}…`} /></Match>
        <Match when={view().t === 'gone'}><ViewerState kind="gone" title="Attachment gone" text={(view() as { text: string }).text} actions={props.onShowSessionList ? [{ label: 'Show session list', onClick: props.onShowSessionList }] : []} /></Match>
        <Match when={view().t === 'damaged'}><ViewerState kind="damaged" title="Cannot open this file" text={(view() as { text: string }).text} actions={bytes() ? [asBinaryAction('Open as binary')] : []} /></Match>
        <Match when={view().t === 'unsupported'}>{(() => { const v = () => view() as { title: string; text: string }; return <ViewerState kind="unsupported" title={v().title} text={v().text} actions={[...externalAction(), ...(bytes() ? [asBinaryAction('View as binary')] : [])]} />; })()}</Match>
        <Match when={view().t === 'too-large'}>{(() => { const v = () => view() as { text: string; canShow: boolean }; return <ViewerState kind="too-large" title="Large file" text={v().text} actions={[...(v().canShow ? [{ label: 'Show first 2 MiB', onClick: () => setShowLarge(true), primary: true }] : []), ...externalAction().map(a => ({ ...a, primary: false }))]} />; })()}</Match>
        <Match when={view().t === 'image'}><ImageView src={(view() as { src: string }).src} name={props.name} onDimensions={(w, h) => setDimensions(`${w} × ${h} px`)} onDamaged={setDamaged} /></Match>
        <Match when={view().t === 'svg'}>{(() => { const v = () => view() as { src?: string; error?: string; source: string };
          return <div class="vw-split" classList={{ 'vw-single': mode() !== 'split' }}>
            <Show when={source()}><div class="vw-pane"><TextView text={v().source} name={props.name} /></div></Show>
            <Show when={preview()}><div class="vw-pane">
              <Show when={v().src} fallback={<ViewerState kind="damaged" title="SVG preview unavailable" text={v().error ?? 'The SVG could not be previewed.'} actions={mode() === 'preview' ? [{ label: 'Show source', onClick: () => changeMode('source') }] : []} />}>
                <ImageView src={v().src!} name={props.name} isSvg onDimensions={(w, h) => setDimensions(`${w} × ${h} px`)} onDamaged={setDamaged} />
              </Show>
            </div></Show>
          </div>; })()}</Match>
        <Match when={view().t === 'media'}>{(() => { const v = () => view() as { kind: 'audio' | 'video'; bytes: Uint8Array; mime: string };
          return <MediaPlayer kind={v().kind} bytes={v().bytes} mime={v().mime} name={props.name} onDuration={setDuration} onVideoSize={(w, h) => setDimensions(`${w} × ${h}`)} onDamaged={setDamaged} />; })()}</Match>
        <Match when={view().t === 'text'}>{(() => { const v = () => view() as { text: string; truncated: string };
          return <><Show when={v().truncated}><p class="vw-note" role="note">{v().truncated}</p></Show><TextView text={v().text} name={props.name} /></>; })()}</Match>
        <Match when={view().t === 'markdown'}>{(() => { const v = () => view() as { text: string; truncated: string };
          return <div class="vw-split" classList={{ 'vw-single': mode() !== 'split' }}>
            <Show when={source()}><div class="vw-pane"><Show when={v().truncated}><p class="vw-note" role="note">{v().truncated}</p></Show><TextView text={v().text} name={props.name} /></div></Show>
            <Show when={preview()}><div class="vw-pane vw-markdown"><MarkdownPreview text={v().text} documentPath={`/attachment/${props.name}`} workspaceRoot="/attachment" /></div></Show>
          </div>; })()}</Match>
        <Match when={view().t === 'json'}>{(() => { const v = () => view() as { text: string; value?: unknown; error?: string; truncated: string };
          return <>
            <Show when={v().error}><p class="vw-note vw-note-error" role="alert">{v().error}</p></Show>
            <Show when={v().error || mode() === 'source'} fallback={<JsonView value={v().value} name={props.name} />}><TextView text={v().text} name={props.name} /></Show>
          </>; })()}</Match>
        <Match when={view().t === 'office'}>{(() => { const v = () => view() as { kind: OfficeKind; bytes: Uint8Array };
          return <OfficeView kind={v().kind} name={props.name} bytes={v().bytes} onMeta={setOfficeMeta} onOpenWithSystem={props.onOpenWithSystem ? () => void run('Open with system app', props.onOpenWithSystem!) : undefined} />; })()}</Match>
        <Match when={view().t === 'hex'}>{(() => { const v = () => view() as { bytes: Uint8Array; binary: boolean };
          return <>
            <HexView bytes={v().bytes} name={props.name} />
            <Show when={v().binary}><div class="vw-banner vw-binary" role="note"><span>Binary file · {props.mime || 'application/octet-stream'}</span><span class="vw-spacer" />
              <Show when={props.onOpenWithSystem}><button type="button" class="vw-btn vw-btn-outline" onClick={() => void run('Open with system app', props.onOpenWithSystem!)}>Open with system app</button></Show></div></Show>
          </>; })()}</Match>
      </Switch>
    </div>
    <footer class="vw-footer">
      <span class="vw-footer-name" title={props.name}>{props.name}</span>
      {footer().map(part => <span>{part}</span>)}
      <span class="vw-spacer" />
      <Show when={view().t === 'svg' && (view() as { src?: string }).src}><span>Isolated SVG preview</span></Show>
      <Show when={!props.inWorkspace}><span>Read-only attachment</span></Show>
    </footer>
  </section>;
}
