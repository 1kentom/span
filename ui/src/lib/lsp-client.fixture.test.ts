import { describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import { createLspSession, describeLspError, normalizeLspError, offsetToPosition, positionToOffset, rangeToOffsets, serverForBuffer } from "./lsp-client";

// Fixture tests: the Tauri boundary is a hand written fake. They do not prove real server behaviour.
const response = <T,>(data: T) => ({ revision: 1, epoch: 0, data });
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

describe("fixture: position conversion", () => {
  const doc = Text.of(["a😀b", "中文x", ""]);
  it("round trips emoji and CJK as UTF-16 units", () => {
    for (let offset = 0; offset <= doc.length; offset++) expect(positionToOffset(doc, offsetToPosition(doc, offset))).toBe(offset);
    expect(offsetToPosition(doc, 4)).toEqual({ line: 0, character: 4 });
    expect(offsetToPosition(doc, 6)).toEqual({ line: 1, character: 1 });
  });
  it("clamps out of range positions", () => {
    expect(positionToOffset(doc, { line: 99, character: 0 })).toBe(doc.length);
    expect(positionToOffset(doc, { line: 0, character: 99 })).toBe(4);
    expect(positionToOffset(doc, { line: -1, character: -5 })).toBe(0);
    expect(rangeToOffsets(doc, { start: { line: 1, character: 2 }, end: { line: 0, character: 0 } })).toEqual({ from: 0, to: 7 });
  });
});

describe("fixture: language families", () => {
  it("maps extensions to servers and ignores the rest", () => {
    expect(serverForBuffer("a/b.tsx")).toBe("vtsls");
    expect(serverForBuffer("x.scss")).toBe("css");
    expect(serverForBuffer("x.jsonc")).toBe("json");
    expect(serverForBuffer("m.rs")).toBe("rust-analyzer");
    expect(serverForBuffer("m.py")).toBe("basedpyright");
    expect(serverForBuffer("A.java")).toBe("jdtls");
    expect(serverForBuffer("README.md")).toBeUndefined();
    expect(serverForBuffer("settings://user")).toBeUndefined();
  });
});

describe("fixture: session", () => {
  const port = () => ({ completion: vi.fn(), hover: vi.fn(), definition: vi.fn(), format: vi.fn(), cancel: vi.fn(async () => null) });
  it("treats stale and cancelled errors as silent and other errors as messages", async () => {
    const p = port();
    p.hover.mockRejectedValueOnce({ kind: "stale" }).mockRejectedValueOnce({ kind: "cancelled" }).mockRejectedValueOnce({ kind: "startFailed", server: "vtsls", reason: "boom" });
    const s = createLspSession(p);
    expect((await s.hover("a.ts", { line: 0, character: 0 })).kind).toBe("silent");
    expect((await s.hover("a.ts", { line: 0, character: 0 })).kind).toBe("silent");
    const out = await s.hover("a.ts", { line: 0, character: 0 });
    expect(out).toMatchObject({ kind: "error", message: "vtsls did not start: boom" });
  });
  it("cancels the older request when a newer one starts and drops its reply", async () => {
    const p = port(); const first = deferred<any>();
    p.completion.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response({ isIncomplete: false, items: [] }));
    const s = createLspSession(p);
    const a = s.completion("a.ts", { line: 0, character: 0 }, null);
    const b = await s.completion("a.ts", { line: 0, character: 1 }, null);
    first.resolve(response({ isIncomplete: false, items: [] }));
    expect(b.kind).toBe("ok");
    expect((await a).kind).toBe("silent");
    await Promise.resolve();
    expect(p.cancel).toHaveBeenCalledWith(p.completion.mock.calls[0][3]);
  });
  it("cancels in flight work on dispose and never rejects", async () => {
    const p = port(); const d = deferred<any>(); p.format.mockReturnValueOnce(d.promise);
    const s = createLspSession(p);
    const f = s.format("a.ts");
    s.dispose();
    d.reject(new Error("late"));
    expect((await f).kind).toBe("silent");
    expect((await s.format("a.ts")).kind).toBe("silent");
    expect(p.cancel).toHaveBeenCalled();
  });
  it("normalizes thrown values", () => {
    expect(normalizeLspError(new Error("x"))).toEqual({ kind: "other", message: "x" });
    expect(describeLspError({ kind: "runtimeMissing", server: "jdtls", runtime: "Java", requiredVersion: 25, found: ["17"] })).toBe("Java (Eclipse JDT LS) needs JDK 25 or newer, found: 17");
  });
});
