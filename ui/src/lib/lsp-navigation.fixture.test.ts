// Fixture tests: no language server is involved, replies come from hand written fixtures.
import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import type { LspResponse, SymbolDto_Serialize } from "../bindings";
import { createNavigationSession, editsToOffsets, flattenSymbols, fuzzyMatch, groupByFile, planWorkspaceEdit, symbolPathAt, wordAt } from "./lsp-navigation";
import { createJumpHistory } from "./navigation-context";

const at = (line: number, from: number, to = from) => ({ start: { line, character: from }, end: { line, character: to } });
const symbol = (name: string, kind: SymbolDto_Serialize["kind"], startLine: number, endLine: number, children: SymbolDto_Serialize[] = []): SymbolDto_Serialize =>
  ({ name, kind, detail: null, range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 10 } }, selectionRange: at(startLine, 6, 6 + name.length), children });
const tree = [symbol("Circle", "class", 0, 10, [symbol("constructor", "constructor", 1, 2), symbol("area", "method", 4, 8)]), symbol("helper", "function", 12, 14)];
const reply = <T,>(data: T): LspResponse<T> => ({ revision: 1, epoch: 1, data });

describe("navigation session (fixture)", () => {
  it("makes the older request of a key silent and cancels it in the backend", async () => {
    const cancel = vi.fn(async () => null);
    const session = createNavigationSession({ cancel });
    let release!: (value: LspResponse<number>) => void;
    const first = session.run("k", () => new Promise<LspResponse<number>>(resolve => { release = resolve; }));
    const second = session.run("k", async () => reply(2));
    release(reply(1));
    expect((await first).kind).toBe("silent");
    expect(await second).toMatchObject({ kind: "ok", response: { data: 2 } });
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("turns stale and cancelled errors into silence and other errors into a message, never a rejection", async () => {
    const session = createNavigationSession({ cancel: async () => null });
    expect((await session.run("a", async () => { throw { kind: "stale" }; })).kind).toBe("silent");
    expect(await session.run("b", async () => { throw { kind: "other", message: "boom" }; })).toMatchObject({ kind: "error", message: "boom" });
    session.dispose();
    expect((await session.run("c", async () => reply(1))).kind).toBe("silent");
  });
});

describe("symbols (fixture)", () => {
  it("finds the symbol path of a position with the siblings of each level", () => {
    const path = symbolPathAt(tree, { line: 5, character: 4 });
    expect(path.map(crumb => crumb.symbol.name)).toEqual(["Circle", "area"]);
    expect(path[1].siblings.map(item => item.name)).toEqual(["constructor", "area"]);
    expect(symbolPathAt(tree, { line: 11, character: 0 })).toEqual([]);
  });
  it("flattens with depth and container names", () => {
    expect(flattenSymbols(tree).map(row => `${row.depth}:${row.container.join(".")}:${row.symbol.name}`)).toEqual(["0::Circle", "1:Circle:constructor", "1:Circle:area", "0::helper"]);
  });
  it("matches fuzzily and ranks prefixes and word starts higher", () => {
    expect(fuzzyMatch("xyz", "area")).toBeUndefined();
    expect(fuzzyMatch("ar", "area")!.score).toBeGreaterThan(fuzzyMatch("ar", "bigarea")!.score);
    expect(fuzzyMatch("gtn", "getTargetName")?.indices).toEqual([0, 2, 9]);
  });
  it("finds the word at the caret", () => {
    const doc = Text.of(["const total = sum(a);"]);
    expect(wordAt(doc, 8)).toMatchObject({ text: "total", from: 6, to: 11 });
    expect(wordAt(doc, 5)?.text).toBe("const");
    expect(wordAt(Text.of(["  ;"]), 1)).toBeUndefined();
  });
  it("groups locations by file in position order", () => {
    const location = (path: string, line: number) => ({ location: { path, range: at(line, 0), external: false, displayPath: path } });
    const groups = groupByFile([location("b.ts", 9), location("a.ts", 3), location("b.ts", 1)]);
    expect(groups.map(group => [group.key, group.items.map(item => item.location.range.start.line)])).toEqual([["b.ts", [1, 9]], ["a.ts", [3]]]);
  });
});

describe("rename planning (fixture)", () => {
  const edit = (path: string, external = false) => ({ path, external, edits: [{ range: at(0, 0, 3), newText: "x" }] });
  it("refuses library files, paths outside the workspace and read-only buffers without applying anything", () => {
    expect(planWorkspaceEdit({ files: [edit("lib.d.ts", true)], skippedOperations: 0 }, () => false)).toMatchObject({ ok: false, message: expect.stringContaining("library") });
    expect(planWorkspaceEdit({ files: [edit("/etc/passwd")], skippedOperations: 0 }, () => false)).toMatchObject({ ok: false, message: expect.stringContaining("outside the workspace") });
    expect(planWorkspaceEdit({ files: [edit("../x.ts")], skippedOperations: 0 }, () => false)).toMatchObject({ ok: false });
    expect(planWorkspaceEdit({ files: [edit("a.ts")], skippedOperations: 0 }, () => true)).toMatchObject({ ok: false, message: expect.stringContaining("read-only") });
    expect(planWorkspaceEdit({ files: [edit("a.ts")], skippedOperations: 1 }, () => false)).toMatchObject({ ok: false });
  });
  it("counts occurrences and files", () => {
    expect(planWorkspaceEdit({ files: [edit("a.ts"), edit("b.ts")], skippedOperations: 0 }, () => false)).toMatchObject({ ok: true, occurrences: 2 });
  });
  it("rejects overlapping or out of range edits", () => {
    const doc = Text.of(["abcdef", "ghi"]);
    expect(editsToOffsets(doc, [{ range: at(0, 3, 5), newText: "" }, { range: at(0, 0, 2), newText: "" }])).toEqual([{ from: 0, to: 2, insert: "" }, { from: 3, to: 5, insert: "" }]);
    expect(editsToOffsets(doc, [{ range: at(0, 0, 4), newText: "" }, { range: at(0, 2, 5), newText: "" }])).toBeUndefined();
    expect(editsToOffsets(doc, [{ range: at(9, 0, 1), newText: "" }])).toBeUndefined();
  });
});

describe("jump history (fixture)", () => {
  it("walks back and forward through recorded places", () => {
    const history = createJumpHistory();
    const place = (line: number) => ({ path: "a.ts", line, column: 1 });
    history.record(place(1)); history.record(place(5));
    expect(history.back(place(9))).toEqual(place(5));
    expect(history.back(place(9))).toEqual(place(1));
    expect(history.back(place(9))).toBeUndefined();
    expect(history.forward()).toEqual(place(5));
    expect(history.forward()).toEqual(place(9));
    expect(history.forward()).toBeUndefined();
  });
});
