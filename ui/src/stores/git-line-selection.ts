import { createEffect, createMemo, createSignal } from "solid-js";
import type { GitLineReview } from "../bindings";
import { MAX_GIT_DIFF_LINES } from "../lib/git-diff";

/** Selection identities and snapshots belong to the immutable server review. */
export function createGitLineSelection(review: () => GitLineReview | undefined) {
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>());
  const [metadata, setMetadata] = createSignal(false);
  let anchor: string | undefined;
  const fingerprint = createMemo(() => JSON.stringify(review()));
  createEffect(() => { fingerprint(); setSelected(new Set<string>()); setMetadata(false); anchor = undefined; });
  const lines = createMemo(() => review()?.hunks.flatMap(hunk => hunk.lines).slice(0, MAX_GIT_DIFF_LINES) ?? []);
  const selectable = createMemo(() => lines().filter(line => line.id && (line.kind === "insert" || line.kind === "delete")));
  const supported = () => !!review() && !review()!.diff.binary && !review()!.diff.truncated && review()!.diff.side !== "commit" && review()!.hunks.reduce((count, hunk) => count + hunk.lines.length, 0) <= MAX_GIT_DIFF_LINES;
  function toggle(id: string, range = false) {
    const ids = selectable().map(line => line.id), index = ids.indexOf(id);
    if (!supported() || index < 0) return;
    const next = new Set(selected());
    const start = anchor ? ids.indexOf(anchor) : -1;
    if (range && start >= 0) for (const value of ids.slice(Math.min(start, index), Math.max(start, index) + 1)) next.add(value);
    else { if (next.has(id)) next.delete(id); else next.add(id); anchor = id; }
    setSelected(next);
  }
  return { selected, metadata, setMetadata, selectable, supported, toggle,
    clear: () => { setSelected(new Set<string>()); setMetadata(false); anchor = undefined; },
    request: () => { const value = review(); return value && supported() ? { review: value, lineIds: selectable().filter(line => selected().has(line.id)).map(line => line.id), includeMetadata: metadata() && value.metadata.length > 0 } : undefined; } };
}
