import { createSignal } from 'solid-js';
import { addAttachments, createFileAttachment, createFolderAttachment, folderOutline, newAttachmentId, createPastedText, maxBytesFor, classifyFile, resolveMime, shouldChipPastedText, type Attachment, type Rejection } from '../../lib/attachments';
import { formatAssetBytes } from '../../lib/asset-preview';

export interface IntakeOptions {
  /** Current attachments, read at the moment of each intake. */
  items: () => readonly Attachment[];
  /** Receives the accepted items. The caller owns the list. */
  onAdd: (items: Attachment[]) => void;
  /** Why attaching is unavailable right now (for example browser preview). Everything is refused with this message. */
  unavailable?: () => string | undefined;
  /** Called with `loading` placeholders while file bytes are being read. They are never added through `onAdd`. */
  onPending?: (placeholders: Attachment[]) => void;
  /** Called with the placeholder ids once reading finished, just before `onAdd` receives the real items. */
  onSettled?: (ids: string[]) => void;
  /** Reads the page count of a PDF. Undefined or a failure leaves the count out rather than guessing. */
  countPages?: (bytes: Uint8Array) => Promise<number | undefined>;
  /** Inserts short dropped text into the prompt when it lands outside the prompt box. */
  insertText?: (text: string) => void;
}

export interface Intake {
  dragging: () => boolean;
  notices: () => string[];
  dismissNotices: () => void;
  onPaste: (event: ClipboardEvent) => void;
  onDragEnter: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  /** Feed files from a file input (change event) or any other source. */
  addFiles: (files: readonly File[], source: 'picked' | 'pasted' | 'dropped') => Promise<void>;
  addPastedText: (text: string) => void;
  /** Report refusals through the same accessible notice list. */
  reject: (rejections: readonly Rejection[]) => void;
  /** Add ready-made items (folder outlines, exported sessions) through the same limits and notices. */
  addItems: (items: readonly Attachment[]) => void;
}

/** The subset of the File and Directory Entries API a dropped folder needs. */
interface DroppedEntry { name: string; isFile: boolean; isDirectory: boolean }
interface DroppedDirectory extends DroppedEntry { createReader(): { readEntries(done: (entries: DroppedEntry[]) => void, fail?: (error: unknown) => void): void } }

/** Every child of a dropped directory. `readEntries` returns batches until an empty one. */
async function readDirectory(dir: DroppedDirectory): Promise<DroppedEntry[]> {
  const reader = dir.createReader();
  const all: DroppedEntry[] = [];
  for (;;) {
    const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}
/** Bounded outline of a dropped folder, built from the browser entries (no absolute path is available). */
export async function droppedFolder(dir: DroppedDirectory): Promise<Attachment> {
  const dirs = new Map<string, DroppedDirectory>([['', dir]]);
  const outline = await folderOutline(dir.name, async relative => {
    const current = dirs.get(relative);
    if (!current) return [];
    const children = await readDirectory(current);
    for (const child of children) if (child.isDirectory) dirs.set(relative ? `${relative}/${child.name}` : child.name, child as DroppedDirectory);
    return children.map(child => ({ name: child.name, isDir: child.isDirectory }));
  });
  return createFolderAttachment({ name: dir.name, ...outline, source: 'dropped' });
}

function readBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer().then(buffer => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}
const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
/** Text dragged from the editor or another app (no files). */
const hasText = (event: DragEvent) => !hasFiles(event) && Array.from(event.dataTransfer?.types ?? []).some(type => type === 'text/plain' || type === 'text/uri-list');
/** The prompt box takes short text drops itself, at the drop position. */
const onPromptBox = (event: DragEvent) => event.target instanceof HTMLTextAreaElement;
/** An in-page image dragged as a data URL (Span's own previews). Remote URLs are never fetched. */
function droppedImage(event: DragEvent): File | undefined {
  const uri = (event.dataTransfer?.getData('text/uri-list') ?? '').split(/\r?\n/).find(line => line && !line.startsWith('#')) ?? '';
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(uri.trim());
  if (!match) return undefined;
  try {
    const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
    return new File([bytes], `Dropped image.${match[1].slice(6).replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`, { type: match[1] });
  } catch { return undefined; }
}

export function createAttachmentIntake(options: IntakeOptions): Intake {
  const [dragging, setDragging] = createSignal(false);
  const [notices, setNotices] = createSignal<string[]>([]);
  let depth = 0;
  const reject = (rejections: readonly Rejection[]) => {
    if (rejections.length) setNotices(previous => [...previous, ...rejections.map(item => `${item.name}: ${item.reason}`)].slice(-6));
  };
  const refuseAll = (names: string[]): boolean => {
    const reason = options.unavailable?.();
    if (!reason) return false;
    reject(names.map(name => ({ name, reason })));
    return true;
  };
  const addFiles: Intake['addFiles'] = async (files, source) => {
    if (!files.length || refuseAll(files.map(file => file.name || 'Pasted file'))) return;
    const rejections: Rejection[] = [];
    const candidates: Attachment[] = [];
    const pending: Attachment[] = [];
    if (options.onPending) {
      for (const file of files) {
        const name = file.name || (file.type.startsWith('image/') ? `Pasted image.${file.type.slice(6).replace('jpeg', 'jpg')}` : 'Pasted file');
        const mime = resolveMime(name, file.type);
        if (file.size <= maxBytesFor(classifyFile(name, mime), mime)) pending.push({ id: newAttachmentId(), kind: classifyFile(name, mime), name, mime, size: file.size, source, status: 'loading' });
      }
      if (pending.length) options.onPending(pending);
    }
    for (const file of files) {
      const name = file.name || (file.type.startsWith('image/') ? `Pasted image.${file.type.slice(6).replace('jpeg', 'jpg')}` : 'Pasted file');
      const mime = resolveMime(name, file.type);
      const limit = maxBytesFor(classifyFile(name, mime), mime);
      // Check the declared size first so an oversized file is never read into memory.
      if (file.size > limit) { rejections.push({ name, reason: `Larger than the ${formatAssetBytes(limit)} limit (${formatAssetBytes(file.size)}).` }); continue; }
      try {
        const item = createFileAttachment({ name, mime, bytes: await readBytes(file), source });
        if (item.mime === 'application/pdf' && options.countPages && item.bytes) {
          try { const pages = await options.countPages(item.bytes); if (Number.isInteger(pages) && pages! > 0) item.pages = pages; } catch { /* no reliable count: leave it out */ }
        }
        candidates.push(item);
      }
      catch (cause) { rejections.push({ name, reason: cause instanceof Error ? cause.message : 'Could not read the file.' }); }
    }
    if (pending.length) options.onSettled?.(pending.map(item => item.id));
    const result = addAttachments(options.items(), candidates);
    if (result.accepted.length) options.onAdd(result.accepted);
    reject([...rejections, ...result.rejected]);
  };
  const addPastedText = (text: string) => {
    const item = createPastedText(text);
    if (refuseAll([item.name])) return;
    const result = addAttachments(options.items(), [item]);
    if (result.accepted.length) options.onAdd(result.accepted);
    reject(result.rejected);
  };
  const addItems = (items: readonly Attachment[]) => {
    if (!items.length || refuseAll(items.map(item => item.name))) return;
    const result = addAttachments(options.items(), items);
    if (result.accepted.length) options.onAdd(result.accepted);
    reject(result.rejected);
  };
  const addFolders = async (dirs: DroppedDirectory[]) => {
    if (!dirs.length || refuseAll(dirs.map(dir => dir.name))) return;
    const items: Attachment[] = [];
    const failed: Rejection[] = [];
    for (const dir of dirs) {
      try { items.push(await droppedFolder(dir)); } catch (cause) { failed.push({ name: dir.name, reason: cause instanceof Error ? cause.message : 'Could not read the folder.' }); }
    }
    reject(failed);
    addItems(items);
  };
  return {
    dragging, notices, reject,
    dismissNotices: () => setNotices([]),
    addFiles, addPastedText, addItems,
    onPaste(event) {
      const data = event.clipboardData;
      if (!data) return;
      const files = Array.from(data.files);
      if (files.length) { event.preventDefault(); void addFiles(files, 'pasted'); return; }
      const text = data.getData('text/plain');
      // Short text pastes into the textarea as usual; long text becomes a chip.
      if (text && shouldChipPastedText(text)) { event.preventDefault(); addPastedText(text); }
    },
    onDragEnter(event) {
      if (hasText(event)) { if (!onPromptBox(event)) event.preventDefault(); return; }
      if (!hasFiles(event)) return; event.preventDefault(); depth += 1; setDragging(true);
    },
    onDragOver(event) {
      // Text over the prompt box keeps the browser's own caret placement; elsewhere on the panel it is accepted here.
      if (hasText(event)) { if (!onPromptBox(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; } return; }
      if (!hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = options.unavailable?.() ? 'none' : 'copy';
    },
    onDragLeave(event) { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); },
    onDrop(event) {
      if (hasText(event)) {
        const image = droppedImage(event);
        if (image) { event.preventDefault(); void addFiles([image], 'dropped'); return; }
        const text = event.dataTransfer?.getData('text/plain') || event.dataTransfer?.getData('text/uri-list') || '';
        if (!text) return;
        // Long text becomes a chip, like a long paste. Short text on the prompt box is inserted there by the browser.
        if (shouldChipPastedText(text)) { event.preventDefault(); addPastedText(text); return; }
        if (onPromptBox(event)) return;
        event.preventDefault();
        options.insertText?.(text);
        return;
      }
      if (!hasFiles(event)) return;
      event.preventDefault(); depth = 0; setDragging(false);
      // Entries must be taken while the event runs. Folders become bounded outlines; files are read as before.
      const items = Array.from(event.dataTransfer?.items ?? []).filter(item => item.kind === 'file');
      const entries = items.map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null) as DroppedEntry | null);
      if (!entries.some(entry => entry?.isDirectory)) { void addFiles(Array.from(event.dataTransfer?.files ?? []), 'dropped'); return; }
      const files = items.flatMap((item, index) => { if (entries[index]?.isDirectory) return []; const file = item.getAsFile(); return file ? [file] : []; });
      void addFolders(entries.filter((entry): entry is DroppedDirectory => !!entry?.isDirectory)).then(() => addFiles(files, 'dropped'));
    },
  };
}
