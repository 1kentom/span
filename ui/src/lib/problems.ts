import type { DiagnosticDto_Deserialize } from "../bindings";

export type ProblemSeverity = "error" | "warning";
export interface Problem { severity: ProblemSeverity; message: string; line: number; column: number; source?: string; code?: string }
export interface ProblemSummary { errors: number; warnings: number; total: number; label: string }

/** Keeps errors and warnings, in file order. Information and hints stay in the editor only. */
export function toProblems(diagnostics: readonly DiagnosticDto_Deserialize[]): Problem[] {
  const out: Problem[] = [];
  for (const item of diagnostics) {
    const severity = item.severity === "warning" ? "warning" : item.severity === "error" || item.severity == null ? "error" : undefined;
    if (!severity) continue;
    out.push({ severity, message: item.message.trim(), line: item.range.start.line + 1, column: item.range.start.character + 1, source: item.source ?? undefined, code: item.code ?? undefined });
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function summarize(problems: readonly Problem[]): ProblemSummary {
  const errors = problems.filter(item => item.severity === "error").length;
  const warnings = problems.length - errors;
  const parts = [errors ? plural(errors, "error") : "", warnings ? plural(warnings, "warning") : ""].filter(Boolean);
  return { errors, warnings, total: problems.length, label: parts.length ? `${parts.join(", ")}. Open problems` : "No problems" };
}

const describe = (path: string, item: Problem, lineText?: string) =>
  `${item.severity === "error" ? "Error" : "Warning"} in ${path}:${item.line}:${item.column}${item.source ? ` (${item.source}${item.code ? ` ${item.code}` : ""})` : ""}: ${item.message}${lineText?.trim() ? `\n    ${lineText.trim()}` : ""}`;

/** Text for the agent composer: what is wrong and where, and what is being asked. The user still sends it. */
export function agentPrompt(path: string, problems: readonly Problem[], action: "fix" | "explain", lineOf?: (line: number) => string | undefined): string {
  const lines = problems.map(item => describe(path, item, lineOf?.(item.line)));
  const ask = action === "explain" ? (problems.length === 1 ? "Explain this problem and how to fix it." : "Explain these problems and how to fix them.") : (problems.length === 1 ? "Fix this problem." : "Fix these problems.");
  return `${ask}\n\n${lines.join("\n")}`;
}
