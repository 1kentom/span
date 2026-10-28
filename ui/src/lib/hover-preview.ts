/**
 * PREVIEW ONLY. Labelled sample files and hover answers so the hover popup, the link affordance and
 * the editor context menu can be exercised in the browser without the desktop backend. The answers are
 * looked up by word, they are not language analysis, the native app never uses them, and they prove
 * nothing about real language servers.
 */
import type { CapabilitiesDto, DiagnosticsPublished_Deserialize, HoverDto_Serialize, LspResponse, PositionDto } from "../bindings";
import type { LanguageServerId } from "../bindings";

export const previewHoverFiles: Readonly<Record<string, string>> = {
  "src/hover-sample/Controller.java": `package com.kentom.todo;

import javafx.scene.control.ComboBox;

public class Controller {
    private ComboBox<String> filter;

    @Override
    public void initialize() {
        filter.getItems().add("All");
    }
}
`,
  "src/hover-sample/api.ts": `/**
 * Adds two numbers.
 * @param a the first number
 */
export function add(a: number, b: number): number {
  return a + b;
}

export const total = add(1, "2");
`,
};

export const previewHoverCapabilities: CapabilitiesDto = {
  completion: false, hover: true, definition: true, formatting: false, rangeFormatting: false, rename: true, prepareRename: true, references: true,
  implementation: true, typeDefinition: true, declaration: false, documentSymbol: true, workspaceSymbol: true, callHierarchy: true,
  typeHierarchy: false, documentHighlight: false, signatureHelp: false,
};

export const previewHoverServer = (path: string): LanguageServerId | undefined => path.startsWith("src/hover-sample/") ? (path.endsWith(".java") ? "jdtls" : "vtsls") : undefined;

const answers: Record<string, string> = {
  initialize: "```java\nvoid com.kentom.todo.Controller.initialize()\n```\n\nSource: *jdt.ls-java-project*",
  ComboBox: "```java\nclass javafx.scene.control.ComboBox<T>\n```\n\n<p>An implementation of the ComboBox abstract class. A <b>ComboBox</b> shows a list of items and lets the user pick one.</p><ul><li>Editable with <code>setEditable(true)</code></li><li>See <a href=\"https://openjfx.io/\">OpenJFX</a></li></ul>",
  add: "```typescript\nfunction add(a: number, b: number): number\n```\n\nAdds two numbers.\n\n*@param* `a` - the first number",
  total: "```typescript\nconst total: number\n```",
};

function wordAt(text: string, position: PositionDto): string | undefined {
  const line = text.split("\n")[position.line] ?? "";
  const match = [...line.matchAll(/[\p{L}\p{N}_$]+/gu)].find(item => position.character >= item.index! && position.character <= item.index! + item[0].length);
  return match?.[0];
}

export function previewHover(path: string, position: PositionDto): LspResponse<HoverDto_Serialize | null> {
  const text = previewHoverFiles[path];
  const word = text ? wordAt(text, position) : undefined;
  return { revision: 0, epoch: 0, data: word && answers[word] ? { markdown: answers[word], range: null } : null } as LspResponse<HoverDto_Serialize | null>;
}

/** The sample type error in api.ts, shown with the hover on `"2"`. */
export function previewDiagnostics(path: string, revision: number): DiagnosticsPublished_Deserialize | undefined {
  if (path !== "src/hover-sample/api.ts") return undefined;
  return { path, revision, diagnostics: [{ severity: "error", message: "Argument of type 'string' is not assignable to parameter of type 'number'.", source: "ts", code: "2345", range: { start: { line: 8, character: 31 }, end: { line: 8, character: 34 } } }] } as DiagnosticsPublished_Deserialize;
}
