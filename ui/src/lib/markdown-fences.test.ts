import { describe, expect, it } from "vitest";
import { languageIds } from "../editor/languages";
import { describeMarkdownFence, markdownFenceLanguages } from "./markdown-fences";

describe("Markdown fence languages and terminal eligibility", () => {
  it("normalizes supported language aliases and preserves explicit declarations", () => {
    for (const [hint, language, label] of [["ts", "typescript", "TypeScript"], ["javascript", "javascript", "JavaScript"], ["py", "python", "Python"], ["rs", "rust", "Rust"], ["sh", "shell", "Shell"], ["bash", "shell", "Bash"], ["zsh", "shell", "Zsh"], ["console", "shell", "Console"], ["yaml", "yaml", "YAML"], ["jsonc", "jsonc", "JSON with comments"]]) {
      const fence = describeMarkdownFence(hint, "npm run dev\n");
      expect(fence.language, hint).toBe(language); expect(fence.label, hint).toBe(label);
      expect(fence.detected, hint).toBe(false);
      if (language !== "shell") expect(fence.action, hint).toBeNull();
    }
    expect(Object.keys(markdownFenceLanguages)).toEqual(expect.arrayContaining(["typescript", "javascript", "json", "jsonc", "markdown", "rust", "python", "java", "dotenv", "toml", "yaml", "html", "css", "shell", "text"]));
    expect(Object.keys(markdownFenceLanguages).sort()).toEqual([...languageIds].sort());
    expect(markdownFenceLanguages).toMatchObject({ go: "Go", cpp: "C++", csharp: "C#", dockerfile: "Dockerfile" });
    expect(describeMarkdownFence("unknown", "npm run dev")).toMatchObject({ language: "text", label: "Plain text", action: null });
    expect(describeMarkdownFence("text", "$ npm run dev")).toMatchObject({ language: "text", action: null, detected: false });
  });

  it("conservatively detects unlabeled package commands and prompts for terminal review", () => {
    for (const code of ["npm run dev", "pnpm install\npnpm run build", "yarn dev", "$ npm run dev\nListening on port 3000"]) expect(describeMarkdownFence("", code)).toMatchObject({ language: "shell", label: "Shell (detected)", detected: true, action: "send" });
    for (const code of ["Use npm run dev to start", 'const command = "npm run dev"', "npm notice A new version is available", "hello\nnpm run dev", "ls -la"]) expect(describeMarkdownFence("", code)).toMatchObject({ language: "text", action: null });
  });

  it("extracts only prompted commands from console transcripts, never output", () => {
    expect(describeMarkdownFence("console", "$ npm run build\n> app build\n✓ built in 1s\n$ npm test\n2 tests passed\n")).toMatchObject({ command: "npm run build\nnpm test", omittedOutput: true, action: "run" });
    expect(describeMarkdownFence("console", "npm run dev\nListening on port 3000")).toMatchObject({ command: "npm run dev", omittedOutput: true, action: "send" });
    expect(describeMarkdownFence("console", "Listening on port 3000\nAll ready")).toMatchObject({ command: null, action: null });
    expect(describeMarkdownFence("console", "$ echo hello \\\n> world\nhello world")).toMatchObject({ action: "send", command: "echo hello \\" });
  });

  it("runs explicit shell code only and blocks terminal control characters", () => {
    expect(describeMarkdownFence("bash", "npm run dev\n")).toMatchObject({ action: "run", command: "npm run dev", detected: false });
    expect(describeMarkdownFence("typescript", 'console.log("npm run dev")')).toMatchObject({ action: null });
    expect(describeMarkdownFence("bash", "echo \u001b[2J")).toMatchObject({ action: null, disabledReason: "Terminal control characters cannot be sent" });
    expect(describeMarkdownFence("bash", "\n")).toMatchObject({ action: null, disabledReason: "Code block is empty" });
  });
});
