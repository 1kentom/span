import { createSignal } from "solid-js";
import type { DiagnosticsPublished_Deserialize } from "../bindings";
import { toProblems, type Problem } from "../lib/problems";

const [byPath, setByPath] = createSignal<ReadonlyMap<string, readonly Problem[]>>(new Map());
const none: readonly Problem[] = [];

/** Errors and warnings of the latest publish for each open file. A publish with none clears the file. */
export function ingestDiagnostics(event: Pick<DiagnosticsPublished_Deserialize, "path" | "diagnostics">): void {
  const problems = toProblems(event.diagnostics ?? []);
  setByPath(current => {
    if (!problems.length && !current.has(event.path)) return current;
    const next = new Map(current);
    if (problems.length) next.set(event.path, problems); else next.delete(event.path);
    return next;
  });
}
export const problemsFor = (path: string): readonly Problem[] => byPath().get(path) ?? none;
export const problemCounts = (path: string): { errors: number; warnings: number } | undefined => {
  const list = byPath().get(path);
  if (!list) return undefined;
  const errors = list.filter(item => item.severity === "error").length;
  return { errors, warnings: list.length - errors };
};
/** Forgets files `keep` rejects, or everything when called without an argument. */
export function pruneProblems(keep?: (path: string) => boolean): void {
  setByPath(current => {
    const next = new Map([...current].filter(([path]) => keep?.(path) ?? false));
    return next.size === current.size ? current : next;
  });
}
