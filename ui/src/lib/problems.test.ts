import { describe, expect, it } from "vitest";
import { agentPrompt, summarize, toProblems } from "./problems";
import type { DiagnosticDto_Deserialize } from "../bindings";

const d = (severity: DiagnosticDto_Deserialize["severity"], line: number, message: string, extra: Partial<DiagnosticDto_Deserialize> = {}): DiagnosticDto_Deserialize =>
  ({ severity, message, range: { start: { line, character: 2 }, end: { line, character: 5 } }, ...extra });

describe("problems", () => {
  it("keeps errors and warnings in file order and drops information and hints", () => {
    const list = toProblems([d("warning", 9, "w"), d("hint", 1, "h"), d("error", 3, "e"), d("information", 2, "i"), d(null, 5, "no severity")]);
    expect(list.map(item => [item.severity, item.line, item.column])).toEqual([["error", 4, 3], ["error", 6, 3], ["warning", 10, 3]]);
  });
  it("words the summary like the design tooltip", () => {
    expect(summarize(toProblems([d("error", 1, "a"), d("error", 2, "b"), d("warning", 3, "c"), d("warning", 4, "d")])).label).toBe("2 errors, 2 warnings. Open problems");
    expect(summarize(toProblems([d("error", 1, "a")])).label).toBe("1 error. Open problems");
    expect(summarize([]).label).toBe("No problems");
  });
  it("builds the agent text with the place, the source and the line", () => {
    const text = agentPrompt("src/a.ts", toProblems([d("error", 2, "Type 'number' is not assignable to type 'string'.", { source: "ts", code: "2322" })]), "fix", line => (line === 3 ? "  const x: string = 1;" : undefined));
    expect(text).toContain("Fix this problem.");
    expect(text).toContain("Error in src/a.ts:3:3 (ts 2322): Type 'number' is not assignable to type 'string'.");
    expect(text).toContain("const x: string = 1;");
    expect(agentPrompt("a.ts", toProblems([d("error", 0, "x"), d("warning", 1, "y")]), "explain")).toContain("Explain these problems");
  });
});

describe("unused code", () => {
  it("counts a hint tagged unnecessary as a warning and keeps plain hints out", () => {
    const list = toProblems([
      { severity: "hint", message: "'x' is declared but its value is never read.", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, unnecessary: true },
      { severity: "hint", message: "just a hint", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ severity: "warning", unused: true });
    expect(summarize(list).label).toBe("1 warning. Open problems");
  });
});
