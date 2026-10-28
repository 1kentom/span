import { describe, expect, it } from "vitest";
import type { FileEntry } from "../bindings";
import { copyName, creationFolder, moveRefusal, rangeBetween, renameSelectionEnd, topLevelPaths, validateName } from "./explorer-ops";

const entry = (path: string, isDir = false): FileEntry => ({ path, name: path.split("/").pop()!, isDir } as FileEntry);
const tree: Record<string, FileEntry[]> = { "": [entry("src", true), entry("README.md")], src: [entry("src/a.ts"), entry("src/lib", true)] };
const listing = (folder: string) => tree[folder];

describe("explorer name validation", () => {
  it("rejects empty, slash, dot and reserved names with the design copy", () => {
    expect(validateName("  ", "", listing)).toEqual({ level: "error", msg: "A file or folder name must be provided." });
    expect(validateName("/x", "", listing)).toMatchObject({ level: "error", msg: "A file or folder name cannot start with a slash." });
    expect(validateName("a//b", "", listing)).toMatchObject({ level: "error", msg: "A name cannot contain two slashes in a row." });
    expect(validateName("..", "", listing)).toMatchObject({ level: "error" });
    expect(validateName("con.txt", "", listing)).toMatchObject({ level: "error" });
    expect(validateName("a:b", "", listing)).toMatchObject({ level: "error" });
  });
  it("reports an existing name case insensitively but allows the item's own name", () => {
    expect(validateName("readme.md", "", listing)).toMatchObject({ level: "error", msg: expect.stringContaining("already exists") });
    expect(validateName("README.md", "", listing, "README.md")).toMatchObject({ level: null });
  });
  it("lists intermediate folders that will be created and rejects a file as a folder", () => {
    expect(validateName("a/b/c.ts", "src", listing)).toMatchObject({ newDirs: ["a", "b"], last: "c.ts" });
    expect(validateName("a.ts/x", "src", listing)).toMatchObject({ level: "error", msg: "'a.ts' is a file, so it cannot contain other items." });
    expect(validateName("dir/", "", listing)).toMatchObject({ trailingSlash: true });
  });
  it("warns about whitespace and trailing periods", () => {
    expect(validateName("a ", "", listing)).toMatchObject({ level: "warn" });
    expect(validateName("a.", "", listing)).toMatchObject({ level: "warn" });
  });
});

describe("explorer helpers", () => {
  it("stops the rename selection before compound suffixes", () => {
    expect(renameSelectionEnd("a.test.ts", false)).toBe(1);
    expect(renameSelectionEnd("types.d.ts", false)).toBe(5);
    expect(renameSelectionEnd("app.min.js", false)).toBe(3);
    expect(renameSelectionEnd("main.rs", false)).toBe(4);
    expect(renameSelectionEnd(".env", false)).toBe(4);
    expect(renameSelectionEnd("a.b", true)).toBe(3);
  });
  it("names copies like VS Code", () => {
    const taken = new Set(["a.ts", "a copy.ts"]);
    expect(copyName("a.ts", false, name => taken.has(name))).toBe("a copy 2.ts");
    expect(copyName("dir", true, () => false)).toBe("dir copy");
    expect(copyName("a copy.ts", false, () => false)).toBe("a copy 2.ts");
  });
  it("picks the creation folder", () => {
    const dirs = new Set(["src", "src/lib"]);
    const isDir = (path: string) => dirs.has(path);
    expect(creationFolder(["src"], isDir)).toBe("src");
    expect(creationFolder(["src/a.ts"], isDir)).toBe("src");
    expect(creationFolder([], isDir, "src/lib/x.ts")).toBe("src/lib");
    expect(creationFolder([], isDir)).toBe("");
  });
  it("refuses unsafe moves", () => {
    expect(moveRefusal("src", "src")).toBeDefined();
    expect(moveRefusal("src", "src/lib")).toBeDefined();
    expect(moveRefusal("src/a.ts", "src")).toBeDefined();
    expect(moveRefusal("src/lib", "")).toBeUndefined();
    expect(moveRefusal("src2", "src")).toBeUndefined();
  });
  it("keeps only top level sources and ranges", () => {
    expect(topLevelPaths(["src", "src/a.ts", "x"])).toEqual(["src", "x"]);
    expect(rangeBetween(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"]);
  });
});
