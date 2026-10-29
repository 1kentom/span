import { createSignal } from 'solid-js';
import type { ImageSource } from '../bindings';
import type { Attachment } from './attachments';
import { safeRasterSource } from './asset-preview';
import { workspaceRelative } from './agent-view';

export type SavedImageCandidate = { id: string; path: string };
export type SavedImage =
  | { state: 'pending' }
  | { state: 'unavailable'; reason: string }
  | { state: 'ready'; attachment: Attachment; src: string };
type Entry = SavedImageCandidate & { epoch: number; value: SavedImage };

export const SAVED_IMAGE_COUNT = 32;
export const SAVED_IMAGE_BYTES = 32 * 1024 * 1024;

type ReadRequest = { current: () => boolean; load: () => Promise<ImageSource>; resolve: (source: ImageSource | undefined) => void; reject: (error: unknown) => void };
let nativeReads = 0;
let pendingReads: ReadRequest[] = [];
function pumpNativeReads() {
  pendingReads = pendingReads.filter((request) => {
    if (request.current()) return true;
    request.resolve(undefined);
    return false;
  });
  while (nativeReads < 2 && pendingReads.length) {
    const request = pendingReads.shift()!;
    nativeReads += 1;
    void Promise.resolve().then(() => request.current() ? request.load() : undefined).then(request.resolve, request.reject).finally(() => { nativeReads -= 1; pumpNativeReads(); });
  }
}
function withNativeRead(load: () => Promise<ImageSource>, current: () => boolean): Promise<ImageSource | undefined> {
  return new Promise((resolve, reject) => {
    pendingReads.push({ load, current, resolve, reject });
    pumpNativeReads();
  });
}

/** Completed tool previews only. Native canonicalization is the authority for all file reads. */
export function createSavedImageStore(load: (path: string, expectedRoot: string) => Promise<ImageSource>) {
  const [version, setVersion] = createSignal(0);
  let scope = '';
  let root = '';
  let epoch = 0;
  let disposed = false;
  let active = 0;
  let retainedBytes = 0;
  let entries = new Map<string, Entry>();
  let queue: Entry[] = [];
  const changed = () => setVersion((value) => value + 1);
  const current = (entry: Entry) => !disposed && entry.epoch === epoch && entries.get(entry.id) === entry;

  function pump() {
    while (!disposed && active < 2 && queue.length) {
      const entry = queue.shift()!;
      if (!current(entry)) continue;
      const expectedRoot = root;
      active += 1;
      // Keep active requests counted across resets, even though their results will be discarded.
      void withNativeRead(() => load(entry.path, expectedRoot), () => current(entry)).then((source) => {
        if (!current(entry) || !source) return;
        const image = safeRasterSource(source);
        if (retainedBytes + image.bytes > SAVED_IMAGE_BYTES) throw new Error('Generated image previews reached the 32 MiB session limit.');
        const binary = atob(image.url.slice(image.url.indexOf(',') + 1));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        const path = workspaceRelative(expectedRoot, entry.path);
        if (!path) throw new Error('Generated image is outside the workspace.');
        const attachment: Attachment = {
          id: `saved-image:${JSON.stringify([entry.id, entry.path])}`,
          name: path.split('/').pop() || 'Generated image',
          path, kind: 'image', source: 'workspace-file', mime: image.mime, size: bytes.length, bytes, status: 'ready',
        };
        retainedBytes += bytes.length;
        entry.value = { state: 'ready', attachment, src: image.url };
        changed();
      }).catch((error: unknown) => {
        if (!current(entry)) return;
        entry.value = { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
        changed();
      }).finally(() => { active -= 1; pump(); });
    }
  }

  function sync(nextScope: string, nextRoot: string, candidates: readonly SavedImageCandidate[]) {
    if (disposed) return;
    if (scope !== nextScope || root !== nextRoot) {
      scope = nextScope;
      root = nextRoot;
      epoch += 1;
      entries = new Map();
      retainedBytes = 0;
      queue = [];
    }
    const latest = new Map(candidates.slice(-SAVED_IMAGE_COUNT).map((candidate) => [candidate.id, candidate]));
    for (const [id, entry] of entries) {
      if (latest.get(id)?.path === entry.path) continue;
      if (entry.value.state === 'ready') retainedBytes -= entry.value.attachment.size;
      entries.delete(id);
    }
    queue = queue.filter(current);
    for (const candidate of latest.values()) {
      if (entries.has(candidate.id)) continue;
      const entry: Entry = { ...candidate, epoch, value: { state: 'pending' } };
      entries.set(candidate.id, entry);
      if (!root || !candidate.path || candidate.path.length > 4096 || candidate.path.includes('\0') || candidate.path.includes('://')) {
        entry.value = { state: 'unavailable', reason: 'Generated images must be local files in the open workspace.' };
      } else queue.push(entry);
    }
    changed();
    pumpNativeReads();
    pump();
  }

  return {
    sync,
    get(id: string, path: string): SavedImage | undefined {
      version();
      const entry = entries.get(id);
      return entry?.path === path ? entry.value : undefined;
    },
    findAttachment(id: string): Attachment | undefined {
      version();
      for (const entry of entries.values()) {
        if (entry.value.state === 'ready' && entry.value.attachment.id === id) return entry.value.attachment;
      }
    },
    dispose() {
      disposed = true;
      epoch += 1;
      entries.clear();
      queue = [];
      retainedBytes = 0;
      pumpNativeReads();
      changed();
    },
  };
}
