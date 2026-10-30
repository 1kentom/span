import { Match, Show, Switch, createEffect, createMemo, createSignal, on } from 'solid-js';
import { MAX_IMAGE_BYTES, MAX_SVG_BYTES, formatAssetBytes, safeRasterSource, sanitizeSvg } from '../../lib/asset-preview';
import type { UploadExtras } from '../../lib/uploads-api';
import type { ArchiveApi } from '../../lib/archive-api';
import {
  FONT_READ_BYTES, MEDIA_MAX_BYTES, TEXT_PREVIEW_BYTES, bytesToDataUrl, classifyFile, decodeTextPreview, formatDuration, isLikelyBinary, lineEnding, mediaMime, modeLabelFor, modeUsesIcons, parseJson,
  rasterMime, splitLines, supportedModes, type ViewerMode,
} from '../../lib/viewer';
import type { ImageSource } from '../../bindings';
import { BrandIcon } from '../BrandIcon';
import Icon from '../Icon';
import { MarkdownPreview } from '../MarkdownPreview';
import { UploadMenu } from '../uploads/UploadMenu';
import type { MenuItem } from '../uploads/upload-model';
import { ActionsMenu, type MenuAction } from './ActionsMenu';
import { AudioView } from './AudioView';
import { CodeView } from './CodeView';
import { CsvView } from './CsvView';
import { FontView } from './FontView';
import { HexView } from './HexView';
import { HtmlView } from './HtmlView';
import { ImageView, type ImageZoom } from './ImageView';
import { JsonView } from './JsonView';
import { MediaPlayer } from './MediaPlayer';
import { ModeSwitch, type ModeOption } from './ModeSwitch';
import { mdxToMarkdown } from './mdx';
import { TextView } from './TextView';
import { TypeIcon, ViewerState, type StateAction } from './ViewerStates';
// Document viewers (docx, pptx, xlsx, pdf, archives): OfficeView loads each viewer as a lazy chunk.
import { OFFICE_PREVIEW_BYTES } from '../../lib/office/limits';
import { officeKindOf, officeLabels, type OfficeKind } from '../../lib/office/kind';
import { OfficeView } from './office/OfficeView';
import '../../styles/viewer.css';

export type ViewerContent =
  | { status: 'loading' }
  /** The attachment no longer exists, for example its session was deleted. */
  | { status: 'gone'; reason?: string }
  | { status: 'error'; message: string }
  /** `bytes` may be a prefix of the file (see readLimit); `size` on the viewer is the full size. */
  | { status: 'ready'; bytes?: Uint8Array; text?: string };

export interface ViewerSource {
  /** Agent brand, resolved by BrandIcon from id or name. */
  agent?: { id?: string; name?: string };
  /** Leading words, for example "Attached in" or "Created by Codex in". Defaults to "Attached in". */
  verb?: string;
  session?: string;
  /** Preformatted, for example "14:02". */
  time?: string;
}

export interface FileViewerProps {
  name: string;
  /** Native archive backend (ADR 0016). With it an archive is listed by Rust and its bytes are not needed. */
  archiveApi?: ArchiveApi;
  onCopyArchivePath?: (path: string) => void;
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
  /** Controlled "Open with" choice. Uncontrolled (local) when omitted. */
  viewAs?: 'preview' | 'hex';
  onViewAsChange?: (viewAs: 'preview' | 'hex') => void;
  /** When given, the source bar shows an "Open with" menu: Span preview, Binary (hex), and these external entries. */
  openWith?: { system?: () => void | Promise<void>; choose?: () => void | Promise<void> };
  /** Optional transcript or chapters for audio. */
  extras?: UploadExtras;
  /** Each action is shown only when its handler is given. Handlers may be async, failures are shown. */
  onSaveToWorkspace?: () => void | Promise<void>;
  onOpenWithSystem?: () => void | Promise<void>;
  onReveal?: () => void | Promise<void>;
  revealLabel?: string;
  onShowInSession?: () => void | Promise<void>;
  onCopyPath?: () => void | Promise<void>;
  onRemove?: () => void | Promise<void>;
  /** Action of the "gone" state. */
  onShowSessionList?: () => void;
  /** False when the host reports action outcomes itself (the uploads workspace uses toasts). Default true. */
  reportActions?: boolean;
}

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const encoder = new TextEncoder();

type TextKind = 'text' | 'markdown' | 'mdx' | 'html' | 'csv';
type View =
  | { t: 'loading' } | { t: 'gone'; text: string } | { t: 'damaged'; text: string }
  | { t: 'unsupported'; title: string; text: string }
  | { t: 'too-large'; text: string; canShow: boolean }
  | { t: 'image'; src: string } | { t: 'svg'; src?: string; error?: string; source: string }
  | { t: 'media'; kind: 'audio' | 'video'; bytes: Uint8Array; mime: string }
  | { t: 'font'; bytes: Uint8Array }
  | { t: TextKind; text: string; truncated: string }
  | { t: 'json'; text: string; value?: unknown; error?: string; truncated: string }
  | { t: 'hex'; bytes: Uint8Array; binary: boolean }
  | { t: 'office'; kind: OfficeKind; bytes: Uint8Array };

const kindLabels: Record<string, string> = { image: 'Image', svg: 'SVG', markdown: 'Markdown', mdx: 'MDX', html: 'HTML', json: 'JSON', csv: 'CSV', font: 'Font', text: 'Text', audio: 'Audio', video: 'Video', unsupported: 'File' };
const modeIcons: Record<ViewerMode, string> = { preview: 'markdown-preview', split: 'markdown-both', source: 'markdown-source' };
const modeTips: Record<ViewerMode, string> = { preview: 'Preview', split: 'Source and preview side by side', source: 'Source' };

export function FileViewer(props: FileViewerProps) {
  const [mode, setMode] = createSignal<ViewerMode>(props.defaultMode ?? 'preview');
  const [localBinary, setLocalBinary] = createSignal(false);
  const [showLarge, setShowLarge] = createSignal(false);
  const [damaged, setDamaged] = createSignal('');
  const [dimensions, setDimensions] = createSignal('');
  const [duration, setDuration] = createSignal(0);
  const [extraMeta, setExtraMeta] = createSignal<string[]>([]);
  const [imageZoom, setImageZoom] = createSignal<ImageZoom>('fit');
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal('');
  const [failure, setFailure] = createSignal('');
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  const identity = () => [props.name, props.content] as const;
  // Document viewers report their own footer facts (pages, words, slides, sheets).
  const [officeMeta, setOfficeMeta] = createSignal<string[]>([]);
  createEffect(on(identity, () => setOfficeMeta([])));
  createEffect(on(identity, () => { setMode(props.defaultMode ?? 'preview'); setLocalBinary(false); setShowLarge(false); setDamaged(''); setDimensions(''); setDuration(0); setExtraMeta([]); setImageZoom('fit'); setStatus(''); setFailure(''); }));

  const asBinary = () => props.viewAs !== undefined ? props.viewAs === 'hex' : localBinary();
  const setAsBinary = (value: boolean) => { setDamaged(''); setLocalBinary(value); props.onViewAsChange?.(value ? 'hex' : 'preview'); };
  const classification = createMemo(() => classifyFile(props.name, props.mime));
  const bytes = createMemo(() => {
    const content = props.content;
    if (content.status !== 'ready') return undefined;
    return content.bytes ?? (content.text !== undefined ? encoder.encode(content.text) : undefined);
  });
  const size = () => props.size ?? bytes()?.length ?? 0;
  const modes = createMemo(() => supportedModes(classification().kind));
  const canBinary = () => !!bytes() || !!props.onViewAsChange;

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
    if (office === 'archive' && props.archiveApi) return { t: 'office', kind: office, bytes: data ?? new Uint8Array() };
    if (office) {
      const limit = OFFICE_PREVIEW_BYTES[office];
      if (Math.max(size(), data?.byteLength ?? 0) > limit) return { t: 'too-large', text: `${officeLabels[office]} preview is limited to ${formatAssetBytes(limit)}.`, canShow: false };
      if (!data) return { t: 'damaged', text: 'File data is not available.' };
      if (data.byteLength < size()) return { t: 'damaged', text: 'The file data is incomplete. Refresh the upload and try again.' };
      return { t: 'office', kind: office, bytes: data };
    }
    if (kind === 'unsupported') {
      const title = `${label} files cannot be previewed here`;
      if (reason === 'format' && label === 'Image') return { t: 'unsupported', title, text: 'Preview supports PNG, JPEG, GIF, WebP and SVG. This format is not supported.' };
      if (reason === 'format') return { t: 'unsupported', title, text: `${label} files need their own application. Open the file there, or view the raw bytes.` };
      return { t: 'unsupported', title, text: `Span does not preview ${label} files yet. Nothing is shown rather than an approximation.` };
    }
    if (kind === 'image' && size() > MAX_IMAGE_BYTES) return { t: 'too-large', text: `This image is ${formatAssetBytes(size())}. Image preview is limited to 8 MiB.`, canShow: false };
    if ((kind === 'audio' || kind === 'video') && size() > MEDIA_MAX_BYTES) return { t: 'too-large', text: `This file is ${formatAssetBytes(size())}. Audio and video over 256 MiB are not loaded into the viewer.`, canShow: false };
    if (kind === 'font' && size() > FONT_READ_BYTES) return { t: 'damaged', text: `This font is ${formatAssetBytes(size())}. Fonts larger than 16 MiB are not previewed.` };
    if (kind === 'image') {
      if (!data) return { t: 'damaged', text: 'Image data is not available.' };
      try { const image = safeRasterSource({ mime: rasterMime(props.name, props.mime), dataUrl: bytesToDataUrl(data, rasterMime(props.name, props.mime)) } as ImageSource); return { t: 'image', src: image.url }; }
      catch (cause) { return { t: 'damaged', text: errorMessage(cause) }; }
    }
    if (kind === 'audio' || kind === 'video') {
      if (!data) return { t: 'damaged', text: 'Media data is not available.' };
      return { t: 'media', kind, bytes: data, mime: mediaMime(props.name, props.mime) };
    }
    if (!data) return { t: 'damaged', text: 'File data is not available.' };
    if (kind === 'font') return { t: 'font', bytes: data };
    if (kind === 'svg') {
      const preview = decodeTextPreview(data, TEXT_PREVIEW_BYTES, size());
      const source = preview?.text ?? '';
      if (size() > MAX_SVG_BYTES) return { t: 'svg', source, error: 'SVG preview is limited to 1 MiB. Source is shown instead.' };
      if (!preview) return { t: 'damaged', text: 'This SVG is not valid text.' };
      try { return { t: 'svg', source, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizeSvg(source).source)}` }; }
      catch (cause) { return { t: 'svg', source, error: errorMessage(cause) }; }
    }
    if (isLikelyBinary(data)) return { t: 'hex', bytes: data, binary: true };
    const preview = decodeTextPreview(data, TEXT_PREVIEW_BYTES, size());
    if (!preview) return { t: 'hex', bytes: data, binary: true };
    if (preview.truncated && !showLarge()) return { t: 'too-large', text: `This file is ${formatAssetBytes(preview.totalBytes)}. Showing the first 2 MiB keeps the viewer responsive.`, canShow: true };
    const truncated = preview.truncated ? `Showing the first ${formatAssetBytes(preview.shownBytes)} of ${formatAssetBytes(preview.totalBytes)}.` : '';
    if (kind === 'markdown' || kind === 'mdx' || kind === 'html' || kind === 'csv') return { t: kind, text: preview.text, truncated };
    if (kind === 'json') {
      if (preview.truncated) return { t: 'json', text: preview.text, error: 'Only the first 2 MiB is loaded, so it cannot be parsed as JSON. Showing text.', truncated };
      const parsed = parseJson(preview.text);
      return parsed.ok ? { t: 'json', text: preview.text, value: parsed.value, truncated } : { t: 'json', text: preview.text, error: `Not valid JSON (${parsed.message}). Showing text.`, truncated };
    }
    return { t: 'text', text: preview.text, truncated };
  });

  const textInfo = createMemo(() => { const v = view(); return ['text', 'markdown', 'mdx', 'html', 'json'].includes(v.t) ? (v as { text: string }).text : undefined; });
  const readOnlyBanner = () => !props.inWorkspace && ['text', 'markdown', 'mdx', 'json', 'hex'].includes(view().t) && !(view() as { binary?: boolean }).binary;
  const showModes = () => modes().length > 1 && ['svg', 'markdown', 'mdx', 'html', 'json', 'csv'].includes(view().t) && !(view().t === 'json' && (view() as { error?: string }).error);
  const modeOptions = createMemo<ModeOption<ViewerMode>[]>(() => modes().map(id => ({ id, label: modeLabelFor(classification().kind, id), icon: modeIcons[id], tip: modeUsesIcons(classification().kind) ? modeTips[id] : undefined })));
  const imageMode = () => imageZoom() === 'fit' ? 'fit' : imageZoom() === 100 ? 'actual' : null;

  async function run(label: string, action: () => void | Promise<void>) {
    if (props.reportActions === false) { setBusy(true); try { await action(); } finally { setBusy(false); } return; }
    setFailure(''); setStatus(''); setBusy(true);
    try { await action(); setStatus(`${label} done`); }
    catch (cause) { setFailure(`${label} failed: ${errorMessage(cause)}`); }
    finally { setBusy(false); }
  }
  const menuActions = createMemo<MenuAction[]>(() => {
    const list: MenuAction[] = [];
    if (props.onOpenWithSystem && !props.openWith) list.push({ id: 'open', label: 'Open with system app', icon: 'ExportSquare', run: () => void run('Open with system app', props.onOpenWithSystem!) });
    if (props.onShowInSession) list.push({ id: 'session', label: 'Show in session', icon: 'Message', run: () => void run('Show in session', props.onShowInSession!) });
    if (props.onCopyPath) list.push({ id: 'copy', label: 'Copy path', icon: 'Copy', run: () => void run('Copy path', props.onCopyPath!) });
    if (props.onRemove) list.push({ id: 'remove', label: 'Remove', icon: 'Trash', danger: true, run: () => void run('Remove', props.onRemove!) });
    return list;
  });
  const openWithItems = (): MenuItem[] => {
    const external = props.openWith ?? {};
    const items: MenuItem[] = [
      { id: 'preview', label: 'Span preview', checked: !asBinary(), run: () => setAsBinary(false) },
      { id: 'hex', label: 'Binary (hex)', checked: asBinary(), run: () => setAsBinary(true) },
    ];
    if (external.system) items.push({ id: 'system', label: 'System default app', separatorBefore: true, run: () => void run('Open with system app', external.system!) });
    if (external.choose) items.push({ id: 'choose', label: 'Choose application…', separatorBefore: !external.system, run: () => void run('Choose application', external.choose!) });
    return items;
  };
  const asBinaryAction = (label: string): StateAction => ({ label, onClick: () => setAsBinary(true) });
  const systemOpen = () => props.openWith?.system ?? props.onOpenWithSystem;
  const externalAction = (): StateAction[] => systemOpen() ? [{ label: 'Open with system app', onClick: () => void run('Open with system app', systemOpen()!), primary: true }] : [];
  const revealAction = (): StateAction[] => props.onReveal ? [{ label: props.revealLabel ?? 'Reveal', onClick: () => void run(props.revealLabel ?? 'Reveal', props.onReveal!) }] : [];
  const changeMode = (next: ViewerMode) => { setMode(next); props.onModeChange?.(next); };

  const footer = createMemo(() => {
    const parts: string[] = [];
    if (dimensions()) parts.push(dimensions());
    if (duration()) parts.push(formatDuration(duration()));
    if (size()) parts.push(formatAssetBytes(size()));
    parts.push(...extraMeta());
    const text = textInfo();
    if (text !== undefined) parts.push(`${splitLines(text).length} lines`, 'UTF-8', lineEnding(text) === 'none' ? 'LF' : lineEnding(text));
    if (view().t === 'office') parts.push(...officeMeta());
    else if (!extraMeta().length || !['csv', 'font'].includes(view().t)) parts.push(props.mime || kindLabels[classification().kind]);
    return parts;
  });
  const preview = () => mode() !== 'source';
  const source = () => mode() !== 'preview';
  const split = (sourcePane: () => any, previewPane: () => any, note?: () => string) => <div class="vw-split" classList={{ 'vw-single': mode() !== 'split' }}>
    <Show when={source()}><div class="vw-pane"><Show when={note?.()}><p class="vw-note" role="note">{note!()}</p></Show>{sourcePane()}</div></Show>
    <Show when={preview()}><div class="vw-pane">{previewPane()}</div></Show>
  </div>;

  return <section class="vw" aria-label={`Viewer for ${props.name}`} data-kind={view().t}>
    <header class="vw-source">
      <Show when={props.source?.agent}><BrandIcon {...props.source!.agent} size={13} /></Show>
      <Show when={props.source}>
        <span class="vw-dim vw-nowrap">{props.source!.verb ?? 'Attached in'}</span>
        <Show when={props.source!.session}><strong class="vw-session" title={props.source!.session}>{props.source!.session}</strong></Show>
        <Show when={props.source!.time}><span class="vw-faint vw-nowrap">· {props.source!.time}</span></Show>
      </Show>
      <span class="vw-spacer" />
      <Show when={showModes()}>
        <ModeSwitch label="View mode" icons={modeUsesIcons(classification().kind)} options={modeOptions()} value={mode()} onChange={changeMode} />
      </Show>
      <Show when={view().t === 'image'}>
        <ModeSwitch label="Image size" options={[{ id: 'fit', label: 'Fit' }, { id: 'actual', label: 'Actual size' }]} value={imageMode()} onChange={value => setImageZoom(value === 'fit' ? 'fit' : 100)} />
      </Show>
      <Show when={(props.onSaveToWorkspace && !props.inWorkspace) || props.openWith}><span class="vw-divider" aria-hidden="true" /></Show>
      <Show when={props.onSaveToWorkspace && !props.inWorkspace}><button type="button" class="vw-btn" disabled={busy()} onClick={() => void run('Save to workspace', props.onSaveToWorkspace!)}><Icon name="ActionDownload" size={12} />Save to workspace</button></Show>
      <Show when={props.openWith}>
        <button type="button" class="vw-btn" aria-haspopup="menu" aria-expanded={!!menu()} onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); setMenu(menu() ? null : { x: bounds.left, y: bounds.bottom + 4 }); }}><Icon name="ExportSquare" size={12} />Open with</button>
      </Show>
      <Show when={menuActions().length}><ActionsMenu actions={menuActions()} /></Show>
    </header>
    <Show when={menu()}>{at => <UploadMenu items={openWithItems()} x={at().x} y={at().y} label="Open with" onClose={() => setMenu(null)} />}</Show>
    <Show when={readOnlyBanner()}><div class="vw-banner" role="note"><Icon name="Eye" size={12} /><strong>Read-only attachment</strong><span class="vw-dim">, not in the workspace</span></div></Show>
    <Show when={failure()}><div class="vw-banner vw-banner-error" role="alert">{failure()}</div></Show>
    <Show when={status()}><div class="vw-banner" role="status">{status()}</div></Show>
    <div class="vw-body">
      <Switch>
        <Match when={view().t === 'loading'}><ViewerState kind="loading" text={`Loading ${props.name}…`} /></Match>
        <Match when={view().t === 'gone'}><ViewerState kind="gone" title="Attachment gone" text={(view() as { text: string }).text} actions={props.onShowSessionList ? [{ label: 'Show session list', onClick: props.onShowSessionList }] : []} /></Match>
        <Match when={view().t === 'damaged'}><ViewerState kind="damaged" title="Cannot open this file" text={(view() as { text: string }).text} actions={canBinary() ? [asBinaryAction('Open as binary')] : []} /></Match>
        <Match when={view().t === 'unsupported'}>{(() => { const v = () => view() as { title: string; text: string };
          return <ViewerState kind="unsupported" title={v().title} text={v().text} icon={<TypeIcon path={props.name} />} actions={[...externalAction(), ...revealAction(), ...(canBinary() ? [asBinaryAction('View as binary')] : [])]} />; })()}</Match>
        <Match when={view().t === 'too-large'}>{(() => { const v = () => view() as { text: string; canShow: boolean }; return <ViewerState kind="too-large" title="Large file" text={v().text} actions={[...(v().canShow ? [{ label: 'Show first 2 MiB', onClick: () => setShowLarge(true), primary: true }] : []), ...externalAction().map(a => ({ ...a, primary: !v().canShow }))]} />; })()}</Match>
        <Match when={view().t === 'image'}><ImageView src={(view() as { src: string }).src} name={props.name} zoom={imageZoom()} onZoom={setImageZoom} onDimensions={(w, h) => setDimensions(`${w} × ${h} px`)} onDamaged={setDamaged} /></Match>
        <Match when={view().t === 'svg'}>{(() => { const v = () => view() as { src?: string; error?: string; source: string };
          return split(() => <CodeView text={v().source} name={props.name} language="xml" />, () => <Show when={v().src} fallback={<ViewerState kind="damaged" title="SVG preview unavailable" text={v().error ?? 'The SVG could not be previewed.'} actions={mode() === 'preview' ? [{ label: 'Show source', onClick: () => changeMode('source') }] : []} />}>
            <ImageView src={v().src!} name={props.name} isSvg onDimensions={(w, h) => setDimensions(`${w} × ${h} px`)} onDamaged={setDamaged} />
          </Show>); })()}</Match>
        <Match when={view().t === 'media'}>{(() => { const v = () => view() as { kind: 'audio' | 'video'; bytes: Uint8Array; mime: string };
          return <Show when={v().kind === 'audio'} fallback={<MediaPlayer kind="video" bytes={v().bytes} mime={v().mime} name={props.name} onDuration={setDuration} onVideoSize={(w, h) => setDimensions(`${w} × ${h}`)} onDamaged={setDamaged} />}>
            <AudioView bytes={v().bytes} mime={v().mime} name={props.name} extras={props.extras} onDuration={setDuration} onMeta={setExtraMeta} onDamaged={setDamaged} />
          </Show>; })()}</Match>
        <Match when={view().t === 'font'}><FontView bytes={(view() as { bytes: Uint8Array }).bytes} name={props.name} onMeta={setExtraMeta} onDamaged={setDamaged} /></Match>
        <Match when={view().t === 'text'}>{(() => { const v = () => view() as { text: string; truncated: string };
          return <><Show when={v().truncated}><p class="vw-note" role="note">{v().truncated}</p></Show><TextView text={v().text} name={props.name} /></>; })()}</Match>
        <Match when={view().t === 'markdown'}>{(() => { const v = () => view() as { text: string; truncated: string };
          return split(() => <CodeView text={v().text} name={props.name} language="markdown" />, () => <div class="vw-markdown"><MarkdownPreview text={v().text} documentPath={`/attachment/${props.name}`} workspaceRoot="/attachment" /></div>, () => v().truncated); })()}</Match>
        <Match when={view().t === 'mdx'}>{(() => { const v = () => view() as { text: string; truncated: string }; const reduced = createMemo(() => mdxToMarkdown(v().text));
          return split(() => <CodeView text={v().text} name={props.name} language="mdx" />, () => <div class="vw-markdown">
            <p class="vw-chip vw-chip-info" role="note"><Icon name="InfoCircle" size={11} />MDX components are not run here{reduced().components.length ? `: ${reduced().components.join(', ')}` : ''}. Only the Markdown is shown.</p>
            <MarkdownPreview text={reduced().markdown} documentPath={`/attachment/${props.name}`} workspaceRoot="/attachment" />
          </div>, () => v().truncated); })()}</Match>
        <Match when={view().t === 'html'}>{(() => { const v = () => view() as { text: string; truncated: string };
          return split(() => <CodeView text={v().text} name={props.name} language="xml" />, () => <HtmlView text={v().text} name={props.name} />, () => v().truncated); })()}</Match>
        <Match when={view().t === 'csv'}>{(() => { const v = () => view() as { text: string; truncated: string };
          return <Show when={mode() !== 'source'} fallback={<TextView text={v().text} name={props.name} />}><CsvView text={v().text} name={props.name} truncatedNote={v().truncated} onMeta={setExtraMeta} /></Show>; })()}</Match>
        <Match when={view().t === 'json'}>{(() => { const v = () => view() as { text: string; value?: unknown; error?: string; truncated: string };
          return <>
            <Show when={v().error}><p class="vw-note vw-note-error" role="alert">{v().error}</p></Show>
            <Show when={v().error || mode() === 'source'} fallback={<JsonView value={v().value} name={props.name} />}><TextView text={v().text} name={props.name} /></Show>
          </>; })()}</Match>
        <Match when={view().t === 'office'}>{(() => { const v = () => view() as { kind: OfficeKind; bytes: Uint8Array };
          return <OfficeView kind={v().kind} name={props.name} bytes={v().bytes} archiveApi={props.archiveApi} onCopyPath={props.onCopyArchivePath} onMeta={setOfficeMeta} onOpenWithSystem={props.onOpenWithSystem ? () => void run('Open with system app', props.onOpenWithSystem!) : undefined} />; })()}</Match>
        <Match when={view().t === 'hex'}>{(() => { const v = () => view() as { bytes: Uint8Array; binary: boolean };
          return <>
            <HexView bytes={v().bytes} name={props.name} />
            <Show when={v().binary}><div class="vw-banner vw-binary" role="note"><span>Binary file · {props.mime || 'application/octet-stream'}</span><span class="vw-spacer" />
              <Show when={systemOpen()}><button type="button" class="vw-btn vw-btn-outline" onClick={() => void run('Open with system app', systemOpen()!)}>Open with system app</button></Show></div></Show>
          </>; })()}</Match>
      </Switch>
    </div>
    <footer class="vw-footer">
      <span class="vw-footer-name" title={props.name}>{props.name}</span>
      {footer().map(part => <span>{part}</span>)}
      <span class="vw-spacer" />
      <Show when={view().t === 'svg' && (view() as { src?: string }).src}><span>Isolated SVG preview</span></Show>
      <Show when={view().t === 'html'}><span>Sandboxed preview</span></Show>
      <Show when={!props.inWorkspace}><span>Read-only attachment</span></Show>
    </footer>
  </section>;
}
