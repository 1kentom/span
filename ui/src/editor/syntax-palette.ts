/**
 * Syntax colour tokens, their default palettes and the helper that applies user
 * overrides. Every code colour in the editor is read from a `--syn-<id>` custom
 * property, so a theme or the user can recolour a token by setting that variable
 * on the editor root.
 *
 * The ids are the contract with `crates/syntax/src/tokens.rs` (tree-sitter spans
 * arrive as `cm-tree-<id>` classes) and with `syntax.css`; tests keep all three in
 * step.
 */

export const SYNTAX_TOKENS = [
  "keyword", "controlKeyword", "operator", "punctuation", "comment", "docComment",
  "string", "number", "constant", "boolean", "function", "method",
  "type", "class", "interface", "enum", "typeParameter",
  "variable", "parameter", "property", "namespace", "importPath", "annotation",
  "macro", "label", "tag", "attribute", "regexp", "escape", "invalid",
] as const;

export type TokenId = (typeof SYNTAX_TOKENS)[number];
export type SyntaxTheme = "dark" | "light" | "purple";
export type SyntaxPalette = Record<TokenId, string>;
export type SyntaxOverrides = Partial<Record<TokenId, string>>;

/** Editor background per theme, used for contrast checks. */
export const THEME_BACKGROUNDS: Record<SyntaxTheme, string> = {
  dark: "#18191b",
  light: "#ffffff",
  purple: "#17172b",
};

const PALETTES: Record<SyntaxTheme, SyntaxPalette> = {
  dark: {
  keyword: "#78c8c7",
  controlKeyword: "#78c8c7",
  operator: "#b4bac0",
  punctuation: "#8d939a",
  comment: "#72777c",
  docComment: "#86a38f",
  string: "#cc8dcb",
  number: "#d9ba7e",
  constant: "#e8906a",
  boolean: "#d9ba7e",
  function: "#d9ba7e",
  method: "#d9ba7e",
  type: "#80b7ec",
  class: "#7ed39a",
  interface: "#4dd0e1",
  enum: "#f28fad",
  typeParameter: "#b8e07a",
  variable: "#e0e1e4",
  parameter: "#af9bf2",
  property: "#dcc0a0",
  namespace: "#c4a7e7",
  importPath: "#9fb0cc",
  annotation: "#f0b429",
  macro: "#e0a4e8",
  label: "#f0a8a0",
  tag: "#78c8c7",
  attribute: "#d9ba7e",
  regexp: "#ee9e7e",
  escape: "#e8c9a0",
  invalid: "#e58a8a",
  },
  light: {
  keyword: "#25797d",
  controlKeyword: "#25797d",
  operator: "#5b6470",
  punctuation: "#6e747c",
  comment: "#8b8d94",
  docComment: "#597461",
  string: "#a34a90",
  number: "#956322",
  constant: "#be123c",
  boolean: "#956322",
  function: "#976319",
  method: "#976319",
  type: "#3c70ad",
  class: "#2b7e46",
  interface: "#177784",
  enum: "#a21caf",
  typeParameter: "#53771c",
  variable: "#252629",
  parameter: "#7b58ad",
  property: "#906535",
  namespace: "#894fcf",
  importPath: "#536f9d",
  annotation: "#b45309",
  macro: "#5b21b6",
  label: "#a64d79",
  tag: "#25797d",
  attribute: "#976319",
  regexp: "#c0392b",
  escape: "#936324",
  invalid: "#d02f2f",
  },
  purple: {
  keyword: "#a6c8d4",
  controlKeyword: "#a6c8d4",
  operator: "#b4bac0",
  punctuation: "#8d939a",
  comment: "#72777c",
  docComment: "#86a38f",
  string: "#daa2cc",
  number: "#d9ba7e",
  constant: "#e8906a",
  boolean: "#d9ba7e",
  function: "#e5c49a",
  method: "#e5c49a",
  type: "#afa3ec",
  class: "#7ed39a",
  interface: "#4dd0e1",
  enum: "#f28fad",
  typeParameter: "#b8e07a",
  variable: "#eeedfd",
  parameter: "#af9bf2",
  property: "#dcc0a0",
  namespace: "#c4a7e7",
  importPath: "#9fb0cc",
  annotation: "#f0b429",
  macro: "#e0a4e8",
  label: "#f0a8a0",
  tag: "#a6c8d4",
  attribute: "#e5c49a",
  regexp: "#ee9e7e",
  escape: "#e8c9a0",
  invalid: "#e58a8a",
  },
};

export function isTokenId(value: string): value is TokenId {
  return (SYNTAX_TOKENS as readonly string[]).includes(value);
}

export function cssVariable(id: TokenId): string {
  return `--syn-${id}`;
}

export function defaultPalette(theme: SyntaxTheme): SyntaxPalette {
  return { ...(PALETTES[theme] ?? PALETTES.dark) };
}

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Accepts #rgb, #rrggbb and #rrggbbaa only. */
export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && COLOR.test(value.trim());
}

/** Keeps only known token ids with valid colours, normalised to lower case. */
export function sanitizeOverrides(overrides: unknown): SyntaxOverrides {
  const result: SyntaxOverrides = {};
  if (!overrides || typeof overrides !== "object") return result;
  for (const [key, value] of Object.entries(overrides)) {
    if (isTokenId(key) && isValidColor(value)) result[key] = value.trim().toLowerCase();
  }
  return result;
}

/**
 * Sets the `--syn-*` variables on `root`. A valid override is set inline. Every
 * other token is removed so the stylesheet default for the root's own
 * `data-theme` applies, unless that attribute differs from `theme`, in which case
 * the default palette for `theme` is written inline.
 */
export function applyPalette(root: HTMLElement, theme: SyntaxTheme, overrides: SyntaxOverrides = {}): void {
  const clean = sanitizeOverrides(overrides);
  const stylesheetTheme = (root.getAttribute("data-theme") ?? "dark") === theme;
  const defaults = PALETTES[theme] ?? PALETTES.dark;
  for (const id of SYNTAX_TOKENS) {
    const name = cssVariable(id);
    const override = clean[id];
    if (override) root.style.setProperty(name, override);
    else if (stylesheetTheme) root.style.removeProperty(name);
    else root.style.setProperty(name, defaults[id]);
  }
}

/** Removes every inline `--syn-*` variable from `root`. */
export function clearPalette(root: HTMLElement): void {
  for (const id of SYNTAX_TOKENS) root.style.removeProperty(cssVariable(id));
}

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  let hex = color.trim().slice(1);
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((digit) => digit + digit).join("");
  const [r, g, b] = [0, 2, 4].map((index) => channel(Number.parseInt(hex.slice(index, index + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two opaque hex colours. */
export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Tokens held to 3:1 instead of the 4.5:1 normal-text minimum. */
export const LOW_CONTRAST_TOKENS: readonly TokenId[] = ["comment", "punctuation"];

/** Minimum contrast ratio for a token: 3 for comments and punctuation, 4.5 for everything else. */
export function contrastMinimum(id: TokenId): number {
  return LOW_CONTRAST_TOKENS.includes(id) ? 3 : 4.5;
}

/** Expands #rgb to #rrggbb and lower cases; keeps #rrggbbaa. Returns null for anything invalid. */
export function expandColor(value: string): string | null {
  if (!isValidColor(value)) return null;
  const hex = value.trim().slice(1).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex}`;
}

/** The opaque #rrggbb part of a valid colour, for a native colour input. */
export function pickerColor(value: string): string {
  return (expandColor(value) ?? "#000000").slice(0, 7);
}

/** Contrast of a token colour against a theme's editor background. A translucent colour is blended over the background first. */
export function tokenContrast(color: string, theme: SyntaxTheme): number {
  const full = expandColor(color);
  const background = THEME_BACKGROUNDS[theme];
  if (!full) return 0;
  if (full.length === 9) {
    const alpha = Number.parseInt(full.slice(7, 9), 16) / 255;
    const mix = [1, 3, 5].map((index) => {
      const fg = Number.parseInt(full.slice(index, index + 2), 16);
      const bg = Number.parseInt(background.slice(index, index + 2), 16);
      return Math.round(fg * alpha + bg * (1 - alpha)).toString(16).padStart(2, "0");
    });
    return contrastRatio(`#${mix.join("")}`, background);
  }
  return contrastRatio(full, background);
}
