import { MAX_IMAGE_BYTES, formatAssetBytes } from './asset-preview';

export type AttachmentKind = 'image' | 'audio' | 'text-paste' | 'file' | 'selection';
export type AttachmentSource = 'picked' | 'pasted' | 'dropped' | 'workspace-file' | 'editor-selection';
export type AttachmentStatus = 'ready' | 'loading' | 'error';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  source: AttachmentSource;
  /** Raw content for images and binary files. Absent for history items and path-only workspace files. */
  bytes?: Uint8Array;
  /** Decoded content for pasted text, selections and text files. */
  text?: string;
  /** Workspace-relative or absolute path for workspace files and selections. */
  path?: string;
  /** 1-based inclusive line range for editor selections. */
  lines?: { start: number; end: number };
  status: AttachmentStatus;
  /** Why the item is in the error status. */
  error?: string;
}

/** ACP `promptCapabilities`. Text and resource links are always accepted by an agent. */
export interface PromptCapabilities { image: boolean; audio: boolean; embeddedContext: boolean }

/** How an attachment can be put into the prompt. `link` is an ACP resource_link and is baseline. */
export type SendPlan =
  | { mode: 'image' | 'audio' | 'resource' | 'text' | 'link' }
  | { mode: 'refuse'; reason: string };

export interface Rejection { name: string; reason: string }

/** Maximum number of attachments on one prompt. */
export const MAX_ATTACHMENT_COUNT = 12;
/** Largest text or binary file that can be attached. Images use MAX_IMAGE_BYTES. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * Cap on the summed size of all attachments on one prompt. Attachments travel through the
 * IPC bridge and are base64 encoded for the agent (about 4/3 overhead), so 20 MiB of raw
 * content keeps the message under roughly 27 MiB on the wire.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Pasted text at or above either threshold becomes a "Pasted text, N lines" chip. */
export const PASTE_CHIP_MIN_LINES = 12;
export const PASTE_CHIP_MIN_CHARS = 2000;
/** The viewer shows at most this many lines, and this many characters of each line. */
export const PREVIEW_MAX_LINES = 500;
export const PREVIEW_MAX_LINE_CHARS = 2000;

const rasterMime = /^image\/(?:png|jpeg|gif|webp)$/;
const textExtensions = /\.(?:txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|xml|html?|css|scss|less|svg|js|jsx|mjs|cjs|ts|tsx|mts|cts|rs|py|rb|go|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|lua|vue|svelte|solid|graphql|proto|diff|patch|lock|gitignore|dockerfile)$/i;
const extensionMime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm', json: 'application/json', md: 'text/markdown', txt: 'text/plain' };

export function extensionOf(name: string): string { return /\.([A-Za-z0-9]+)$/.exec(name)?.[1].toLowerCase() ?? ''; }
/** Prefer the declared mime, fall back to the extension, then to octet-stream. */
export function resolveMime(name: string, mime: string): string { return mime || extensionMime[extensionOf(name)] || 'application/octet-stream'; }
export function isSvgMime(mime: string): boolean { return mime === 'image/svg+xml'; }
export function isRasterMime(mime: string): boolean { return rasterMime.test(mime); }
export function isTextLike(name: string, mime: string): boolean {
  return mime.startsWith('text/') || /^application\/(?:json|xml|javascript|x-sh|x-yaml|toml|sql)|\+(?:json|xml)$/.test(mime) || isSvgMime(mime) || textExtensions.test(name);
}
/** Classify a file by mime then extension. SVG is an image for preview; it is sent as text. */
export function classifyFile(name: string, mime: string): 'image' | 'audio' | 'file' {
  const resolved = resolveMime(name, mime);
  return resolved.startsWith('image/') ? 'image' : resolved.startsWith('audio/') ? 'audio' : 'file';
}
/** The largest size allowed for one item of this kind and mime. */
export function maxBytesFor(kind: AttachmentKind, mime: string): number {
  return kind === 'image' && isRasterMime(mime) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
}

export function countLines(text: string): number { return text === '' ? 0 : text.split(/\r\n|\r|\n/).length; }
export function shouldChipPastedText(text: string): boolean {
  return countLines(text) >= PASTE_CHIP_MIN_LINES || text.length >= PASTE_CHIP_MIN_CHARS;
}
export function pastedTextName(text: string): string {
  const lines = countLines(text);
  return `Pasted text, ${lines} ${lines === 1 ? 'line' : 'lines'}`;
}

let counter = 0;
export function newAttachmentId(): string { counter += 1; return `att-${Date.now().toString(36)}-${counter}`; }
const utf8 = new TextEncoder();

export function createPastedText(text: string, id = newAttachmentId()): Attachment {
  return { id, kind: 'text-paste', name: pastedTextName(text), mime: 'text/plain', size: utf8.encode(text).length, source: 'pasted', text, status: 'ready' };
}
export function createSelection(input: { path: string; text: string; start: number; end: number; id?: string }): Attachment {
  const base = input.path.split(/[\\/]/).at(-1) || input.path;
  const range = input.start === input.end ? `${input.start}` : `${input.start}–${input.end}`;
  return { id: input.id ?? newAttachmentId(), kind: 'selection', name: `${base}:${range}`, mime: 'text/plain', size: utf8.encode(input.text).length, source: 'editor-selection', text: input.text, path: input.path, lines: { start: input.start, end: input.end }, status: 'ready' };
}
export function createWorkspaceFile(path: string, size = 0, id = newAttachmentId()): Attachment {
  const name = path.split(/[\\/]/).at(-1) || path;
  const mime = resolveMime(name, '');
  return { id, kind: classifyFile(name, mime), name, mime, size, source: 'workspace-file', path, status: 'ready' };
}
export function createFileAttachment(input: { name: string; mime: string; bytes: Uint8Array; source: 'picked' | 'pasted' | 'dropped'; id?: string }): Attachment {
  const mime = resolveMime(input.name, input.mime);
  const kind = classifyFile(input.name, mime);
  const item: Attachment = { id: input.id ?? newAttachmentId(), kind, name: input.name, mime, size: input.bytes.length, source: input.source, bytes: input.bytes, status: 'ready' };
  if (isTextLike(input.name, mime)) {
    try { item.text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes); } catch { /* binary content stays as bytes */ }
  }
  return item;
}

/** Cheap content fingerprint: length plus FNV-1a over the first and last 4 KiB. */
function fingerprint(item: Attachment): string {
  const data = item.bytes ?? utf8.encode(item.text ?? '');
  let hash = 0x811c9dc5;
  const mix = (from: number, to: number) => { for (let i = from; i < to; i++) hash = Math.imul(hash ^ data[i], 0x01000193) >>> 0; };
  mix(0, Math.min(4096, data.length));
  if (data.length > 4096) mix(Math.max(4096, data.length - 4096), data.length);
  return `${data.length}:${hash.toString(16)}`;
}
/** Two items with the same workspace path (and range), or the same kind, name and content, are duplicates. */
export function dedupeKey(item: Attachment): string {
  if (item.path) return `path:${item.path}:${item.lines ? `${item.lines.start}-${item.lines.end}` : ''}`;
  return `content:${item.kind}:${item.name}:${item.mime}:${item.bytes || item.text !== undefined ? fingerprint(item) : item.size}`;
}

export function totalBytes(items: readonly Attachment[]): number { return items.reduce((sum, item) => sum + item.size, 0); }

/** Why this item cannot be added to the current list, or undefined when it can. */
export function rejectionReason(existing: readonly Attachment[], item: Attachment): string | undefined {
  if (existing.length >= MAX_ATTACHMENT_COUNT) return `A prompt can carry at most ${MAX_ATTACHMENT_COUNT} attachments.`;
  if (item.size === 0 && item.source !== 'workspace-file') return 'The file is empty.';
  const limit = maxBytesFor(item.kind, item.mime);
  if (item.size > limit) return `Larger than the ${formatAssetBytes(limit)} limit for ${item.kind === 'image' && isRasterMime(item.mime) ? 'images' : 'files'} (${formatAssetBytes(item.size)}).`;
  if (totalBytes(existing) + item.size > MAX_TOTAL_ATTACHMENT_BYTES) return `Would exceed the ${formatAssetBytes(MAX_TOTAL_ATTACHMENT_BYTES)} total attachment limit.`;
  const key = dedupeKey(item);
  if (existing.some(other => dedupeKey(other) === key)) return 'Already attached.';
  return undefined;
}

/** Add candidates in order, returning the new list plus every refusal with its reason. Never throws. */
export function addAttachments(existing: readonly Attachment[], candidates: readonly Attachment[]): { items: Attachment[]; accepted: Attachment[]; rejected: Rejection[] } {
  const items = [...existing];
  const accepted: Attachment[] = [];
  const rejected: Rejection[] = [];
  for (const candidate of candidates) {
    const reason = rejectionReason(items, candidate);
    if (reason) rejected.push({ name: candidate.name, reason });
    else { items.push(candidate); accepted.push(candidate); }
  }
  return { items, accepted, rejected };
}

/** Decide how one attachment can be sent to an agent with these capabilities. */
export function planAttachment(item: Attachment, caps: PromptCapabilities): SendPlan {
  if (item.status === 'error') return { mode: 'refuse', reason: item.error || 'This attachment failed to load.' };
  if (item.status === 'loading') return { mode: 'refuse', reason: 'Still loading.' };
  const hasText = item.text !== undefined;
  if (item.kind === 'image' && isRasterMime(item.mime)) {
    if (!item.bytes) return item.path ? { mode: 'link' } : { mode: 'refuse', reason: 'The image data is no longer available.' };
    return caps.image ? { mode: 'image' } : { mode: 'refuse', reason: 'This agent does not accept images.' };
  }
  if (item.kind === 'audio' || item.mime.startsWith('audio/')) {
    if (!item.bytes) return item.path ? { mode: 'link' } : { mode: 'refuse', reason: 'The audio data is no longer available.' };
    if (caps.audio) return { mode: 'audio' };
    // Without audio support the agent still gets a resource link when the file has a path.
    return item.path ? { mode: 'link' } : { mode: 'refuse', reason: 'This agent does not accept audio.' };
  }
  if (hasText) return caps.embeddedContext ? { mode: 'resource' } : { mode: 'text' };
  if (item.path && !item.bytes) return { mode: 'link' };
  if (item.bytes) return caps.embeddedContext ? { mode: 'resource' } : { mode: 'refuse', reason: 'This agent cannot receive binary files (no embedded context support).' };
  if (item.kind === 'image') return { mode: 'refuse', reason: 'This image format cannot be previewed or sent. Use PNG, JPEG, GIF, WebP or SVG.' };
  return { mode: 'refuse', reason: 'The file content is no longer available.' };
}

/** Split a list into what can be sent and what is blocked, with a reason for each blocked item. */
export function gateAttachments(items: readonly Attachment[], caps: PromptCapabilities): { send: { item: Attachment; plan: Exclude<SendPlan, { mode: 'refuse' }> }[]; blocked: { item: Attachment; reason: string }[] } {
  const send: { item: Attachment; plan: Exclude<SendPlan, { mode: 'refuse' }> }[] = [];
  const blocked: { item: Attachment; reason: string }[] = [];
  for (const item of items) {
    const plan = planAttachment(item, caps);
    if (plan.mode === 'refuse') blocked.push({ item, reason: plan.reason }); else send.push({ item, plan });
  }
  return { send, blocked };
}

/** Line-numbered preview text, bounded in lines and in characters per line. */
export function previewText(text: string, maxLines = PREVIEW_MAX_LINES, maxChars = PREVIEW_MAX_LINE_CHARS): { lines: string[]; totalLines: number; truncated: boolean } {
  const all = text.split(/\r\n|\r|\n/);
  const lines = all.slice(0, maxLines).map(line => line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
  return { lines, totalLines: all.length, truncated: all.length > maxLines || all.some((line, index) => index < maxLines && line.length > maxChars) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const sourceLabels: Record<AttachmentSource, string> = { picked: 'Picked file', pasted: 'Pasted', dropped: 'Dropped file', 'workspace-file': 'Workspace file', 'editor-selection': 'Editor selection' };
/** True when the item already lives in the workspace, so Save to workspace is not offered. */
export function isInWorkspace(item: Attachment): boolean { return (item.source === 'workspace-file' || item.source === 'editor-selection') && !!item.path; }
