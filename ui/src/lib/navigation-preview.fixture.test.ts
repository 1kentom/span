// Fixture test of the preview-only navigation port itself (labelled fixture, not a language server).
import { describe, expect, it } from "vitest";
import { createPreviewNavigationPort, previewNavigationFiles } from "./navigation-preview";

const files = () => Object.fromEntries(Object.entries(previewNavigationFiles).map(([path, text]) => [path, { text, revision: 3 }]));
const port = createPreviewNavigationPort(files);
const shapes = "src/navigation-sample/shapes.ts"; const main = "src/navigation-sample/main.ts";

describe("preview navigation port", () => {
  it("resolves a definition, references, implementations and document symbols", async () => {
    const definition = await port.definition(main, { line: 6, character: 33 }, null);
    expect(definition.data[0]).toMatchObject({ path: shapes, external: false });
    const references = await port.references(main, { line: 6, character: 33 }, true, null);
    expect(references.data.length).toBeGreaterThan(4);
    expect(references.revision).toBe(3);
    const implementations = await port.implementation(main, { line: 6, character: 33 }, null);
    expect(implementations.data.length).toBe(2);
    const symbols = await port.documentSymbols(shapes, null);
    expect(symbols.data.map(item => item.name)).toEqual(["Shape", "Circle", "Square"]);
    expect(symbols.data[1].children.map(item => item.name)).toEqual(["name", "constructor", "area"]);
  });
  it("marks library definitions external and serves their source read only", async () => {
    const located = await port.definition(main, { line: 15, character: 32 }, null);
    expect(located.data[0]).toMatchObject({ external: true });
    const source = await port.readSource(located.data[0], 1);
    expect(source).toMatchObject({ external: true, readOnly: true });
  });
  it("builds call and type hierarchies with token round trips", async () => {
    const [item] = (await port.callPrepare(main, { line: 6, character: 19 }, null)).data;
    const incoming = await port.callIncoming(item, null);
    expect(incoming.data.map(call => call.from.name)).toEqual(["report"]);
    const [type] = (await port.typePrepare(shapes, { line: 5, character: 15 }, null)).data;
    expect((await port.typeSupertypes(type, null)).data.map(next => next.name)).toEqual(["Shape"]);
  });
  it("renames every occurrence and rejects invalid identifiers", async () => {
    const edit = (await port.rename(main, { line: 6, character: 19 }, "summarize", null)).data;
    expect(edit.files.flatMap(file => file.edits)).toHaveLength(2);
    await expect(port.rename(main, { line: 6, character: 19 }, "no good", null)).rejects.toMatchObject({ kind: "other" });
  });
});
