/**
 * Pure logic for the File/Upload viewer: classification, limits, decoding, hex and JSON rows, tab model.
 *
 * Design inconsistencies, settled here (File Viewer and Upload Viewer designs disagree):
 * - Image zoom runs from 10 to 800 percent in steps of 25 (the Upload Viewer range; File Viewer showed 25 to 400).
 * - Archive warning copy: "N entries point outside the archive and are always skipped" (File Viewer said
 *   "always skipped", Upload Viewer said "will be skipped on extract").
 * - Source bar copy: "Attached in <session> · <time>" for files the user sent, and
 *   "Created by <agent> in <session> · <time>" for files an agent generated (Upload Viewer used
 *   "Attachment from" for both).
 */
import { MAX_IMAGE_BYTES, MAX_SVG_BYTES } from './asset-preview';
import { extensionOf } from './file-extension';
import { officeKindOf } from './office/kind';
import { OFFICE_PREVIEW_BYTES } from './office/limits';
export { extensionOf } from './file-extension';

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
export const PLAYBACK_SPEEDS = [0.75, 1, 1.5, 2] as const;
/** Fonts above this are refused with the damaged state rather than handed to FontFace. */
export const FONT_READ_BYTES = 16 * 1024 * 1024;
/** Audio and video are read whole into a Blob, so they are capped. Larger files offer the system app instead. */
export const MEDIA_MAX_BYTES = 256 * 1024 * 1024;

export type ViewerKind = 'image' | 'svg' | 'markdown' | 'mdx' | 'html' | 'json' | 'csv' | 'font' | 'text' | 'audio' | 'video' | 'unsupported';
export type ViewerMode = 'preview' | 'split' | 'source';
export type UnsupportedReason = 'not-yet' | 'format';
export interface Classification { kind: ViewerKind; reason?: UnsupportedReason; label?: string }

const rasterExt = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const videoExt = new Set(['mp4', 'm4v', 'mov', 'webm']);
const audioExt = new Set(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aac']);
/** Generic fallback labels. Document dispatch checks officeKindOf before using this fallback. */
const notYet: Record<string, string> = {
  pdf: 'PDF', docx: 'Word document', doc: 'Word document', pptx: 'Presentation', ppt: 'Presentation', key: 'Keynote', xlsx: 'Spreadsheet', xls: 'Spreadsheet', numbers: 'Numbers',
  zip: 'Archive', tar: 'Archive', tgz: 'Archive', gz: 'Archive', '7z': 'Archive', rar: 'Archive',
};
/** Formats Span does not preview at all: they need their own application. */
const otherFormats: Record<string, string> = { fig: 'Figma', sketch: 'Sketch', xd: 'Adobe XD', ai: 'Illustrator', indd: 'InDesign', psd: 'Photoshop' };
const otherImageExt = new Set(['bmp', 'ico', 'avif', 'tif', 'tiff', 'heic']);
const fontExt = new Set(['ttf', 'otf', 'woff', 'woff2']);

export function classifyFile(name: string, mime = ''): Classification {
  const ext = extensionOf(name);
  const type = mime.toLowerCase().split(';')[0].trim();
  if (ext === 'svg' || type === 'image/svg+xml') return { kind: 'svg' };
  if (rasterExt.has(ext) || /^image\/(?:png|jpeg|gif|webp)$/.test(type)) return { kind: 'image' };
  if (otherFormats[ext]) return { kind: 'unsupported', reason: 'format', label: otherFormats[ext] };
  if (otherImageExt.has(ext) || type.startsWith('image/')) return { kind: 'unsupported', reason: 'format', label: 'Image' };
  if (fontExt.has(ext) || type.startsWith('font/')) return { kind: 'font' };
  if (videoExt.has(ext) || type.startsWith('video/')) return { kind: 'video' };
  if (audioExt.has(ext) || type.startsWith('audio/')) return { kind: 'audio' };
  if (notYet[ext]) return { kind: 'unsupported', reason: 'not-yet', label: notYet[ext] };
  if (type === 'application/pdf') return { kind: 'unsupported', reason: 'not-yet', label: 'PDF' };
  if (ext === 'mdx') return { kind: 'mdx' };
  if (ext === 'md' || ext === 'markdown' || type === 'text/markdown') return { kind: 'markdown' };
  if (ext === 'html' || ext === 'htm' || type === 'text/html') return { kind: 'html' };
  if (ext === 'csv' || ext === 'tsv' || type === 'text/csv' || type === 'text/tab-separated-values') return { kind: 'csv' };
  if (ext === 'json' || type === 'application/json') return { kind: 'json' };
  return { kind: 'text' };
}

/** Preview/Split/Source exist only where a second representation is real. */
export function supportedModes(kind: ViewerKind): ViewerMode[] {
  if (kind === 'svg' || kind === 'markdown' || kind === 'mdx' || kind === 'html') return ['preview', 'split', 'source'];
  if (kind === 'json' || kind === 'csv') return ['preview', 'source'];
  return [];
}
export const modeLabels: Record<ViewerMode, string> = { preview: 'Preview', split: 'Split', source: 'Source' };
/** JSON reads as Tree and Raw, CSV as Table and Raw; the rest use Preview, Split and Source. */
export function modeLabelFor(kind: ViewerKind, mode: ViewerMode): string {
  if (kind === 'json') return mode === 'preview' ? 'Tree' : 'Raw';
  if (kind === 'csv') return mode === 'preview' ? 'Table' : 'Raw';
  return modeLabels[mode];
}
/** The three-way Preview, Split, Source switch uses icons (design); two-way switches use words. */
export function modeUsesIcons(kind: ViewerKind): boolean { return supportedModes(kind).length === 3; }

/**
 * How many bytes to read for a file. 0 means do not read: the viewer shows the too-large state without data.
 * Text-like kinds read 4 bytes past the preview limit so truncation is detectable without splitting a character.
 */
export function readLimit(name: string, mime: string, size: number, asBinary = false): number {
  const total = Math.max(0, size);
  if (asBinary) return Math.min(total, HEX_PREVIEW_BYTES);
  // Binary document decoders need the complete container, including its trailing indexes.
  const document = officeKindOf(name, mime);
  if (document) return total > OFFICE_PREVIEW_BYTES[document] ? 0 : total;
  const { kind } = classifyFile(name, mime);
  switch (kind) {
    case 'image': return total > MAX_IMAGE_BYTES ? 0 : total;
    case 'svg': return Math.min(total, MAX_SVG_BYTES + 1);
    case 'font': return total > FONT_READ_BYTES ? 0 : total;
    case 'audio': case 'video': return total > MEDIA_MAX_BYTES ? 0 : total;
    case 'unsupported': return Math.min(total, HEX_PREVIEW_BYTES);
    default: return Math.min(total, TEXT_PREVIEW_BYTES + 4);
  }
}

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
/** Percent at which an image fits its box. Never enlarges past 100, clamped to the zoom range. */
export function fitPercent(width: number, height: number, boxWidth: number, boxHeight: number): number {
  if (!(width > 0 && height > 0 && boxWidth > 0 && boxHeight > 0)) return 100;
  return clampZoom(Math.min(100, boxWidth / width * 100, boxHeight / height * 100));
}
/** Ctrl or pinch wheel zoom: continuous and proportional, clamped to the range. */
export function wheelZoom(current: number, deltaY: number): number {
  return clampZoom(current * Math.exp(-Math.max(-500, Math.min(500, deltaY)) * 0.002));
}
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
export function decodeTextPreview(bytes: Uint8Array, limit = TEXT_PREVIEW_BYTES, totalBytes = bytes.length): TextPreview | undefined {
  const total = Math.max(totalBytes, bytes.length);
  const truncated = bytes.length > limit || total > bytes.length;
  const slice = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
  try {
    // stream:true lets a multibyte character cut at the limit stay pending instead of failing the decode.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(slice, truncated ? { stream: true } : undefined);
    return { text, truncated, totalBytes: total, shownBytes: slice.length };
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
    case ' ': case 'Spacebar': case 'k': case 'K': return { type: 'toggle' };
    case 'ArrowLeft': case 'j': case 'J': return { type: 'seek', delta: -SEEK_SECONDS };
    case 'ArrowRight': case 'l': case 'L': return { type: 'seek', delta: SEEK_SECONDS };
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
/** `base` is the starting state before toggles: the default two open levels, everything open, or everything closed. */
export type JsonBase = 'default' | 'all' | 'none';
export function jsonIsOpen(path: string, depth: number, toggled: ReadonlySet<string>, base: JsonBase = 'default'): boolean {
  const start = base === 'all' ? true : base === 'none' ? false : depth < JSON_OPEN_DEPTH;
  return start !== toggled.has(path);
}
export function jsonRows(value: unknown, toggled: ReadonlySet<string> = new Set(), maxRows = JSON_MAX_ROWS, base: JsonBase = 'default'): { rows: JsonRow[]; truncated: boolean } {
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
    const open = jsonIsOpen(path, depth, toggled, base);
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

export function closeOtherTabs(state: ViewerTabs, id: string): ViewerTabs {
  const keep = state.tabs.find(tab => tab.id === id);
  return keep ? { tabs: [keep], active: id } : state;
}
export function closeTabsToRight(state: ViewerTabs, id: string): ViewerTabs {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0 || index === state.tabs.length - 1) return state;
  const tabs = state.tabs.slice(0, index + 1);
  return { tabs, active: tabs.some(tab => tab.id === state.active) ? state.active : id };
}
export function closeAllTabs(): ViewerTabs { return { tabs: [], active: null }; }
/** Close the tabs of uploads that are gone from the list (removed elsewhere). */
export function removeFromTabs(state: ViewerTabs, existing: ReadonlySet<string>): ViewerTabs {
  let next = state;
  for (const tab of state.tabs) if (!existing.has(tab.id)) next = closeTab(next, tab.id);
  return next;
}
