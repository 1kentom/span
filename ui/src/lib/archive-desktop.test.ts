import { describe, expect, it, vi } from 'vitest';
import { createBindingsArchiveApi } from './archive-desktop';
import type { ExtractOptions } from './archive-api';

const options: ExtractOptions = { target: 'workspace', paths: 'all', keepStructure: true, skipHidden: true, openWhenDone: false, conflict: 'ask' };
const nativePlan = { planId: 'plan-1', destination: 'extracted-files', files: 1, bytes: 4, skippedUnsafe: ['link'] };
function client() {
  return {
    archiveListEntries: vi.fn(async () => ({ format: 'zip', method: 'zip', entries: [{ path: 'link', dir: false, size: 4, packed: 4, modified: null, encrypted: false, unsafeReason: 'Symbolic links are skipped' }] })),
    archiveReadEntry: vi.fn(async () => ({ dataBase64: 'dGVzdA==' })),
    archivePlanExtract: vi.fn(async () => nativePlan),
    archiveExtract: vi.fn(async (_id: string, _root: string, progress: (value: { done: number; total: number; bytes: number; current: string }) => void) => {
      progress({ done: 1, total: 1, bytes: 4, current: 'a.txt' });
      return { extracted: 1, skipped: ['link'], destination: 'extracted-files', cancelled: false, error: null };
    }),
    archiveCancel: vi.fn(async (_id: string) => undefined),
  };
}

describe('native ZIP adapter', () => {
  it('lists native refusals and passes only the owned upload ID and exact root', async () => {
    const commands = client();
    const api = createBindingsArchiveApi(commands, 'owned-upload', '/workspace');
    expect(await api.list()).toMatchObject({ format: 'ZIP', entries: [{ path: 'link', unsafeReason: 'Symbolic links are skipped' }] });
    expect(commands.archiveListEntries).toHaveBeenCalledWith('owned-upload', '/workspace');
    expect([...await api.readEntry('a.txt')]).toEqual([116, 101, 115, 116]);
    expect(commands.archiveReadEntry).toHaveBeenCalledWith('owned-upload', '/workspace', 'a.txt');
    expect(api.freshFolderOnly).toBe(true);
    expect(api.targets().map(target => target.kind)).toEqual(['workspace']);
  });
  it('retains the opaque native token and runs only the exact prepared options', async () => {
    const commands = client();
    const api = createBindingsArchiveApi(commands, 'owned', '/w');
    await expect(api.extract(options, () => undefined)).rejects.toThrow('Prepare this exact extraction');
    expect(await api.planExtract(options)).toMatchObject({ destination: 'extracted-files', conflicts: [], skippedUnsafe: ['link'] });
    expect(commands.archivePlanExtract).toHaveBeenCalledWith('owned', '/w', { paths: null, keepStructure: true, skipHidden: true });
    await expect(api.extract({ ...options, keepStructure: false }, () => undefined)).rejects.toThrow('Prepare this exact extraction');
    const progress = vi.fn();
    expect(await api.extract(options, progress)).toMatchObject({ extracted: 1, skipped: 1, destination: 'extracted-files' });
    expect(commands.archiveExtract).toHaveBeenCalledWith('plan-1', '/w', expect.any(Function));
    expect(progress).toHaveBeenCalledWith({ done: 1, total: 1, bytes: 4, current: 'a.txt' });
    await expect(api.extract(options, progress)).rejects.toThrow('Prepare this exact extraction');
  });
  it('does not expose replace or arbitrary destination behavior', async () => {
    const commands = client();
    const api = createBindingsArchiveApi(commands, 'owned', '/w');
    for (const patch of [{ conflict: 'replace' as const }, { target: 'choose' as const }, { openWhenDone: true }]) {
      await expect(api.planExtract({ ...options, ...patch })).rejects.toThrow();
    }
    expect(commands.archivePlanExtract).not.toHaveBeenCalled();
  });
  it('cancels a native plan that arrives after the viewer was closed', async () => {
    const commands = client();
    let resolve!: (value: typeof nativePlan) => void;
    commands.archivePlanExtract.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const api = createBindingsArchiveApi(commands, 'owned', '/w');
    const pending = api.planExtract(options);
    await Promise.resolve();
    await api.cancel();
    resolve(nativePlan);
    await expect(pending).rejects.toThrow('cancelled');
    expect(commands.archiveCancel).toHaveBeenCalledWith('plan-1');
    expect(commands.archiveExtract).not.toHaveBeenCalled();
  });
  it('reports partial extraction errors and releases the completed native token', async () => {
    const commands = client();
    commands.archiveExtract.mockResolvedValueOnce({ extracted: 1, skipped: [], destination: 'extracted-files', cancelled: false, error: 'CRC check failed' } as never);
    const api = createBindingsArchiveApi(commands, 'owned', '/w');
    await api.planExtract(options);
    await expect(api.extract(options, () => undefined)).rejects.toThrow('1 files completed in extracted-files. CRC check failed');
    await expect(api.extract(options, () => undefined)).rejects.toThrow('Prepare this exact extraction');
  });
});
