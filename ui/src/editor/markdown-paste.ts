import { EditorSelection, Facet, type EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { inCode, isMarkdown } from "./markdown-context";

/** True when `text` is one http(s) URL and nothing else. */
export function isSingleUrl(text: string): boolean {
  const value = text.trim();
  if (!/^https?:\/\/[^\s<>]+$/i.test(value)) return false;
  try { new URL(value); return true; } catch { return false; }
}

/**
 * Pasting a URL over selected text makes `[selection](url)` (VS Code `pasteUrlAsFormattedLink`
 * smartWithSelection): only for a single http(s) URL, non-empty single-line selections outside code, and
 * selections that are not URLs themselves. One transaction, so one undo step.
 */
export function urlPasteSpec(state: EditorState, text: string): TransactionSpec | null {
  if (!isMarkdown(state) || !isSingleUrl(text)) return null;
  const url = text.trim();
  for (const range of state.selection.ranges) {
    const selected = state.sliceDoc(range.from, range.to);
    if (range.empty || selected.includes("\n") || isSingleUrl(selected) || inCode(state, range.from, true) || inCode(state, range.to, true)) return null;
  }
  return {
    ...state.changeByRange((range) => {
      const insert = `[${state.sliceDoc(range.from, range.to)}](${url})`;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
    }),
    userEvent: "input.paste",
    scrollIntoView: true,
  };
}

/** Where pasted or dropped images are saved, relative to the Markdown file's folder. Empty means next to the file. */
export const MARKDOWN_IMAGE_FOLDER = "";

/** Workspace file access for pasted images. `documentPath` is workspace relative with forward slashes. */
export interface MarkdownFilePort {
  documentPath: string;
  /** Writes a new file without overwriting; resolves to the workspace relative path that was written. */
  save(directory: string, fileName: string, base64: string): Promise<{ path: string }>;
  /** Names in a workspace relative folder; an empty list when it does not exist. */
  list(directory: string): Promise<string[]>;
}

export const markdownFiles = Facet.define<MarkdownFilePort | null, MarkdownFilePort | null>({ combine: (values) => values.find(Boolean) ?? null });

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp", "image/avif": "avif" };

/** `image.png`, then `image_1.png`, `image_2.png`... skipping names already in the folder. */
export function imageFileName(existing: Iterable<string>, extension = "png"): string {
  const taken = new Set([...existing].map((name) => name.toLowerCase()));
  for (let index = 0; ; index++) {
    const name = index ? `image_${index}.${extension}` : `image.${extension}`;
    if (!taken.has(name)) return name;
  }
}

/** The workspace relative folder that receives images for `documentPath`. */
export function imageDirectory(documentPath: string, folder = MARKDOWN_IMAGE_FOLDER): string {
  const parent = documentPath.includes("/") ? documentPath.slice(0, documentPath.lastIndexOf("/")) : "";
  return [parent, folder].filter(Boolean).join("/");
}

/** `target` relative to the folder of `documentPath`, encoded for a Markdown link. */
export function relativeLink(documentPath: string, target: string): string {
  const from = documentPath.split("/").slice(0, -1);
  const to = target.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  const parts = [...from.slice(shared).map(() => ".."), ...to.slice(shared)];
  return parts.map((part) => part.replace(/%/g, "%25").replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
}

/** Inserts `![](link)` at the main selection with the caret in the alt text. */
export function imageInsertSpec(state: EditorState, link: string): TransactionSpec {
  const { from, to } = state.selection.main;
  return { changes: { from, to, insert: `![](${link})` }, selection: EditorSelection.cursor(from + 2), userEvent: "input.paste", scrollIntoView: true };
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** Saves an image next to the document through the file port and inserts a relative image link. */
export async function insertImage(view: EditorView, image: Blob): Promise<boolean> {
  const port = view.state.facet(markdownFiles);
  if (!port || view.state.readOnly) return false;
  const directory = imageDirectory(port.documentPath);
  const existing = await port.list(directory).catch(() => [] as string[]);
  const saved = await port.save(directory, imageFileName(existing, IMAGE_EXTENSIONS[image.type] ?? "png"), await base64(image));
  view.dispatch(view.state.update(imageInsertSpec(view.state, relativeLink(port.documentPath, saved.path))));
  return true;
}

function imageFrom(data: DataTransfer | null): File | undefined {
  return data ? [...data.files].find((file) => file.type.startsWith("image/")) : undefined;
}

/** Paste handling for Markdown: URL over selection becomes a link, an image is saved and linked. */
export const markdownPasteHandlers = EditorView.domEventHandlers({
  paste(event, view) {
    if (!isMarkdown(view.state) || view.state.readOnly) return false;
    const image = imageFrom(event.clipboardData);
    if (image && view.state.facet(markdownFiles)) {
      event.preventDefault();
      void insertImage(view, image).catch((error) => console.warn("Could not save the pasted image.", error));
      return true;
    }
    const spec = urlPasteSpec(view.state, event.clipboardData?.getData("text/plain") ?? "");
    if (!spec) return false;
    event.preventDefault();
    view.dispatch(view.state.update(spec));
    return true;
  },
  drop(event, view) {
    if (!isMarkdown(view.state) || view.state.readOnly) return false;
    const image = imageFrom(event.dataTransfer);
    if (!image || !view.state.facet(markdownFiles)) return false;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== null) view.dispatch({ selection: { anchor: pos } });
    void insertImage(view, image).catch((error) => console.warn("Could not save the dropped image.", error));
    return true;
  },
});
