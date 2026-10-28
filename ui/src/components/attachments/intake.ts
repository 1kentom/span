import { createSignal } from 'solid-js';
import { addAttachments, createFileAttachment, createPastedText, maxBytesFor, classifyFile, resolveMime, shouldChipPastedText, type Attachment, type Rejection } from '../../lib/attachments';
import { formatAssetBytes } from '../../lib/asset-preview';

export interface IntakeOptions {
  /** Current attachments, read at the moment of each intake. */
  items: () => readonly Attachment[];
  /** Receives the accepted items. The caller owns the list. */
  onAdd: (items: Attachment[]) => void;
  /** Why attaching is unavailable right now (for example browser preview). Everything is refused with this message. */
  unavailable?: () => string | undefined;
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
    for (const file of files) {
      const name = file.name || (file.type.startsWith('image/') ? `Pasted image.${file.type.slice(6).replace('jpeg', 'jpg')}` : 'Pasted file');
      const mime = resolveMime(name, file.type);
      const limit = maxBytesFor(classifyFile(name, mime), mime);
      // Check the declared size first so an oversized file is never read into memory.
      if (file.size > limit) { rejections.push({ name, reason: `Larger than the ${formatAssetBytes(limit)} limit (${formatAssetBytes(file.size)}).` }); continue; }
      try { candidates.push(createFileAttachment({ name, mime, bytes: await readBytes(file), source })); }
      catch (cause) { rejections.push({ name, reason: cause instanceof Error ? cause.message : 'Could not read the file.' }); }
    }
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
  return {
    dragging, notices, reject,
    dismissNotices: () => setNotices([]),
    addFiles, addPastedText,
    onPaste(event) {
      const data = event.clipboardData;
      if (!data) return;
      const files = Array.from(data.files);
      if (files.length) { event.preventDefault(); void addFiles(files, 'pasted'); return; }
      const text = data.getData('text/plain');
      // Short text pastes into the textarea as usual; long text becomes a chip.
      if (text && shouldChipPastedText(text)) { event.preventDefault(); addPastedText(text); }
    },
    onDragEnter(event) { if (!hasFiles(event)) return; event.preventDefault(); depth += 1; setDragging(true); },
    onDragOver(event) { if (!hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = options.unavailable?.() ? 'none' : 'copy'; },
    onDragLeave(event) { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); },
    onDrop(event) {
      if (!hasFiles(event)) return;
      event.preventDefault(); depth = 0; setDragging(false);
      void addFiles(Array.from(event.dataTransfer?.files ?? []), 'dropped');
    },
  };
}
