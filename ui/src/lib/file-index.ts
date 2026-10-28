import type { FileIndexStatus } from "../bindings";

/** Counts are observations from the index, not an estimate of total workspace size. */
export function fileIndexMessage(status?: FileIndexStatus | null, error?: string): string {
  if (error) return "File index status unavailable. Retrying…";
  if (!status) return "Starting file index…";
  const count = status.indexedFiles.toLocaleString();
  if (status.status === "scanning") return `Indexing files… ${count} found · ${status.scannedEntries.toLocaleString()} entries scanned`;
  if (status.status === "failed") return `File indexing failed · ${count} files available`;
  if (status.status === "partial") return `File index partial · ${count} files · ${status.errorCount.toLocaleString()} scan errors`;
  if (status.status === "idle") return "Starting file index…";
  return `${count} files indexed${status.watcherError ? " · File watching unavailable" : ""}`;
}
