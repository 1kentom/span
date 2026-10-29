import { Prec, type Extension } from "@codemirror/state";
import { keymap, type Command, type KeyBinding } from "@codemirror/view";
import { insertNewlineAndIndent } from "@codemirror/commands";
import type { Language } from "@codemirror/language";
import { continueListAtLineEndCommand, continueListCommand, deleteListMarkupCommand, indentListCommand, outdentListCommand } from "./markdown-lists";
import { decreaseHeading, headingCommand, increaseHeading, markdownSurround, toggleBlockquoteCommand, toggleBold, toggleBulletListCommand, toggleInlineCode, toggleItalic, toggleOrderedListCommand, toggleStrikethrough, toggleTaskCommand } from "./markdown-format";
import { markdownPasteHandlers } from "./markdown-paste";
import { markdownRegionFolding } from "./markdown-fold";
import { markdownSnippetSource } from "./markdown-snippets";

/**
 * Markdown keys. Mod+B and Mod+E are also the workbench's Toggle Project Panel and Toggle Files defaults, which
 * the window handles first, so bold and inline code only get them when those commands are rebound.
 */
export const markdownKeymap: readonly KeyBinding[] = [
  { key: "Enter", run: continueListCommand, shift: insertNewlineAndIndent },
  { key: "Mod-Enter", run: continueListAtLineEndCommand },
  { key: "Tab", run: indentListCommand, shift: outdentListCommand },
  { key: "Backspace", run: deleteListMarkupCommand },
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-Shift-x", run: toggleStrikethrough },
  { key: "Alt-s", mac: "Ctrl-Alt-s", run: toggleStrikethrough },
  { key: "Mod-e", run: toggleInlineCode },
  { key: "Alt-c", mac: "Mod-Alt-c", run: toggleTaskCommand },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-Alt-${level}`, run: headingCommand(level) })),
];

/** Every Markdown editing command, for a later command palette registry. Ids are not in the Rust COMMAND_IDS list yet. */
export const markdownCommands: readonly { id: string; label: string; run: Command }[] = [
  { id: "markdown.toggleBold", label: "Markdown: Toggle Bold", run: toggleBold },
  { id: "markdown.toggleItalic", label: "Markdown: Toggle Italic", run: toggleItalic },
  { id: "markdown.toggleStrikethrough", label: "Markdown: Toggle Strikethrough", run: toggleStrikethrough },
  { id: "markdown.toggleCodeSpan", label: "Markdown: Toggle Inline Code", run: toggleInlineCode },
  { id: "markdown.toggleTask", label: "Markdown: Toggle Task", run: toggleTaskCommand },
  { id: "markdown.toggleBlockquote", label: "Markdown: Toggle Blockquote", run: toggleBlockquoteCommand },
  { id: "markdown.toggleBulletList", label: "Markdown: Toggle Bullet List", run: toggleBulletListCommand },
  { id: "markdown.toggleOrderedList", label: "Markdown: Toggle Ordered List", run: toggleOrderedListCommand },
  { id: "markdown.increaseHeading", label: "Markdown: Increase Heading Level", run: increaseHeading },
  { id: "markdown.decreaseHeading", label: "Markdown: Decrease Heading Level", run: decreaseHeading },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ id: `markdown.heading${level}`, label: `Markdown: Heading ${level}`, run: headingCommand(level) })),
];

/** List continuation, list Tab and Backspace, formatting keys, surround, smart paste, region folding and snippets. */
export function markdownEditing(language: Language): Extension {
  return [
    Prec.high(keymap.of(markdownKeymap)),
    Prec.high(markdownSurround),
    markdownPasteHandlers,
    markdownRegionFolding,
    language.data.of({ autocomplete: markdownSnippetSource, closeBrackets: { brackets: ["(", "[", "{", "<", "'", "\"", "`"] } }),
  ];
}
