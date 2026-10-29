import { afterEach, describe, expect, it } from "vitest";
import { ingestDiagnostics, problemCounts, problemsFor, pruneProblems } from "./problems";

const event = (path: string, severities: ("error" | "warning")[]) => ({ path, diagnostics: severities.map((severity, line) => ({ severity, message: `m${line}`, range: { start: { line, character: 0 }, end: { line, character: 1 } } })) });
afterEach(() => pruneProblems());

describe("problems store", () => {
  it("replaces a file's problems on each publish and clears it on an empty one", () => {
    ingestDiagnostics(event("a.ts", ["error", "warning", "warning"]));
    expect(problemCounts("a.ts")).toEqual({ errors: 1, warnings: 2 });
    ingestDiagnostics(event("a.ts", ["warning"]));
    expect(problemCounts("a.ts")).toEqual({ errors: 0, warnings: 1 });
    ingestDiagnostics(event("a.ts", []));
    expect(problemCounts("a.ts")).toBeUndefined();
    expect(problemsFor("a.ts")).toEqual([]);
  });
  it("prunes files the filter rejects, or all of them", () => {
    ingestDiagnostics(event("a.ts", ["error"])); ingestDiagnostics(event("b.ts", ["error"]));
    pruneProblems(path => path === "a.ts");
    expect(problemCounts("b.ts")).toBeUndefined();
    expect(problemCounts("a.ts")).toBeDefined();
  });
});
