/** Pure logic for the File/Upload viewer: classification, limits, decoding, hex and JSON rows, tab model. */
import { MAX_IMAGE_BYTES, MAX_SVG_BYTES } from './asset-preview';

export { MAX_IMAGE_BYTES, MAX_SVG_BYTES };

/** Largest slice of a text file the viewer decodes and renders (design card 1h: "first 2 MiB"). */
export const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
/** Hex view shows this many bytes at most, 16 per row, so the DOM stays small (4,096 rows). */
export const HEX_PREVIEW_BYTES = 64 * 1024;
export const HEX_ROW_BYTES = 16;
/** Bytes inspected to decide that a file is binary. */
export const BINARY_SNIFF_BYTES = 8192;
/** Cap on rendered JSON tree rows. */
export const JSON_MAX_ROWS = 5000;
/**
 * Image zoom range, one range for the whole viewer: 10 to 800 percent in steps of 25.
 * This is the larger range from the Upload Viewer design and is the same range AssetPreview already uses.
 */
export const ZOOM_MIN = 10;
export const ZOOM_MAX = 800;
export const ZOOM_STEP = 25;
export const SEEK_SECONDS = 10;
export const VOLUME_STEP = 0.1;
export const PLAYBACK_SPEEDS = [0.5, 1, 1.5, 2] as const;

export type ViewerKind = 'image' | 'svg' | 'markdown' | 'json' | 'text' | 'audio' | 'video' | 'unsupported';
export type ViewerMode = 'preview' | 'split' | 'source';
export type UnsupportedReason = 'not-yet' | 'format';
export interface Classification { kind: ViewerKind; reason?: UnsupportedReason; label?: string }

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const rasterExt = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const videoExt = new Set(['mp4', 'm4v', 'mov', 'webm']);
const audioExt = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aac']);
/** Separate issues will build these. Until then they show the honest unsupported state, never fake content. */
const notYet: Record<string, string> = {
  pdf: 'PDF', docx: 'Word document', pptx: 'Presentation', xlsx: 'Spreadsheet', csv: 'CSV table', tsv: 'TSV table',
  zip: 'Archive', tar: 'Archive', tgz: 'Archive', gz: 'Archive', '7z': 'Archive', rar: 'Archive',
  ttf: 'Font', otf: 'Font', woff: 'Font', woff2: 'Font', html: 'HTML page', htm: 'HTML page', mdx: 'MDX document',
};
const otherImageExt = new Set(['bmp', 'ico', 'avif', 'tif', 'tiff', 'heic', 'psd']);

export function classifyFile(name: string, mime = ''): Classification {
  const ext = extensionOf(name);
  const type = mime.toLowerCase().split(';')[0].trim();
  if (ext === 'svg' || type === 'image/svg+xml') return { kind: 'svg' };
  if (rasterExt.has(ext) || /^image\/(?:png|jpeg|gif|webp)$/.test(type)) return { kind: 'image' };
  if (otherImageExt.has(ext) || type.startsWith('image/')) return { kind: 'unsupported', reason: 'format', label: 'Image' };
  if (videoExt.has(ext) || type.startsWith('video/')) return { kind: 'video' };
  if (audioExt.has(ext) || type.startsWith('audio/')) return { kind: 'audio' };
  if (notYet[ext]) return { kind: 'unsupported', reason: 'not-yet', label: notYet[ext] };
  if (type === 'application/pdf') return { kind: 'unsupported', reason: 'not-yet', label: 'PDF' };
  if (ext === 'md' || ext === 'markdown' || type === 'text/markdown') return { kind: 'markdown' };
  if (ext === 'json' || type === 'application/json') return { kind: 'json' };
  return { kind: 'text' };
}

/** Preview/Split/Source exist only where a second representation is real. */
export function supportedModes(kind: ViewerKind): ViewerMode[] {
  if (kind === 'svg' || kind === 'markdown') return ['preview', 'split', 'source'];
  if (kind === 'json') return ['preview', 'source'];
  return [];
}
export const modeLabels: Record<ViewerMode, string> = { preview: 'Preview', split: 'Split', source: 'Source' };

export function mediaMime(name: string, mime = ''): string {
  const type = mime.toLowerCase().split(';')[0].trim();
  if (/^(?:audio|video)\//.test(type)) return type;
  const ext = extensionOf(name);
  const map: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' };
  return map[ext] ?? type;
}
export function rasterMime(name: string, mime = ''): string {
  const type = mime.toLowerCase().split(';')[0].trim();
  if (/^image\/(?:png|jpeg|gif|webp)$/.test(type)) return type;
  const ext = extensionOf(name);
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[ext] ?? type;
}

/** Base64 data URL, chunked so large byte arrays do not overflow the argument limit. */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

export function clampZoom(value: number): number { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value))); }
/** From Fit the step starts at 100 percent, as AssetPreview does. */
export function stepZoom(current: number | 'fit', direction: 1 | -1): number {
  return clampZoom((current === 'fit' ? 100 : current) + direction * ZOOM_STEP);
}

export function isLikelyBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, BINARY_SNIFF_BYTES);
  if (head.includes(0)) return true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); return false; } catch { return true; }
}

export interface TextPreview { text: string; truncated: boolean; totalBytes: number; shownBytes: number }
/** Decode at most `limit` bytes as UTF-8. Returns undefined when the bytes are not valid text. */
export function decodeTextPreview(bytes: Uint8Array, limit = TEXT_PREVIEW_BYTES): TextPreview | undefined {
  const truncated = bytes.length > limit;
  const slice = truncated ? bytes.subarray(0, limit) : bytes;
  try {
    // stream:true lets a multibyte character cut at the limit stay pending instead of failing the decode.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(slice, truncated ? { stream: true } : undefined);
    return { text, truncated, totalBytes: bytes.length, shownBytes: slice.length };
  } catch { return undefined; }
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}
export function lineEnding(text: string): 'CRLF' | 'LF' | 'CR' | 'none' {
  if (text.includes('\r\n')) return 'CRLF';
  if (text.includes('\n')) return 'LF';
  return text.includes('\r') ? 'CR' : 'none';
}
export function lineNumberColumn(count: number): string { return Array.from({ length: count }, (_, i) => i + 1).join('\n'); }

export interface HexRow { offset: string; bytes: string; ascii: string }
export function hexRows(bytes: Uint8Array, maxBytes = HEX_PREVIEW_BYTES, rowBytes = HEX_ROW_BYTES): { rows: HexRow[]; truncated: boolean; shown: number } {
  const shown = Math.min(bytes.length, maxBytes);
  const rows: HexRow[] = [];
  for (let at = 0; at < shown; at += rowBytes) {
    const chunk = bytes.subarray(at, Math.min(at + rowBytes, shown));
    rows.push({
      offset: at.toString(16).padStart(8, '0'),
      bytes: Array.from(chunk, byte => byte.toString(16).padStart(2, '0')).join(' '),
      ascii: Array.from(chunk, byte => byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.').join(''),
    });
  }
  return { rows, truncated: bytes.length > shown, shown };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export type MediaAction = { type: 'toggle' } | { type: 'seek'; delta: number } | { type: 'volume'; delta: number } | { type: 'mute' };
/** Keyboard map for the audio and video players. */
export function mediaKeyAction(key: string): MediaAction | undefined {
  switch (key) {
    case ' ': case 'Spacebar': return { type: 'toggle' };
    case 'ArrowLeft': return { type: 'seek', delta: -SEEK_SECONDS };
    case 'ArrowRight': return { type: 'seek', delta: SEEK_SECONDS };
    case 'ArrowUp': return { type: 'volume', delta: VOLUME_STEP };
    case 'ArrowDown': return { type: 'volume', delta: -VOLUME_STEP };
    case 'm': case 'M': return { type: 'mute' };
    default: return undefined;
  }
}
export function seekTarget(current: number, delta: number, duration: number): number {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Math.max(0, current + delta);
  return Math.min(end, Math.max(0, current + delta));
}
export function clampVolume(value: number): number { return Math.min(1, Math.max(0, Math.round(value * 100) / 100)); }

export interface JsonRow {
  path: string; depth: number; key: string | null; text: string;
  kind: 'string' | 'number' | 'boolean' | 'null' | 'open' | 'collapsed' | 'close';
  expandable: boolean; open: boolean; meta: string;
}
const JSON_OPEN_DEPTH = 2;
/** Containers deeper than this start collapsed. `toggled` flips the default for a path. */
export function jsonIsOpen(path: string, depth: number, toggled: ReadonlySet<string>): boolean {
  return (depth < JSON_OPEN_DEPTH) !== toggled.has(path);
}
export function jsonRows(value: unknown, toggled: ReadonlySet<string> = new Set(), maxRows = JSON_MAX_ROWS): { rows: JsonRow[]; truncated: boolean } {
  const rows: JsonRow[] = [];
  let truncated = false;
  const walk = (key: string | null, v: unknown, depth: number, path: string): void => {
    if (rows.length >= maxRows) { truncated = true; return; }
    const isContainer = v !== null && typeof v === 'object';
    if (!isContainer) {
      const kind = v === null ? 'null' : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : 'boolean';
      rows.push({ path, depth, key, text: JSON.stringify(v), kind, expandable: false, open: false, meta: '' });
      return;
    }
    const isArray = Array.isArray(v);
    const entries = isArray ? (v as unknown[]).map((item, i) => [String(i), item] as const) : Object.entries(v as Record<string, unknown>);
    const open = jsonIsOpen(path, depth, toggled);
    const meta = `${entries.length} ${isArray ? (entries.length === 1 ? 'item' : 'items') : (entries.length === 1 ? 'key' : 'keys')}`;
    rows.push({ path, depth, key, text: open ? (isArray ? '[' : '{') : (isArray ? '[…]' : '{…}'), kind: open ? 'open' : 'collapsed', expandable: entries.length > 0, open, meta });
    if (!open) return;
    for (const [childKey, child] of entries) walk(childKey, child, depth + 1, `${path}/${childKey.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    if (rows.length < maxRows) rows.push({ path: `${path}$`, depth, key: null, text: isArray ? ']' : '}', kind: 'close', expandable: false, open: false, meta: '' });
    else truncated = true;
  };
  walk(null, value, 0, '$');
  return { rows, truncated };
}

/** Parse JSON for the tree. Returns an error message instead of throwing. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (cause) { return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }; }
}

/** Tab model. A preview tab (italic) is replaced by the next single click; a pinned tab stays until closed. */
export interface ViewerTab { id: string; pinned: boolean }
export interface ViewerTabs { tabs: ViewerTab[]; active: string | null }
export const isPreviewTab = (tab: ViewerTab): boolean => !tab.pinned;

/** Single click opens a preview tab (replaces the existing preview tab in place). `pin` keeps it open. */
export function openTab(state: ViewerTabs, id: string, pin = false): ViewerTabs {
  const tabs = state.tabs.slice();
  const existing = tabs.findIndex(tab => tab.id === id);
  if (existing >= 0) {
    if (pin && !tabs[existing].pinned) tabs[existing] = { ...tabs[existing], pinned: true };
    return { tabs, active: id };
  }
  const slot = tabs.findIndex(isPreviewTab);
  const next = { id, pinned: pin };
  if (slot >= 0) tabs[slot] = next; else tabs.push(next);
  return { tabs, active: id };
}
/** Double-click on a tab or list row: keep it open. */
export function pinTab(state: ViewerTabs, id: string): ViewerTabs {
  if (!state.tabs.some(tab => tab.id === id)) return state;
  return { tabs: state.tabs.map(tab => tab.id === id ? { ...tab, pinned: true } : tab), active: state.active };
}
export function closeTab(state: ViewerTabs, id: string): ViewerTabs {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(tab => tab.id !== id);
  const active = state.active === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.active;
  return { tabs, active };
}
