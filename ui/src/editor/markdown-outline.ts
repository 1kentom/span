import type { Text } from "@codemirror/state";

export interface OutlineHeading {
  level: number;
  text: string;
  /** 1-based line number of the heading text (the first line of a Setext heading). */
  line: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const NOT_PARAGRAPH = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>|#|\||<|`{3}|~{3})|^ {4}|^\t/;

/**
 * Headings of a Markdown document in order: ATX (`# Title`) and Setext (underlined with `===` or `---`).
 * Fenced code and front matter are skipped. For outline panels and breadcrumbs.
 */
export function markdownOutline(source: string | Text): OutlineHeading[] {
  const lines = typeof source === "string" ? source.split(/\r?\n/) : source.toJSON();
  const headings: OutlineHeading[] = [];
  let index = 0;
  const opener = lines[0]?.trimEnd();
  if (opener === "---" || opener === "+++") {
    const close = lines.findIndex((line, at) => at > 0 && (line.trimEnd() === opener || (opener === "---" && line.trimEnd() === "...")));
    if (close > 0) index = close + 1;
  }
  let fence: string | null = null;
  for (; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !line.slice(fenceMatch[0].length).trim()) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; continue; }
    const atx = ATX.exec(line);
    if (atx) { headings.push({ level: atx[1].length, text: (atx[2] ?? "").trim(), line: index + 1 }); continue; }
    const next = lines[index + 1];
    const previous = index > 0 ? lines[index - 1] : "";
    if (next !== undefined && SETEXT.test(next) && line.trim() && !NOT_PARAGRAPH.test(line) && (!previous.trim() || index === 0 || SETEXT.test(previous) || ATX.test(previous))) {
      headings.push({ level: next.trim()[0] === "=" ? 1 : 2, text: line.trim(), line: index + 1 });
      index++;
    }
  }
  return headings;
}
