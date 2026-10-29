/**
 * Read-only, bounded ZIP access for the Office viewers and the browser archive listing.
 * The central directory is parsed here; entries are inflated with fflate in small input chunks
 * so the real output size is counted as it grows and a lying header cannot exhaust memory.
 * Nothing here writes to disk or follows paths: names are only map keys.
 */
import { Inflate } from 'fflate';

export type OfficeErrorKind = 'too-large' | 'damaged' | 'locked' | 'unsupported';
export class OfficeError extends Error {
  constructor(readonly kind: OfficeErrorKind, message: string) { super(message); this.name = 'OfficeError'; }
}

export interface ZipLimits {
  /** Largest uncompressed size of one entry. */
  maxEntryBytes: number;
  /** Largest uncompressed size of all entries together. */
  maxTotalBytes: number;
  maxEntries: number;
  /** Largest uncompressed to compressed ratio of one entry, checked once the entry is past the floor. */
  maxRatio: number;
  ratioFloorBytes: number;
}
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
  maxRatio: 200,
  ratioFloorBytes: 1024 * 1024,
};
/** Largest XML part handed to DOMParser. */
export const MAX_XML_BYTES = 32 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  /** Declared uncompressed size. Verified while inflating. */
  size: number;
  compressedSize: number;
  method: number;
  /** Offset of the local file header. */
  offset: number;
  flags: number;
  encrypted: boolean;
  dir: boolean;
  /** Milliseconds since the epoch, from the DOS date and time (local time). */
  modified?: number;
}
export interface ZipDirectory { entries: ZipEntry[]; comment?: string }

const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;
const u64 = (b: Uint8Array, i: number) => u32(b, i) + u32(b, i + 4) * 0x100000000;
const damaged = (message: string) => new OfficeError('damaged', message);

/** Encrypted Office files are OLE compound documents, not ZIP archives. */
export function isOleCompound(bytes: Uint8Array): boolean {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return bytes.length >= 8 && sig.every((value, i) => bytes[i] === value);
}

function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch {
    if (utf8Flag) return new TextDecoder('utf-8').decode(raw);
    return Array.from(raw, byte => String.fromCharCode(byte)).join('');
  }
}

function dosTime(time: number, date: number): number | undefined {
  if (!date) return undefined;
  const value = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
  return Number.isFinite(value) ? value : undefined;
}

/** Parse the end of central directory record and every central directory header. Supports ZIP64 sizes. */
export function readZipDirectory(bytes: Uint8Array, maxEntries = DEFAULT_ZIP_LIMITS.maxEntries): ZipDirectory {
  if (bytes.length < 22) throw damaged('The file is too short to be a ZIP archive.');
  let eocd = -1;
  for (let i = bytes.length - 22, stop = Math.max(0, bytes.length - 22 - 0xffff); i >= stop; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw damaged('The archive directory was not found. The file may be damaged or is not a ZIP archive.');
  let count = u16(bytes, eocd + 10);
  let cdOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(bytes, locator) !== 0x07064b50) throw damaged('The ZIP64 directory locator is missing.');
    const record = u64(bytes, locator + 8);
    if (record + 56 > bytes.length || u32(bytes, record) !== 0x06064b50) throw damaged('The ZIP64 directory record is damaged.');
    count = u64(bytes, record + 32);
    cdOffset = u64(bytes, record + 48);
  }
  if (count > maxEntries) throw new OfficeError('too-large', `The archive has ${count.toLocaleString('en-US')} entries. The preview reads at most ${maxEntries.toLocaleString('en-US')}.`);
  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) throw damaged('An archive directory entry is damaged.');
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    let compressedSize = u32(bytes, at + 20);
    let size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28), extraLength = u16(bytes, at + 30), commentLength = u16(bytes, at + 32);
    let offset = u32(bytes, at + 42);
    const nameEnd = at + 46 + nameLength;
    if (nameEnd + extraLength > bytes.length) throw damaged('An archive directory entry runs past the end of the file.');
    const name = decodeName(bytes.subarray(at + 46, nameEnd), (flags & 0x800) !== 0);
    // ZIP64 extended information: only the fields whose 32-bit value is saturated are present, in order.
    for (let e = nameEnd; e + 4 <= nameEnd + extraLength;) {
      const id = u16(bytes, e), length = u16(bytes, e + 2);
      if (id === 0x0001) {
        let p = e + 4;
        if (size === 0xffffffff) { size = u64(bytes, p); p += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(bytes, p); p += 8; }
        if (offset === 0xffffffff) { offset = u64(bytes, p); }
      }
      e += 4 + length;
    }
    entries.push({ name, size, compressedSize, method, offset, flags, encrypted: (flags & 1) !== 0, dir: name.endsWith('/') || name.endsWith('\\'), modified: dosTime(u16(bytes, at + 12), u16(bytes, at + 14)) });
    at = nameEnd + extraLength + commentLength;
  }
  return { entries };
}

export type BudgetResult = { ok: true; totalBytes: number } | { ok: false; reason: 'entry' | 'total' | 'count' | 'ratio'; message: string };
const mib = (n: number) => `${Math.round(n / 1024 / 1024)} MiB`;

/** Refuse archives whose declared sizes or ratios look like a zip bomb, before inflating anything. */
export function checkZipBudget(entries: readonly ZipEntry[], limits: ZipLimits = DEFAULT_ZIP_LIMITS): BudgetResult {
  if (entries.length > limits.maxEntries) return { ok: false, reason: 'count', message: `The archive has ${entries.length.toLocaleString('en-US')} entries. The preview reads at most ${limits.maxEntries.toLocaleString('en-US')}.` };
  let total = 0;
  for (const entry of entries) {
    if (entry.size > limits.maxEntryBytes) return { ok: false, reason: 'entry', message: `${entry.name} unpacks to more than ${mib(limits.maxEntryBytes)}, which is above the preview limit.` };
    if (entry.size >= limits.ratioFloorBytes && entry.size / Math.max(1, entry.compressedSize) > limits.maxRatio) {
      return { ok: false, reason: 'ratio', message: `${entry.name} expands more than ${limits.maxRatio} times. It is refused as a possible zip bomb.` };
    }
    total += entry.size;
    if (total > limits.maxTotalBytes) return { ok: false, reason: 'total', message: `The archive unpacks to more than ${mib(limits.maxTotalBytes)}, which is above the preview limit.` };
  }
  return { ok: true, totalBytes: total };
}

const INPUT_CHUNK = 4096;
/** Inflate one entry, counting the real output. Throws too-large as soon as the output passes `cap`. */
export function inflateEntry(bytes: Uint8Array, entry: ZipEntry, cap: number): Uint8Array {
  if (entry.encrypted) throw new OfficeError('locked', 'This archive entry is encrypted. Password protected files are not opened in the preview.');
  const local = entry.offset;
  if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw damaged(`The data of ${entry.name} is damaged.`);
  const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw damaged(`The data of ${entry.name} runs past the end of the file.`);
  const input = bytes.subarray(start, end);
  const tooLarge = () => new OfficeError('too-large', `${entry.name} unpacks to more than ${mib(cap)}, which is above the preview limit.`);
  if (entry.method === 0) {
    if (input.length > cap) throw tooLarge();
    return input.slice();
  }
  if (entry.method !== 8) throw new OfficeError('unsupported', `${entry.name} uses compression method ${entry.method}, which the preview does not read.`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = new Inflate();
  inflater.ondata = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > cap) throw tooLarge();
    chunks.push(chunk);
  };
  try {
    for (let at = 0; at < input.length; at += INPUT_CHUNK) inflater.push(input.subarray(at, Math.min(at + INPUT_CHUNK, input.length)), at + INPUT_CHUNK >= input.length);
    if (input.length === 0) inflater.push(new Uint8Array(0), true);
  } catch (cause) {
    if (cause instanceof OfficeError) throw cause;
    throw damaged(`The data of ${entry.name} could not be decompressed.`);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

export interface OfficeZip {
  entries: ZipEntry[];
  has(name: string): boolean;
  entry(name: string): ZipEntry | undefined;
  /** Inflate an entry. Missing entries return undefined. */
  bytes(name: string, cap?: number): Uint8Array | undefined;
  /** Decode an entry as UTF-8 text, at most MAX_XML_BYTES by default. */
  text(name: string, cap?: number): string | undefined;
  /** Inflate every entry once with the bounds, so the real total is known before another reader opens the file. */
  verifyAll(): void;
}

/** Open an archive for bounded, read-only access. Encrypted Office files are reported as locked. */
export function openZip(bytes: Uint8Array, overrides: Partial<ZipLimits> = {}): OfficeZip {
  const limits = { ...DEFAULT_ZIP_LIMITS, ...overrides };
  if (isOleCompound(bytes)) throw new OfficeError('locked', 'This file is password protected or encrypted. The preview does not ask for passwords.');
  const { entries } = readZipDirectory(bytes, limits.maxEntries);
  const budget = checkZipBudget(entries, limits);
  if (!budget.ok) throw new OfficeError('too-large', budget.message);
  const byName = new Map<string, ZipEntry>();
  for (const entry of entries) {
    const key = entry.name.replace(/^\/+/, '').toLowerCase();
    if (!byName.has(key)) byName.set(key, entry);
  }
  let readTotal = 0;
  const lookup = (name: string) => byName.get(name.replace(/^\/+/, '').toLowerCase());
  const read = (entry: ZipEntry, cap: number) => {
    const data = inflateEntry(bytes, entry, Math.min(cap, limits.maxEntryBytes));
    readTotal += data.length;
    if (readTotal > limits.maxTotalBytes * 2) throw new OfficeError('too-large', 'The document unpacks to more data than the preview reads.');
    return data;
  };
  return {
    entries,
    has: name => lookup(name) !== undefined,
    entry: lookup,
    bytes(name, cap = limits.maxEntryBytes) { const entry = lookup(name); return entry && !entry.dir ? read(entry, cap) : undefined; },
    text(name, cap = MAX_XML_BYTES) {
      const entry = lookup(name);
      if (!entry || entry.dir) return undefined;
      return new TextDecoder('utf-8').decode(read(entry, cap));
    },
    verifyAll() {
      let total = 0;
      for (const entry of entries) {
        if (entry.dir) continue;
        total += inflateEntry(bytes, entry, limits.maxEntryBytes).length;
        if (total > limits.maxTotalBytes) throw new OfficeError('too-large', `The document unpacks to more than ${mib(limits.maxTotalBytes)}, which is above the preview limit.`);
      }
    },
  };
}
