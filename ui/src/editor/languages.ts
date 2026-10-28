import { LanguageDescription, LanguageSupport, StreamLanguage, type Language, type StreamParser } from "@codemirror/language";

export type LanguageId = "typescript" | "javascript" | "json" | "markdown" | "rust" | "python" | "dotenv" | "toml" | "yaml" | "html" | "css" | "shell" | "text";

const aliases: Record<string, LanguageId> = {
  ts: "typescript", tsx: "typescript", typescript: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", javascript: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", md: "markdown", mdx: "markdown", markdown: "markdown", mdown: "markdown",
  rs: "rust", rust: "rust", py: "python", python: "python", pyw: "python",
  env: "dotenv", dotenv: "dotenv", toml: "toml", yaml: "yaml", yml: "yaml",
  html: "html", htm: "html", xml: "html", svg: "html", css: "css", scss: "css",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", shellscript: "shell", console: "shell",
};

export function resolveLanguageId(hint: string, path = ""): LanguageId {
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
const loading = new Map<string, Promise<LoadedLanguage | null>>();

/** Grammar modules load when a file or a fenced block actually uses them. */
export function loadLanguage(hint: string, path = ""): Promise<LoadedLanguage | null> {
  const id = resolveLanguageId(hint, path);
  const jsx = /\.[cm]?[jt]sx$/i.test(path) || /^(?:jsx|tsx)$/i.test(hint);
  const key = `${id}:${jsx}`;
  const cached = loading.get(key);
  if (cached) return cached;
  const result = (async (): Promise<LoadedLanguage | null> => {
    switch (id) {
      case "typescript": return (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx });
      case "javascript": return (await import("@codemirror/lang-javascript")).javascript({ jsx });
      case "json": return (await import("@codemirror/lang-json")).json();
      case "rust": return (await import("@codemirror/lang-rust")).rust();
      case "python": return (await import("@codemirror/lang-python")).python();
      case "html": return (await import("@codemirror/lang-html")).html();
      case "css": return (await import("@codemirror/lang-css")).css();
      case "dotenv": return dotenvLanguage;
      case "toml": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
      case "yaml": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/yaml")).yaml);
      case "shell": return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
      case "markdown": {
        const { markdown } = await import("@codemirror/lang-markdown");
        const names = ["typescript", "javascript", "json", "rust", "python", "html", "css", "toml", "yaml", "shell", "dotenv"] as const;
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
