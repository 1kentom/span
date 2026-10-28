import { describe, expect, it } from "vitest";
import { compactChain, insideSourceRoot, isSourceRoot, type TreeEntry } from "./compact-tree";

// Fixture-only tests: listings are hand-written maps, no real workspace is read.
const dir = (path: string): TreeEntry => ({ name: path.split("/").pop()!, path, isDir: true });
const file = (path: string): TreeEntry => ({ name: path.split("/").pop()!, path, isDir: false });

describe("compactChain (fixture)", () => {
  it("merges a single-child directory chain with a slash label", () => {
    const chain = compactChain("com", { com: [dir("com/example")], "com/example": [dir("com/example/todo")], "com/example/todo": [file("com/example/todo/A.txt"), file("com/example/todo/B.txt")] });
    expect(chain.segments.map(s => s.name)).toEqual(["com", "example", "todo"]);
    expect(chain.deepest).toBe("com/example/todo"); expect(chain.label).toBe("com/example/todo"); expect(chain.inSourceRoot).toBe(false);
  });
  it("stops at a branch, at files and at a directory that is not loaded", () => {
    expect(compactChain("a", { a: [dir("a/b"), dir("a/c")] }).deepest).toBe("a");
    expect(compactChain("a", { a: [file("a/x.txt")] }).deepest).toBe("a");
    expect(compactChain("a", { a: [dir("a/b")] }).deepest).toBe("a/b");
    expect(compactChain("a", {}).segments).toHaveLength(1);
  });
  it("uses dots below a Java source root and keeps the root as its own row", () => {
    const listings = { "src/main/java": [dir("src/main/java/com")], "src/main/java/com": [dir("src/main/java/com/example")], "src/main/java/com/example": [dir("src/main/java/com/example/todo")] };
    expect(compactChain("src/main/java/com", listings)).toMatchObject({ label: "com.example.todo", separator: ".", inSourceRoot: true, deepest: "src/main/java/com/example/todo" });
    expect(compactChain("src/main/java", listings)).toMatchObject({ isSourceRoot: true, deepest: "src/main/java" });
    expect(compactChain("src", { src: [dir("src/main")], "src/main": [dir("src/main/java")] }).deepest).toBe("src/main");
  });
  it("falls back to slashes for non identifier segments and supports multi-module and kotlin roots", () => {
    const bad = compactChain("mod/src/test/kotlin/org", { "mod/src/test/kotlin/org": [dir("mod/src/test/kotlin/org/my-app")] });
    expect(bad.label).toBe("org/my-app"); expect(bad.inSourceRoot).toBe(true);
    const ok = compactChain("mod/src/main/java/org", { "mod/src/main/java/org": [dir("mod/src/main/java/org/app")] });
    expect(ok.label).toBe("org.app");
    expect(isSourceRoot("a/b/src/integrationTest/java")).toBe(true); expect(isSourceRoot("src/main/java/x")).toBe(false); expect(insideSourceRoot("src/main/java/x")).toBe(true);
  });
  it("caps very deep chains", () => {
    const listings: Record<string, TreeEntry[]> = {}; let path = "d0";
    for (let i = 1; i < 50; i++) { const next = `${path}/d${i}`; listings[path] = [dir(next)]; path = next; }
    expect(compactChain("d0", listings).segments).toHaveLength(32);
    expect(compactChain("d0", listings, 5).segments).toHaveLength(5);
  });
});
