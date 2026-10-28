import { HighlightStyle } from "@codemirror/language";
import { Tag, styleTags, tagHighlighter, tags } from "@lezer/highlight";
import type { TokenId } from "./syntax-palette";

/**
 * CodeMirror side of the syntax colours. Lezer tags are mapped to the same token
 * ids the tree-sitter spans use, and every colour is `var(--syn-<id>)`, so the two
 * layers read one palette and can only differ where a token cannot be told apart
 * without semantic knowledge.
 */

/** Tags Lezer grammars do not provide; language packs opt in through `LANGUAGE_STYLE_TAGS`. */
export const tokenTags = {
  importPath: Tag.define("importPath"),
  interfaceName: Tag.define("interfaceName"),
  enumName: Tag.define("enumName"),
  typeParameter: Tag.define("typeParameter"),
  parameter: Tag.define("parameter"),
  methodName: Tag.define("methodName"),
  constantName: Tag.define("constantName"),
};

type TagEntry = readonly [Tag | readonly Tag[], TokenId];

/**
 * The single Lezer tag to token table. More specific tags (children and modifier
 * combinations) win over their parents, so `controlKeyword` beats `keyword`.
 */
export const TAG_TOKENS: readonly TagEntry[] = [
  [[tags.keyword, tags.modifier, tags.self, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.unit, tags.processingInstruction, tags.list], "keyword"],
  [tags.controlKeyword, "controlKeyword"],
  [tags.operator, "operator"],
  [tags.punctuation, "punctuation"],
  [[tags.comment, tags.lineComment, tags.blockComment, tags.quote, tags.contentSeparator], "comment"],
  [[tags.docComment, tags.docString], "docComment"],
  [[tags.string, tags.character, tags.attributeValue, tags.monospace], "string"],
  [[tags.number, tags.integer, tags.float], "number"],
  [[tags.constant(tags.variableName), tags.constant(tags.propertyName), tags.null, tags.atom, tokenTags.constantName], "constant"],
  [tags.bool, "boolean"],
  [[tags.function(tags.variableName), tags.function(tags.definition(tags.variableName)), tags.function(tags.local(tags.variableName)), tags.heading], "function"],
  [[tags.function(tags.propertyName), tags.function(tags.definition(tags.propertyName)), tokenTags.methodName], "method"],
  [[tags.standard(tags.typeName), tags.standard(tags.className)], "type"],
  [[tags.typeName, tags.className, tags.definition(tags.typeName), tags.definition(tags.className)], "class"],
  [tokenTags.interfaceName, "interface"],
  [tokenTags.enumName, "enum"],
  [tokenTags.typeParameter, "typeParameter"],
  [[tags.variableName, tags.definition(tags.variableName), tags.local(tags.variableName), tags.standard(tags.variableName), tags.special(tags.variableName)], "variable"],
  [tokenTags.parameter, "parameter"],
  [[tags.propertyName, tags.definition(tags.propertyName)], "property"],
  [tags.namespace, "namespace"],
  [tokenTags.importPath, "importPath"],
  [[tags.annotation, tags.meta], "annotation"],
  [tags.macroName, "macro"],
  [tags.labelName, "label"],
  [tags.tagName, "tag"],
  [tags.attributeName, "attribute"],
  [tags.regexp, "regexp"],
  [tags.escape, "escape"],
  [[tags.invalid], "invalid"],
  [[tags.link, tags.url], "type"],
];

export function colorFor(token: TokenId): string {
  return `var(--syn-${token})`;
}

/** Class based view of the same table (`syn-<token>`), used to inspect which token a node gets. */
export const tokenClassHighlighter = tagHighlighter(
  TAG_TOKENS.flatMap(([tag, token]) => ([] as Tag[]).concat(tag as Tag | Tag[]).map((single) => ({ tag: single, class: `syn-${token}` }))),
);

const EXTRA_STYLE = new Map<Tag, Record<string, string>>([
  [tags.heading, { fontWeight: "600" }],
  [tags.link, { textDecoration: "underline" }],
  [tags.url, { textDecoration: "underline" }],
  [tags.comment, { fontStyle: "italic" }],
  [tags.lineComment, { fontStyle: "italic" }],
  [tags.blockComment, { fontStyle: "italic" }],
  [tags.docComment, { fontStyle: "italic" }],
]);

/** Highlight style built from `TAG_TOKENS`, plus the markup styles that carry no colour token. */
export const syntaxHighlightStyle = HighlightStyle.define([
  ...TAG_TOKENS.flatMap(([tag, token]) => ([] as Tag[]).concat(tag as Tag | Tag[]).map((single) => ({ tag: single, color: colorFor(token), ...EXTRA_STYLE.get(single) }))),
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
]);

/** Per language node rules that give Lezer trees the distinctions tree-sitter spans make. */
export const LANGUAGE_STYLE_TAGS: Record<string, Record<string, Tag | readonly Tag[]>> = {
  java: {
    "PackageDeclaration/ScopedIdentifier!": tags.namespace,
    "PackageDeclaration/Identifier": tags.namespace,
    "ImportDeclaration/ScopedIdentifier/ScopedIdentifier!": tokenTags.importPath,
    "ImportDeclaration/ScopedIdentifier/Identifier": tags.className,
    "MarkerAnnotation!": tags.annotation,
    "Annotation/Identifier": tags.annotation,
    "ClassDeclaration/Definition": tags.className,
    "InterfaceDeclaration/Definition": tokenTags.interfaceName,
    "EnumDeclaration/Definition": tokenTags.enumName,
    "EnumConstant/Definition": tokenTags.constantName,
    "TypeParameter/Definition": tokenTags.typeParameter,
    "FormalParameter/Definition": tokenTags.parameter,
    "FieldDeclaration/VariableDeclarator/Definition": tags.propertyName,
    "MethodDeclaration/Definition": tokenTags.methodName,
    "MethodName/Identifier": tokenTags.methodName,
    "SuperInterfaces/InterfaceTypeList/TypeName": tokenTags.interfaceName,
  },
  typescript: {
    "ImportDeclaration/String": tokenTags.importPath,
    "ExportDeclaration/String": tokenTags.importPath,
    "ClassDeclaration/VariableDefinition": tags.className,
    "InterfaceDeclaration/TypeDefinition": tokenTags.interfaceName,
    "EnumDeclaration/TypeDefinition": tokenTags.enumName,
    "EnumBody/PropertyName": tokenTags.constantName,
    "NamespaceDeclaration/VariableDefinition": tags.namespace,
    "TypeParamList/TypeDefinition": tokenTags.typeParameter,
    "ParamList/VariableDefinition": tokenTags.parameter,
    "Decorator/At": tags.annotation,
    "Decorator/VariableName": tags.annotation,
    "Decorator/CallExpression/VariableName": tags.annotation,
    "MethodDeclaration/PropertyDefinition": tokenTags.methodName,
  },
  python: {
    "Decorator/At": tags.annotation,
    "Decorator/VariableName": tags.annotation,
    "Decorator/CallExpression/VariableName": tags.annotation,
    "ClassDefinition/VariableName": tags.className,
    "ParamList/VariableName": tokenTags.parameter,
  },
  rust: {
    "UseDeclaration/ScopedIdentifier/ScopeIdentifier": tokenTags.importPath,
    "ScopedUseList/ScopeIdentifier": tokenTags.importPath,
    "Attribute!": tags.annotation,
    "Lifetime!": tags.labelName,
    "StructItem/TypeIdentifier": tags.className,
    "TraitItem/TypeIdentifier": tokenTags.interfaceName,
    "EnumItem/TypeIdentifier": tokenTags.enumName,
    "MacroInvocation/Identifier": tags.macroName,
  },
};

export function languageStyleTags(language: string) {
  const rules = LANGUAGE_STYLE_TAGS[language];
  return rules ? styleTags(rules as Parameters<typeof styleTags>[0]) : undefined;
}
