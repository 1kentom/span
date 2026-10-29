import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NO_CAPABILITIES, UploadsError, createDesktopUploadsApi, createMemoryUploadsApi, createUnavailableUploadsApi, type UploadsCommands } from './uploads-api';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('in-memory uploads api (tests only)', () => {
  const seed = () => createMemoryUploadsApi([
    { entry: { id: 'a', name: 'notes.md', size: 0, createdAt: 1, origin: 'sent' }, data: bytes('# Hello world') },
    { entry: { id: 'b', name: 'core.bin', size: 0, createdAt: 2, origin: 'generated' }, data: new Uint8Array([1, 2, 3, 4]) },
  ]);
  it('lists newest first with sizes and reads a byte range', async () => {
    const api = seed();
    expect(api.available).toBe(true);
    const list = await api.list();
    expect(list.map(e => [e.name, e.size])).toEqual([['core.bin', 4], ['notes.md', 13]]);
    expect(new TextDecoder().decode(await api.read('a', 2, 5))).toBe('Hello');
    expect(await api.read('b', 3, 100)).toEqual(new Uint8Array([4]));
  });
  it('renames, duplicates with a free name, removes and reports usage', async () => {
    const api = seed();
    await api.rename('a', 'release.md');
    const copy = await api.duplicate('a');
    expect(copy.name).toBe('release copy.md');
    expect((await api.duplicate('a')).name).toBe('release copy 2.md');
    await api.remove('b');
    await expect(api.read('b', 0, 1)).rejects.toMatchObject({ code: 'gone' });
    expect(await api.usage()).toEqual({ count: 3, bytes: 39 });
    await expect(api.rename('a', 'release copy.md')).rejects.toBeInstanceOf(UploadsError);
  });
  it('records side effects for actions that would leave the app', async () => {
    const api = seed();
    expect(await api.saveToWorkspace('a')).toBe('uploads/notes.md');
    await api.reveal('a'); await api.openWithSystem('a');
    expect(api.calls).toEqual([['saveToWorkspace', 'a'], ['reveal', 'a'], ['openWithSystem', 'a']]);
  });
  it('honours a capability override so the UI can be tested with missing actions', () => {
    const api = createMemoryUploadsApi([], { reveal: false, copyPath: false });
    expect(api.capabilities.reveal).toBe(false);
    expect(api.capabilities.rename).toBe(true);
  });
});

describe('browser preview api', () => {
  it('is unavailable, supports nothing and never returns sample data', async () => {
    const api = createUnavailableUploadsApi();
    expect(api.available).toBe(false);
    expect(api.unavailableReason).toBe('Uploads need the desktop app');
    expect(api.capabilities).toEqual(NO_CAPABILITIES);
    expect(await api.list()).toEqual([]);
    await expect(api.read('x', 0, 1)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('desktop adapter', () => {
  it('derives capabilities from the commands that exist and maps calls one to one', async () => {
    const commands: UploadsCommands = {
      uploadsList: vi.fn(async () => [{ id: 'a', name: 'n.md', size: 3, createdAt: 5, origin: 'sent' as const }]),
      uploadsRead: vi.fn(async () => [104, 105]),
      uploadsRename: vi.fn(async () => undefined),
    };
    const api = createDesktopUploadsApi(commands);
    expect(api.capabilities).toMatchObject({ rename: true, remove: false, reveal: false, add: false });
    expect(await api.list()).toHaveLength(1);
    expect(await api.read('a', 0, 2)).toEqual(new Uint8Array([104, 105]));
    expect(commands.uploadsRead).toHaveBeenCalledWith('a', 0, 2);
    await expect(api.remove('a')).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('turns a not found error into the gone state', async () => {
    const api = createDesktopUploadsApi({ uploadsList: async () => [], uploadsRead: async () => { throw { kind: 'NotFound', message: 'no such upload' }; } });
    await expect(api.read('a', 0, 1)).rejects.toMatchObject({ code: 'gone' });
  });
});

describe('app code never imports the in-memory implementation', () => {
  const src = resolve(process.cwd(), 'src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
  it('only tests reference createMemoryUploadsApi', () => {
    const offenders = walk(src).filter(path => /\.(tsx?)$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith('uploads-api.ts'))
      .filter(path => readFileSync(path, 'utf8').includes('createMemoryUploadsApi'));
    expect(offenders).toEqual([]);
  });
});
