/**
 * Native ArchiveApi (ADR 0016). Rust lists, previews and extracts; this adapter only maps the viewer's options
 * to typed commands. Extraction always goes into a new folder named after the archive inside a workspace folder,
 * with the Explorer clash policy (keep both by default). Nothing extracted is ever opened.
 */
import { Channel } from '@tauri-apps/api/core';
import {
  commands, type ArchiveEntryData, type ArchiveExtractProgress, type ArchiveExtractReport_Serialize, type ArchiveExtractRequest_Deserialize,
  type ArchiveListing_Serialize, type ArchivePlan, type ArchiveRef, type ConflictPolicy,
} from '../bindings';
import type { ArchiveApi, ConflictMode, ExtractOptions, ExtractTarget, ExtractTargetKind } from './archive-api';

export type { ArchiveRef };
export type ArchiveReport = ArchiveExtractReport_Serialize;

/** The desktop commands the adapter calls. Tests pass a fake. */
export interface ArchiveCommands {
  list(source: ArchiveRef): Promise<ArchiveListing_Serialize>;
  read(source: ArchiveRef, path: string): Promise<ArchiveEntryData>;
  plan(source: ArchiveRef, request: ArchiveExtractRequest_Deserialize): Promise<ArchivePlan>;
  extract(jobId: string, source: ArchiveRef, request: ArchiveExtractRequest_Deserialize, onProgress: (progress: ArchiveExtractProgress) => void): Promise<ArchiveReport>;
  cancel(jobId: string): Promise<void>;
}

export const desktopArchiveCommands: ArchiveCommands = {
  list: source => commands.archiveList(source),
  read: (source, path) => commands.archiveReadEntry(source, path),
  plan: (source, request) => commands.archivePlanExtract(source, request),
  extract: (jobId, source, request, onProgress) => {
    const channel = new Channel<ArchiveExtractProgress>();
    channel.onmessage = onProgress;
    return commands.archiveExtract(jobId, source, request, channel);
  },
  cancel: jobId => commands.archiveCancel(jobId).then(() => undefined),
};

export interface DesktopArchiveOptions {
  /** Workspace folder "Extract here" writes into: the archive's own folder, or "" (the root) for uploads. */
  hereDir: string;
  /** "Extract to…": a workspace relative folder the user picked, or undefined when the picker was dismissed. */
  chooseDir?: () => Promise<string | undefined>;
  /** False without an open workspace: the archive is listed but cannot be extracted. */
  canExtract: boolean;
  /** Runs after an extraction created a folder, for example to refresh the tree and offer Undo. */
  onExtracted?: (report: ArchiveReport, folder: string) => void;
}

const SUFFIXES = ['.tar.gz', '.tgz', '.tar', '.zip', '.jar', '.war', '.apk', '.whl', '.vsix'];
/** "build.tar.gz" to "build", as Rust names the new folder. */
export function archiveFolderName(name: string): string {
  const lower = name.toLowerCase();
  const suffix = SUFFIXES.find(s => lower.endsWith(s));
  const stem = (suffix ? name.slice(0, name.length - suffix.length) : name).replace(/^[. ]+|[. ]+$/g, '');
  return stem && !/[\\/:\u0000]/.test(stem) ? stem : 'extracted';
}

export function policyOf(mode: ConflictMode): ConflictPolicy {
  return mode === 'skip' ? 'skip' : mode === 'replace' ? 'replace' : 'keepBoth';
}

const join = (dir: string, name: string) => dir ? `${dir}/${name}` : name;
const decode = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};
const aborted = () => Object.assign(new Error('Extraction was not started.'), { name: 'AbortError' });
let jobs = 0;

export function createDesktopArchiveApi(client: ArchiveCommands, source: ArchiveRef, name: string, options: DesktopArchiveOptions): ArchiveApi {
  const folder = archiveFolderName(name);
  let chosen: string | undefined;
  let running: string | undefined;
  const request = (dir: string, opts: ExtractOptions): ArchiveExtractRequest_Deserialize => ({
    targetDir: dir, folderName: null, policy: policyOf(opts.conflict),
    options: { paths: opts.paths === 'all' ? null : opts.paths, keepStructure: opts.keepStructure, skipHidden: opts.skipHidden, keepExecutable: !!opts.keepExecutable },
  });
  const dirFor = async (target: ExtractTargetKind, pick: boolean) => {
    if (target !== 'choose') return options.hereDir;
    if (!pick) { if (chosen === undefined) throw aborted(); return chosen; }
    const dir = await options.chooseDir?.();
    if (dir === undefined) throw aborted();
    chosen = dir;
    return dir;
  };
  return {
    canExtract: options.canExtract,
    canOpenWhenDone: false,
    canKeepExecutable: true,
    canKeepBoth: true,
    atomic: true,
    targets(): ExtractTarget[] {
      if (!options.canExtract) return [];
      const here: ExtractTarget = { kind: 'here', label: 'Extract here', detail: `${join(options.hereDir, folder)}/` };
      return options.chooseDir ? [here, { kind: 'choose', label: 'Extract to…', detail: 'Choose a folder in the project' }] : [here];
    },
    async list() {
      const listing = await client.list(source);
      return {
        format: listing.format,
        method: listing.method ?? undefined,
        truncated: listing.truncated,
        entries: listing.entries.map(entry => ({
          path: entry.path, dir: entry.dir, size: entry.size, packed: entry.packed, modified: entry.modified ?? undefined,
          encrypted: entry.encrypted, unsafeReason: entry.unsafeReason ?? undefined,
        })),
      };
    },
    async readEntry(path) {
      return decode((await client.read(source, path)).dataBase64);
    },
    async planExtract(opts) {
      const dir = await dirFor(opts.target, true);
      const plan = await client.plan(source, request(dir, opts));
      return { destination: `${plan.destination}/`, files: plan.files, bytes: plan.bytes, conflicts: plan.conflicts, skippedUnsafe: plan.skipped.map(skip => skip.path) };
    },
    async extract(opts, onProgress) {
      // The job ID exists before the first await, so an early Cancel reaches it.
      const id = `archive-${Date.now()}-${++jobs}`;
      running = id;
      let report: ArchiveReport;
      try {
        const dir = await dirFor(opts.target, false);
        report = await client.extract(id, source, request(dir, opts), progress => onProgress({ done: progress.entries, total: progress.totalEntries, bytes: progress.bytes, current: progress.current }));
      } finally { if (running === id) running = undefined; }
      const dir = opts.target === 'choose' ? chosen ?? '' : options.hereDir;
      if (report.error) throw new Error(report.error);
      if (report.created) options.onExtracted?.(report, dir);
      const destination = report.created ? `${report.created}/` : report.skippedExisting ? `${join(dir, folder)}/ (kept as it was)` : `${join(dir, folder)}/`;
      return { extracted: report.created ? report.entries : 0, skipped: report.skipped.length, destination, cancelled: report.cancelled };
    },
    async cancel() {
      if (running) await client.cancel(running);
    },
  };
}
