// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { For, Show, createSignal } from 'solid-js';
import { AttachmentNotices, MessageAttachments, createAttachmentIntake, type Intake } from './index';
import { MAX_IMAGE_BYTES } from '../../lib/asset-preview';
import { createFileAttachment, type Attachment } from '../../lib/attachments';

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
  it('ignores drags that carry no files', () => {
    const root = mount(() => <Harness />);
    const zone = root.querySelector('.att-dropzone')!;
    const e = event('dragenter', { dataTransfer: transfer([], ['text/plain']) });
    zone.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false); expect(zone.classList.contains('att-dragging')).toBe(false);
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
