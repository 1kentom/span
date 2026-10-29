import { describe, expect, it } from "vitest";
import { computeIndentGuides, leadingColumns } from "./indent-guides";

const source = (text: string) => { const lines = text.split("\n"); return { lines: lines.length, text: (line: number) => lines[line - 1] }; };
const columnsOf = (text: string, unit = 4, tabSize = 4) => computeIndentGuides(source(text), 1, text.split("\n").length, { tabSize, unit }).lines.map((line) => line.columns);

const java = [
  "class A {",            // 1
  "    void run() {",     // 2
  "        int a = 1;",   // 3
  "",                     // 4
  "        if (a > 0) {", // 5
  "            a++;",     // 6
  "        }",            // 7
  "",                     // 8
  "    }",                // 9
  "}",                    // 10
].join("\n");

describe("leadingColumns", () => {
  it("expands tabs to the next stop and reports blank lines as null", () => {
    expect(leadingColumns("\tx", 4)).toBe(4);
    expect(leadingColumns("  \tx", 4)).toBe(4);
    expect(leadingColumns("   ", 4)).toBeNull();
    expect(leadingColumns("", 4)).toBeNull();
  });
});

describe("computeIndentGuides", () => {
  it("never draws a guide on the first column and stops short of the text", () => {
    expect(columnsOf(java)).toEqual([[], [], [4], [4], [4], [4, 8], [4], [4], [], []]);
  });

  it("continues guides through blank lines inside a block", () => {
    const lines = columnsOf(java);
    expect(lines[3]).toEqual(lines[2]);
    // Blank before a closing brace keeps the closing block's guide.
    expect(lines[7]).toEqual([4]);
  });

  it("continues through runs of blank lines, including whitespace-only ones", () => {
    expect(columnsOf("a:\n    b:\n        c\n\n   \n        d\n    e", 4)).toEqual([[], [], [4], [4], [4], [4], []]);
  });

  it("aligns guides to the indent unit, also for tab indentation", () => {
    expect(columnsOf("x\n\t\ty", 4, 4)).toEqual([[], [4]]);
    expect(columnsOf("x\n      y", 2)).toEqual([[], [2, 4]]);
  });

  it("highlights the block the cursor is in, from its first to its last body line", () => {
    const result = computeIndentGuides(source(java), 1, 10, { tabSize: 4, unit: 4, activeLine: 6 });
    expect(result.active).toEqual({ column: 8, from: 6, to: 6 });
    expect(computeIndentGuides(source(java), 1, 10, { tabSize: 4, unit: 4, activeLine: 3 }).active).toEqual({ column: 4, from: 3, to: 8 });
  });

  it("treats an opening or closing line as the owner of its block", () => {
    expect(computeIndentGuides(source(java), 1, 10, { tabSize: 4, unit: 4, activeLine: 5 }).active).toEqual({ column: 8, from: 6, to: 6 });
    expect(computeIndentGuides(source(java), 1, 10, { tabSize: 4, unit: 4, activeLine: 7 }).active).toEqual({ column: 8, from: 6, to: 6 });
    expect(computeIndentGuides(source(java), 1, 10, { tabSize: 4, unit: 4, activeLine: 2 }).active).toEqual({ column: 4, from: 3, to: 8 });
  });

  it("has no active guide for top-level blocks, which have no guide", () => {
    expect(computeIndentGuides(source(java), 1, 10, { tabSize: 4, unit: 4, activeLine: 1 }).active).toBeNull();
    expect(computeIndentGuides(source(java), 1, 10, { tabSize: 4, unit: 4, activeLine: 10 }).active).toBeNull();
  });

  it("only computes the requested range, with bounded context scans", () => {
    const big = Array.from({ length: 200000 }, (_, index) => (index % 3 ? "        line" : "")).join("\n");
    const started = performance.now();
    const result = computeIndentGuides(source(big), 100000, 100060, { tabSize: 4, unit: 4, activeLine: 100030 });
    expect(result.lines).toHaveLength(61);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
