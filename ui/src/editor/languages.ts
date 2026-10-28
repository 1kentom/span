import { LanguageDescription, LanguageSupport, LRLanguage, StreamLanguage, type Language, type StreamParser } from "@codemirror/language";
import { languageStyleTags } from "./syntax-highlight";

export type LanguageId = "typescript" | "javascript" | "json" | "jsonc" | "markdown" | "rust" | "python" | "java" | "dotenv" | "toml" | "yaml" | "html" | "css" | "shell" | "text";

const aliases: Record<string, LanguageId> = {
  ts: "typescript", tsx: "typescript", typescript: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", javascript: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "jsonc", md: "markdown", mdx: "markdown", markdown: "markdown", mdown: "markdown",
  rs: "rust", rust: "rust", py: "python", python: "python", pyw: "python",
  java: "java", jav: "java",
  env: "dotenv", dotenv: "dotenv", toml: "toml", yaml: "yaml", yml: "yaml",
  html: "html", htm: "html", xml: "html", svg: "html", css: "css", scss: "css",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", shellscript: "shell", console: "shell",
};

export function resolveLanguageId(hint: string, path = ""): LanguageId {
  if (path === "settings://user" || path === "settings://workspace") return "jsonc";
  const basename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (/^\.env(?:\.|$)/.test(basename)) return "dotenv";
  if (/^(readme|changelog|changes|contributing)(?:\.markdown)?$/.test(basename)) return "markdown";
  if (["cargo.lock", "poetry.lock", "uv.lock"].includes(basename)) return "toml";
  if ([".bashrc", ".zshrc", ".profile", ".bash_profile", ".envrc"].includes(basename)) return "shell";
  const extension = basename.includes(".") ? basename.split(".").pop() ?? "" : "";
  return aliases[extension] ?? aliases[hint.toLowerCase().replace(/^language-/, "")] ?? "text";
}

interface DotenvState { quote: string | null; value: boolean }

const dotenvParser: StreamParser<DotenvState> = {
  name: "dotenv",
  startState: () => ({ quote: null, value: false }),
  token(stream, state) {
    if (stream.sol() && !state.quote) state.value = false;
    if (state.quote) {
      if (state.quote === '"' && stream.match(/^\$\{[^}\n]+\}/)) return "variableName.special";
      while (!stream.eol()) {
        if (state.quote === '"' && stream.match(/^\$\{[^}\n]+\}/, false)) break;
        const character = stream.next();
        if (character === "\\" && state.quote === '"') stream.next();
        else if (character === state.quote) { state.quote = null; break; }
      }
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^#.*/)) return "comment";
    if (!state.value && stream.match(/^export(?=\s+[A-Za-z_][\w.-]*\s*=)/)) return "keyword";
    if (!state.value && stream.match(/^[A-Za-z_][\w.-]*(?=\s*=)/)) return "propertyName";
    if (stream.eat("=")) { state.value = true; return "operator"; }
    const quote = stream.peek();
    if (quote === '"' || quote === "'") { stream.next(); state.quote = quote; return "string"; }
    if (stream.match(/^\$\{[^}\n]+\}/)) return "variableName.special";
    if (stream.match(/^(?:true|false)(?=\s|#|$)/)) return "bool";
    if (stream.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?=\s|#|$)/)) return "number";
    if (!stream.eatWhile(/[^\s#$'"=]/)) stream.next();
    return state.value ? "string" : null;
  },
  languageData: { commentTokens: { line: "#" } },
};

const dotenvLanguage = StreamLanguage.define(dotenvParser);
type LoadedLanguage = LanguageSupport | Language;

/** Adds the node rules that let Lezer trees colour imports, annotations and declarations like the tree-sitter layer. */
function withTokenTags(support: LanguageSupport, rules: string): LanguageSupport {
  const props = languageStyleTags(rules);
  const language = support.language;
  if (!props || !(language instanceof LRLanguage)) return support;
  return new LanguageSupport(language.configure({ props: [props] }), support.support);
}
const loading = new Map<string, Promise<LoadedLanguage | null>>();

/** Grammar modules load when a file or a fenced block actually uses them. */
export function loadLanguage(hint: string, path = ""): Promise<LoadedLanguage | null> {
  const id = resolveLanguageId(hint, path);
  const jsx = /\.[cm]?[jt]sx$/i.test(path) || /^(?:jsx|tsx)$/i.test(hint);
  const settings = path === "settings://user" || path === "settings://workspace";
  const key = `${id}:${jsx}:${settings}`;
  const cached = loading.get(key);
  if (cached) return cached;
  const result = (async (): Promise<LoadedLanguage | null> => {
    switch (id) {
      case "typescript": return withTokenTags((await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx }), "typescript");
      case "javascript": return withTokenTags((await import("@codemirror/lang-javascript")).javascript({ jsx }), "typescript");
      case "json": {
        const [{ json, jsonParseLinter }, { linter }] = await Promise.all([import("@codemirror/lang-json"), import("@codemirror/lint")]);
        const support = json(); const lint = jsonParseLinter();
        return new LanguageSupport(support.language, [support.support, linter((view) => view.state.doc.length <= 2 * 1024 * 1024 ? lint(view) : [], { delay: 400 })]);
      }
      case "jsonc": return (await import("./settings-completion")).jsoncSupport(settings);
      case "rust": return withTokenTags((await import("@codemirror/lang-rust")).rust(), "rust");
      case "python": return withTokenTags((await import("@codemirror/lang-python")).python(), "python");
      case "java": return withTokenTags((await import("@codemirror/lang-java")).java(), "java");
      case "html": {
        const [{ html }, { emmetSupport }] = await Promise.all([import("@codemirror/lang-html"), import("./emmet")]);
        const support = html();
        return new LanguageSupport(support.language, [support.support, emmetSupport("html")]);
      }
      case "css": {
        const [{ css }, { emmetSupport }] = await Promise.all([import("@codemirror/lang-css"), import("./emmet")]);
        const support = css();
        return new LanguageSupport(support.language, [support.support, emmetSupport("css")]);
      }
      case "dotenv": return dotenvLanguage;
      case "toml": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
      case "yaml": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/yaml")).yaml);
      case "shell": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
      case "markdown": {
        const { markdown } = await import("@codemirror/lang-markdown");
        const names = ["typescript", "javascript", "json", "jsonc", "rust", "python", "java", "html", "css", "toml", "yaml", "shell", "dotenv"] as const;
        return markdown({ codeLanguages: names.map((name) => LanguageDescription.of({ name, alias: Object.keys(aliases).filter((alias) => aliases[alias] === name), load: async () => {
          const support = await loadLanguage(name);
          if (!support) throw new Error(`No grammar for ${name}`);
          return support instanceof LanguageSupport ? support : new LanguageSupport(support);
        } })) });
      }
      default: return null;
    }
  })();
  loading.set(key, result);
  return result;
}

export async function loadFenceLanguage(name: string): Promise<Language | null> {
  const support = await loadLanguage(name);
  return support instanceof LanguageSupport ? support.language : support;
}
