import { describe, expect, it, vi } from 'vitest';
import { archiveFolderName, createDesktopArchiveApi, policyOf, type ArchiveCommands, type ArchiveReport } from './archive-desktop';
import type { ExtractOptions } from './archive-api';

const options: ExtractOptions = { target: 'here', paths: 'all', keepStructure: true, skipHidden: false, openWhenDone: false, conflict: 'ask' };
const report = (extra: Partial<ArchiveReport> = {}): ArchiveReport => ({ created: 'docs/site', replaced: null, skippedExisting: false, skipped: [], entries: 2, bytes: 9, cancelled: false, error: null, ...extra });
function fake(overrides: Partial<ArchiveCommands> = {}): ArchiveCommands {
  return {
    list: vi.fn(async () => ({ format: 'ZIP', method: 'Deflate', truncated: false, declaredSize: 9, archiveSize: 50, entries: [
      { path: 'a.txt', dir: false, kind: 'file' as const, size: 4, packed: 4, modified: 1000, encrypted: false, executable: false, unsafeReason: null },
      { path: 'link', dir: false, kind: 'symlink' as const, size: 4, packed: 4, modified: null, encrypted: false, executable: false, unsafeReason: 'symbolic link (links are never extracted)' },
    ] })),
    read: vi.fn(async () => ({ kind: 'text' as const, dataBase64: 'dGVzdA==', truncated: false })),
    plan: vi.fn(async () => ({ destination: 'docs/site', files: 1, bytes: 4, conflicts: [], skipped: [{ path: 'link', reason: 'symbolic link' }] })),
    extract: vi.fn(async (_job, _source, _request, onProgress) => { onProgress({ entries: 1, totalEntries: 1, bytes: 4, totalBytes: 4, current: 'a.txt' }); return report(); }),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}
const source = { kind: 'workspace' as const, path: 'docs/site.zip' };

describe('native archive adapter', () => {
  it('maps the listing, keeps native refusals and decodes previews', async () => {
    const client = fake();
    const api = createDesktopArchiveApi(client, source, 'site.zip', { hereDir: 'docs', canExtract: true });
    const listing = await api.list();
    expect(listing).toMatchObject({ format: 'ZIP', method: 'Deflate', truncated: false });
    expect(listing.entries[0]).toEqual({ path: 'a.txt', dir: false, size: 4, packed: 4, modified: 1000, encrypted: false, unsafeReason: undefined });
    expect(listing.entries[1].unsafeReason).toContain('symbolic link');
    expect([...await api.readEntry('a.txt')]).toEqual([116, 101, 115, 116]);
    expect(client.read).toHaveBeenCalledWith(source, 'a.txt');
    expect(api.canOpenWhenDone).toBe(false);
    expect(api.targets()).toEqual([{ kind: 'here', label: 'Extract here', detail: 'docs/site/' }]);
  });

  it('plans and extracts into a new folder next to the archive with the chosen policy', async () => {
    const client = fake();
    const onExtracted = vi.fn();
    const api = createDesktopArchiveApi(client, source, 'site.zip', { hereDir: 'docs', canExtract: true, onExtracted });
    expect(await api.planExtract(options)).toEqual({ destination: 'docs/site/', files: 1, bytes: 4, conflicts: [], skippedUnsafe: ['link'] });
    expect(client.plan).toHaveBeenCalledWith(source, { targetDir: 'docs', folderName: null, policy: 'keepBoth', options: { paths: null, keepStructure: true, skipHidden: false, keepExecutable: false } });
    const progress = vi.fn();
    const result = await api.extract({ ...options, paths: ['a.txt'], conflict: 'replace', keepExecutable: true }, progress);
    expect(result).toEqual({ extracted: 2, skipped: 0, destination: 'docs/site/', cancelled: false });
    expect((client.extract as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({ targetDir: 'docs', folderName: null, policy: 'replace', options: { paths: ['a.txt'], keepStructure: true, skipHidden: false, keepExecutable: true } });
    expect(progress).toHaveBeenCalledWith({ done: 1, total: 1, bytes: 4, current: 'a.txt' });
    expect(onExtracted).toHaveBeenCalledWith(report(), 'docs');
  });

  it('asks for a folder for "Extract to…" and stops quietly when the picker is dismissed', async () => {
    const chooseDir = vi.fn(async (): Promise<string | undefined> => undefined);
    const client = fake();
    const api = createDesktopArchiveApi(client, source, 'site.zip', { hereDir: 'docs', canExtract: true, chooseDir });
    expect(api.targets().map(target => target.kind)).toEqual(['here', 'choose']);
    await expect(api.planExtract({ ...options, target: 'choose' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.plan).not.toHaveBeenCalled();
    chooseDir.mockResolvedValueOnce('out');
    await api.planExtract({ ...options, target: 'choose' });
    await api.extract({ ...options, target: 'choose' }, () => undefined);
    expect((client.extract as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ targetDir: 'out' });
  });

  it('reports errors, cancels the running job and cannot extract without a workspace', async () => {
    let release!: (value: ArchiveReport) => void;
    const client = fake({ extract: vi.fn(() => new Promise<ArchiveReport>(resolve => { release = resolve; })) });
    const api = createDesktopArchiveApi(client, source, 'site.zip', { hereDir: '', canExtract: true });
    const running = api.extract(options, () => undefined);
    await api.cancel();
    const job = (client.cancel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(job).toBe((client.extract as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    release(report({ created: null, cancelled: true, entries: 0 }));
    expect(await running).toMatchObject({ cancelled: true, extracted: 0 });
    const failing = createDesktopArchiveApi(fake({ extract: vi.fn(async () => report({ created: null, error: 'a.txt holds more data than its header declares' })) }), source, 'site.zip', { hereDir: '', canExtract: true });
    await expect(failing.extract(options, () => undefined)).rejects.toThrow('more data than its header declares');
    const closed = createDesktopArchiveApi(fake(), source, 'site.zip', { hereDir: '', canExtract: false });
    expect(closed.canExtract).toBe(false);
    expect(closed.targets()).toEqual([]);
  });

  it('names the folder like Rust and maps clash modes to the Explorer policy', () => {
    expect(archiveFolderName('build.tar.gz')).toBe('build');
    expect(archiveFolderName('App.JAR')).toBe('App');
    expect(archiveFolderName('.zip')).toBe('extracted');
    expect(policyOf('ask')).toBe('keepBoth');
    expect(policyOf('keepBoth')).toBe('keepBoth');
    expect(policyOf('skip')).toBe('skip');
    expect(policyOf('replace')).toBe('replace');
  });
});
