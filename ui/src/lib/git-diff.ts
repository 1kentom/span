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
