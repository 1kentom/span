import { describe, expect, it } from "vitest";
import { absolutePath, clampMenu, fileName, fileResults, parentPath, pathBreadcrumbs, relativePath, parseFileQuery } from "./navigation";

describe("workspace navigation paths", () => {
  it("builds each nested breadcrumb from actual workspace paths", () => {
    expect(pathBreadcrumbs("public/img/logos/afya-connect.svg", { name: "Console-HTX", root: "/work/Console-HTX" })).toEqual([
      { name: "Console-HTX", path: "", directory: true },
      { name: "public", path: "public", directory: true },
      { name: "img", path: "public/img", directory: true },
      { name: "logos", path: "public/img/logos", directory: true },
      { name: "afya-connect.svg", path: "public/img/logos/afya-connect.svg", directory: false },
    ]);
  });
  it("copies filenames, relative paths and native absolute paths on Windows and Unix", () => {
    expect(fileName("C:\\Projects\\Console\\public\\logo.svg")).toBe("logo.svg");
    expect(parentPath("public/img/logo.svg")).toBe("public/img");
    expect(relativePath("C:\\Projects\\Console\\public\\logo.svg", "c:\\projects\\console")).toBe("public/logo.svg");
    expect(absolutePath("public/img/logo.svg", "C:\\Projects\\Console")).toBe("C:\\Projects\\Console\\public\\img\\logo.svg");
    expect(absolutePath("public/img/logo.svg", "/work/Console/")).toBe("/work/Console/public/img/logo.svg");
    expect(relativePath("/work/Console-other/a.ts", "/work/Console")).toBe("/work/Console-other/a.ts");
    expect(relativePath("/work/Console/a.ts", "/work/Console")).toBe("a.ts");
    expect(absolutePath("/other/a.ts", "/work/Console")).toBe("/other/a.ts");
  });
  it("uses recent workspace files without manufacturing aliases or content results", () => {
    const files = ["one/a.ts", "two/a.ts", "b.ts"].map(path => ({ path, name: fileName(path), isDir: false }));
    expect(fileResults(files, "", ["b.ts", "missing.ts"]).map(file => file.path)).toEqual(["b.ts", "one/a.ts", "two/a.ts"]);
    expect(fileResults(files, "two/a:12").map(file => file.path)).toEqual(["two/a.ts"]);
    expect(fileResults(files, "Console/b.ts")).toEqual([]);
  });
  it("clamps a menu at the visible viewport edges", () => {
    expect(clampMenu(999, 999, 220, 250, 800, 600)).toEqual({ x: 572, y: 342 });
    expect(clampMenu(-1, -5, 220, 250, 800, 600)).toEqual({ x: 8, y: 8 });
  });
});

describe("Goto position queries", () => {
  const files = ["src/file.ts", "notes/report:2026.md", "notes/report:2026", "colon:12"].map(path => ({ path, name: fileName(path), isDir: false }));
  it("keeps file matches through incomplete position suffixes", () => {
    for (const query of ["file:", "file:12", "file:12:", "file:12:3"]) expect(fileResults(files, query).map(file => file.path)).toEqual(["src/file.ts"]);
    expect(parseFileQuery("file:12:3", files)).toMatchObject({ filter: "file", line: 12, column: 3 });
    expect(parseFileQuery("file:12:", files)).toMatchObject({ filter: "file", line: 12, column: undefined });
  });
  it("preserves actual colon filenames and favors the longest existing path prefix", () => {
    expect(parseFileQuery("colon:12", files)).toEqual({ filter: "colon:12", suffix: "" });
    expect(parseFileQuery("report:202", files)).toEqual({ filter: "report:202", suffix: "" });
    expect(parseFileQuery("notes/report:2026:12", files)).toMatchObject({ filter: "notes/report:2026", line: 12, column: undefined });
    expect(parseFileQuery("notes/report:2026.md:4:2", files)).toMatchObject({ filter: "notes/report:2026.md", line: 4, column: 2 });
  });
  it("distinguishes Windows drive letters from position suffixes", () => {
    expect(parseFileQuery("C:", files)).toEqual({ filter: "C:", suffix: "" });
    expect(fileResults(files, "C:\\workspace\\src\\file.ts:14:7", [], "C:\\workspace").map(file => file.path)).toEqual(["src/file.ts"]);
    expect(parseFileQuery("C:\\workspace\\src\\file.ts:14:7", files, "C:\\workspace")).toMatchObject({ filter: "C:\\workspace\\src\\file.ts", line: 14, column: 7 });
  });
  it("keeps malformed or invalid positions from opening an unrelated result", () => {
    for (const query of ["file:0", "file:12:0", "file:999999999999999999999999999999", "file:12:abc", "file::", "missing:12:3"]) expect(fileResults(files, query)).toEqual([]);
  });
});
