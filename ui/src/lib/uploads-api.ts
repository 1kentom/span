/**
 * Typed client for uploads (files the user sent to an agent, or files an agent generated).
 *
 * The UI codes against `UploadsApi` only. Capability flags hide every action the backend does not offer.
 * - `createDesktopUploadsApi(commands)` is the thin adapter over the generated Tauri wrappers
 *   (uploads_list, uploads_add, uploads_read, uploads_rename, uploads_duplicate, uploads_remove,
 *   uploads_save_to_workspace, uploads_reveal, uploads_open, uploads_usage). A lead passes the generated
 *   `commands` object from bindings.ts once those wrappers exist; missing wrappers become missing capabilities.
 * - `createUnavailableUploadsApi()` is what the browser preview uses: no data, a clear reason.
 * - `createMemoryUploadsApi()` exists for tests only. App code must not import it (a test enforces this).
 */

export interface UploadEntry {
  id: string;
  name: string;
  /** Bytes. */
  size: number;
  mime?: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** `sent`: the user attached it. `generated`: an agent created it. */
  origin: 'sent' | 'generated';
  session?: { id?: string; title: string };
  /** Agent brand, resolved by BrandIcon from id or name. */
  agent?: { id?: string; name?: string };
}

export interface UploadsUsage { count: number; bytes: number; limitBytes?: number }

/** Optional extra data. The audio viewer renders a transcript or chapters only when present. */
export interface UploadExtras {
  transcript?: { at: number; speaker?: string; text: string; source?: string }[];
  chapters?: { at: number; label: string }[];
}

export interface UploadsCapabilities {
  add: boolean;
  rename: boolean;
  duplicate: boolean;
  remove: boolean;
  saveToWorkspace: boolean;
  reveal: boolean;
  openWithSystem: boolean;
  chooseApplication: boolean;
  copyPath: boolean;
  usage: boolean;
}

export const NO_CAPABILITIES: UploadsCapabilities = Object.freeze({ add: false, rename: false, duplicate: false, remove: false, saveToWorkspace: false, reveal: false, openWithSystem: false, chooseApplication: false, copyPath: false, usage: false });

export type UploadsErrorCode = 'gone' | 'unavailable' | 'unsupported' | 'invalid' | 'io';
export class UploadsError extends Error {
  constructor(readonly code: UploadsErrorCode, message: string) { super(message); this.name = 'UploadsError'; }
}

export interface UploadsApi {
  /** False in the browser preview. The UI then shows `unavailableReason` and nothing else. */
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly capabilities: UploadsCapabilities;
  list(): Promise<UploadEntry[]>;
  /** Reads `length` bytes from `offset`. Rejects with code `gone` when the upload no longer exists. */
  read(id: string, offset: number, length: number): Promise<Uint8Array>;
  /** Asks the user for files and adds them. Returns the new entries (empty when cancelled). */
  add(): Promise<UploadEntry[]>;
  rename(id: string, name: string): Promise<void>;
  duplicate(id: string): Promise<UploadEntry>;
  remove(id: string): Promise<void>;
  /** Returns the workspace-relative path it was saved to. */
  saveToWorkspace(id: string): Promise<string>;
  reveal(id: string): Promise<void>;
  openWithSystem(id: string): Promise<void>;
  chooseApplication(id: string): Promise<void>;
  /** Absolute path, only when `capabilities.copyPath`. */
  path(id: string): Promise<string>;
  usage(): Promise<UploadsUsage>;
  extras?(id: string): Promise<UploadExtras | undefined>;
}

const unsupported = (action: string) => Promise.reject(new UploadsError('unsupported', `${action} is not available.`));

export function createUnavailableUploadsApi(reason = 'Uploads need the desktop app'): UploadsApi {
  const no = () => Promise.reject(new UploadsError('unavailable', reason));
  return {
    available: false, unavailableReason: reason, capabilities: NO_CAPABILITIES,
    list: async () => [], read: no, add: no, rename: no, duplicate: no, remove: no, saveToWorkspace: no, reveal: no, openWithSystem: no, chooseApplication: no, path: no, usage: no,
  };
}

/**
 * Shape of the generated Tauri wrappers this adapter expects. Names follow tauri-specta's camelCase output for
 * the uploads_* commands. Adjust the element types here once bindings.ts has the real ones; the UI is unaffected.
 */
export interface UploadsCommands {
  uploadsList(): Promise<UploadEntry[]>;
  uploadsRead(id: string, offset: number, length: number): Promise<number[] | Uint8Array>;
  uploadsAdd?(): Promise<UploadEntry[]>;
  uploadsRename?(id: string, name: string): Promise<void>;
  uploadsDuplicate?(id: string): Promise<UploadEntry>;
  uploadsRemove?(id: string): Promise<void>;
  uploadsSaveToWorkspace?(id: string): Promise<string>;
  uploadsReveal?(id: string): Promise<void>;
  uploadsOpen?(id: string): Promise<void>;
  uploadsUsage?(): Promise<UploadsUsage>;
}

/** Map a backend error (string, Error or a serialised error object) to an UploadsError. */
function toUploadsError(cause: unknown): UploadsError {
  if (cause instanceof UploadsError) return cause;
  const record = (typeof cause === 'object' && cause !== null ? cause : {}) as { kind?: string; code?: string; message?: string };
  const message = typeof cause === 'string' ? cause : record.message ?? (cause instanceof Error ? cause.message : String(cause));
  const kind = `${record.kind ?? record.code ?? ''}`.toLowerCase();
  if (kind === 'notfound' || kind === 'not_found' || kind === 'gone' || /not found|no such/i.test(message)) return new UploadsError('gone', message);
  if (kind === 'invalid' || kind === 'invalidname') return new UploadsError('invalid', message);
  return new UploadsError('io', message);
}
async function call<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (cause) { throw toUploadsError(cause); }
}

export function createDesktopUploadsApi(commands: UploadsCommands): UploadsApi {
  const c = commands;
  return {
    available: true,
    capabilities: {
      add: !!c.uploadsAdd, rename: !!c.uploadsRename, duplicate: !!c.uploadsDuplicate, remove: !!c.uploadsRemove, saveToWorkspace: !!c.uploadsSaveToWorkspace,
      reveal: !!c.uploadsReveal, openWithSystem: !!c.uploadsOpen, chooseApplication: false, copyPath: false, usage: !!c.uploadsUsage,
    },
    list: () => call(() => c.uploadsList()),
    read: (id, offset, length) => call(async () => { const data = await c.uploadsRead(id, offset, length); return data instanceof Uint8Array ? data : Uint8Array.from(data); }),
    add: () => c.uploadsAdd ? call(() => c.uploadsAdd!()) : unsupported('Adding uploads'),
    rename: (id, name) => c.uploadsRename ? call(() => c.uploadsRename!(id, name)) : unsupported('Rename'),
    duplicate: id => c.uploadsDuplicate ? call(() => c.uploadsDuplicate!(id)) : unsupported('Duplicate'),
    remove: id => c.uploadsRemove ? call(() => c.uploadsRemove!(id)) : unsupported('Remove'),
    saveToWorkspace: id => c.uploadsSaveToWorkspace ? call(() => c.uploadsSaveToWorkspace!(id)) : unsupported('Save to workspace'),
    reveal: id => c.uploadsReveal ? call(() => c.uploadsReveal!(id)) : unsupported('Reveal'),
    openWithSystem: id => c.uploadsOpen ? call(() => c.uploadsOpen!(id)) : unsupported('Open with system app'),
    chooseApplication: () => unsupported('Choose application'),
    path: () => unsupported('Copy path'),
    usage: () => c.uploadsUsage ? call(() => c.uploadsUsage!()) : unsupported('Usage'),
  };
}

export interface MemoryUpload { entry: UploadEntry; data: Uint8Array; extras?: UploadExtras }
export type MemoryUploadsApi = UploadsApi & { calls: [string, string][] };

/** Tests only. Holds uploads in memory and records actions that would leave the app. */
export function createMemoryUploadsApi(seed: MemoryUpload[] = [], capabilities: Partial<UploadsCapabilities> = {}): MemoryUploadsApi {
  const store = new Map(seed.map(item => [item.entry.id, { ...item, entry: { ...item.entry, size: item.data.length } }]));
  const calls: [string, string][] = [];
  let next = 1;
  const get = (id: string) => { const item = store.get(id); if (!item) throw new UploadsError('gone', 'This upload no longer exists.'); return item; };
  const taken = (name: string, except?: string) => [...store.values()].some(item => item.entry.id !== except && item.entry.name.toLowerCase() === name.toLowerCase());
  return {
    available: true, calls,
    capabilities: { add: true, rename: true, duplicate: true, remove: true, saveToWorkspace: true, reveal: true, openWithSystem: true, chooseApplication: true, copyPath: true, usage: true, ...capabilities },
    async list() { return [...store.values()].map(item => item.entry).sort((a, b) => b.createdAt - a.createdAt); },
    async read(id, offset, length) { const { data } = get(id); return data.slice(offset, offset + length); },
    async add() { return []; },
    async rename(id, name) {
      const item = get(id);
      if (taken(name, id)) throw new UploadsError('invalid', 'Another upload already has this name.');
      item.entry = { ...item.entry, name };
    },
    async duplicate(id) {
      const item = get(id);
      const dot = item.entry.name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [item.entry.name.slice(0, dot), item.entry.name.slice(dot)] : [item.entry.name, ''];
      let name = `${stem} copy${ext}`;
      for (let n = 2; taken(name); n++) name = `${stem} copy ${n}${ext}`;
      const entry = { ...item.entry, id: `copy-${next++}`, name, createdAt: item.entry.createdAt };
      store.set(entry.id, { entry, data: item.data.slice() });
      return entry;
    },
    async remove(id) { get(id); store.delete(id); },
    async saveToWorkspace(id) { calls.push(['saveToWorkspace', id]); return `uploads/${get(id).entry.name}`; },
    async reveal(id) { get(id); calls.push(['reveal', id]); },
    async openWithSystem(id) { get(id); calls.push(['openWithSystem', id]); },
    async chooseApplication(id) { get(id); calls.push(['chooseApplication', id]); },
    async path(id) { return `/uploads/${get(id).entry.name}`; },
    async usage() { const items = [...store.values()]; return { count: items.length, bytes: items.reduce((sum, item) => sum + item.data.length, 0) }; },
    async extras(id) { return get(id).extras; },
  };
}
