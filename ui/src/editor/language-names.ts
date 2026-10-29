/** Friendly names for every language id the Rust detector or the editor knows. */
export const languageNames: Readonly<Record<string, string>> = {
  text: "Plain text",
  typescript: "TypeScript", javascript: "JavaScript", json: "JSON", jsonc: "JSON with comments", markdown: "Markdown",
  rust: "Rust", python: "Python", java: "Java", yaml: "YAML", css: "CSS", scss: "SCSS", less: "Less", html: "HTML",
  vue: "Vue", svelte: "Svelte", astro: "Astro", toml: "TOML", shell: "Shell script", dotenv: "Environment file",
  go: "Go", gomod: "Go module", c: "C", cpp: "C++", csharp: "C#", kotlin: "Kotlin", swift: "Swift", php: "PHP",
  ruby: "Ruby", sql: "SQL", xml: "XML", dockerfile: "Dockerfile", makefile: "Makefile", cmake: "CMake", lua: "Lua",
  dart: "Dart", r: "R", scala: "Scala", groovy: "Groovy", perl: "Perl", powershell: "PowerShell", batch: "Batch",
  ini: "INI", proto: "Protocol Buffers", graphql: "GraphQL", terraform: "Terraform", zig: "Zig", haskell: "Haskell",
  elixir: "Elixir", erlang: "Erlang", clojure: "Clojure", objectivec: "Objective-C", diff: "Diff",
};

export function languageDisplayName(id: string): string {
  const key = id.trim().toLowerCase();
  return Object.hasOwn(languageNames, key) ? languageNames[key] : key ? key.charAt(0).toUpperCase() + key.slice(1) : languageNames.text;
}
