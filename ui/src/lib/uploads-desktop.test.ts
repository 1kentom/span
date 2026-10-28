// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Upload_Serialize } from '../bindings';
import { createBindingsUploadsApi, createUploadRecorder, uploadEntry, uploadOrigin, SAVE_DIR, type UploadsClient } from './uploads-desktop';
import { UploadsError } from './uploads-api';

const upload = (patch: Partial<Upload_Serialize> = {}): Upload_Serialize => ({
  id: 'a'.repeat(32), name: 'notes.md', mime: 'text/markdown', size: 5, kind: 'document', fingerprint: 'fnv1a128:0', createdMs: 1000, missing: false,
  source: { sessionId: 'session-123456789', agentId: 'claude-acp', messageId: '4', origin: 'dropped' }, ...patch,
});
const b64 = (text: string) => btoa(text);
function client(patch: Partial<UploadsClient> = {}): UploadsClient {
  return {
    uploadsList: vi.fn(async () => [upload(), upload({ id: 'b'.repeat(32), missing: true })]),
    uploadsAdd: vi.fn(async (name: string) => upload({ name })),
    uploadsRead: vi.fn(async (_id: string, offset: number, len: number) => { const all = 'hello world'; const part = all.slice(offset, offset + len); return { dataBase64: b64(part), eof: offset + len >= all.length }; }),
    uploadsRename: vi.fn(async () => upload()),
    uploadsDuplicate: vi.fn(async () => upload({ id: 'c'.repeat(32), name: 'notes (1).md' })),
    uploadsRemove: vi.fn(async () => undefined),
    uploadsSaveToWorkspace: vi.fn(async () => ({ path: 'assets/notes.md' })),
    uploadsCopyPath: vi.fn(async () => '/data/open/x/notes.md'),
    uploadsReveal: vi.fn(async () => undefined),
    uploadsOpen: vi.fn(async () => undefined),
    uploadsUsage: vi.fn(async () => ({ count: 1, totalBytes: 5, maxTotalBytes: 512 })),
    ...patch,
  };
}

describe('desktop uploads api over the generated commands', () => {
  it('maps store records to panel entries, hiding entries whose blob is missing', async () => {
    const api = createBindingsUploadsApi(client(), { sessionTitle: id => (id === 'session-123456789' ? 'Fix the toggle' : undefined) });
    const list = await api.list();
    expect(list).toEqual([{ id: 'a'.repeat(32), name: 'notes.md', size: 5, mime: 'text/markdown', createdAt: 1000, origin: 'sent', session: { id: 'session-123456789', title: 'Fix the toggle' }, agent: { id: 'claude-acp' } }]);
    expect(uploadEntry(upload({ source: { sessionId: 'abcdefghij', agentId: null, messageId: null, origin: 'agent-generated' } }))).toMatchObject({ origin: 'generated', session: { title: 'Chat abcdefgh' } });
  });
  it('reads in chunks until the requested length or the end', async () => {
    const c = client();
    const api = createBindingsUploadsApi(c);
    expect(new TextDecoder().decode(await api.read('a'.repeat(32), 0, 5))).toBe('hello');
    expect(new TextDecoder().decode(await api.read('a'.repeat(32), 6, 100))).toBe('world');
  });
  it('saves to the workspace through uploads_save_to_workspace into the assets folder', async () => {
    const c = client();
    const api = createBindingsUploadsApi(c);
    expect(api.capabilities.saveToWorkspace).toBe(true);
    expect(await api.saveToWorkspace('a'.repeat(32))).toBe('assets/notes.md');
    expect(c.uploadsSaveToWorkspace).toHaveBeenCalledWith('a'.repeat(32), SAVE_DIR);
    expect(await api.path('a'.repeat(32))).toBe('/data/open/x/notes.md');
    expect(await api.usage()).toEqual({ count: 1, bytes: 5, limitBytes: 512 });
  });
  it('adds picked files with the picked origin', async () => {
    const c = client();
    const api = createBindingsUploadsApi(c, { pick: async () => [new File(['hi'], 'a.txt', { type: 'text/plain' })] });
    const added = await api.add();
    expect(added.map(entry => entry.name)).toEqual(['a.txt']);
    expect(c.uploadsAdd).toHaveBeenCalledWith('a.txt', b64('hi'), { origin: 'picked' });
  });
  it('turns backend failures into UploadsError, gone for a missing upload', async () => {
    const api = createBindingsUploadsApi(client({ uploadsRemove: vi.fn(async () => { throw 'upload not found'; }), uploadsReveal: vi.fn(async () => { throw new Error('denied'); }) }));
    await expect(api.remove('x')).rejects.toMatchObject({ code: 'gone' });
    await expect(api.reveal('x')).rejects.toBeInstanceOf(UploadsError);
  });
  it('records through uploads_add and maps attachment sources to store origins', async () => {
    const c = client();
    const recorder = createUploadRecorder(c);
    expect(await recorder.add('n.md', 'eA==', { origin: 'pasted', sessionId: 's', agentId: 'a', messageId: '1' })).toEqual({ id: 'a'.repeat(32) });
    expect(await recorder.copyPath('a'.repeat(32))).toBe('/data/open/x/notes.md');
    expect(['picked', 'pasted', 'dropped', 'workspace-file'].map(uploadOrigin)).toEqual(['picked', 'pasted', 'dropped', 'sent']);
  });
});
