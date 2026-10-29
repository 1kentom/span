/**
 * In-memory ArchiveApi for tests only. App code must never import this module
 * (a test in ArchiveView.test.tsx enforces it). Extraction is driven by the test through `emit` and `finish`.
 */
import type { ArchiveApi, ArchiveEntry, ExtractOptions, ExtractPlan, ExtractProgress, ExtractResult, ExtractTarget } from './archive-api';

export interface MemoryArchive {
  api: ArchiveApi;
  calls: { method: string; options?: ExtractOptions; path?: string }[];
  emit(progress: ExtractProgress): void;
  finish(result?: Partial<ExtractResult>): void;
  fail(message: string): void;
}

export function createMemoryArchiveApi(entries: ArchiveEntry[], options: { canExtract?: boolean; conflicts?: string[]; files?: Record<string, Uint8Array>; destination?: string } = {}): MemoryArchive {
  const calls: MemoryArchive['calls'] = [];
  const destination = options.destination ?? 'agent-panel/build-artifacts/';
  let progress: ((p: ExtractProgress) => void) | undefined;
  let settle: { resolve(result: ExtractResult): void; reject(error: Error): void } | undefined;
  const targets: ExtractTarget[] = [
    { kind: 'workspace', label: 'Extract to workspace', detail: destination },
    { kind: 'here', label: 'Extract here', detail: 'Next to the upload, in uploads/' },
    { kind: 'choose', label: 'Extract to…', detail: 'Choose a folder' },
    { kind: 'new-folder', label: 'Extract into a new folder', detail: 'build-artifacts 2/' },
  ];
  const api: ArchiveApi = {
    canExtract: options.canExtract ?? true,
    targets: () => targets,
    async list() { calls.push({ method: 'list' }); return { format: 'ZIP', method: 'Deflate', entries }; },
    async readEntry(path) { calls.push({ method: 'readEntry', path }); const data = options.files?.[path]; if (!data) throw new Error(`${path} is not in the archive.`); return data; },
    async planExtract(opts): Promise<ExtractPlan> {
      calls.push({ method: 'planExtract', options: opts });
      const files = opts.paths === 'all' ? entries.filter(e => !e.dir).length : opts.paths.length;
      return { destination, files, bytes: 0, conflicts: options.conflicts ?? [], skippedUnsafe: [] };
    },
    extract(opts, onProgress) {
      calls.push({ method: 'extract', options: opts });
      progress = onProgress;
      return new Promise<ExtractResult>((resolve, reject) => { settle = { resolve, reject }; });
    },
    async cancel() { calls.push({ method: 'cancel' }); settle?.resolve({ extracted: 0, skipped: 0, destination, cancelled: true }); },
  };
  return {
    api, calls,
    emit: p => progress?.(p),
    finish: result => settle?.resolve({ extracted: 3, skipped: 0, destination, ...result }),
    fail: message => settle?.reject(new Error(message)),
  };
}
