// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { EditorView } from "@codemirror/view";

const saveAttachment = vi.fn(async (directory: string, fileName: string) => ({ path: `${directory}/${fileName}`, size: 4, renamed: false }));
const listDirectory = vi.fn(async () => [{ name: "image.png" }]);
vi.mock("../lib/client", () => ({ api: { saveAttachment, listDirectory } }));

import Editor from "./Editor";

const dispose: (() => void)[] = [];
beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { dispose.splice(0).forEach((close) => close()); document.body.replaceChildren(); });

it("saves a pasted Markdown image through saveAttachment next to the file and links the written name", async () => {
  const parent = document.createElement("div");
  document.body.append(parent);
  dispose.push(render(() => <Editor buffer={{ path: "docs/notes.md", text: "", revision: 0, savedRevision: 0, language: "markdown" }} onEdit={() => {}} onSave={() => {}} />, parent));
  await vi.waitFor(() => expect(parent.querySelector(".cm-editor")).not.toBeNull());
  const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
  await vi.waitFor(() => expect(view.state.languageDataAt("autocomplete", 0).length).toBeGreaterThan(0));

  const event = new Event("paste", { bubbles: true, cancelable: true });
  const image = new File([new Uint8Array([1, 2, 3, 4])], "clip.png", { type: "image/png" });
  Object.defineProperty(event, "clipboardData", { value: { files: [image], getData: () => "", types: ["Files"] } });
  view.contentDOM.dispatchEvent(event);

  await vi.waitFor(() => expect(view.state.doc.toString()).toBe("![](image_1.png)"));
  expect(event.defaultPrevented).toBe(true);
  expect(listDirectory).toHaveBeenCalledWith("docs");
  // The existing image.png is never targeted; the command itself also refuses to overwrite.
  expect(saveAttachment).toHaveBeenCalledWith("docs", "image_1.png", btoa(String.fromCharCode(1, 2, 3, 4)));
});
