// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { Show, createSignal } from 'solid-js';
import { AttachmentChips, AttachmentDropZone, AttachmentPickerButton, AttachmentViewer, MessageAttachments, createAttachmentIntake, type Intake } from './index';
import { MAX_IMAGE_BYTES } from '../../lib/asset-preview';
import { createFileAttachment, createPastedText, createSelection, createWorkspaceFile, type Attachment } from '../../lib/attachments';

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

describe('viewer', () => {
  it('shows line numbers from the selection start and truncates long text', () => {
    const selection = createSelection({ path: 'src/a.ts', text: Array.from({ length: 600 }, (_, i) => `row ${i}`).join('\n'), start: 40, end: 639 });
    const root = mount(() => <AttachmentViewer item={selection} onClose={() => undefined} />);
    const numbers = [...document.querySelectorAll('.att-line-number')].map(node => node.textContent);
    expect(numbers[0]).toBe('40'); expect(numbers).toHaveLength(500);
    expect(document.querySelector('.att-viewer-truncated')?.textContent).toBe('Preview truncated at 500 of 600 lines.');
    expect(document.querySelector('.att-viewer-text')?.getAttribute('tabindex')).toBe('0');
    expect(root).toBeTruthy();
  });
  it('previews rasters from bytes as an inert img and shows metadata for other files', () => {
    mount(() => <AttachmentViewer item={png()} onClose={() => undefined} />);
    const img = document.querySelector<HTMLImageElement>('.att-viewer-image img')!;
    expect(img.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(img.alt).toBe('shot.png');
    document.body.replaceChildren();
    const pdf = createFileAttachment({ name: 'doc.pdf', mime: 'application/pdf', bytes: new Uint8Array(2048), source: 'picked' });
    mount(() => <AttachmentViewer item={pdf} onClose={() => undefined} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.att-viewer-meta')?.textContent).toContain('application/pdf');
    expect(document.querySelector('.att-viewer-meta')?.textContent).toContain('2.0 KiB');
  });
  it('previews SVG only after sanitising it', () => {
    const svg = createFileAttachment({ name: 'a.svg', mime: 'image/svg+xml', source: 'picked', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script><rect width="4" height="4" onclick="x()"/></svg>') });
    mount(() => <AttachmentViewer item={svg} onClose={() => undefined} />);
    const src = decodeURIComponent(document.querySelector<HTMLImageElement>('.att-viewer-image img')!.src);
    expect(src).toContain('<rect'); expect(src).not.toMatch(/script|onclick|alert/);
    document.body.replaceChildren();
    const bad = { ...svg, text: '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>' };
    mount(() => <AttachmentViewer item={bad} onClose={() => undefined} />);
    expect(document.querySelector('.att-viewer-image img')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/declarations/);
  });
  it('loads path-only workspace images through the supplied loader and rejects bad data', async () => {
    const item = createWorkspaceFile('assets/logo.png', 10);
    const loadImage = vi.fn(async () => ({ mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }) as any);
    mount(() => <AttachmentViewer item={item} loadImage={loadImage} onClose={() => undefined} />);
    await settle();
    expect(loadImage).toHaveBeenCalledWith('assets/logo.png');
    expect(document.querySelector<HTMLImageElement>('.att-viewer-image img')!.src).toBe('data:image/png;base64,AAAA');
    document.body.replaceChildren();
    mount(() => <AttachmentViewer item={createWorkspaceFile('x.png', 1)} loadImage={async () => ({ mime: 'image/png', dataUrl: 'javascript:alert(1)' }) as any} onClose={() => undefined} />);
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Invalid workspace image/);
  });
  it('offers Save only for items outside the workspace and only with a handler', async () => {
    const save = vi.fn(async () => undefined);
    mount(() => <AttachmentViewer item={png()} onSaveToWorkspace={save} onClose={() => undefined} />);
    const button = [...document.querySelectorAll<HTMLButtonElement>('.att-action')].find(node => node.textContent === 'Save to workspace')!;
    button.click(); await settle();
    expect(save).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Saved to workspace');
    document.body.replaceChildren();
    mount(() => <AttachmentViewer item={createWorkspaceFile('a.ts')} onSaveToWorkspace={save} onClose={() => undefined} />);
    expect(document.body.textContent).not.toContain('Save to workspace');
    document.body.replaceChildren();
    mount(() => <AttachmentViewer item={png()} onClose={() => undefined} />);
    expect(document.body.textContent).not.toContain('Save to workspace');
  });
  it('reports a failed save instead of claiming success', async () => {
    mount(() => <AttachmentViewer item={png()} onSaveToWorkspace={async () => { throw new Error('disk full'); }} onClose={() => undefined} />);
    document.querySelector<HTMLButtonElement>('.att-action')!.click(); await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Could not save to workspace: disk full');
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
  it('runs copy path, open in editor and remove callbacks', async () => {
    const copy = vi.fn(); const openEditor = vi.fn(); const remove = vi.fn(); const close = vi.fn(); const item = createWorkspaceFile('src/a.ts', 4);
    mount(() => <AttachmentViewer item={item} onCopyPath={copy} onOpenInEditor={openEditor} onRemove={remove} onClose={close} />);
    const named = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.att-action')].find(node => node.textContent === label)!;
    named('Copy path').click(); await settle(); expect(copy).toHaveBeenCalledWith('src/a.ts');
    named('Open in editor').click(); expect(openEditor).toHaveBeenCalledWith(item);
    named('Remove').click(); expect(remove).toHaveBeenCalledWith(item); expect(close).toHaveBeenCalledOnce();
  });
  it('hides actions without handlers and disables native actions in browser preview', () => {
    mount(() => <AttachmentViewer item={createWorkspaceFile('a.ts')} onClose={() => undefined} />);
    expect(document.querySelectorAll('.att-action')).toHaveLength(0);
    document.body.replaceChildren();
    mount(() => <AttachmentViewer item={createWorkspaceFile('a.ts')} onOpenInEditor={() => undefined} nativeUnavailable="Open the desktop app." onClose={() => undefined} />);
    expect(document.querySelector<HTMLButtonElement>('.att-action')!.disabled).toBe(true);
    expect([...document.querySelectorAll('[role="note"]')].map(node => node.textContent)).toContain('Open the desktop app.');
  });
  it('explains why the agent will not receive the item', () => {
    mount(() => <AttachmentViewer item={png()} blockedReason="This agent does not accept images." onClose={() => undefined} />);
    expect(document.querySelector('.att-viewer-blocked')?.textContent).toBe('Not sent: This agent does not accept images.');
  });
  it('closes on Escape, focuses the close button and restores focus to the chip', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const close = vi.fn();
    const root = mount(() => { const [open, setOpen] = createSignal(true); return <Show when={open()}><AttachmentViewer item={png()} onClose={() => { close(); setOpen(false); }} /></Show>; });
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true'); expect(dialog.getAttribute('aria-label')).toBe('Attachment shot.png');
    expect(document.activeElement).toBe(document.querySelector('.att-viewer-close'));
    expect(document.querySelector('.att-viewer-close')!.getAttribute('aria-label')).toBe('Close attachment viewer');
    key(dialog, 'Escape'); await settle();
    expect(close).toHaveBeenCalledOnce(); expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger); expect(root).toBeTruthy();
  });
  it('traps Tab inside the dialog', async () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return document.body; } });
    try {
      mount(() => <AttachmentViewer item={createWorkspaceFile('a.ts')} onCopyPath={() => undefined} onClose={() => undefined} />);
      await settle();
      const dialog = document.querySelector('[role="dialog"]')!;
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      last.focus(); key(last, 'Tab'); expect(document.activeElement).toBe(first);
      first.focus(); dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); expect(document.activeElement).toBe(last);
    } finally { delete (HTMLElement.prototype as any).offsetParent; }
  });
});
