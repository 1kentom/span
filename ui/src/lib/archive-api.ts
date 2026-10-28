/**
 * The archive viewer talks to its backend through this small interface. The desktop implementation
 * (archive_list, archive_read_entry, archive_plan_extract, archive_extract with a progress Channel,
 * archive_cancel) is wired by the lead from client.ts; this file only defines the contract and the
 * browser preview implementation, which lists and reads ZIP entries locally and never extracts.
 *
 * Adapter point: build an ArchiveApi per opened archive and pass it to ArchiveView as `api`.
 */
import { checkZipBudget, DEFAULT_ZIP_LIMITS, inflateEntry, OfficeError, readZipDirectory, type ZipEntry } from './office/zip';

export interface ArchiveEntry {
  /** Path as stored in the archive, before any normalisation. */
  path: string;
  dir: boolean;
  size: number;
  packed: number;
  /** Milliseconds since the epoch. */
  modified?: number;
  encrypted?: boolean;
}
export interface ArchiveListing { format: string; method?: string; entries: ArchiveEntry[]; truncated?: boolean }
export type ConflictMode = 'ask' | 'skip' | 'replace';
export type ExtractTargetKind = 'workspace' | 'here' | 'choose' | 'new-folder';
export interface ExtractTarget { kind: ExtractTargetKind; label: string; detail: string }
export interface ExtractOptions {
  target: ExtractTargetKind;
  /** Entry paths to extract, or every safe entry. */
  paths: string[] | 'all';
  keepStructure: boolean;
  skipHidden: boolean;
  openWhenDone: boolean;
  conflict: ConflictMode;
}
export interface ExtractPlan { destination: string; files: number; bytes: number; conflicts: string[]; skippedUnsafe: string[] }
export interface ExtractProgress { done: number; total: number; bytes?: number; current?: string }
export interface ExtractResult { extracted: number; skipped: number; destination: string; cancelled?: boolean }

export interface ArchiveApi {
  readonly canExtract: boolean;
  targets(): ExtractTarget[];
  list(): Promise<ArchiveListing>;
  readEntry(path: string): Promise<Uint8Array>;
  planExtract(options: ExtractOptions): Promise<ExtractPlan>;
  extract(options: ExtractOptions, onProgress: (progress: ExtractProgress) => void): Promise<ExtractResult>;
  cancel(): Promise<void>;
}

const methodName = (method: number) => method === 8 ? 'Deflate' : method === 0 ? 'Stored' : `Method ${method}`;
const noExtract = () => Promise.reject(new Error('Extraction needs the desktop app.'));

/** Browser preview: list and read ZIP entries from bytes already in memory. Extraction is disabled. */
export function localZipArchiveApi(bytes: Uint8Array): ArchiveApi {
  let directory: ZipEntry[] | undefined;
  const entries = () => directory ??= readZipDirectory(bytes).entries;
  return {
    canExtract: false,
    targets: () => [],
    async list() {
      const all = entries();
      const methods = [...new Set(all.filter(e => !e.dir).map(e => methodName(e.method)))];
      return { format: 'ZIP', method: methods.join(', ') || undefined, entries: all.map(e => ({ path: e.name, dir: e.dir, size: e.size, packed: e.compressedSize, modified: e.modified, encrypted: e.encrypted })) };
    },
    async readEntry(path) {
      const entry = entries().find(e => e.name === path && !e.dir);
      if (!entry) throw new OfficeError('damaged', `${path} is not in the archive.`);
      const budget = checkZipBudget([entry]);
      if (!budget.ok) throw new OfficeError('too-large', budget.message);
      return inflateEntry(bytes, entry, DEFAULT_ZIP_LIMITS.maxEntryBytes);
    },
    planExtract: noExtract,
    extract: noExtract,
    cancel: async () => undefined,
  };
}
