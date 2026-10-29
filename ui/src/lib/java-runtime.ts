import type { ToolInfo } from "../bindings";

/** Source-file launch requires a JDK, and Java 8's 1.8 version is below the floor. */
export function javaSourceRuntimeAvailable(tools: readonly ToolInfo[]): boolean {
  const runtime = tools.find(tool => tool.id === "java");
  const compiler = tools.find(tool => tool.id === "javac");
  const version = /(?:version\s+"?|openjdk\s+|java\s+)(\d+)(?:\.(\d+))?/i.exec(runtime?.version ?? "");
  const major = version?.[1] === "1" ? Number(version[2]) : Number(version?.[1]);
  return Boolean(runtime?.available && compiler?.available && compiler.version && Number.isFinite(major) && major >= 11);
}
