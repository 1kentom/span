// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { For, Show, createSignal } from 'solid-js';
import { AttachmentNotices, MessageAttachments, createAttachmentIntake, type Intake } from './index';
import { MAX_IMAGE_BYTES } from '../../lib/asset-preview';
import { createFileAttachment, planAttachment, type Attachment } from '../../lib/attachments';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const textFile = () => createFileAttachment({ name: 'a.ts', mime: '', bytes: new TextEncoder().encode('one\ntwo\nthree'), source: 'dropped' });
function event(type: string, extra: Record<string, unknown>) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(extra)) Object.defineProperty(e, name, { value });
  return e;
}
const paste = (target: Element, data: { files?: File[]; text?: string }) => {
  const e = event('paste', { clipboardData: { files: data.files ?? [], getData: (type: string) => type === 'text/plain' ? data.text ?? '' : '' } });
  target.dispatchEvent(e); return e;
};
const transfer = (files: File[] = [], types = ['Files']) => ({ files, types, dropEffect: 'none' });

/** The intake wired the way the agent composer wires it: drag handlers on a wrapper, paste on the prompt, a file input and the notices. */
function Harness(props: { unavailable?: string; capture?: (intake: Intake, items: () => Attachment[]) => void }) {
  const [items, setItems] = createSignal<Attachment[]>([]);
  const intake = createAttachmentIntake({ items, onAdd: added => setItems(previous => [...previous, ...added]), unavailable: () => props.unavailable });
  props.capture?.(intake, items);
  return <div class="att-dropzone" classList={{ 'att-dragging': intake.dragging() }} onDragEnter={intake.onDragEnter} onDragOver={intake.onDragOver} onDragLeave={intake.onDragLeave} onDrop={intake.onDrop}>
    <textarea aria-label="Prompt" onPaste={intake.onPaste} />
    <input type="file" multiple onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void intake.addFiles(files, 'picked'); }} />
    <span data-testid="count">{items().length}</span>
    <ul><For each={items()}>{item => <li class="att-chip"><span class="att-chip-name">{item.name}</span></li>}</For></ul>
    <Show when={intake.dragging()}><div class="att-drop-overlay">{props.unavailable ?? 'Drop files to attach'}</div></Show>
    <AttachmentNotices intake={intake} />
  </div>;
}

describe('paste intake', () => {
  it('turns a clipboard image into a chip and stops the default paste', async () => {
    const root = mount(() => <Harness />);
    const e = paste(root.querySelector('textarea')!, { files: [new File([new Uint8Array(20).fill(5)], 'image.png', { type: 'image/png' })] });
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(root.querySelectorAll('.att-chip')).toHaveLength(1);
    expect(root.querySelector('.att-chip-name')?.textContent).toBe('image.png');
  });
  it('chips long pasted text with its line count and leaves short text alone', async () => {
    const root = mount(() => <Harness />);
    const area = root.querySelector('textarea')!;
    expect(paste(area, { text: 'just a sentence' }).defaultPrevented).toBe(false);
    expect(root.querySelectorAll('.att-chip')).toHaveLength(0);
    const long = paste(area, { text: 'line\n'.repeat(30) });
    expect(long.defaultPrevented).toBe(true);
    expect(root.querySelector('.att-chip-name')?.textContent).toBe('Pasted text, 31 lines');
  });
  it('refuses a duplicate paste with a visible alert', async () => {
    const root = mount(() => <Harness />);
    const area = root.querySelector('textarea')!;
    paste(area, { text: 'line\n'.repeat(30) }); paste(area, { text: 'line\n'.repeat(30) });
    expect(root.querySelectorAll('.att-chip')).toHaveLength(1);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Already attached.');
  });
});

describe('drop and file input intake', () => {
  it('shows a drop state while files are dragged over and clears it on leave', () => {
    const root = mount(() => <Harness />);
    const zone = root.querySelector('.att-dropzone')!;
    zone.dispatchEvent(event('dragenter', { dataTransfer: transfer() }));
    expect(zone.classList.contains('att-dragging')).toBe(true);
    expect(root.querySelector('.att-drop-overlay')?.textContent).toBe('Drop files to attach');
    zone.dispatchEvent(event('dragleave', { dataTransfer: transfer() }));
    expect(root.querySelector('.att-drop-overlay')).toBeNull();
  });
  it('never shows the file overlay for text drags and leaves the prompt box its own text drop', () => {
    const root = mount(() => <Harness />);
    const zone = root.querySelector('.att-dropzone')!;
    const e = event('dragenter', { dataTransfer: transfer([], ['text/plain']) });
    zone.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true); expect(zone.classList.contains('att-dragging')).toBe(false);
    const onPrompt = event('dragover', { dataTransfer: transfer([], ['text/plain']) });
    root.querySelector('textarea')!.dispatchEvent(onPrompt);
    expect(onPrompt.defaultPrevented).toBe(false);
    const none = event('dragenter', { dataTransfer: transfer([], ['text/html']) });
    zone.dispatchEvent(none);
    expect(none.defaultPrevented).toBe(false);
  });
  it('adds dropped files and reports oversized ones without reading them', async () => {
    const root = mount(() => <Harness />);
    const zone = root.querySelector('.att-dropzone')!;
    const big = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: MAX_IMAGE_BYTES + 1 });
    const read = vi.spyOn(big, 'arrayBuffer');
    zone.dispatchEvent(event('drop', { dataTransfer: transfer([new File(['hello'], 'a.txt', { type: 'text/plain' }), big]) }));
    await settle();
    expect([...root.querySelectorAll('.att-chip-name')].map(node => node.textContent)).toEqual(['a.txt']);
    expect(read).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')?.textContent).toMatch(/huge\.png: Larger than the 8\.0 MiB limit/);
    expect(zone.classList.contains('att-dragging')).toBe(false);
  });
  it('attaches a dropped or picked binary file as bytes, never as text, even under a text name', async () => {
    let items: () => Attachment[] = () => [];
    const root = mount(() => <Harness capture={(_, list) => { items = list; }} />);
    const zone = root.querySelector('.att-dropzone')!;
    // Valid UTF-8 with NUL bytes and invalid UTF-8, both named like text, plus a plain binary.
    const nul = new File([new Uint8Array([0x68, 0x69, 0x00, 0x01, 0x02])], 'notes.txt', { type: 'text/plain' });
    const invalid = new File([new Uint8Array([0x61, 0xff, 0xfe])], 'build.log', { type: '' });
    zone.dispatchEvent(event('drop', { dataTransfer: transfer([nul, invalid]) }));
    await settle();
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00])], 'tool.bin')], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(items().map(item => item.name)).toEqual(['notes.txt', 'build.log', 'tool.bin']);
    for (const item of items()) {
      expect(item.text).toBeUndefined();
      expect(item.bytes).toBeInstanceOf(Uint8Array);
      expect(planAttachment(item, { image: true, audio: true, embeddedContext: true })).toEqual({ mode: 'resource' });
      expect(planAttachment(item, { image: true, audio: true, embeddedContext: false }).mode).not.toBe('text');
    }
    expect([...items()[0].bytes!]).toEqual([0x68, 0x69, 0x00, 0x01, 0x02]);
  });
  it('dismisses notices', async () => {
    const root = mount(() => <Harness />);
    root.querySelector('.att-dropzone')!.dispatchEvent(event('drop', { dataTransfer: transfer([new File([], 'empty.txt')]) }));
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('The file is empty.');
    root.querySelector<HTMLButtonElement>('[aria-label="Dismiss attachment messages"]')!.click();
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });
  it('adds files chosen through the file input', async () => {
    const root = mount(() => <Harness />);
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { value: [new File(['abc'], 'b.txt', { type: 'text/plain' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(root.querySelector('.att-chip-name')?.textContent).toBe('b.txt');
  });
  it('is honestly unavailable in browser preview: refused drop and paste', async () => {
    const reason = 'Attachments need the desktop app.';
    const root = mount(() => <Harness unavailable={reason} />);
    const zone = root.querySelector('.att-dropzone')!;
    zone.dispatchEvent(event('dragenter', { dataTransfer: transfer() }));
    expect(root.querySelector('.att-drop-overlay')?.textContent).toBe(reason);
    zone.dispatchEvent(event('drop', { dataTransfer: transfer([new File(['x'], 'a.txt')]) }));
    paste(root.querySelector('textarea')!, { text: 'line\n'.repeat(30) });
    await settle();
    expect(root.querySelectorAll('.att-chip')).toHaveLength(0);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(reason);
  });
});

describe('message chips', () => {
  it('renders read-only message chips that open the viewer and cannot be removed', () => {
    const open = vi.fn(); const item = textFile();
    const root = mount(() => <MessageAttachments items={[item]} onOpen={open} />);
    expect(root.querySelector('.att-chip-remove')).toBeNull();
    root.querySelector<HTMLButtonElement>('.att-chip-open')!.click();
    expect(open).toHaveBeenCalledWith(item);
  });
});

describe('pdf page count and dropped folders (#91)', () => {
  function intakeWith(countPages?: (bytes: Uint8Array) => Promise<number | undefined>) {
    const [items, setItems] = createSignal<Attachment[]>([]);
    const intake = createAttachmentIntake({ items, onAdd: added => setItems(previous => [...previous, ...added]), countPages });
    return { intake, items };
  }
  const pdfFile = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'spec.pdf', { type: 'application/pdf' });
  it('records the page count when it can be read and leaves it out when it cannot', async () => {
    const counted = intakeWith(async () => 8);
    await counted.intake.addFiles([pdfFile()], 'picked');
    expect(counted.items()[0].pages).toBe(8);
    const failed = intakeWith(async () => { throw new Error('locked'); });
    await failed.intake.addFiles([pdfFile()], 'picked');
    expect(failed.items()[0].pages).toBeUndefined();
    const none = intakeWith();
    await none.intake.addFiles([pdfFile()], 'picked');
    expect(none.items()[0].pages).toBeUndefined();
  });
  it('turns a dropped folder into a bounded outline with its file count, skipping dependency folders', async () => {
    const dir = (name: string, children: object[]) => ({ name, isFile: false, isDirectory: true, createReader: () => { let done = false; return { readEntries: (ok: (entries: object[]) => void) => { ok(done ? [] : children); done = true; } }; } });
    const file = (name: string) => ({ name, isFile: true, isDirectory: false });
    const dropped = dir('styles', [file('a.css'), file('b.css'), dir('node_modules', [file('x.js')]), dir('themes', [file('dark.css')])]);
    const loose = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const { intake, items } = intakeWith();
    const items$ = [
      { kind: 'file', webkitGetAsEntry: () => dropped, getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => file('note.txt'), getAsFile: () => loose },
    ];
    intake.onDrop(event('drop', { dataTransfer: { ...transfer([loose]), items: items$ } }) as DragEvent);
    await settle(); await settle();
    const [folder, note] = items();
    expect(folder).toMatchObject({ kind: 'folder', name: 'styles', source: 'dropped', folder: { files: 3, truncated: false } });
    expect(folder.text).toContain('themes/dark.css');
    expect(folder.text).not.toContain('node_modules');
    expect(note.name).toBe('note.txt');
  });
});
