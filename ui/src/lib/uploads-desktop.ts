/**
 * Desktop glue for the uploads store (ADR 0006): the UploadsApi the Uploads workspace reads, and the recorder the
 * agent send path writes through. Both use the generated uploads_* commands via client.ts. The browser preview gets
 * the unavailable api and no recorder, so nothing pretends to be stored there.
 */
import type { Upload_Serialize, UploadOrigin, UploadSource_Deserialize } from '../bindings';
import { createUnavailableUploadsApi, UploadsError, type UploadEntry, type UploadsApi } from './uploads-api';

/** The client functions this module needs. Injected so tests never touch Tauri. */
export interface UploadsClient {
  uploadsList(): Promise<Upload_Serialize[]>;
  uploadsAdd(name: string, dataBase64: string, source: UploadSource_Deserialize): Promise<Upload_Serialize>;
  uploadsRead(id: string, offset: number, len: number): Promise<{ dataBase64: string; eof: boolean }>;
  uploadsRename(id: string, name: string): Promise<Upload_Serialize>;
  uploadsDuplicate(id: string): Promise<Upload_Serialize>;
  uploadsRemove(id: string): Promise<void>;
  uploadsSaveToWorkspace(id: string, dir: string): Promise<{ path: string }>;
  uploadsCopyPath(id: string): Promise<string>;
  uploadsReveal(id: string): Promise<void>;
  uploadsOpen(id: string): Promise<void>;
  uploadsUsage(): Promise<{ count: number; totalBytes: number; maxTotalBytes: number }>;
}

/** Records sent attachments in the uploads store. `copyPath` is the app data path of a named copy, for a link. */
export interface UploadRecorder {
  add(name: string, dataBase64: string, source: UploadSource_Deserialize): Promise<{ id: string }>;
  copyPath(id: string): Promise<string>;
}

/** Workspace folder that Save to workspace writes into, the same default the agent panel uses for attachments. */
export const SAVE_DIR = 'assets';
/** uploads_read returns at most 4 MiB per call. */
const READ_CHUNK = 4 * 1024 * 1024;

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
function encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Store record to panel entry. Session titles are not in the store, so a short id stands in until one is known. */
export function uploadEntry(upload: Upload_Serialize, sessionTitle?: (id: string) => string | undefined): UploadEntry {
  const { sessionId, agentId, origin } = upload.source;
  return {
    id: upload.id, name: upload.name, size: upload.size, mime: upload.mime || undefined, createdAt: upload.createdMs,
    origin: origin === 'agent-generated' ? 'generated' : 'sent',
    ...(sessionId ? { session: { id: sessionId, title: sessionTitle?.(sessionId) ?? `Chat ${sessionId.slice(0, 8)}` } } : {}),
    ...(agentId ? { agent: { id: agentId } } : {}),
  };
}

/** Lets the user pick files with a hidden file input. Must run from a click. Resolves empty when cancelled. */
function pickFiles(): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

export function createBindingsUploadsApi(client: UploadsClient, options: { pick?: () => Promise<File[]>; sessionTitle?: (id: string) => string | undefined } = {}): UploadsApi {
  const call = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); } catch (cause) {
      const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : String((cause as { message?: string })?.message ?? cause);
      throw new UploadsError(/not found|no such|unknown upload/i.test(message) ? 'gone' : 'io', message);
    }
  };
  const entry = (upload: Upload_Serialize) => uploadEntry(upload, options.sessionTitle);
  return {
    available: true,
    capabilities: { add: true, rename: true, duplicate: true, remove: true, saveToWorkspace: true, reveal: true, openWithSystem: true, chooseApplication: false, copyPath: true, usage: true },
    list: () => call(async () => (await client.uploadsList()).filter(upload => !upload.missing).map(entry)),
    read: (id, offset, length) => call(async () => {
      const parts: Uint8Array[] = [];
      let read = 0;
      while (read < length) {
        const chunk = await client.uploadsRead(id, offset + read, Math.min(READ_CHUNK, length - read));
        const bytes = decode(chunk.dataBase64);
        parts.push(bytes);
        read += bytes.length;
        if (chunk.eof || !bytes.length) break;
      }
      const out = new Uint8Array(read);
      let at = 0;
      for (const part of parts) { out.set(part, at); at += part.length; }
      return out;
    }),
    add: () => call(async () => {
      const files = await (options.pick ?? pickFiles)();
      const added: UploadEntry[] = [];
      for (const file of files) added.push(entry(await client.uploadsAdd(file.name, encode(new Uint8Array(await file.arrayBuffer())), { origin: 'picked' })));
      return added;
    }),
    rename: (id, name) => call(async () => { await client.uploadsRename(id, name); }),
    duplicate: id => call(async () => entry(await client.uploadsDuplicate(id))),
    remove: id => call(() => client.uploadsRemove(id)),
    saveToWorkspace: id => call(async () => (await client.uploadsSaveToWorkspace(id, SAVE_DIR)).path),
    reveal: id => call(() => client.uploadsReveal(id)),
    openWithSystem: id => call(() => client.uploadsOpen(id)),
    chooseApplication: () => Promise.reject(new UploadsError('unsupported', 'Choose application is not available.')),
    path: id => call(() => client.uploadsCopyPath(id)),
    usage: () => call(async () => { const usage = await client.uploadsUsage(); return { count: usage.count, bytes: usage.totalBytes, limitBytes: usage.maxTotalBytes }; }),
  };
}

export function createUploadRecorder(client: Pick<UploadsClient, 'uploadsAdd' | 'uploadsCopyPath'>): UploadRecorder {
  return {
    add: async (name, dataBase64, source) => ({ id: (await client.uploadsAdd(name, dataBase64, source)).id }),
    copyPath: id => client.uploadsCopyPath(id),
  };
}

/** Store origin for an attachment source. Workspace files and selections are never recorded (they live in the workspace). */
export function uploadOrigin(source: string): UploadOrigin {
  return source === 'pasted' ? 'pasted' : source === 'dropped' ? 'dropped' : source === 'picked' ? 'picked' : 'sent';
}

export { createUnavailableUploadsApi };
