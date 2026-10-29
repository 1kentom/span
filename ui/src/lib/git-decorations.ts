import type { GitChange, GitContext, GitStatus } from "../bindings";

export type GitLineKind = "added" | "modified" | "deleted";
export type GitLineHunk = { oldStart: number; newStart: number; before: string[]; after: string[]; kind: GitLineKind };
export type GitPathDecoration = { kind: GitLineKind | "renamed" | "conflicted"; badge: string; label: string; count: number };
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_WORK = 250_000;

/** A bounded shortest-edit diff. If the exact result would exceed the budget, show no approximation. */
export function gitLineHunks(baseline: string, current: string): GitLineHunk[] | undefined {
  if (baseline.length > MAX_TEXT || current.length > MAX_TEXT) return;
  const lines = (text: string) => text ? text.replace(/\r\n?/g, "\n").split("\n") : [];
  const before = lines(baseline), after = lines(current);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  if (prefix === oldEnd && prefix === newEnd) return [];
  const old = before.slice(prefix, oldEnd), next = after.slice(prefix, newEnd);
  const operations = shortestEdit(old, next);
  if (!operations) return;
  const hunks: GitLineHunk[] = [];
  let oldLine = prefix + 1, newLine = prefix + 1;
  let hunk: GitLineHunk | undefined;
  for (const operation of operations) {
    if (operation === "equal") { hunk = undefined; oldLine++; newLine++; continue; }
    if (!hunk) { hunk = { oldStart: oldLine, newStart: newLine, before: [], after: [], kind: "added" }; hunks.push(hunk); }
    if (operation === "delete") hunk.before.push(before[oldLine++ - 1]);
    else hunk.after.push(after[newLine++ - 1]);
    hunk.kind = hunk.before.length ? hunk.after.length ? "modified" : "deleted" : "added";
  }
  return hunks;
}

type Edit = "equal" | "delete" | "insert";
function shortestEdit(before: string[], after: string[]): Edit[] | undefined {
  if (!before.length) return after.map(() => "insert");
  if (!after.length) return before.map(() => "delete");
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let work = 0;
  for (let depth = 0; depth <= before.length + after.length; depth++) {
    trace.push(frontier);
    const next = new Map<number, number>();
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      if (++work > MAX_WORK) return;
      const left = frontier.get(diagonal - 1) ?? -1;
      const right = frontier.get(diagonal + 1) ?? -1;
      let x = diagonal === -depth || diagonal !== depth && left < right ? right : left + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) { x++; y++; if (++work > MAX_WORK) return; }
      next.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        const result: Edit[] = [];
        for (let step = depth; step >= 0; step--) {
          const previous = trace[step], k = x - y;
          const previousK = k === -step || k !== step && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1) ? k + 1 : k - 1;
          const previousX = previous.get(previousK) ?? 0, previousY = previousX - previousK;
          while (x > previousX && y > previousY) { result.push("equal"); x--; y--; }
          if (step > 0) { if (x === previousX) { result.push("insert"); y--; } else { result.push("delete"); x--; } }
        }
        return result.reverse();
      }
    }
    frontier = next;
  }
}

function changeDecoration(entry: GitChange): GitPathDecoration {
  if (entry.conflicted) return { kind: "conflicted", badge: "!", label: "Merge conflict", count: 1 };
  if (entry.untracked) return { kind: "added", badge: "U", label: "Untracked", count: 1 };
  const codes = `${entry.indexStatus}${entry.worktreeStatus}`;
  const staged = !["", ".", " ", "?", "!"].includes(entry.indexStatus);
  const working = !["", ".", " ", "!"].includes(entry.worktreeStatus);
  const suffix = staged && working ? ", staged and working changes" : staged ? ", staged" : ", working changes";
  if (codes.includes("D")) return { kind: "deleted", badge: "D", label: `Deleted${suffix}`, count: 1 };
  if (codes.includes("R")) return { kind: "renamed", badge: "R", label: `Renamed${suffix}`, count: 1 };
  if (codes.includes("A")) return { kind: "added", badge: "A", label: `Added${suffix}`, count: 1 };
  return { kind: "modified", badge: "M", label: `Modified${suffix}`, count: 1 };
}

/** Git paths are relative to the repository, while tree and buffer paths are relative to the open workspace. */
export function gitPathDecorations(context: GitContext | undefined, status: GitStatus | undefined, dirtyPaths: readonly string[] = []): Map<string, GitPathDecoration> {
  const result = new Map<string, GitPathDecoration>();
  if (!context?.enabled || !context.repository || status?.repository.id !== context.repository.id) return result;
  const prefix = context.repository.workspacePrefix.replace(/\/$/, "");
  for (const entry of status.entries) {
    if (entry.path == null || prefix && !entry.path.startsWith(`${prefix}/`)) continue;
    const path = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
    result.set(path, changeDecoration(entry));
  }
  for (const path of dirtyPaths) {
    if (path.includes("://")) continue;
    const prior = result.get(path);
    result.set(path, prior ? { ...prior, label: `${prior.label}, unsaved changes` } : { kind: "modified", badge: "M", label: "Modified, unsaved changes", count: 1 });
  }
  return result;
}

export function gitFolderDecorations(files: ReadonlyMap<string, GitPathDecoration>): Map<string, GitPathDecoration> {
  const result = new Map<string, GitPathDecoration>();
  for (const [path, status] of files) {
    let parent = path.lastIndexOf("/");
    while (parent > 0) {
      const folder = path.slice(0, parent), prior = result.get(folder);
      const count = (prior?.count ?? 0) + 1;
      const kind = status.kind === "conflicted" || prior?.kind === "conflicted" ? "conflicted" : prior && prior.kind !== status.kind ? "modified" : status.kind;
      result.set(folder, { kind, badge: "•", label: `${count} changed ${count === 1 ? "file" : "files"}${kind === "conflicted" ? ", includes merge conflicts" : ""}`, count });
      parent = path.lastIndexOf("/", parent - 1);
    }
  }
  return result;
}

/** Maps an unchanged current line to its HEAD line. Added and replaced lines have no prior attribution. */
export function gitOriginalLine(hunks: readonly GitLineHunk[], currentLine: number): number | undefined {
  let offset = 0;
  for (const hunk of hunks) {
    if (currentLine < hunk.newStart) break;
    if (currentLine < hunk.newStart + hunk.after.length) return;
    offset += hunk.before.length - hunk.after.length;
  }
  return currentLine + offset;
}
