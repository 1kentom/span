import type { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";

/** The parser extension type, taken from lang-markdown so @lezer/markdown need not be a direct dependency. */
type MarkdownExtension = Exclude<NonNullable<NonNullable<Parameters<typeof markdown>[0]>["extensions"]>, readonly unknown[]>;

/** Bytes searched for the closing delimiter, so an unclosed `---` on line 1 stays a horizontal rule. */
const FRONT_MATTER_SCAN_LIMIT = 64 * 1024;

interface ReadableInput { length: number; read(from: number, to: number): string }

/** Finds the line that closes front matter opened by `delimiter` on line 1. Returns its line index, or -1. */
export function frontMatterEnd(text: string, delimiter: "---" | "+++"): number {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== delimiter) return -1;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index].trimEnd();
    if (line === delimiter || (delimiter === "---" && line === "...")) return index;
  }
  return -1;
}

/**
 * Front matter at the start of a Markdown file: `---` YAML or `+++` TOML, closed by the same
 * delimiter (YAML also accepts `...`). Delimiters, keys, values and comments get their own
 * nodes so they are highlighted; the body is not handed to a nested YAML or TOML parser.
 */
export const frontMatter: MarkdownExtension = {
  defineNodes: [
    { name: "FrontMatter", block: true },
    { name: "FrontMatterMark", style: tags.meta },
    { name: "FrontMatterKey", style: tags.propertyName },
    { name: "FrontMatterValue", style: tags.string },
    { name: "FrontMatterComment", style: tags.lineComment },
  ],
  parseBlock: [{
    name: "FrontMatter",
    before: "HorizontalRule",
    parse(cx, line) {
      if (cx.lineStart !== 0) return false;
      const delimiter = line.text.trimEnd();
      if (delimiter !== "---" && delimiter !== "+++") return false;
      const input = (cx as unknown as { input?: ReadableInput }).input;
      if (!input || frontMatterEnd(input.read(0, Math.min(input.length, FRONT_MATTER_SCAN_LIMIT)), delimiter) < 0) return false;
      const children = [cx.elt("FrontMatterMark", 0, delimiter.length)];
      const separator = delimiter === "---" ? ":" : "=";
      let end = delimiter.length;
      while (cx.nextLine()) {
        const start = cx.lineStart;
        const text = line.text;
        end = start + text.length;
        const trimmed = text.trimEnd();
        if (trimmed === delimiter || (delimiter === "---" && trimmed === "...")) {
          children.push(cx.elt("FrontMatterMark", start, start + trimmed.length));
          cx.nextLine();
          break;
        }
        const leading = /^\s*/.exec(text)![0].length;
        if (text[leading] === "#") { children.push(cx.elt("FrontMatterComment", start + leading, end)); continue; }
        const at = text.indexOf(separator);
        if (at > leading) {
          const key = text.slice(0, at).trimEnd();
          children.push(cx.elt("FrontMatterKey", start + leading, start + key.length));
          const value = text.slice(at + 1);
          const valueStart = at + 1 + (value.length - value.trimStart().length);
          if (valueStart < text.trimEnd().length) children.push(cx.elt("FrontMatterValue", start + valueStart, start + text.trimEnd().length));
        }
      }
      cx.addElement(cx.elt("FrontMatter", 0, end, children));
      return true;
    },
  }],
};
