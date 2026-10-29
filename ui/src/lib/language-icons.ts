/**
 * Language logos, vendored from devicon (public/icons/languages, see provenance.json there).
 * `languageIconFor` maps an editor language id or a language server id to one logo. A logo that
 * would vanish on a theme's surfaces renders as a currentColor mask on that theme instead; the
 * choice is measured by a test, not picked by eye.
 */
import type { LanguageServerId } from "../bindings";

export type LanguageIconRender = "color" | "mono";
export interface LanguageIconAsset {
  /** The devicon name, for example "rust" or "html5". */
  key: string;
  src: string;
  light: LanguageIconRender;
  /** Dark and purple themes. */
  dark: LanguageIconRender;
}

/** devicon name, file variant, and how it renders on light and on dark surfaces. Kept in step with provenance.json by a test. */
const LOGOS: Readonly<Record<string, readonly [variant: "original" | "plain", light: LanguageIconRender, dark: LanguageIconRender]>> = {
  astro: ["original", "color", "color"], bash: ["original", "color", "color"], c: ["original", "mono", "color"], clojure: ["original", "color", "color"], cmake: ["original", "color", "color"],
  cplusplus: ["original", "color", "color"], csharp: ["original", "color", "color"], css3: ["original", "color", "color"], dart: ["original", "color", "color"],
  docker: ["original", "color", "color"], elixir: ["original", "color", "color"], erlang: ["original", "color", "mono"], go: ["original", "color", "color"],
  graphql: ["plain", "color", "color"], groovy: ["original", "color", "color"], haskell: ["original", "color", "mono"], html5: ["original", "color", "color"],
  java: ["original", "color", "color"], javascript: ["original", "color", "color"], json: ["original", "color", "color"], kotlin: ["original", "color", "color"],
  lua: ["original", "color", "color"], markdown: ["original", "color", "mono"], objectivec: ["plain", "color", "mono"], perl: ["original", "color", "color"],
  php: ["original", "color", "color"], powershell: ["original", "color", "color"], python: ["original", "color", "color"], r: ["original", "color", "color"],
  ruby: ["original", "color", "color"], rust: ["original", "color", "mono"], sass: ["original", "color", "color"], scala: ["original", "color", "color"],
  svelte: ["original", "color", "color"], swift: ["original", "color", "color"], terraform: ["original", "color", "mono"], toml: ["original", "color", "mono"],
  typescript: ["original", "color", "color"], vuejs: ["original", "color", "color"], xml: ["original", "color", "color"], yaml: ["original", "color", "mono"],
  zig: ["original", "mono", "color"],
};

/** Editor language ids (see editor/language-names.ts) that do not share their devicon name. */
const ALIASES: Readonly<Record<string, string>> = {
  html: "html5", css: "css3", scss: "sass", jsonc: "json", shell: "bash", sh: "bash", zsh: "bash", gomod: "go", cpp: "cplusplus",
  vue: "vuejs", dockerfile: "docker", typescriptreact: "typescript", javascriptreact: "javascript",
  tsx: "typescript", jsx: "javascript", yml: "yaml",
};

/** The language a server speaks when its id is not already a language id (svelte, vue and astro are). */
const SERVER_LANGUAGE: Readonly<Partial<Record<LanguageServerId, string>>> = {
  jdtls: "java", vtsls: "typescript", html: "html", css: "css", json: "json", "rust-analyzer": "rust", basedpyright: "python",
};

/** The language id a server's list row draws. A new server with a language-shaped id needs no entry here. */
export const serverLanguage = (id: LanguageServerId): string => SERVER_LANGUAGE[id] ?? id;

/**
 * The language to name and draw for a file. A buffer still marked plain text (detection pending, or the
 * browser preview) takes the language of the server that serves it, so Controller.java never reads "Plain text".
 */
export function fileLanguage(bufferLanguage: string | undefined | null, server: LanguageServerId | undefined): string {
  const lang = (bufferLanguage ?? "").trim();
  return lang && lang !== "text" ? lang : server ? serverLanguage(server) : "text";
}

/** Every devicon name that ships, for the provenance test. */
export const languageLogoKeys = Object.keys(LOGOS);

export function languageIconFor(id: string | undefined | null): LanguageIconAsset | undefined {
  if (!id) return undefined;
  const raw = id.trim().toLowerCase();
  const lang = Object.hasOwn(SERVER_LANGUAGE, raw) ? SERVER_LANGUAGE[raw as LanguageServerId]! : raw;
  const key = Object.hasOwn(ALIASES, lang) ? ALIASES[lang] : lang;
  if (!Object.hasOwn(LOGOS, key)) return undefined;
  const [variant, light, dark] = LOGOS[key];
  return { key, src: `/icons/languages/${key}-${variant}.svg`, light, dark };
}

/** How a logo draws on a theme. Purple counts as dark. */
export function languageIconRender(asset: LanguageIconAsset, theme: string): LanguageIconRender {
  return theme.toLowerCase() === "light" ? asset.light : asset.dark;
}

/** The neutral Iconsax glyph for a language without a logo, drawn through the Icon wrapper. */
export const LANGUAGE_FALLBACK_ICON = "language-unknown";
