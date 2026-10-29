import { languageIds, resolveLanguageId, type LanguageId } from "../editor/languages";
import { languageDisplayName } from "../editor/language-names";

export const markdownFenceLanguages: Readonly<Record<LanguageId, string>> = Object.fromEntries(
  languageIds.map((id) => [id, ({ jsonc: "JSON with comments", dotenv: "Environment", shell: "Shell" } as Partial<Record<LanguageId, string>>)[id] ?? languageDisplayName(id)]),
) as Record<LanguageId, string>;

export interface MarkdownFence {
  language: LanguageId;
  label: string;
  declared: string;
  detected: boolean;
  command: string | null;
  action: "run" | "send" | null;
  omittedOutput: boolean;
  disabledReason: string;
}

export interface MarkdownRunRequest {
  code: string;
  language: string;
  documentPath: string;
  workspaceRoot: string;
  sourceLine: number;
  action: "run" | "send";
  detected: boolean;
  omittedOutput: boolean;
}

const packageCommand = /^(?:npm\s+(?:run|install|i|ci|test|start|exec|init|create|uninstall|update|audit|pack|publish)|(?:pnpm|yarn|bun)\s+(?:run|install|i|add|remove|test|start|dev|build|exec|dlx|create|init|update|upgrade))(?=\s|$)/;
const promptCommand = /^\s*\$\s+(.+)$/;
const shellNames: Record<string, string> = { bash: "Bash", sh: "Shell", zsh: "Zsh", shell: "Shell", shellscript: "Shell", console: "Console" };

/** Language declarations always win. Guesses only recognize complete package commands or explicit prompts. */
export function describeMarkdownFence(info: string, code: string): MarkdownFence {
  const provided = info.trim().length > 0;
  const hint = info.trim().split(/\s+/, 1)[0].toLowerCase().replace(/^language-/, "");
  const declared = /^[\w+-]{1,32}$/.test(hint) ? hint : "";
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const nonempty = lines.filter((line) => line.trim());
  const prompted = nonempty.flatMap((line) => { const match = promptCommand.exec(line); return match ? [match[1]] : []; });
  const packageLines = nonempty.filter((line) => packageCommand.test(line.trim()));
  const detected = !provided && nonempty.length > 0 && (prompted.length > 0 || packageLines.length === nonempty.length);
  const language = detected ? "shell" : resolveLanguageId(declared);
  const label = detected ? "Shell (detected)" : language === "shell" ? shellNames[declared] ?? "Shell" : markdownFenceLanguages[language];
  const result: MarkdownFence = { language, label, declared, detected, command: null, action: null, omittedOutput: false, disabledReason: "Run is available for shell code blocks" };
  if (language !== "shell") return result;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(code)) return { ...result, disabledReason: "Terminal control characters cannot be sent" };
  const transcript = declared === "console" || prompted.length > 0;
  const commands = prompted.length ? prompted : declared === "console" ? packageLines.map((line) => line.trim()) : null;
  if (transcript && !commands?.length) return { ...result, disabledReason: "No prompted shell commands detected" };
  const command = commands ? commands.join("\n") : code.replace(/\s+$/, "");
  if (!command.trim()) return { ...result, disabledReason: "Code block is empty" };
  // Transcript continuations cannot be reconstructed reliably from output, so leave execution to the explicit Run draft action.
  const review = detected || (declared === "console" && !prompted.length) || !!commands?.some((line) => /\\\s*$/.test(line));
  return { ...result, command, action: review ? "send" : "run", omittedOutput: !!commands && nonempty.length > commands.length, disabledReason: "" };
}
