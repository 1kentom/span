import { LanguageDescription, LanguageSupport, LRLanguage, StreamLanguage, type Language, type StreamParser } from "@codemirror/language";
import { languageStyleTags } from "./syntax-highlight";

type LoadedLanguage = LanguageSupport | Language;
/** Adds the node rules that let Lezer trees colour imports, annotations and declarations like the tree-sitter layer. */
function withTokenTags(support: LanguageSupport, rules: string): LanguageSupport {
  const props = languageStyleTags(rules);
  const language = support.language;
  if (!props || !(language instanceof LRLanguage)) return support;
  return new LanguageSupport(language.configure({ props: [props] }), support.support);
}
interface LoadContext { jsx: boolean; settings: boolean }

/** A language: where it is detected from (extensions, exact file names, fence aliases) and how its grammar loads. */
interface LanguageEntry {
  /** Lowercase extensions without the dot. */
  extensions?: readonly string[];
  /** Lowercase exact base names. */
  filenames?: readonly string[];
  /** Markdown fence names and editor hints, besides the id itself. */
  aliases?: readonly string[];
  /** Absent means there is no grammar yet. */
  load?: (context: LoadContext) => Promise<LoadedLanguage>;
}

const legacy = (parser: () => Promise<StreamParser<any>>) => async () => StreamLanguage.define(await parser());
const extra = async () => import("./language-extra");

/** Single source of truth for detection and grammars. Every id in the Rust table (crates/core/src/buffer.rs) has an entry here or is listed in `noHighlightingYet`. */
const loadHtml = async () => {
  const [{ html }, { emmetSupport }] = await Promise.all([import("@codemirror/lang-html"), import("./emmet")]);
  const support = html();
  return new LanguageSupport(support.language, [support.support, emmetSupport("html")]);
};

const languageTable = {
  typescript: { extensions: ["ts", "tsx", "mts", "cts"], load: async ({ jsx }) => withTokenTags((await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx }), "typescript") },
  javascript: { extensions: ["js", "jsx", "mjs", "cjs"], load: async ({ jsx }) => withTokenTags((await import("@codemirror/lang-javascript")).javascript({ jsx }), "typescript") },
  json: {
    extensions: ["json"],
    load: async () => {
      const [{ json, jsonParseLinter }, { linter }] = await Promise.all([import("@codemirror/lang-json"), import("@codemirror/lint")]);
      const support = json(); const lint = jsonParseLinter();
      return new LanguageSupport(support.language, [support.support, linter((view) => view.state.doc.length <= 2 * 1024 * 1024 ? lint(view) : [], { delay: 400 })]);
    },
  },
  jsonc: { extensions: ["jsonc"], load: async ({ settings }) => (await import("./settings-completion")).jsoncSupport(settings) },
  markdown: { extensions: ["md", "mdx", "markdown", "mdown", "mkd"], load: async () => markdownSupport() },
  rust: { extensions: ["rs"], load: async () => withTokenTags((await import("@codemirror/lang-rust")).rust(), "rust") },
  python: { extensions: ["py", "pyi", "pyw"], load: async () => withTokenTags((await import("@codemirror/lang-python")).python(), "python") },
  java: { extensions: ["java", "jav"], load: async () => withTokenTags((await import("@codemirror/lang-java")).java(), "java") },
  dotenv: { extensions: ["env"], aliases: ["dotenv"], load: async () => dotenvLanguage },
  toml: { extensions: ["toml"], filenames: ["cargo.lock", "poetry.lock", "uv.lock"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml) },
  yaml: { extensions: ["yaml", "yml"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/yaml")).yaml) },
  html: { extensions: ["html", "htm", "svg"], load: loadHtml },
  // Svelte, Vue and Astro markup is HTML with embedded script and style blocks, so it borrows the HTML grammar until it has its own.
  svelte: { extensions: ["svelte"], load: loadHtml },
  vue: { extensions: ["vue"], load: loadHtml },
  astro: { extensions: ["astro"], load: loadHtml },
  css: {
    extensions: ["css", "scss"],
    aliases: ["scss"],
    load: async () => {
      const [{ css }, { emmetSupport }] = await Promise.all([import("@codemirror/lang-css"), import("./emmet")]);
      const support = css();
      return new LanguageSupport(support.language, [support.support, emmetSupport("css")]);
    },
  },
  less: { extensions: ["less"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/css")).less) },
  shell: {
    extensions: ["sh", "bash", "zsh", "fish"],
    filenames: [".bashrc", ".zshrc", ".profile", ".bash_profile", ".bash_aliases", ".bash_logout", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".envrc"],
    aliases: ["shellscript", "console", "sh"],
    load: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
  },
  go: { extensions: ["go"], aliases: ["golang"], load: async () => (await import("@codemirror/lang-go")).go() },
  gomod: { filenames: ["go.mod", "go.work"], aliases: ["go.mod"], load: async () => (await extra()).goModLanguage() },
  c: { extensions: ["c", "h"], load: async () => (await import("@codemirror/lang-cpp")).cpp() },
  cpp: { extensions: ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++", "ipp", "inl"], aliases: ["c++"], load: async () => (await import("@codemirror/lang-cpp")).cpp() },
  csharp: { extensions: ["cs", "csx"], aliases: ["c#"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp) },
  kotlin: { extensions: ["kt", "kts"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin) },
  swift: { extensions: ["swift"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift) },
  php: { extensions: ["php", "phtml"], load: async () => (await import("@codemirror/lang-php")).php() },
  ruby: { extensions: ["rb", "rake", "gemspec", "ru"], filenames: ["gemfile", "rakefile", "podfile"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby) },
  sql: { extensions: ["sql"], aliases: ["mysql", "postgres", "postgresql", "pgsql", "psql", "sqlite"], load: async () => (await import("@codemirror/lang-sql")).sql() },
  xml: { extensions: ["xml", "xsd", "xsl", "xslt", "plist", "csproj", "props", "targets"], load: async () => (await import("@codemirror/lang-xml")).xml() },
  dockerfile: { extensions: ["dockerfile"], filenames: ["dockerfile", "containerfile"], aliases: ["docker"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile) },
  makefile: { extensions: ["mk"], filenames: ["makefile", "gnumakefile"], aliases: ["make"], load: async () => (await extra()).makefileLanguage() },
  cmake: { extensions: ["cmake"], filenames: ["cmakelists.txt"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/cmake")).cmake) },
  lua: { extensions: ["lua"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua) },
  dart: { extensions: ["dart"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).dart) },
  r: { extensions: ["r"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/r")).r) },
  scala: { extensions: ["scala", "sbt", "sc"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).scala) },
  groovy: { extensions: ["groovy", "gradle"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/groovy")).groovy) },
  perl: { extensions: ["pl", "pm"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/perl")).perl) },
  powershell: { extensions: ["ps1", "psm1", "psd1"], aliases: ["pwsh"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell) },
  batch: { extensions: ["bat", "cmd"], aliases: ["bat", "cmd"], load: async () => (await extra()).batchLanguage() },
  ini: { extensions: ["ini", "cfg", "conf", "properties"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties) },
  proto: { extensions: ["proto"], aliases: ["protobuf"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/protobuf")).protobuf) },
  graphql: { extensions: ["graphql", "gql"], load: async () => (await extra()).graphqlLanguage() },
  terraform: { extensions: ["tf", "tfvars", "hcl"], load: async () => (await extra()).hclLanguage() },
  zig: { extensions: ["zig"], load: async () => (await extra()).zigLanguage() },
  haskell: { extensions: ["hs"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/haskell")).haskell) },
  // No Elixir grammar ships with CodeMirror: Ruby's is the closest fallback (def/do/end, atoms, strings, sigils).
  elixir: { extensions: ["ex", "exs"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby) },
  erlang: { extensions: ["erl"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/erlang")).erlang) },
  clojure: { extensions: ["clj", "cljs", "edn"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/clojure")).clojure) },
  objectivec: { extensions: ["m", "mm"], aliases: ["objc", "objective-c", "obj-c"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).objectiveC) },
  diff: { extensions: ["diff", "patch"], load: legacy(async () => (await import("@codemirror/legacy-modes/mode/diff")).diff) },
  text: {},
} satisfies Record<string, LanguageEntry>;

export type LanguageId = keyof typeof languageTable;
const entries = languageTable as Record<LanguageId, LanguageEntry>;
export const languageIds = Object.keys(languageTable) as LanguageId[];

/** Ids the Rust detector can produce that have no grammar yet. */
export const noHighlightingYet: readonly string[] = [];

/** Whether an id has a grammar loader. */
export const hasGrammar = (id: string): boolean => Object.hasOwn(entries, id) && typeof entries[id as LanguageId].load === "function";

const aliases: Record<string, LanguageId> = {};
const filenames: Record<string, LanguageId> = {};
for (const id of languageIds) {
  const entry = entries[id];
  aliases[id] = id;
  for (const key of [...(entry.extensions ?? []), ...(entry.aliases ?? [])]) aliases[key] ??= id;
  for (const name of entry.filenames ?? []) filenames[name] = id;
}

export function resolveLanguageId(hint: string, path = ""): LanguageId {
  if (path === "settings://user" || path === "settings://workspace") return "jsonc";
  const basename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (/^\.env(?:\.|$)/.test(basename)) return "dotenv";
  if (/^(readme|changelog|changes|contributing)(?:\.markdown)?$/.test(basename)) return "markdown";
  if (Object.hasOwn(filenames, basename)) return filenames[basename];
  if (/^dockerfile\./.test(basename)) return "dockerfile";
  const extension = basename.includes(".") ? basename.split(".").pop() ?? "" : "";
  const key = hint.toLowerCase().replace(/^language-/, "");
  return (Object.hasOwn(aliases, extension) ? aliases[extension] : undefined) ?? (Object.hasOwn(aliases, key) ? aliases[key] : undefined) ?? "text";
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
const loading = new Map<string, Promise<LoadedLanguage | null>>();

async function markdownSupport(): Promise<LoadedLanguage> {
  const [{ markdown, markdownLanguage }, { frontMatter }, { markdownEditing }] = await Promise.all([import("@codemirror/lang-markdown"), import("./markdown-frontmatter"), import("./markdown-editing")]);
  const names = languageIds.filter((id) => id !== "markdown" && hasGrammar(id));
  // GFM base: tables, strikethrough, task lists and autolinks parse; front matter is its own block.
  // Span's own list keys and URL paste replace lang-markdown's (see markdown-editing.ts).
  const support = markdown({ base: markdownLanguage, extensions: frontMatter, addKeymap: false, pasteURLAsLink: false, codeLanguages: names.map((name) => LanguageDescription.of({ name, alias: Object.keys(aliases).filter((alias) => aliases[alias] === name), load: async () => {
    const support = await loadLanguage(name);
    if (!support) throw new Error(`No grammar for ${name}`);
    return support instanceof LanguageSupport ? support : new LanguageSupport(support);
  } })) });
  return new LanguageSupport(support.language, [support.support, markdownEditing(support.language)]);
}

/** Grammar modules load when a file or a fenced block actually uses them. */
export function loadLanguage(hint: string, path = ""): Promise<LoadedLanguage | null> {
  const id = resolveLanguageId(hint, path);
  const jsx = /\.[cm]?[jt]sx$/i.test(path) || /^(?:jsx|tsx)$/i.test(hint);
  const settings = path === "settings://user" || path === "settings://workspace";
  const key = `${id}:${jsx}:${settings}`;
  const cached = loading.get(key);
  if (cached) return cached;
  const load = entries[id].load;
  const result = load ? load({ jsx, settings }) : Promise.resolve(null);
  loading.set(key, result);
  return result;
}

export async function loadFenceLanguage(name: string): Promise<Language | null> {
  const support = await loadLanguage(name);
  return support instanceof LanguageSupport ? support.language : support;
}
