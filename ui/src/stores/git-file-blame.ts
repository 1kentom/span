import { createEffect, createMemo, createSignal, on } from "solid-js";
import type { GitBlame, GitBlameLine, GitFileBaseline_Serialize } from "../bindings";
import { gitLineHunks, gitOriginalLine } from "../lib/git-decorations";

export type GitBlameRow = { line: number; text: string; attribution?: GitBlameLine; changed: boolean };
const PAGE_SIZE = 150;
/** Keep rendering bounded and withhold attribution unless an exact HEAD mapping exists. */
export function createGitFileBlame(options: {
  path: () => string;
  text: () => string | undefined;
  blame: () => GitBlame | undefined;
  baseline: () => GitFileBaseline_Serialize | undefined;
}) {
  const [page, setPage] = createSignal(0);
  const [heatmap, setHeatmap] = createSignal(false);
  createEffect(on(options.path, () => setPage(0)));
  const source = createMemo(() => {
    const text = options.text(), baseline = options.baseline(), blame = options.blame();
    if (text === undefined || text.length > 2 * 1024 * 1024 || !baseline || baseline.binary || baseline.truncated || baseline.headText == null || !blame || blame.path !== baseline.path || blame.repositoryId !== baseline.repositoryId) return;
    const hunks = gitLineHunks(baseline.headText, text);
    if (!hunks) return;
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const authors = new Map(blame.lines.map(line => [line.line, line]));
    return { path: options.path(), lines, hunks, authors };
  });
  const pages = createMemo(() => Math.max(1, Math.ceil((source()?.lines.length ?? 0) / PAGE_SIZE)));
  const currentPage = createMemo(() => Math.min(page(), pages() - 1));
  const rows = createMemo<GitBlameRow[]>(() => {
    const value = source();
    if (!value) return [];
    const offset = currentPage() * PAGE_SIZE;
    return value.lines.slice(offset, offset + PAGE_SIZE).map((text, index) => {
      const line = offset + index + 1, original = gitOriginalLine(value.hunks, line);
      return { line, text, attribution: original === undefined ? undefined : value.authors.get(original), changed: original === undefined };
    });
  });
  // Fixed age bands remain stable across pagination and explain the color without relying on it.
  const age = (timestamp: number, now = Date.now() / 1000) => !Number.isFinite(timestamp) ? "unknown" : now - timestamp < 30 * 86400 ? "recent" : now - timestamp < 180 * 86400 ? "months" : "older";
  return { rows, pages, page: currentPage, available: () => !!source(), total: () => source()?.lines.length ?? 0, heatmap, toggleHeatmap: () => setHeatmap(value => !value), age,
    previous: () => setPage(Math.max(0, currentPage() - 1)), next: () => setPage(Math.min(pages() - 1, currentPage() + 1)) };
}
