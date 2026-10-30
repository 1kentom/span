import { snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { inCode } from "./markdown-context";

/** VS Code's Markdown snippets, plus a table. */
export const markdownSnippets: readonly Completion[] = [
  snippetCompletion("**${text}**", { label: "bold", detail: "Insert bold text", type: "text" }),
  snippetCompletion("*${text}*", { label: "italic", detail: "Insert italic text", type: "text" }),
  snippetCompletion("~~${text}~~", { label: "strikethrough", detail: "Insert strikethrough", type: "text" }),
  snippetCompletion("> ${text}", { label: "quote", detail: "Insert quoted text", type: "text" }),
  snippetCompletion("`${code}`", { label: "code", detail: "Insert inline code", type: "text" }),
  snippetCompletion("```${language}\n${code}\n```", { label: "fenced codeblock", detail: "Insert fenced code block", type: "text" }),
  ...[1, 2, 3, 4, 5, 6].map((level) => snippetCompletion(`${"#".repeat(level)} \${heading}`, { label: `heading${level}`, detail: `Insert heading level ${level}`, type: "text" })),
  snippetCompletion("- ${first}\n- ${second}\n- ${third}", { label: "unordered list", detail: "Insert unordered list", type: "text" }),
  snippetCompletion("1. ${first}\n2. ${second}\n3. ${third}", { label: "ordered list", detail: "Insert ordered list", type: "text" }),
  snippetCompletion("- [ ] ${task}", { label: "task list", detail: "Insert task list", type: "text" }),
  snippetCompletion("----------\n", { label: "horizontal rule", detail: "Insert horizontal rule", type: "text" }),
  snippetCompletion("[${title}](${link})", { label: "link", detail: "Insert link", type: "text" }),
  snippetCompletion("![${alt}](${link})", { label: "image", detail: "Insert image", type: "text" }),
  snippetCompletion("| ${Column 1} | ${Column 2} |\n| --- | --- |\n| ${} | ${} |", { label: "table", detail: "Insert table", type: "text" }),
];

/** Offers the snippets while a word that starts one of their names is typed (two letters or more), never in code. */
export function markdownSnippetSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[A-Za-z][\w]*/);
  if (!word && !context.explicit) return null;
  if (inCode(context.state, context.pos, true)) return null;
  const typed = word?.text.toLowerCase() ?? "";
  if (!context.explicit && (typed.length < 2 || !markdownSnippets.some((snippet) => snippet.label.startsWith(typed)))) return null;
  return { from: word?.from ?? context.pos, options: markdownSnippets, validFor: /^\w*$/ };
}
