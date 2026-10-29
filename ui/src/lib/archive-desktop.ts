import type { api } from './client';
import type { ArchiveApi, ExtractOptions } from './archive-api';
import type { NativeArchivePlan } from '../bindings';

type ArchiveClient = Pick<typeof api, 'archiveListEntries' | 'archiveReadEntry' | 'archivePlanExtract' | 'archiveExtract' | 'archiveCancel'>;
const optionKey = (options: ExtractOptions) => JSON.stringify(options);
const decode = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** Owned upload IDs only. Native retains the immutable plan; the UI receives an opaque token. */
export function createBindingsArchiveApi(client: ArchiveClient, uploadId: string, expectedRoot: string): ArchiveApi {
  let epoch = 0;
  let planned: { value: NativeArchivePlan; options: string; running: boolean } | undefined;
  const validate = (options: ExtractOptions) => {
    if (!expectedRoot) throw new Error('Open a workspace folder to extract an archive.');
    if (!['workspace', 'new-folder'].includes(options.target)) throw new Error('ZIP extraction currently creates a new folder in the workspace.');
    if (options.conflict !== 'ask' || options.openWhenDone) throw new Error('This extractor creates a fresh folder and never replaces existing files.');
  };
  return {
    canExtract: Boolean(expectedRoot),
    freshFolderOnly: true,
    targets: () => expectedRoot ? [{ kind: 'workspace', label: 'New folder in workspace', detail: 'Existing files are never replaced' }] : [],
    async list() {
      const listing = await client.archiveListEntries(uploadId, expectedRoot);
      return {
        format: listing.format.toUpperCase(),
        method: listing.method.toLowerCase() === 'zip' ? undefined : listing.method,
        entries: listing.entries.map(entry => ({ path: entry.path, dir: entry.dir, size: entry.size, packed: entry.packed, modified: entry.modified ?? undefined, encrypted: entry.encrypted, unsafeReason: entry.unsafeReason ?? undefined })),
      };
    },
    async readEntry(path) {
      const chunk = await client.archiveReadEntry(uploadId, expectedRoot, path);
      return decode(chunk.dataBase64);
    },
    async planExtract(options) {
      validate(options);
      const ticket = ++epoch;
      const previous = planned;
      planned = undefined;
      if (previous) await client.archiveCancel(previous.value.planId);
      if (ticket !== epoch) throw new Error('Archive preparation was cancelled.');
      const value = await client.archivePlanExtract(uploadId, expectedRoot, { paths: options.paths === 'all' ? null : options.paths, keepStructure: options.keepStructure, skipHidden: options.skipHidden });
      if (ticket !== epoch) {
        await client.archiveCancel(value.planId);
        throw new Error('Archive preparation was cancelled.');
      }
      planned = { value, options: optionKey(options), running: false };
      return { destination: value.destination, files: value.files, bytes: value.bytes, conflicts: [], skippedUnsafe: value.skippedUnsafe };
    },
    async extract(options, onProgress) {
      validate(options);
      const current = planned;
      if (!current || current.options !== optionKey(options) || current.running) throw new Error('Prepare this exact extraction again before running it.');
      const ticket = epoch;
      current.running = true;
      try {
        const result = await client.archiveExtract(current.value.planId, expectedRoot, progress => { if (ticket === epoch) onProgress({ done: progress.done, total: progress.total, bytes: progress.bytes, current: progress.current }); });
        if (result.error) throw new Error(`${result.extracted} files completed in ${result.destination}. ${result.error}`);
        return { extracted: result.extracted, skipped: result.skipped.length, destination: result.destination, cancelled: result.cancelled };
      } finally { if (planned === current) planned = undefined; }
    },
    async cancel() {
      epoch += 1;
      const current = planned;
      planned = undefined;
      if (current) await client.archiveCancel(current.value.planId);
    },
  };
}
