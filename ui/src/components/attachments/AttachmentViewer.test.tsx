// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { Show, createSignal } from 'solid-js';
import { readFileSync } from 'node:fs';
import { AttachmentView, AttachmentViewer, type AttachmentViewProps, type AttachmentViewerProps } from './index';
import { createFileAttachment, createPastedText, createSelection, createWorkspaceFile, type Attachment } from '../../lib/attachments';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
beforeEach(() => {
  // jsdom has no blob URLs or media playback, so the audio and video path is stubbed.
  URL.createObjectURL = vi.fn(() => 'blob:test/0') as never;
  URL.revokeObjectURL = vi.fn() as never;
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve()) as never;
  HTMLMediaElement.prototype.pause = vi.fn() as never;
});
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const key = (element: Element, value: string) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
const open = (item: Attachment, props: Partial<AttachmentViewerProps> = {}) => mount(() => <AttachmentViewer item={item} onClose={() => undefined} {...props} />);
const file = (name: string, mime: string, bytes: Uint8Array) => createFileAttachment({ name, mime, bytes, source: 'picked' });
const png = () => file('shot.png', 'image/png', new Uint8Array(12).fill(1));
const kind = () => document.querySelector('.vw')?.getAttribute('data-kind');
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent?.trim() === label) as HTMLButtonElement | undefined;
const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent);
const openMenu = async () => { button('More actions')!.click(); await settle(); };

describe('attachment kinds map to the viewer', () => {
  it('opens images through ImageView as an inert data URL', () => {
    open(png());
    expect(kind()).toBe('image');
    const img = document.querySelector<HTMLImageElement>('.vw img')!;
    expect(img.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(img.alt).toBe('shot.png');
  });
  it('sanitises SVG and shows a damaged state for unsafe markup', () => {
    open(file('a.svg', 'image/svg+xml', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><script>alert(1)</script><rect width="4" height="4" onclick="x()"/></svg>')));
    expect(kind()).toBe('svg');
    expect(decodeURIComponent(document.querySelector<HTMLImageElement>('.vw img')!.src)).not.toMatch(/script|onclick|alert/);
  });
  it('opens pasted text and selections as text with the read-only banner and selection line start', () => {
    open(createPastedText('alpha\nbeta\n'.repeat(10)));
    expect(kind()).toBe('text');
    expect(document.querySelector('.vw-banner')?.textContent).toContain('Read-only attachment');
    document.body.replaceChildren();
    open(createSelection({ path: 'src/a.ts', text: 'one\ntwo', start: 40, end: 41 }));
    expect(kind()).toBe('text');
    expect(document.querySelector('.vw-banner')?.textContent).toContain('Read-only attachment');
  });
  it('opens audio and video through MediaPlayer with a blob URL and no autoplay', () => {
    open(file('talk.mp3', 'audio/mpeg', new Uint8Array([1, 2, 3])));
    expect(kind()).toBe('media');
    const audio = document.querySelector('audio')!;
    expect(audio.getAttribute('src')).toBe('blob:test/0');
    expect(audio.hasAttribute('autoplay')).toBe(false);
    document.body.replaceChildren();
    open(file('clip.mp4', 'video/mp4', new Uint8Array([0, 0, 0, 24])));
    expect(document.querySelector('video')).not.toBeNull();
  });
  it('opens unknown binary as hex and unsupported formats with the honest state', () => {
    open(file('blob.bin', 'application/octet-stream', new Uint8Array([0, 1, 2, 0, 255, 0, 3])));
    expect(kind()).toBe('hex');
    document.body.replaceChildren();
    open(file('bundle.7z', 'application/x-7z-compressed', new Uint8Array(64)));
    expect(kind()).toBe('unsupported');
    expect(document.querySelector('img')).toBeNull();
  });
  it('maps item status and missing content to loading, error and gone', () => {
    open({ ...png(), bytes: undefined, status: 'loading' });
    expect(kind()).toBe('loading');
    document.body.replaceChildren();
    open({ ...png(), bytes: undefined, status: 'error', error: 'Too large' });
    expect(kind()).toBe('damaged');
    expect(document.body.textContent).toContain('Too large');
    document.body.replaceChildren();
    const sessionList = vi.fn();
    open({ ...png(), bytes: undefined }, { onShowSessionList: sessionList });
    expect(kind()).toBe('gone');
    button('Show session list')!.click();
    expect(sessionList).toHaveBeenCalledOnce();
  });
  it('loads path-only workspace images through the loader and rejects bad data', async () => {
    const loadImage = vi.fn(async () => ({ mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }) as never);
    open(createWorkspaceFile('assets/logo.png', 10), { loadImage });
    await settle();
    expect(loadImage).toHaveBeenCalledWith('assets/logo.png');
    expect(kind()).toBe('image');
    document.body.replaceChildren();
    open(createWorkspaceFile('x.png', 1), { loadImage: async () => ({ mime: 'image/png', dataUrl: 'javascript:alert(1)' }) as never });
    await settle();
    expect(document.body.textContent).toMatch(/Invalid workspace image/);
    document.body.replaceChildren();
    open(createWorkspaceFile('x.png', 1));
    expect(kind()).toBe('damaged');
  });
});

describe('source bar', () => {
  it('shows the brand, session and verb it is given and nothing else', () => {
    open(createPastedText('x\n'.repeat(20)), { source: { agent: { id: 'claude-code', name: 'Claude' }, verb: 'Sent in', session: 'Match the toggle spec' } });
    const bar = document.querySelector('.vw-source')!;
    expect(bar.textContent).toContain('Sent in');
    expect(bar.textContent).toContain('Match the toggle spec');
    expect(bar.textContent).not.toContain('·');
  });
  it('omits the source bar text for composer items', () => {
    open(png());
    expect(document.querySelector('.vw-source')!.textContent).not.toMatch(/Attachment from|Sent/);
  });
});

describe('actions', () => {
  it('shows only the actions whose handler exists, never Open with system app', async () => {
    open(png());
    expect(button('Save to workspace')).toBeUndefined();
    expect(button('More actions')).toBeUndefined();
    document.body.replaceChildren();
    open(png(), { onSaveToWorkspace: () => undefined, onRemove: () => undefined, onShowInSession: () => undefined });
    expect(button('Save to workspace')).toBeDefined();
    await openMenu();
    expect(menuItems()).toEqual(['Show in session', 'Remove']);
    expect(document.body.textContent).not.toContain('Open with system app');
  });
  it('offers Copy path only with a path, Open in editor only for workspace items, Save never for workspace items', async () => {
    const item = createWorkspaceFile('src/a.ts', 4);
    const copy = vi.fn(), editor = vi.fn(), save = vi.fn();
    open(item, { onCopyPath: copy, onOpenInEditor: editor, onSaveToWorkspace: save });
    expect(button('Save to workspace')).toBeUndefined();
    await openMenu();
    expect(menuItems()).toEqual(['Copy path']);
    (document.querySelector('[role="menuitem"]') as HTMLButtonElement).click(); await settle();
    expect(copy).toHaveBeenCalledWith('src/a.ts');
    button('Open in editor')!.click();
    expect(editor).toHaveBeenCalledWith(item);
    document.body.replaceChildren();
    open(png(), { onCopyPath: copy, onOpenInEditor: editor });
    expect(button('More actions')).toBeUndefined();
    expect(button('Open in editor')).toBeUndefined();
  });
  it('removes a composer item and closes', async () => {
    const remove = vi.fn(), close = vi.fn(), item = png();
    open(item, { onRemove: remove, onClose: close });
    await openMenu();
    (document.querySelector('[role="menuitem"]') as HTMLButtonElement).click(); await settle();
    expect(remove).toHaveBeenCalledWith(item);
    expect(close).toHaveBeenCalledOnce();
  });
  it('runs Show in session with the item', async () => {
    const show = vi.fn(), item = png();
    open(item, { onShowInSession: show });
    await openMenu();
    (document.querySelector('[role="menuitem"]') as HTMLButtonElement).click(); await settle();
    expect(show).toHaveBeenCalledWith(item);
  });
  it('withholds native actions in browser preview and says why', () => {
    open(createWorkspaceFile('a.ts'), { onOpenInEditor: () => undefined, nativeUnavailable: 'Open the desktop app.' });
    expect(button('Open in editor')!.disabled).toBe(true);
    expect([...document.querySelectorAll('[role="note"]')].map(node => node.textContent)).toContain('Open the desktop app.');
    document.body.replaceChildren();
    open(png(), { onSaveToWorkspace: () => undefined, nativeUnavailable: 'Open the desktop app.' });
    expect(button('Save to workspace')).toBeUndefined();
    expect([...document.querySelectorAll('[role="note"]')].map(node => node.textContent)).toContain('Open the desktop app.');
  });
  it('explains why the agent will not receive the item', () => {
    open(png(), { blockedReason: 'This agent does not accept images.' });
    expect(document.querySelector('.att-viewer-blocked')?.textContent).toBe('Not sent: This agent does not accept images.');
  });
});

describe('save flow', () => {
  it('saves the item through the handler and reports it', async () => {
    const item = png(), save = vi.fn(async () => undefined);
    open(item, { onSaveToWorkspace: save });
    button('Save to workspace')!.click(); await settle();
    expect(save).toHaveBeenCalledWith(item);
    expect(document.querySelector('.vw [role="status"]')?.textContent).toContain('Save to workspace');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it('shows the error alert when the save fails', async () => {
    open(png(), { onSaveToWorkspace: async () => { throw new Error('disk full'); } });
    button('Save to workspace')!.click(); await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('disk full');
  });
  it('turns into a workspace item after a save, hiding Save and enabling Open in editor', async () => {
    const [item, setItem] = createSignal<Attachment>(png());
    mount(() => <AttachmentViewer item={item()} onClose={() => undefined} onOpenInEditor={() => undefined} onSaveToWorkspace={async current => { setItem({ ...current, source: 'workspace-file', path: 'assets/shot.png' }); }} />);
    expect(button('Open in editor')).toBeUndefined();
    button('Save to workspace')!.click(); await settle();
    expect(button('Save to workspace')).toBeUndefined();
    expect(button('Open in editor')).toBeDefined();
    expect(document.querySelector('.vw-banner')?.textContent ?? '').not.toContain('Read-only');
  });
});

describe('modal behaviour', () => {
  it('closes on Escape, focuses the close button and restores focus to the opener', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const close = vi.fn();
    mount(() => { const [shown, setShown] = createSignal(true); return <Show when={shown()}><AttachmentViewer item={png()} onClose={() => { close(); setShown(false); }} /></Show>; });
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Attachment shot.png');
    expect(document.activeElement).toBe(document.querySelector('.att-viewer-close'));
    key(dialog, 'Escape'); await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('traps Tab inside the dialog', async () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return document.body; } });
    try {
      open(createWorkspaceFile('a.ts'), { onCopyPath: () => undefined, onOpenInEditor: () => undefined });
      await settle();
      const dialog = document.querySelector('[role="dialog"]')!;
      const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      last.focus(); key(last, 'Tab'); expect(document.activeElement).toBe(first);
      first.focus(); dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); expect(document.activeElement).toBe(last);
    } finally { delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent; }
  });
});

describe('narrow header', () => {
  // jsdom does no layout or container queries, so the rules are asserted in the stylesheets.
  const css = (name: string) => readFileSync(`${process.cwd()}/src/styles/${name}`, 'utf8');
  it('gives the session title a minimum width', () => {
    expect(css('agent.css')).toMatch(/\.agent-title \{[^}]*min-width: 72px/);
  });
  it('collapses the Following pill to icon-only in a narrow header, keeping its accessible name', () => {
    const sheet = css('agent-sidebar.css');
    expect(css('agent.css')).toMatch(/container: agent-header \/ inline-size/);
    expect(sheet).toMatch(/@container agent-header \(max-width: 380px\) \{[^}]*\.sb-follow\.on \{ width: 28px/);
    expect(sheet).toMatch(/\.sb-follow\.on > span:not\(\.icon\) \{ display: none/);
  });
});

describe('inline attachment view for workbench tabs', () => {
  const inline = (item: Attachment, props: Partial<AttachmentViewProps> = {}) => mount(() => <AttachmentView item={item} {...props} />);
  it('renders the shared viewer in place, not as a dialog, with no close button of its own', () => {
    const root = inline(png());
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('.att-viewer-tab')).not.toBeNull();
    expect(kind()).toBe('image');
    expect(button('Close attachment viewer')).toBeUndefined();
    expect(document.querySelector('.att-viewer-title')?.textContent).toBe('shot.png');
  });
  it('offers Save to workspace through the supplied handler', async () => {
    const save = vi.fn(async () => undefined);
    const item = png();
    inline(item, { onSaveToWorkspace: save });
    button('Save to workspace')!.click(); await settle();
    expect(save).toHaveBeenCalledWith(item);
  });
  it('closes its tab after removing a composer attachment', async () => {
    const remove = vi.fn(); const close = vi.fn();
    const item = png();
    inline(item, { onRemove: remove, onClose: close });
    await openMenu();
    ([...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.includes('Remove')) as HTMLElement).click(); await settle();
    expect(remove).toHaveBeenCalledWith(item);
    expect(close).toHaveBeenCalled();
  });
  it('opens the document viewers for office and archive formats', () => {
    for (const [name, mime] of [['report.pdf', 'application/pdf'], ['spec.docx', ''], ['deck.pptx', ''], ['data.xlsx', ''], ['bundle.zip', 'application/zip']]) {
      document.body.replaceChildren();
      inline(file(name, mime, new Uint8Array([80, 75, 3, 4, 1, 2])));
      expect(kind()).toBe('office');
    }
  });
});
