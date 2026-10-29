/**
 * Paced reveal for streamed agent text. The full received text always lives in the feed; this module only decides how
 * much of it to show on the next animation frame. Pure: no timers, no DOM.
 */

/** A backlog that arrives mid turn is fully shown within this window. */
export const CATCH_UP_MS = 400;
/** When the turn ends, whatever is still hidden is shown within this window. */
export const FLUSH_MS = 150;
/** Steady pace for small chunks, in characters per millisecond (about 120 characters a second). */
export const MIN_RATE = 0.12;
/** A word longer than this is split rather than held back. */
const MAX_WORD = 48;

export interface RevealState {
  /** Characters of the received text currently shown. */
  revealed: number;
  /** Characters per millisecond for the current backlog; 0 when caught up. */
  rate: number;
}

export interface RevealOptions {
  /** The turn ended: flush the rest quickly and stop holding back unfinished markup. */
  done?: boolean;
  /** Show everything at once; the caller still batches updates per frame. */
  reducedMotion?: boolean;
}

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Never end between the two halves of a surrogate pair. */
export function clampSurrogate(text: string, index: number): number {
  if (index > 0 && index < text.length && isHigh(text.charCodeAt(index - 1))) return index + 1;
  return index;
}

type Segmenter = { segment(input: string): Iterable<{ index: number; segment: string }> };
let segmenter: Segmenter | null | undefined;
function wordSegmenter(): Segmenter | null {
  if (segmenter === undefined) {
    const Ctor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter;
    segmenter = Ctor ? new Ctor(undefined, { granularity: "word" }) : null;
  }
  return segmenter;
}

/**
 * The word boundary at or after `target`. `partial` is true when the word runs to the end of the received text and may
 * still be arriving, so showing it now could show half a word.
 */
export function wordBoundary(text: string, target: number): { end: number; start: number; partial: boolean } {
  if (target <= 0) return { end: 0, start: 0, partial: false };
  if (target >= text.length) {
    let start = text.length;
    while (start > 0 && !isSpace(text[start - 1])) start--;
    return { end: text.length, start, partial: !isSpace(text[text.length - 1]) };
  }
  const segments = wordSegmenter();
  if (segments) {
    const from = Math.max(0, target - MAX_WORD);
    const to = Math.min(text.length, target + MAX_WORD);
    const window = text.slice(from, to);
    for (const part of segments.segment(window)) {
      const start = from + part.index;
      const end = start + part.segment.length;
      if (end < target) continue;
      if (start >= target) return { end: target, start: target, partial: false };
      // The segmenter cuts at the window edge, so a word touching it is either too long or still arriving.
      const atEdge = end === to;
      if (atEdge && to === text.length) return { end, start, partial: true };
      return { end: clampSurrogate(text, end), start, partial: false };
    }
    return { end: target, start: target, partial: false };
  }
  if (isSpace(text[target - 1]) || isSpace(text[target])) return { end: target, start: target, partial: false };
  let start = target;
  while (start > 0 && !isSpace(text[start - 1])) start--;
  let end = target;
  const limit = Math.min(text.length, target + MAX_WORD);
  while (end < limit && !isSpace(text[end])) end++;
  if (end === text.length && !isSpace(text[end - 1])) return { end, start, partial: true };
  return { end: clampSurrogate(text, end), start, partial: false };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** True when `index` (a line start) sits inside an open code fence. */
export function insideFence(text: string, index: number): boolean {
  let open: string | undefined;
  for (const line of text.slice(0, index).split("\n")) {
    const match = FENCE.exec(line);
    if (!match) continue;
    if (!open) open = match[1];
    else if (match[1][0] === open[0] && match[1].length >= open.length && !line.slice(match[0].length).trim()) open = undefined;
  }
  return open !== undefined;
}

const lineStartOf = (text: string, index: number) => text.lastIndexOf("\n", index - 1) + 1;
const lineEndOf = (text: string, index: number) => {
  const end = text.indexOf("\n", index);
  return end < 0 ? -1 : end;
};

/** A line made only of block markers (`-`, `1.`, `#`, `>`, `---`) can render as a different block once its text arrives. */
const MARKERS_ONLY = /^\s*(?:[-*+#>=_|`~]+|\d+[.)])?\s*$/;
/** Lines that only make sense whole: fence openers and table rows. */
const WHOLE_LINE = /^ {0,3}(?:`{3,}|~{3,}|\|)/;

/** Inline pairs whose opener alone renders as raw markup. */
const PAIRS: { open: string; close: string }[] = [
  { open: "`", close: "`" },
  { open: "**", close: "**" },
  { open: "__", close: "__" },
  { open: "~~", close: "~~" },
];

/** The index of an unclosed inline opener in `line`, ignoring markers inside code spans. */
function unclosedOpener(line: string): { at: number; close: string } | undefined {
  let open: { at: number; close: string } | undefined;
  for (let index = 0; index < line.length; ) {
    if (open) {
      if (line.startsWith(open.close, index)) {
        index += open.close.length;
        open = undefined;
        continue;
      }
      index++;
      continue;
    }
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    const pair = PAIRS.find((candidate) => line.startsWith(candidate.open, index));
    if (pair) {
      open = { at: index, close: pair.close };
      index += pair.open.length;
      continue;
    }
    index++;
  }
  return open;
}

/** An unfinished `[label](target` link: returns the `[` index. */
function unclosedLink(line: string): number | undefined {
  const open = line.lastIndexOf("[");
  if (open < 0) return undefined;
  const rest = line.slice(open);
  const close = rest.indexOf("]");
  if (close < 0) return open;
  if (rest[close + 1] === "(" && !rest.slice(close + 2).includes(")")) return open;
  return undefined;
}

/**
 * Moves a raw reveal target to a place that renders cleanly: a whole word, never half a surrogate pair, and (while the
 * turn runs) never an unclosed fence line, table header, lone list marker, code span, bold run or link. Missing text is
 * waited for rather than shown as raw markup. Returns a value in [revealed, text.length].
 */
export function snapReveal(text: string, revealed: number, target: number, done = false): number {
  if (target >= text.length) return done ? text.length : holdPartialWord(text, revealed, text.length);
  if (target <= revealed) return revealed;
  const word = wordBoundary(text, target);
  if (done) return Math.max(revealed, word.end);
  const end = word.partial ? word.start : word.end;
  if (end <= revealed) return revealed;
  return Math.max(revealed, settleMarkup(text, revealed, end));
}

function holdPartialWord(text: string, revealed: number, end: number): number {
  const word = wordBoundary(text, end);
  const at = word.partial ? word.start : word.end;
  return Math.max(revealed, at <= revealed ? revealed : settleMarkup(text, revealed, at));
}

function settleMarkup(text: string, revealed: number, end: number): number {
  for (let pass = 0; pass < 4; pass++) {
    const next = settleOnce(text, end);
    if (next === end) break;
    end = next;
  }
  return Math.max(revealed, end);
}

/** One adjustment step. Returns `end` when nothing needs to change. */
function settleOnce(text: string, end: number): number {
  if (end >= text.length && text.endsWith("\n")) return end;
  const lineStart = lineStartOf(text, end);
  if (end === lineStart) return end;
  const lineEnd = lineEndOf(text, end);
  const shown = text.slice(lineStart, end);
  const fenced = insideFence(text, lineStart);
  // A fence line or table row is shown whole; a table header waits for its delimiter row too.
  if (WHOLE_LINE.test(shown)) {
    if (end === lineEnd) {
      if (!shown.trimStart().startsWith("|") || fenced) return end;
    } else if (lineEnd < 0) return lineStart;
    else return lineEnd;
    const previousStart = lineStartOf(text, lineStart - 1);
    const previous = lineStart > 0 ? text.slice(previousStart, lineStart - 1) : "";
    if (previous.trimStart().startsWith("|")) return end;
    const nextEnd = lineEndOf(text, end + 1);
    return nextEnd < 0 ? lineStart : nextEnd;
  }
  if (fenced) return end;
  if (MARKERS_ONLY.test(shown)) {
    // Show the marker together with its first word, or not at all yet.
    let index = end;
    while (index < text.length && text[index] !== "\n" && /\s/.test(text[index])) index++;
    if (index >= text.length || text[index] === "\n") return lineStart;
    const word = wordBoundary(text, index + 1);
    return word.partial ? lineStart : Math.max(end, word.end);
  }
  // Opening markers belong to the word after them: never end on `*`, `_`, `~`, backtick or `[` that leads into text.
  const markers = /[*_~`[]+$/.exec(shown);
  if (markers && (end >= text.length || !/\s/.test(text[end]))) {
    const before = shown.slice(0, -markers[0].length);
    const closes = unclosedOpener(before) !== undefined && unclosedOpener(shown) === undefined;
    if (!closes) return end - markers[0].length;
  }
  const inline = unclosedOpener(shown);
  if (inline) {
    const close = text.indexOf(inline.close, end);
    const limit = lineEnd < 0 ? text.length : lineEnd;
    if (close >= 0 && close + inline.close.length <= limit) return close + inline.close.length;
    // A finished line without a closer stays literal for good, so there is nothing to wait for.
    return lineEnd < 0 ? lineStart + inline.at : end;
  }
  const link = unclosedLink(shown);
  if (link !== undefined && lineEnd < 0) {
    // The rest of this unfinished line is everything received, so a complete link is shown whole or waited for.
    const from = lineStart + link;
    const match = /^\[[^\]\n]*\](\([^)\n]*\))?/.exec(text.slice(from));
    if (match) {
      const after = from + match[0].length;
      const waitsForTarget = !match[1] && (after === text.length || text[after] === "(");
      if (!waitsForTarget) return Math.max(end, after);
    }
    return from;
  }
  return end;
}

/**
 * Advances the reveal by one frame. The pace keeps the highest rate needed by any backlog until it is cleared, so a
 * burst finishes within CATCH_UP_MS of arriving (FLUSH_MS once the turn is done) instead of tailing off.
 */
export function stepReveal(text: string, state: RevealState, elapsedMs: number, options: RevealOptions = {}): RevealState {
  const length = text.length;
  if (options.reducedMotion || state.revealed >= length) return { revealed: length, rate: 0 };
  const revealed = Math.max(0, state.revealed);
  const backlog = length - revealed;
  const window = options.done ? FLUSH_MS : CATCH_UP_MS;
  const rate = Math.max(state.rate, MIN_RATE, backlog / window);
  const elapsed = Math.max(0, elapsedMs);
  if (!elapsed) return { revealed, rate };
  const target = Math.min(length, revealed + Math.max(1, Math.ceil(rate * elapsed)));
  const next = snapReveal(text, revealed, target, options.done);
  return { revealed: next, rate: next >= length ? 0 : rate };
}
