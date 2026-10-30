// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clearSpanStorage, readStored, recordOf, spanStorageKeyNames, stringArray, stringRecord, writeStored } from "./stored";

beforeEach(() => window.localStorage.clear());

const isCount = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : undefined);

describe("readStored", () => {
  it("returns the fallback when nothing is stored", () => {
    expect(readStored("span.test", isCount, 7)).toBe(7);
  });
  it("returns a stored value that passes validation", () => {
    writeStored("span.test", 3);
    expect(readStored("span.test", isCount, 7)).toBe(3);
  });
  it("falls back and deletes a value in the wrong shape", () => {
    window.localStorage.setItem("span.test", JSON.stringify({ count: 3 }));
    expect(readStored("span.test", isCount, 7)).toBe(7);
    expect(window.localStorage.getItem("span.test")).toBeNull();
  });
  it("falls back and deletes a value that is not JSON", () => {
    window.localStorage.setItem("span.test", "{nope");
    expect(readStored("span.test", isCount, 7)).toBe(7);
    expect(window.localStorage.getItem("span.test")).toBeNull();
  });
  it("falls back when the validator itself throws", () => {
    window.localStorage.setItem("span.test", "null");
    expect(readStored("span.test", (value) => (value as { a: number }).a, 1)).toBe(1);
  });
  it("survives storage that throws or is missing", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(readStored("span.test", isCount, 7, broken)).toBe(7);
    expect(readStored("span.test", isCount, 7, undefined)).toBe(7);
    const failingRemove = { getItem: () => "{nope", removeItem: () => { throw new Error("read only"); } };
    expect(readStored("span.test", isCount, 7, failingRemove)).toBe(7);
    expect(writeStored("span.test", 1, { getItem: () => null, removeItem: () => undefined, setItem: () => { throw new Error("full"); } })).toBe(false);
  });
  it("narrows nested shapes with the shared validators", () => {
    expect(recordOf(stringRecord)({ a: { model: "x", n: 1 }, b: null, c: [1], d: "x" })).toEqual({ a: { model: "x" } });
    expect(stringArray(["a", 1, null, "b"])).toEqual(["a", "b"]);
    expect(stringArray({ 0: "a" })).toBeUndefined();
    expect(recordOf(stringRecord)([])).toBeUndefined();
  });
});

describe("clearSpanStorage", () => {
  it("removes only Span keys", () => {
    window.localStorage.setItem("span.agent.lastConfig", "{}");
    window.localStorage.setItem("span:window.zoomLevel", "1");
    window.localStorage.setItem("other.app", "keep");
    window.localStorage.setItem("spanish", "keep");
    expect(clearSpanStorage()).toBe(2);
    expect(window.localStorage.getItem("other.app")).toBe("keep");
    expect(window.localStorage.getItem("spanish")).toBe("keep");
    expect(window.localStorage.getItem("span.agent.lastConfig")).toBeNull();
  });
  it("returns zero without storage", () => {
    expect(clearSpanStorage(undefined)).toBe(0);
  });
});

describe("spanStorageKeyNames", () => {
  it("lists key names with folder paths redacted and never values", () => {
    window.localStorage.setItem("span.theme", "dark");
    window.localStorage.setItem("span:run-selected:/home/someone/project", "secret-value");
    window.localStorage.setItem("span.agents.mode:/home/someone/project", "agents");
    window.localStorage.setItem("other.app", "x");
    const names = spanStorageKeyNames();
    expect(names).toEqual(["span.agents.mode:<redacted>", "span.theme", "span:run-selected:<redacted>"]);
    expect(names.join(" ")).not.toContain("someone");
    expect(names.join(" ")).not.toContain("secret-value");
  });
});
