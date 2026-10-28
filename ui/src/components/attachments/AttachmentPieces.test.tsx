// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { AttachMenu, DropOverlay, AttachmentTray, attachMenuNote, linkReason } from './index';
import { MAX_FILE_BYTES, createFileAttachment, createFolderAttachment, createPastedText, createWorkspaceFile, type PromptCapabilities } from '../../lib/attachments';
import { formatAssetBytes } from '../../lib/asset-preview';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const press = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const all: PromptCapabilities = { image: true, audio: true, embeddedContext: true };
const noImage: PromptCapabilities = { image: false, audio: false, embeddedContext: true };
const items = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];

describe('AttachMenu', () => {
  it('shows only items that have a handler, in order', () => {
    const root = mount(() => <AttachMenu agentName="Claude" handlers={{ upload: () => {}, folder: () => {}, selection: () => {} }} onClose={() => {}} />);
    expect(items(root).map(i => i.textContent)).toEqual(['Upload files', 'Selection', 'Folder']);
  });
  it('disables image items with the reason and does not run their handler', () => {
    const image = vi.fn(); const onClose = vi.fn();
    const root = mount(() => <AttachMenu agentName="Codex" capabilities={noImage} handlers={{ image, screenshot: image, upload: () => {} }} onClose={onClose} />);
    const [upload, add] = [items(root)[0], items(root)[1]];
    expect(upload.textContent).toBe('Upload files');
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.getAttribute('aria-label')).toContain('Codex does not accept images.');
    add.click();
    expect(image).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
  it('honours a caller supplied reason and runs a handler then closes', () => {
    const file = vi.fn(); const onClose = vi.fn();
    const root = mount(() => <AttachMenu agentName="A" handlers={{ file, selection: file }} disabledReasons={{ selection: 'Nothing is selected.' }} onClose={onClose} />);
    items(root)[1].click(); expect(file).not.toHaveBeenCalled();
    items(root)[0].click(); expect(file).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('derives the footer note from capabilities and the real size constant', () => {
    const limit = formatAssetBytes(MAX_FILE_BYTES);
    expect(attachMenuNote('Claude', { image: true, audio: false, embeddedContext: true })).toBe(`Claude reads images and file contents. Other types are sent as links. Up to ${limit} per file`);
    expect(attachMenuNote('Claude', all)).toContain('images, file contents and audio');
    expect(attachMenuNote('Zed', { image: false, audio: false, embeddedContext: false })).toContain('Zed takes links only.');
  });
  it('navigates with arrows, wraps, skips nothing but focuses, and closes on Escape', () => {
    const onClose = vi.fn();
    const root = mount(() => <AttachMenu agentName="A" handlers={{ upload: () => {}, file: () => {}, folder: () => {} }} onClose={onClose} />);
    const [a, b, c] = items(root);
    expect(document.activeElement).toBe(a);
    press(a, 'ArrowDown'); expect(document.activeElement).toBe(b);
    press(b, 'ArrowUp'); press(a, 'ArrowUp'); expect(document.activeElement).toBe(c);
    press(c, 'Home'); expect(document.activeElement).toBe(a);
    press(a, 'End'); expect(document.activeElement).toBe(c);
    press(c, 'Escape'); expect(onClose).toHaveBeenCalledOnce();
  });
  it('returns focus to the opener when it unmounts', async () => {
    const opener = document.createElement('button'); document.body.append(opener);
    const [open, setOpen] = createSignal(true);
    mount(() => <>{open() && <AttachMenu agentName="A" handlers={{ upload: () => {} }} returnFocus={() => opener} onClose={() => setOpen(false)} />}</>);
    setOpen(false); await flush();
    expect(document.activeElement).toBe(opener);
  });
  it('closes on an outside pointer press', () => {
    const onClose = vi.fn();
    mount(() => <AttachMenu agentName="A" handlers={{ upload: () => {} }} onClose={onClose} />);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('DropOverlay', () => {
  it('renders nothing until visible', () => {
    const [visible, setVisible] = createSignal(false);
    const root = mount(() => <DropOverlay visible={visible()} capabilities={all} />);
    expect(root.querySelector('.att-drop')).toBeNull();
    setVisible(true);
    expect(root.querySelector('[role=status]')?.textContent).toContain('Drop to attach');
  });
  it('ticks supported types and marks the rest as links', () => {
    const root = mount(() => <DropOverlay visible capabilities={noImage} />);
    const chips = [...root.querySelectorAll('.att-drop-chip')].map(c => [c.textContent?.trim(), c.classList.contains('att-drop-chip-link')]);
    expect(chips).toEqual([['Images · as link', true], ['Text and code', false], ['PDF', false], ['Audio · as link', true]]);
    expect(root.querySelectorAll('.att-drop-tick')).toHaveLength(2);
  });
});

describe('AttachmentTray', () => {
  const png = createFileAttachment({ name: 'shot.png', mime: 'image/png', bytes: new Uint8Array(2048).fill(1), source: 'picked' });
  const text = createFileAttachment({ name: 'a.ts', mime: '', bytes: new TextEncoder().encode('x'), source: 'dropped' });
  const tiles = (root: Element) => [...root.querySelectorAll<HTMLElement>('.att-tile')];

  it('shows extension badge and meta, opens on click and removes via the x', () => {
    const onOpen = vi.fn(); const onRemove = vi.fn();
    const root = mount(() => <AttachmentTray items={[png, text]} capabilities={all} onOpen={onOpen} onRemove={onRemove} />);
    expect(tiles(root)[0].querySelector('.att-tile-ext')?.textContent).toBe('PNG');
    expect(tiles(root)[0].querySelector('.att-tile-meta')?.textContent).toBe('2.0 KiB');
    tiles(root)[0].querySelector<HTMLButtonElement>('.att-tile-open')!.click();
    expect(onOpen).toHaveBeenCalledWith(png);
    root.querySelector<HTMLButtonElement>('[aria-label="Remove a.ts"]')!.click();
    expect(onRemove).toHaveBeenCalledWith(text);
  });
  it('shows the amber sent-as-link state with the reason as title', () => {
    const linked = { ...createFileAttachment({ name: 'note.mp3', mime: '', bytes: new Uint8Array(4), source: 'picked' }), path: 'sounds/note.mp3' };
    const root = mount(() => <AttachmentTray items={[linked, createWorkspaceFile('docs/pic.png', 10)]} capabilities={noImage} onOpen={() => {}} onRemove={() => {}} />);
    const tile = tiles(root)[0];
    expect(tile.dataset.state).toBe('link');
    expect(tile.querySelector('.att-tile-meta')?.textContent).toBe('Sent as link');
    expect(tile.title).toBe(linkReason(linked, noImage));
    expect(tile.title).toContain('does not accept audio');
    expect(tiles(root)[1].title).toContain('Only the file path');
  });
  it('marks refused items blocked with the reason', () => {
    const root = mount(() => <AttachmentTray items={[png]} capabilities={{ image: false, audio: false, embeddedContext: false }} onOpen={() => {}} onRemove={() => {}} />);
    expect(tiles(root)[0].dataset.state).toBe('blocked');
    expect(tiles(root)[0].title).toBe('This agent does not accept images.');
  });
  it('shows determinate and indeterminate upload progress', () => {
    const loading = { ...png, id: 'up', status: 'loading' as const };
    const other = { ...text, id: 'wait', status: 'loading' as const };
    const root = mount(() => <AttachmentTray items={[loading, other]} progress={{ up: 0.4 }} onOpen={() => {}} onRemove={() => {}} />);
    const bars = [...root.querySelectorAll('[role=progressbar]')];
    expect(bars[0].getAttribute('aria-valuenow')).toBe('40');
    expect((bars[0].firstElementChild as HTMLElement).style.width).toBe('40%');
    expect(bars[1].hasAttribute('aria-valuenow')).toBe(false);
    expect(tiles(root)[0].querySelector('.att-tile-meta')?.textContent).toBe('40%');
  });
  it('removes on Delete, then focuses a neighbour and reports empty', async () => {
    const [list, setList] = createSignal([png, text]);
    const onEmpty = vi.fn();
    const root = mount(() => <AttachmentTray items={list()} onOpen={() => {}} onRemove={item => setList(l => l.filter(o => o.id !== item.id))} onEmpty={onEmpty} />);
    const first = root.querySelector<HTMLElement>('.att-tile-open')!;
    press(first, 'Delete'); await flush();
    expect(document.activeElement?.getAttribute('aria-label')).toContain('a.ts');
    press(document.activeElement!, 'Backspace'); await flush();
    expect(onEmpty).toHaveBeenCalledOnce();
  });
  it('badges pasted text and audio', () => {
    const audio = createFileAttachment({ name: 'note.mp3', mime: '', bytes: new Uint8Array(4), source: 'picked' });
    const root = mount(() => <AttachmentTray items={[createPastedText('a\n'.repeat(20)), audio]} capabilities={all} onOpen={() => {}} onRemove={() => {}} />);
    expect(tiles(root).map(t => t.querySelector('.att-tile-ext')?.textContent)).toEqual(['TXT', 'MP3']);
  });
});

describe('uploads end to end pieces (#91)', () => {
  const tiles = (root: Element) => [...root.querySelectorAll<HTMLElement>('.att-tile')];
  it('lists every attach path the design names when each has a handler', () => {
    const run = () => {};
    const root = mount(() => <AttachMenu agentName="Claude" handlers={{ upload: run, image: run, screenshot: run, file: run, selection: run, folder: run, session: run }} onClose={() => {}} />);
    expect(items(root).map(i => i.querySelector('.att-menu-label')?.textContent)).toEqual(['Upload files', 'Add image', 'Paste screenshot', 'Current file', 'Selection', 'Folder', 'Earlier session']);
  });
  it('shows the PDF page count only when it was read, and the folder file count', () => {
    const pdf = { ...createFileAttachment({ name: 'spec.pdf', mime: 'application/pdf', bytes: new Uint8Array(2048), source: 'picked' }), pages: 12 };
    const unread = createFileAttachment({ name: 'locked.pdf', mime: 'application/pdf', bytes: new Uint8Array(1024), source: 'picked' });
    const folder = createFolderAttachment({ name: 'styles', text: 'outline', files: 14, truncated: false, path: 'ui/src/styles', source: 'workspace-file' });
    const big = createFolderAttachment({ name: 'src', text: 'outline', files: 180, truncated: true, path: 'src', source: 'workspace-file' });
    const root = mount(() => <AttachmentTray items={[pdf, unread, folder, big]} capabilities={all} onOpen={() => {}} onRemove={() => {}} />);
    expect(tiles(root).map(t => t.querySelector('.att-tile-meta')?.textContent)).toEqual(['12 pages · 2.0 KiB', '1.0 KiB', '14 files', '180+ files']);
    expect(tiles(root)[2].querySelector('.att-tile-ext')?.textContent).toBe('DIR');
    expect(tiles(root)[2].title).toContain('added by Span (not an ACP content type)');
  });
  it('explains a stored link and shows the stored path once the copy exists', () => {
    const caps: PromptCapabilities = { image: true, audio: false, embeddedContext: false, storeLinks: true };
    const item = createFileAttachment({ name: 'data.bin', mime: 'application/octet-stream', bytes: new Uint8Array([1, 2]), source: 'picked' });
    expect(linkReason(item, caps)).toBe('This agent cannot take this content inline, so Span saves it to Uploads and sends a link to that copy. The agent must be able to read that file.');
    const stored = { ...item, uploadId: 'u1', path: '/data/uploads/open/u1/data.bin' };
    const root = mount(() => <AttachmentTray items={[stored]} capabilities={caps} onOpen={() => {}} onRemove={() => {}} />);
    expect(tiles(root)[0].dataset.state).toBe('link');
    expect(tiles(root)[0].title).toContain('/data/uploads/open/u1/data.bin');
  });
});
