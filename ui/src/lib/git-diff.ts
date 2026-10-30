export const MAX_GIT_DIFF_LINES = 10_000;
export type GitPatchRow = { text: string; kind: "added" | "removed" | "context" | "header"; oldLine?: number; newLine?: number };
/** Line numbers come from Git's patch headers, never from a mutable editor buffer. */
export function gitPatchRows(patch: string): GitPatchRow[] {
  if (!patch) return [];
  let oldLine: number | undefined; let newLine: number | undefined;
  return patch.split("\n", MAX_GIT_DIFF_LINES).map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, kind: "header" }; }
    if (/^(diff --git|index |--- |\+\+\+ |new file |deleted file |similarity |rename |Binary files|GIT binary patch)/.test(text)) { oldLine = undefined; newLine = undefined; return { text, kind: "header" }; }
    if (oldLine === undefined || newLine === undefined || text.startsWith("\\")) return { text, kind: "header" };
    if (text.startsWith("+")) return { text, kind: "added", newLine: newLine++ };
    if (text.startsWith("-")) return { text, kind: "removed", oldLine: oldLine++ };
    if (text.startsWith(" ")) return { text, kind: "context", oldLine: oldLine++, newLine: newLine++ };
    return { text, kind: "header" };
  });
}

/** Git exposes untracked files as saved text, without an index patch. */
export function gitNewFileRows(text: string): GitPatchRow[] {
  if (!text) return [];
  const lines = text.split("\n", MAX_GIT_DIFF_LINES + 1);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(0, MAX_GIT_DIFF_LINES).map((line, index) => ({ text: `+${line}`, kind: "added", newLine: index + 1 }));
}

export function gitDiffLinesCapped(text: string): boolean {
  let offset = 0;
  for (let line = 0; line < MAX_GIT_DIFF_LINES; line++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return false;
    offset = next + 1;
  }
  return offset < text.length;
}

export type GitSplitRow = { header?: GitPatchRow; left?: GitPatchRow; right?: GitPatchRow };
/** Align only adjacent removed/added blocks. Context is never synthesized. */
export function gitSplitRows(rows: GitPatchRow[]): GitSplitRow[] {
  const result: GitSplitRow[] = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === "header") { result.push({ header: row }); i++; }
    else if (row.kind === "context") { result.push({ left: row, right: row }); i++; }
    else {
      const removed: GitPatchRow[] = [], added: GitPatchRow[] = [];
      while (i < rows.length && rows[i].kind === "removed") removed.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "added") added.push(rows[i++]);
      for (let j = 0; j < Math.max(removed.length, added.length); j++) result.push({ left: removed[j], right: added[j] });
    }
  }
  return result;
}
export type GitWordSegment = { text: string; changed: boolean };
/** Bounded word LCS for the exact displayed line pair, with a whole-line fallback. */
export function gitWordSegments(left: string, right: string): [GitWordSegment[], GitWordSegment[]] {
  const a = left.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  const b = right.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  if (a.length * b.length > 16_384) return [[{ text: left, changed: left !== right }], [{ text: right, changed: left !== right }]];
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  const x = a.map(text => ({ text, changed: true })), y = b.map(text => ({ text, changed: true }));
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { x[i++].changed = false; y[j++].changed = false; }
    else if (matrix[i + 1][j] >= matrix[i][j + 1]) i++; else j++;
  }
  return [x, y];
}
