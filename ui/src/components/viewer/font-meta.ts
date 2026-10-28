/**
 * Font metadata and loading for the specimen viewer. Metadata comes from the sfnt `name` and `maxp` tables,
 * read with bounds checks; anything malformed is skipped rather than trusted. WOFF is read only when the tables
 * are stored uncompressed, and WOFF2 (Brotli) is not read at all: the specimen still renders through FontFace.
 */
import { FONT_READ_BYTES } from '../../lib/viewer';

export const FONT_MAX_BYTES = FONT_READ_BYTES;

export interface FontMeta { format: 'TrueType' | 'OpenType' | 'WOFF' | 'WOFF2'; family?: string; style?: string; version?: string; license?: string; glyphs?: number }

const tagAt = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

interface Table { offset: number; length: number }

function sfntTables(view: DataView, bytes: Uint8Array): Map<string, Table> {
  const tables = new Map<string, Table>();
  if (bytes.length < 12) return tables;
  const count = Math.min(view.getUint16(4), 512);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > bytes.length) break;
    tables.set(tagAt(bytes, at), { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return tables;
}
function woffTables(view: DataView, bytes: Uint8Array): Map<string, Table> {
  const tables = new Map<string, Table>();
  if (bytes.length < 44) return tables;
  const count = Math.min(view.getUint16(12), 512);
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    if (at + 20 > bytes.length) break;
    const compressed = view.getUint32(at + 8), original = view.getUint32(at + 12);
    if (compressed === original) tables.set(tagAt(bytes, at), { offset: view.getUint32(at + 4), length: original });
  }
  return tables;
}
const inBounds = (table: Table | undefined, bytes: Uint8Array, need: number): table is Table => !!table && table.offset + Math.max(need, 0) <= bytes.length && table.offset + table.length <= bytes.length;

function readNames(view: DataView, bytes: Uint8Array, table: Table | undefined): Map<number, string> {
  const names = new Map<number, string>();
  if (!inBounds(table, bytes, 6)) return names;
  const count = view.getUint16(table.offset + 2), storage = table.offset + view.getUint16(table.offset + 4);
  const ranked = new Map<number, number>();
  for (let i = 0; i < Math.min(count, 1024); i++) {
    const at = table.offset + 6 + i * 12;
    if (at + 12 > table.offset + table.length) break;
    const platform = view.getUint16(at), language = view.getUint16(at + 4), id = view.getUint16(at + 6), length = Math.min(view.getUint16(at + 8), 1024), start = storage + view.getUint16(at + 10);
    if (start + length > bytes.length) continue;
    const rank = platform === 3 ? (language === 0x409 ? 3 : 2) : platform === 1 && language === 0 ? 1 : 0;
    if (!rank || rank <= (ranked.get(id) ?? 0)) continue;
    let text = '';
    if (platform === 3) for (let j = 0; j + 1 < length; j += 2) text += String.fromCharCode(view.getUint16(start + j));
    else for (let j = 0; j < length; j++) text += String.fromCharCode(bytes[start + j]);
    names.set(id, text.replace(/[\u0000-\u001f]/g, '').trim()); ranked.set(id, rank);
  }
  return names;
}

function shortLicense(text?: string): string | undefined {
  if (!text) return undefined;
  const known = /SIL Open Font License|Apache License|Ubuntu Font Licen[cs]e|MIT License|Bitstream Vera/i.exec(text);
  if (known) return known[0];
  const first = text.split(/(?<=\.)\s/)[0];
  return first.length <= 60 ? first : `${first.slice(0, 57)}...`;
}

/** Throws a readable message when the bytes are not a single font this viewer can load. */
export function parseFontMeta(bytes: Uint8Array): FontMeta {
  if (bytes.length < 4) throw new Error('This file is not a font.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = tagAt(bytes, 0);
  let format: FontMeta['format'], tables: Map<string, Table>;
  if (view.getUint32(0) === 0x00010000 || signature === 'true') { format = 'TrueType'; tables = sfntTables(view, bytes); }
  else if (signature === 'OTTO') { format = 'OpenType'; tables = sfntTables(view, bytes); }
  else if (signature === 'wOFF') { format = 'WOFF'; tables = woffTables(view, bytes); }
  else if (signature === 'wOF2') return { format: 'WOFF2' };
  else if (signature === 'ttcf') throw new Error('Font collections (.ttc) are not supported. Open it with a system app.');
  else throw new Error('This file is not a font. Its header does not match TrueType, OpenType, WOFF or WOFF2.');
  const meta: FontMeta = { format };
  const maxp = tables.get('maxp');
  if (inBounds(maxp, bytes, 6)) meta.glyphs = view.getUint16(maxp.offset + 4);
  const names = readNames(view, bytes, tables.get('name'));
  const family = names.get(16) || names.get(1), style = names.get(17) || names.get(2), version = names.get(5);
  if (family) meta.family = family;
  if (style) meta.style = style;
  if (version) { const number = /\d+(?:\.\d+)+/.exec(version)?.[0]; meta.version = number ? `v${number}` : version.slice(0, 24); }
  const license = shortLicense(names.get(13));
  if (license) meta.license = license;
  return meta;
}

export function fontMetaLine(meta: FontMeta): string[] {
  return [meta.style, meta.glyphs !== undefined ? `${meta.glyphs.toLocaleString('en-US')} glyphs` : undefined, meta.version, meta.license].filter((part): part is string => !!part);
}

let counter = 0;
interface FontEnvironment { FontFace?: typeof FontFace; fonts?: { add(face: FontFace): unknown; delete(face: FontFace): unknown } }

/** Loads a FontFace from bytes under a unique family name. `dispose` removes it from the document again. */
export async function loadFontFromBytes(bytes: Uint8Array, env: FontEnvironment = { FontFace: globalThis.FontFace, fonts: globalThis.document?.fonts }): Promise<{ family: string; dispose: () => void }> {
  if (bytes.length > FONT_MAX_BYTES) throw new Error('Fonts larger than 16 MiB are not previewed.');
  if (!env.FontFace || !env.fonts) throw new Error('Font loading is not available in this webview.');
  const family = `span-viewer-font-${++counter}`;
  const face = new env.FontFace(family, bytes.slice().buffer as ArrayBuffer);
  try { await face.load(); }
  catch (cause) { throw new Error(`The webview could not load this font. It may be damaged. (${cause instanceof Error ? cause.message : String(cause)})`); }
  env.fonts.add(face);
  let disposed = false;
  return { family, dispose: () => { if (disposed) return; disposed = true; env.fonts!.delete(face); } };
}
