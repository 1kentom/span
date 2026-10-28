// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { AttachmentChips, AttachmentDropZone, AttachmentPickerButton, MessageAttachments, createAttachmentIntake, type Intake } from './index';
import { MAX_IMAGE_BYTES } from '../../lib/asset-preview';
import { createFileAttachment, createPastedText, type Attachment } from '../../lib/attachments';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const key = (element: Element, value: string) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
const png = (fill = 1) => createFileAttachment({ name: 'shot.png', mime: 'image/png', bytes: new Uint8Array(12).fill(fill), source: 'picked' });
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

function Harness(props: { unavailable?: string; capture?: (intake: Intake, items: () => Attachment[]) => void }) {
  const [items, setItems] = createSignal<Attachment[]>([]);
  const intake = createAttachmentIntake({ items, onAdd: added => setItems(previous => [...previous, ...added]), unavailable: () => props.unavailable });
  props.capture?.(intake, items);
  return <AttachmentDropZone intake={intake} unavailable={props.unavailable}>
    <textarea aria-label="Prompt" onPaste={intake.onPaste} />
    <AttachmentPickerButton intake={intake} unavailable={props.unavailable} />
    <span data-testid="count">{items().length}</span>
    <AttachmentChips items={items()} onOpen={() => undefined} onRemove={item => setItems(previous => previous.filter(other => other.id !== item.id))} />
  </AttachmentDropZone>;
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

describe('drop zone and picker', () => {
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
  it('is honestly unavailable in browser preview: disabled picker, refused drop and paste', async () => {
    const reason = 'Attachments need the desktop app.';
    const root = mount(() => <Harness unavailable={reason} />);
    const picker = root.querySelector<HTMLButtonElement>('.att-picker')!;
    expect(picker.disabled).toBe(true);
    expect(picker.getAttribute('aria-label')).toContain(reason);
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

describe('chips', () => {
  it('opens on click, removes with the keyboard and moves focus to the next chip', async () => {
    const open = vi.fn(); const items = [png(1), png(2), png(3)];
    const root = mount(() => { const [list, setList] = createSignal<Attachment[]>(items); return <AttachmentChips items={list()} onOpen={open} onRemove={item => setList(previous => previous.filter(other => other.id !== item.id))} />; });
    const opens = () => root.querySelectorAll<HTMLButtonElement>('.att-chip-open');
    opens()[1].click(); expect(open).toHaveBeenCalledWith(items[1]);
    opens()[1].focus(); key(opens()[1], 'Delete'); await settle();
    expect(opens()).toHaveLength(2); expect(document.activeElement).toBe(opens()[1]);
    key(opens()[1], 'Backspace'); await settle();
    expect(opens()).toHaveLength(1); expect(document.activeElement).toBe(opens()[0]);
  });
  it('calls onEmpty after the last chip is removed and names every control', async () => {
    const empty = vi.fn();
    const root = mount(() => { const [list, setList] = createSignal<Attachment[]>([createPastedText('a\n'.repeat(20))]); return <AttachmentChips items={list()} onOpen={() => undefined} onRemove={() => setList([])} onEmpty={empty} />; });
    expect(root.querySelector('ul')?.getAttribute('aria-label')).toBe('Attachments, 1');
    const remove = root.querySelector<HTMLButtonElement>('.att-chip-remove')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove Pasted text, 21 lines');
    expect(root.querySelector('.att-chip-open')!.getAttribute('aria-label')).toMatch(/^Pasted text, 21 lines, Pasted text, .*Open preview$/);
    remove.click(); await settle();
    expect(empty).toHaveBeenCalledOnce();
  });
  it('disables chips with a reason when the agent lacks the capability, and keeps them removable', () => {
    const root = mount(() => <AttachmentChips items={[png(), createPastedText('x\n'.repeat(20))]} capabilities={{ image: false, audio: false, embeddedContext: false }} onOpen={() => undefined} onRemove={() => undefined} />);
    const chips = root.querySelectorAll('.att-chip');
    expect(chips[0].classList.contains('att-chip-disabled')).toBe(true);
    expect(chips[0].getAttribute('title')).toBe('This agent does not accept images.');
    expect(chips[0].querySelector('.att-chip-open')!.getAttribute('aria-label')).toContain('unavailable, This agent does not accept images.');
    expect(chips[1].classList.contains('att-chip-disabled')).toBe(false);
    expect(chips[0].querySelector('.att-chip-remove')).not.toBeNull();
  });
  it('renders read-only message chips that open the viewer and cannot be removed', () => {
    const open = vi.fn(); const item = textFile();
    const root = mount(() => <MessageAttachments items={[item]} onOpen={open} />);
    expect(root.querySelector('.att-chip-remove')).toBeNull();
    root.querySelector<HTMLButtonElement>('.att-chip-open')!.click();
    expect(open).toHaveBeenCalledWith(item);
  });
});
