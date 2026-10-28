import { describe, expect, it } from "vitest";
import { classifyLocation, isUriPath, libraryOrigin } from "./lsp-navigation";

import { REPORTED_JDT_URI } from "./lsp-location.testkit";

describe("classifyLocation", () => {
  it("opens a workspace path as a workspace file", () => {
    expect(classifyLocation({ path: "src/Main.java", external: false }, "/w")).toEqual({ kind: "workspace", path: "src/Main.java" });
  });
  it("turns an absolute path inside the workspace into a relative one", () => {
    expect(classifyLocation({ path: "/w/src/Main.java", external: false }, "/w")).toEqual({ kind: "workspace", path: "src/Main.java" });
    expect(classifyLocation({ path: "C:\\w\\src\\Main.java", external: false }, "C:\\w")).toEqual({ kind: "workspace", path: "src/Main.java" });
  });
  it("opens an external file path in the library viewer", () => {
    expect(classifyLocation({ path: "/usr/lib/node_modules/typescript/lib/lib.d.ts", external: true }, "/w").kind).toBe("library");
    expect(classifyLocation({ path: "node_modules/@types/node/index.d.ts", external: true }, "/w").kind).toBe("library");
  });
  it("opens the exact jdt URI of the bug report in the library viewer, even when it is not marked external", () => {
    expect(classifyLocation({ path: REPORTED_JDT_URI, external: true }, "/Users/user/projects/Java Projects/todo").kind).toBe("library");
    expect(classifyLocation({ path: REPORTED_JDT_URI, external: false }, "/Users/user/projects/Java Projects/todo").kind).toBe("library");
  });
  it("treats other URIs as library source", () => {
    for (const path of ["jar:file:///x.jar!/A.class", "file:///usr/share/typeshed/stdlib/os.pyi", "jrt:/java.base/java/lang/String.class"]) {
      expect(classifyLocation({ path, external: false }, "/w").kind, path).toBe("library");
    }
  });
  it("treats Windows absolute paths outside the workspace as library source, not as URIs", () => {
    expect(isUriPath("C:\\Users\\x\\lib\\Foo.java")).toBe(false);
    expect(classifyLocation({ path: "C:\\Users\\x\\lib\\Foo.java", external: false }, "C:\\work\\proj").kind).toBe("library");
    expect(classifyLocation({ path: "\\\\?\\C:\\Users\\x\\lib\\Foo.java", external: false }, "C:\\work\\proj").kind).toBe("library");
    expect(classifyLocation({ path: "\\\\server\\share\\Foo.java", external: false }, "C:\\work\\proj").kind).toBe("library");
  });
  it("treats a relative path that climbs out of the workspace as library source", () => {
    expect(classifyLocation({ path: "../other/Foo.java", external: false }, "/w").kind).toBe("library");
    expect(classifyLocation({ path: "src/../../Foo.java", external: false }, "/w").kind).toBe("library");
  });
  it("treats a NUL byte as library source rather than a file", () => {
    expect(classifyLocation({ path: "a\0b.ts", external: false }, "/w").kind).toBe("library");
  });
});

describe("libraryOrigin", () => {
  it("names the jar of a Maven class file URI", () => {
    expect(libraryOrigin(REPORTED_JDT_URI)).toBe("javafx-fxml-21.0.2-mac-aarch64.jar");
  });
  it("has nothing for a JDK class or a plain path", () => {
    expect(libraryOrigin("jdt://contents/java.base/java.lang/String.class?=p")).toBeUndefined();
    expect(libraryOrigin("/usr/lib/x.jar")).toBeUndefined();
  });
});
