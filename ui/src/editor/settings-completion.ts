import { snippetCompletion, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { LanguageSupport, StreamLanguage, foldService, type StreamParser } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { findNodeAtLocation, getLocation, parseTree, printParseErrorCode, visit, type Node, type ParseError, type JSONPath } from "jsonc-parser";
import canonicalSchema from "../../../crates/core/settings.schema.json";

interface Schema {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  propertyNames?: Schema;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

export const settingsSchema = canonicalSchema as Schema;
const assistanceLimit = 256 * 1024;
const analyses = new WeakMap<Text, ReturnType<typeof analyze>>();
const parseOptions = { allowTrailingComma: true, disallowComments: false };

function analyze(text: string) {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, parseOptions);
  const comments: { from: number; to: number }[] = [];
  visit(text, { onComment: (from, length) => comments.push({ from, to: from + length }) }, parseOptions);
  return { text, root, errors, comments };
}

function analysis(doc: Text) {
  if (doc.length > assistanceLimit) return undefined;
  let result = analyses.get(doc);
  if (!result) { result = analyze(doc.toString()); analyses.set(doc, result); }
  return result;
}

export function isSettingsDocument(path: string) { return path === "settings://user" || path === "settings://workspace"; }

function property(schema: Schema, name: string): Schema | undefined {
  if (schema.properties && Object.hasOwn(schema.properties, name)) return schema.properties[name];
  return typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined;
}

function schemaAt(path: JSONPath) {
  let schema: Schema | undefined = settingsSchema;
  for (const segment of path) {
    if (!schema) return undefined;
    schema = typeof segment === "number" ? schema.items : property(schema, segment);
  }
  return schema;
}

function defaultValue(schema: Schema): unknown {
  if (Object.hasOwn(schema, "default")) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  return type === "object" ? {} : type === "array" ? [] : type === "boolean" ? false : type === "number" || type === "integer" ? 0 : "";
}

function propertyCompletion(name: string, schema: Schema, hasColon: boolean): Completion {
  const value = defaultValue(schema);
  const detail = `${Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type ?? "value"}${Object.hasOwn(schema, "default") ? ` · default ${JSON.stringify(schema.default)}` : ""}`;
  const completion: Completion = { label: name, type: "property", detail, info: schema.description ?? "Built-in span setting.", boost: name.includes(".") ? 3 : 0 };
  if (hasColon) return { ...completion, apply: JSON.stringify(name) };
  const valueSnippet = value !== null && typeof value === "object"
    ? Array.isArray(value) ? "[${}]" : "{\n\t${}\n}"
    : `\${1:${JSON.stringify(value)}}`;
  return snippetCompletion(`${JSON.stringify(name)}: ${valueSnippet}`, completion);
}

/** One schema-driven source, limited to the two trusted settings documents. */
export const settingsCompletionSource: CompletionSource = (context) => {
  const parsed = analysis(context.state.doc);
  if (!parsed || parsed.comments.some((comment) => context.pos >= comment.from && context.pos <= comment.to)) return null;
  const location = getLocation(parsed.text, context.pos);
  const previous = location.previousNode;
  const token = previous && previous.offset <= context.pos && previous.offset + previous.length >= context.pos ? previous : undefined;
  const from = token?.offset ?? context.pos;
  const to = token ? token.offset + token.length : context.pos;
  if (location.isAtPropertyKey) {
    const parentPath = location.path.slice(0, -1);
    const schema = schemaAt(parentPath);
    if (!schema) return null;
    const parent = parsed.root && findNodeAtLocation(parsed.root, parentPath);
    const existing = new Set(parent?.children?.map((node) => String(node.children?.[0]?.value)) ?? []);
    const currentName = location.path[location.path.length - 1];
    const names = schema.properties ? Object.keys(schema.properties) : schema.propertyNames?.enum?.filter((name): name is string => typeof name === "string") ?? [];
    const hasColon = /^\s*:/.test(parsed.text.slice(to));
    const options = names.filter((name) => !existing.has(name) || name === currentName).map((name) => propertyCompletion(name, property(schema, name) ?? {}, hasColon));
    return options.length ? { from, to, options, validFor: /^"?[\w.$-]*"?$/ } : null;
  }
  const schema = schemaAt(location.path);
  if (!schema) return null;
  const values = schema.enum ? [...schema.enum] : [];
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!schema.enum && types.includes("boolean")) values.push(true, false);
  if (types.includes("null")) values.push(null);
  if (Object.hasOwn(schema, "default") && !values.some((value) => JSON.stringify(value) === JSON.stringify(schema.default))) values.push(schema.default);
  return values.length ? { from, to, options: values.map((value) => ({ label: JSON.stringify(value), type: "value", info: schema.description, detail: Object.hasOwn(schema, "default") && JSON.stringify(value) === JSON.stringify(schema.default) ? "Default" : undefined })), validFor: /^"?[\w.-]*"?$/ } : null;
};

function diagnostic(node: Node, message: string, severity: "error" | "warning" = "error"): Diagnostic { return { from: node.offset, to: node.offset + node.length, severity, message, source: "span settings" }; }

function validateNode(node: Node, schema: Schema, diagnostics: Diagnostic[], path: string) {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = types.length === 0 || types.includes(node.type) || (node.type === "number" && types.includes("integer") && Number.isInteger(node.value));
  if (!matches) { diagnostics.push(diagnostic(node, `${path || "Settings"} must be ${types.join(" or ")}.`)); return; }
  if (schema.enum && !schema.enum.some((value) => value === node.value)) diagnostics.push(diagnostic(node, `Expected one of ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}.`));
  if (node.type === "number") {
    if (schema.minimum !== undefined && node.value < schema.minimum) diagnostics.push(diagnostic(node, `Minimum value is ${schema.minimum}.`));
    if (schema.maximum !== undefined && node.value > schema.maximum) diagnostics.push(diagnostic(node, `Maximum value is ${schema.maximum}.`));
  }
  if (node.type === "string") {
    if (schema.minLength !== undefined && node.value.length < schema.minLength) diagnostics.push(diagnostic(node, `Use at least ${schema.minLength} characters.`));
    if (schema.maxLength !== undefined && node.value.length > schema.maxLength) diagnostics.push(diagnostic(node, `Use at most ${schema.maxLength} characters.`));
    if (schema.pattern && !new RegExp(schema.pattern).test(node.value)) diagnostics.push(diagnostic(node, "This name does not match the supported pattern."));
  }
  if (node.type === "array") {
    const items = node.children ?? [];
    if (schema.minItems !== undefined && items.length < schema.minItems) diagnostics.push(diagnostic(node, `Use at least ${schema.minItems} items.`));
    if (schema.maxItems !== undefined && items.length > schema.maxItems) diagnostics.push(diagnostic(node, `Use at most ${schema.maxItems} items.`));
    if (schema.items) items.forEach((item, index) => validateNode(item, schema.items!, diagnostics, `${path}[${index}]`));
  }
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const item of node.children ?? []) {
      const [key, value] = item.children ?? [];
      if (!key || !value) continue;
      const name = String(key.value);
      if (seen.has(name)) diagnostics.push(diagnostic(key, `Duplicate setting ${name}. The later value takes precedence.`, "warning"));
      seen.add(name);
      if (schema.propertyNames) validateNode(key, schema.propertyNames, diagnostics, name);
      const childSchema = property(schema, name);
      if (childSchema) validateNode(value, childSchema, diagnostics, path ? `${path}.${name}` : name);
      else if (schema.additionalProperties === false) diagnostics.push(diagnostic(key, `Unknown property ${name}.`));
      else if (schema.properties) diagnostics.push(diagnostic(key, `Unknown setting ${name}. It is preserved but has no effect.`, "warning"));
    }
  }
}

export function jsoncDiagnostics(doc: Text, settings: boolean): Diagnostic[] {
  const parsed = analysis(doc);
  if (!parsed) return [];
  const diagnostics: Diagnostic[] = parsed.errors.map((error) => ({ from: error.offset, to: Math.min(doc.length, error.offset + error.length), severity: "error", message: `${printParseErrorCode(error.error).replace(/([a-z])([A-Z])/g, "$1 $2")}.`, source: "JSONC" }));
  if (settings && parsed.root) validateNode(parsed.root, settingsSchema, diagnostics, "");
  return diagnostics;
}

interface JsoncState { blockComment: boolean; depth: number }
const jsoncParser: StreamParser<JsoncState> = {
  name: "jsonc",
  startState: () => ({ blockComment: false, depth: 0 }),
  token(stream, state) {
    if (state.blockComment) { while (!stream.eol()) { if (stream.match("*/")) { state.blockComment = false; break; } stream.next(); } return "comment"; }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match("/*")) { state.blockComment = true; return "comment"; }
    if (stream.eat('"')) {
      while (!stream.eol()) { const character = stream.next(); if (character === "\\") stream.next(); else if (character === '"') break; }
      return /^\s*:/.test(stream.string.slice(stream.pos)) ? "propertyName" : "string";
    }
    if (stream.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(?:true|false|null)\b/)) return "atom";
    const character = stream.next();
    if (character === "{" || character === "[") { state.depth++; return "bracket"; }
    if (character === "}" || character === "]") { state.depth = Math.max(0, state.depth - 1); return "bracket"; }
    return character === "," || character === ":" ? "punctuation" : "invalid";
  },
  indent: (state, textAfter, context) => Math.max(0, state.depth - (/^\s*[}\]]/.test(textAfter) ? 1 : 0)) * context.unit,
  languageData: { closeBrackets: { brackets: ["[", "{", '"'] }, commentTokens: { line: "//", block: { open: "/*", close: "*/" } }, indentOnInput: /^\s*[}\]]$/ },
};

export const jsoncLanguage = StreamLanguage.define(jsoncParser);

export function jsoncSupport(settings: boolean) {
  return new LanguageSupport(jsoncLanguage, [
    linter((view) => jsoncDiagnostics(view.state.doc, settings), { delay: 400 }),
    settings ? jsoncLanguage.data.of({ autocomplete: settingsCompletionSource }) : [],
    foldService.of((state, lineStart, lineEnd) => {
      const cached = analyses.get(state.doc);
      if (!cached?.root) return null;
      let found: { from: number; to: number } | null = null;
      const visit = (node: Node) => {
        if ((node.type === "object" || node.type === "array") && node.offset >= lineStart && node.offset <= lineEnd && node.offset + node.length > lineEnd) found = { from: node.offset + 1, to: node.offset + node.length - 1 };
        if (!found) node.children?.forEach(visit);
      };
      visit(cached.root);
      return found;
    }),
  ]);
}
