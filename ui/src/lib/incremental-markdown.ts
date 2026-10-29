/**
 * Incremental block parsing for streamed markdown. Text before the last safe block break is parsed once and kept; each
 * update re-parses only the tail after it, so a long message costs a tail parse per frame instead of a full parse.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])(?:\s|$)/;

/**
 * The last offset at or after `from` where the text can be split into two independently parsed documents without
 * changing how either renders: a line start after a blank line, outside a code fence, that does not indent into or
 * continue the previous block. `from` must itself be such a break (or 0). Returns `from` when there is none.
 */
export function lastSafeBreak(text: string, from: number): number {
  let best = from;
  let open: string | undefined;
  let previousBlank = false;
  let index = from;
  while (index < text.length) {
    const newline = text.indexOf("\n", index);
    // An unfinished last line is never a break candidate: it may still turn into anything.
    if (newline < 0) break;
    const line = text.slice(index, newline);
    const fence = FENCE.exec(line);
    if (open) {
      if (fence && fence[1][0] === open[0] && fence[1].length >= open.length && !line.slice(fence[0].length).trim()) open = undefined;
      previousBlank = false;
    } else {
      const blank = !line.trim();
      if (previousBlank && !blank && index > from && !/^\s/.test(line) && !LIST_ITEM.test(line) && !line.startsWith("[")) best = index;
      if (fence) open = fence[1];
      previousBlank = blank;
    }
    index = newline + 1;
  }
  return best;
}

export interface IncrementalParser<B> {
  (source: string): B[];
  /** Characters passed to the underlying parser so far (for tests and benchmarks). */
  readonly parsedChars: number;
}

const countLines = (text: string) => {
  let lines = 0;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) lines++;
  return lines;
};

/**
 * Wraps a whole-document block parser. `parse` gets the line the text starts on, so source positions stay those of the
 * whole message. Frozen blocks keep their identity, so renderers can skip them.
 */
export function createIncrementalParser<B>(parse: (text: string, startLine: number) => B[]): IncrementalParser<B> {
  let frozenSource = "";
  let frozenLines = 0;
  let frozen: B[] = [];
  let parsedChars = 0;
  const run = (text: string) => {
    parsedChars += text.length;
    return parse(text, frozenLines);
  };
  const update = ((source: string) => {
    if (!source.startsWith(frozenSource)) {
      frozenSource = "";
      frozenLines = 0;
      frozen = [];
    }
    const cut = lastSafeBreak(source, frozenSource.length);
    if (cut > frozenSource.length) {
      const chunk = source.slice(frozenSource.length, cut);
      frozen = frozen.concat(run(chunk));
      frozenSource = source.slice(0, cut);
      frozenLines += countLines(chunk);
    }
    const tail = source.slice(frozenSource.length);
    return tail ? frozen.concat(run(tail)) : frozen.slice();
  }) as IncrementalParser<B>;
  Object.defineProperty(update, "parsedChars", { get: () => parsedChars });
  return update;
}

/** Shifts block token source lines so a chunk parsed on its own reports lines of the whole message. */
export function offsetLines<B extends { tokens: { map: [number, number] | null }[] }>(blocks: B[], startLine: number): B[] {
  if (startLine)
    for (const block of blocks)
      for (const token of block.tokens) if (token.map) token.map = [token.map[0] + startLine, token.map[1] + startLine];
  return blocks;
}
