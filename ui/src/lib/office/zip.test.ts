import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { OfficeError, checkZipBudget, inflateEntry, isOleCompound, openZip, readZipDirectory, type ZipEntry } from './zip';

const entry = (name: string, size: number, compressedSize: number): ZipEntry => ({ name, size, compressedSize, method: 8, offset: 0, flags: 0, encrypted: false, dir: false });
const limits = { maxEntryBytes: 1000, maxTotalBytes: 2500, maxEntries: 3, maxRatio: 100, ratioFloorBytes: 200 };

describe('zip directory', () => {
  it('lists entries with sizes, method, directories and dates from the central directory', () => {
    const bytes = zipSync({ 'a.txt': strToU8('hello hello hello hello'), 'dir/': new Uint8Array(0), 'dir/b.bin': [new Uint8Array([1, 2, 3]), { level: 0 }] }, { mtime: new Date(2026, 9, 28, 14, 2, 0) });
    const dir = readZipDirectory(bytes);
    expect(dir.entries.map(e => [e.name, e.size, e.dir])).toEqual([['a.txt', 23, false], ['dir/', 0, true], ['dir/b.bin', 3, false]]);
    expect(dir.entries[2].method).toBe(0);
    expect(new Date(dir.entries[0].modified!).getFullYear()).toBe(2026);
  });
  it('rejects bytes that are not a zip archive as damaged', () => {
    expect(() => readZipDirectory(strToU8('not a zip at all'))).toThrowError(OfficeError);
    try { readZipDirectory(strToU8('not a zip at all')); } catch (cause) { expect((cause as OfficeError).kind).toBe('damaged'); }
  });
  it('recognises an encrypted Office file (OLE compound document) as locked', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(isOleCompound(ole)).toBe(true);
    expect(() => openZip(ole)).toThrowError(expect.objectContaining({ kind: 'locked' }));
  });
});

describe('zip bomb guard thresholds', () => {
  it('accepts entries at the limits', () => {
    expect(checkZipBudget([entry('a', 1000, 10), entry('b', 1000, 900), entry('c', 500, 500)], limits)).toEqual({ ok: true, totalBytes: 2500 });
  });
  it('refuses one entry above the per-entry limit', () => {
    expect(checkZipBudget([entry('a', 1001, 900)], limits)).toMatchObject({ ok: false, reason: 'entry' });
  });
  it('refuses a total above the archive limit', () => {
    expect(checkZipBudget([entry('a', 1000, 900), entry('b', 1000, 900), entry('c', 501, 500)], limits)).toMatchObject({ ok: false, reason: 'total' });
  });
  it('refuses too many entries', () => {
    expect(checkZipBudget([entry('a', 1, 1), entry('b', 1, 1), entry('c', 1, 1), entry('d', 1, 1)], limits)).toMatchObject({ ok: false, reason: 'count' });
  });
  it('refuses a compression ratio above the limit only once the entry is past the ratio floor', () => {
    expect(checkZipBudget([entry('small', 199, 1)], limits)).toMatchObject({ ok: true });
    expect(checkZipBudget([entry('bomb', 1000, 9)], limits)).toMatchObject({ ok: false, reason: 'ratio' });
    expect(checkZipBudget([entry('fine', 1000, 10)], limits)).toMatchObject({ ok: true });
  });
  it('stops inflating once the real output passes the cap, whatever the header claims', () => {
    const big = new Uint8Array(200_000).fill(65);
    const bytes = zipSync({ 'big.txt': big });
    const dir = readZipDirectory(bytes);
    const lying = { ...dir.entries[0], size: 10 };
    expect(() => inflateEntry(bytes, lying, 50_000)).toThrowError(expect.objectContaining({ kind: 'too-large' }));
    expect(inflateEntry(bytes, dir.entries[0], 200_000).length).toBe(200_000);
  });
  it('openZip reads text parts and refuses a bomb with the too-large kind', () => {
    const bytes = zipSync({ 'word/document.xml': strToU8('<doc/>') });
    expect(openZip(bytes).text('word/document.xml')).toBe('<doc/>');
    expect(openZip(bytes).has('missing.xml')).toBe(false);
    const bomb = zipSync({ 'x.xml': new Uint8Array(3_000_000) });
    expect(() => openZip(bomb, { maxRatio: 100, ratioFloorBytes: 1024 })).toThrowError(expect.objectContaining({ kind: 'too-large' }));
  });
});
