import { describe, expect, it } from "vitest";
import type { ToolInfo } from "../bindings";
import { javaSourceRuntimeAvailable } from "./java-runtime";
const tool = (id: string, version: string | null, available = true): ToolInfo => ({ id, version, available, name: id, program: id, path: available ? `/bin/${id}` : null, kind: "Runtime" });
describe("Java source runtime availability", () => {
  it.each(['openjdk version "21.0.13.0.2" 2026-10-22', 'java version "11.0.2" 2019-01-15', 'openjdk 25 2025-09-16'])("accepts installed JDK version %s", version => {
    expect(javaSourceRuntimeAvailable([tool("java", version), tool("javac", "javac 21.0.2")])).toBe(true);
  });
  it("hides source Run for missing, unprobed, unsupported and JRE-only runtimes", () => {
    for (const tools of [[], [tool("java", 'java version "1.8.0_402"'), tool("javac", "javac 1.8.0")], [tool("java", null), tool("javac", "javac 21")], [tool("java", "openjdk 21")], [tool("java", "openjdk 21", false), tool("javac", "javac 21")]]) expect(javaSourceRuntimeAvailable(tools)).toBe(false);
  });
});
