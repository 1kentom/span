// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { zipSync } from 'fflate';
import { OFFICE_PREVIEW_BYTES } from '../../lib/office/limits';
import { createMemoryUploadsApi, createUnavailableUploadsApi, type MemoryUpload, type UploadsApi, type UploadsCapabilities } from '../../lib/uploads-api';
import { UploadsWorkspace } from './UploadsWorkspace';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); } };
const bytes = (text: string) => new TextEncoder().encode(text);
const now = new Date(2026, 9, 28, 15, 0).getTime();
const at = (h: number, m: number) => new Date(2026, 9, 28, h, m).getTime();
const seed = (): MemoryUpload[] => [
  { entry: { id: 'md', name: 'notes.md', size: 0, createdAt: at(12, 48), origin: 'sent', session: { title: 'Session list and resume' }, agent: { name: 'Claude' } }, data: bytes('# Release notes\n\nHello') },
  { entry: { id: 'csv', name: 'export.csv', size: 0, createdAt: at(13, 1), origin: 'generated', session: { title: 'Filter resume list' }, agent: { name: 'Codex' } }, data: bytes('a,b\n1,2') },
  { entry: { id: 'bin', name: 'core.bin', size: 0, createdAt: at(11, 0), origin: 'sent' }, data: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1]) },
];
async function mount(api: UploadsApi, extra: Record<string, unknown> = {}) {
  const root = document.createElement('div'); document.body.append(root);
  cleanup.push(render(() => <UploadsWorkspace api={api} platform="mac" now={() => now} {...extra} />, root));
  await settle();
  return root;
}
const rows = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('.up-row')];
const row = (root: ParentNode, name: string) => rows(root).find(r => r.querySelector('.up-row-name')?.textContent === name)!;
const tabs = (root: ParentNode) => [...root.querySelectorAll('.up-tab')].map(tab => `${tab.querySelector('.up-tab-name')?.textContent}${tab.classList.contains('up-tab-preview') ? ' (preview)' : ''}`);
const key = (element: Element, value: string, extra: KeyboardEventInit = {}) => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
const menuLabels = () => [...document.querySelectorAll('.up-menu:not(.up-submenu) > .up-menu-list > [role^="menuitem"]')].map(item => item.querySelector('.up-menu-label')?.textContent);
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find(item => item.querySelector('.up-menu-label')?.textContent === label)!;
const toast = (root: ParentNode) => root.querySelector('.up-toast-host')?.textContent ?? '';

describe('uploads workspace', () => {
  it('in the browser preview shows that uploads need the desktop app, with no data and no actions', async () => {
    const root = await mount(createUnavailableUploadsApi());
    expect(root.querySelector('.up-rail')?.textContent).toContain('Uploads need the desktop app');
    expect(root.querySelector('.up-start')?.textContent).toContain('Uploads need the desktop app');
    expect(root.querySelector('input[aria-label="Filter uploads"]')).toBeNull();
    expect(root.querySelector('[aria-label="Upload files"]')).toBeNull();
    expect(rows(root)).toHaveLength(0);
  });

  it('groups uploads with counts, shows session and time, filters and collapses', async () => {
    const root = await mount(createMemoryUploadsApi(seed()));
    expect([...root.querySelectorAll('.up-group-row')].map(g => g.textContent)).toEqual(['Documents1', 'Data1', 'Code and archives1']);
    expect(row(root, 'notes.md').querySelector('.up-row-meta')?.textContent).toBe('Session list and resume · 12:48');
    expect(root.querySelector('.up-rail-foot')?.textContent).toContain('Click to preview, double-click to keep open, right-click for more');
    expect(root.querySelector('.up-usage')?.textContent).toBe('3 files · 35 B');
    const filter = root.querySelector('input[aria-label="Filter uploads"]') as HTMLInputElement;
    filter.value = 'resume list'; filter.dispatchEvent(new InputEvent('input', { bubbles: true })); await settle(1);
    expect(rows(root).map(r => r.querySelector('.up-row-name')?.textContent)).toEqual(['export.csv']);
    filter.value = 'zzz'; filter.dispatchEvent(new InputEvent('input', { bubbles: true })); await settle(1);
    expect(root.querySelector('.up-rail-body')?.textContent).toContain('No uploads match “zzz”');
    filter.value = ''; filter.dispatchEvent(new InputEvent('input', { bubbles: true })); await settle(1);
    (root.querySelector('.up-group-row') as HTMLElement).click(); await settle(1);
    expect(root.querySelector('.up-group')?.getAttribute('aria-expanded')).toBe('false');
    expect(rows(root)).toHaveLength(2);
  });

  it('opens an italic preview tab on click, replaces it, pins on double-click and closes with the middle button', async () => {
    const root = await mount(createMemoryUploadsApi(seed()));
    expect(root.querySelector('.up-start')?.textContent).toContain('Open an upload to preview it');
    row(root, 'notes.md').click(); await settle();
    expect(tabs(root)).toEqual(['notes.md (preview)']);
    expect(root.querySelector('.markdown-body h1')?.textContent).toBe('Release notes');
    expect(root.querySelector('.vw-source')?.textContent).toContain('Attached in');
    expect(root.querySelector('.vw-source')?.textContent).toContain('Session list and resume');
    row(root, 'export.csv').click(); await settle();
    expect(tabs(root)).toEqual(['export.csv (preview)']);
    expect(root.querySelector('.vw-source')?.textContent).toContain('Created by Codex in');
    row(root, 'export.csv').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await settle();
    row(root, 'notes.md').click(); await settle();
    expect(tabs(root)).toEqual(['export.csv', 'notes.md (preview)']);
    (root.querySelector('.up-tab-preview .up-tab-label') as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await settle(1);
    expect(tabs(root)).toEqual(['export.csv', 'notes.md']);
    root.querySelectorAll('.up-tab')[0].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })); await settle(1);
    expect(tabs(root)).toEqual(['notes.md']);
    (root.querySelector('[aria-label="Close notes.md"]') as HTMLButtonElement).click(); await settle(1);
    expect(tabs(root)).toEqual([]);
  });

  it('is keyboard operable: arrows, Enter previews, Space pins, F2 renames with validation, Delete confirms', async () => {
    const api = createMemoryUploadsApi(seed());
    const root = await mount(api);
    const tree = root.querySelector('[role="tree"]')!;
    const group = tree.querySelector('[role="treeitem"]') as HTMLElement;
    expect(group.tabIndex).toBe(0);
    group.focus();
    key(group, 'ArrowDown'); await settle(1);
    expect(document.activeElement).toBe(row(root, 'notes.md'));
    key(document.activeElement!, 'Enter'); await settle();
    expect(tabs(root)).toEqual(['notes.md (preview)']);
    key(document.activeElement!, ' '); await settle(1);
    expect(tabs(root)).toEqual(['notes.md']);
    key(document.activeElement!, 'F2'); await settle(1);
    const input = root.querySelector('input[aria-label="Rename notes.md"]') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = 'export.csv'; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    key(input, 'Enter'); await settle(1);
    expect(root.querySelector('.up-rename-error')?.textContent).toBe('Another upload already has this name.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    input.value = 'release.md'; input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    key(input, 'Enter'); await settle();
    expect(row(root, 'release.md')).toBeDefined();
    expect(toast(root)).toContain('Renamed to release.md');
    expect(tabs(root)).toEqual(['release.md']);
    row(root, 'release.md').focus();
    key(row(root, 'release.md'), 'Delete'); await settle(1);
    const dialog = root.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Remove release.md from uploads?');
    expect(document.activeElement?.textContent).toBe('Cancel');
    key(dialog, 'Escape'); await settle(1);
    expect(root.querySelector('[role="alertdialog"]')).toBeNull();
    key(row(root, 'release.md'), 'Delete'); await settle(1);
    ([...root.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === 'Remove') as HTMLButtonElement).click(); await settle();
    expect(row(root, 'release.md')).toBeUndefined();
    expect(tabs(root)).toEqual([]);
    expect(toast(root)).toContain('Removed release.md');
  });

  it('gates menu entries by capability, closes with Escape and returns focus', async () => {
    const limited: Partial<UploadsCapabilities> = { reveal: false, copyPath: false, chooseApplication: false, duplicate: false };
    const root = await mount(createMemoryUploadsApi(seed(), limited));
    const target = row(root, 'notes.md');
    target.focus();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 })); await settle(1);
    expect(document.querySelector('.up-menu-title')?.textContent).toBe('notes.md');
    expect(menuLabels()).toEqual(['Open preview', 'Open and keep', 'Open with', 'Save to workspace…', 'Rename…', 'Remove upload']);
    expect(menuItem('Rename…').querySelector('.up-menu-key')?.textContent).toBe('F2');
    expect(document.activeElement).toBe(menuItem('Open preview'));
    key(document.activeElement!, 'Escape'); await settle(1);
    expect(document.querySelector('.up-menu')).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  it('saves, reveals and copies the path from the menu with toasts', async () => {
    const api = createMemoryUploadsApi(seed());
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const root = await mount(api);
    const open = async () => { row(root, 'notes.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); await settle(1); };
    await open(); menuItem('Save to workspace…').click(); await settle();
    expect(toast(root)).toContain('notes.md saved to workspace');
    await open(); menuItem('Reveal in Finder').click(); await settle();
    expect(toast(root)).toContain('Revealed notes.md in Finder');
    await open(); menuItem('Copy path').click(); await settle();
    expect(writeText).toHaveBeenCalledWith('/uploads/notes.md');
    expect(toast(root)).toContain('Copied path of notes.md');
    expect(api.calls).toEqual([['saveToWorkspace', 'md'], ['reveal', 'md']]);
  });

  it('switches to the binary view from Open with, with a tick on the current choice', async () => {
    const root = await mount(createMemoryUploadsApi(seed()));
    row(root, 'notes.md').click(); await settle();
    row(root, 'notes.md').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); await settle(1);
    menuItem('Open with').focus();
    key(menuItem('Open with'), 'ArrowRight'); await settle(1);
    expect(menuItem('Span preview').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(menuItem('Span preview'));
    menuItem('Binary (hex)').click(); await settle();
    expect(root.querySelector('.vw-hex-row')?.textContent).toContain('23 20 52 65');
    const button = [...root.querySelectorAll('.vw-source button')].find(b => b.textContent === 'Open with') as HTMLButtonElement;
    button.click(); await settle(1);
    expect(menuItem('Binary (hex)').getAttribute('aria-checked')).toBe('true');
    expect(menuLabels()).toEqual(['Span preview', 'Binary (hex)', 'System default app', 'Choose application…']);
  });

  it('offers the tab menu with close variants and handles Delete and arrows on tabs', async () => {
    const root = await mount(createMemoryUploadsApi(seed()));
    for (const name of ['notes.md', 'export.csv', 'core.bin']) { row(root, name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await settle(); }
    expect(tabs(root)).toEqual(['notes.md', 'export.csv', 'core.bin']);
    root.querySelectorAll('.up-tab')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); await settle(1);
    expect(menuLabels()).toEqual(['Close', 'Close others', 'Close to the right', 'Close all', 'Open with', 'Copy path', 'Reveal in Finder']);
    menuItem('Close to the right').click(); await settle(1);
    expect(tabs(root)).toEqual(['notes.md', 'export.csv']);
    const active = root.querySelector('.up-tab-active .up-tab-label') as HTMLElement;
    active.focus();
    key(active, 'ArrowLeft'); await settle(1);
    expect(document.activeElement?.textContent).toContain('notes.md');
    key(document.activeElement!, 'Delete'); await settle(1);
    expect(tabs(root)).toEqual(['export.csv']);
  });

  it('shows the gone state when the upload disappeared and failures as an error toast', async () => {
    const api = createMemoryUploadsApi(seed());
    const root = await mount(api);
    await api.remove('csv');
    row(root, 'export.csv').click(); await settle();
    expect(root.querySelector('[data-state="gone"]')).not.toBeNull();
    row(root, 'export.csv').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); await settle(1);
    menuItem('Save to workspace…').click(); await settle();
    expect(root.querySelector('.up-toast-host [role="alert"]')?.textContent).toContain('Could not save export.csv');
  });
});

describe('uploads workspace mounted in the app', () => {
  it('shows an Explorer tab beside the Uploads title only when the host can go back to the explorer', async () => {
    const withoutHost = await mount(createMemoryUploadsApi(seed()));
    expect(withoutHost.querySelector('.up-rail-tab')).toBeNull();
    const onShowExplorer = vi.fn();
    const root = await mount(createMemoryUploadsApi(seed()), { onShowExplorer });
    const tab = root.querySelectorAll<HTMLButtonElement>('.up-rail-tab');
    expect([...tab].map(t => t.textContent)).toEqual(['Explorer']);
    tab[0].click();
    expect(onShowExplorer).toHaveBeenCalledOnce();
  });
});


it('reads the complete ZIP container above the hex prefix limit before listing its directory', async () => {
  const data = zipSync({ 'payload.bin': Uint8Array.from({ length: 80 * 1024 }, (_, index) => index % 251) }, { level: 0 });
  expect(data.length).toBeGreaterThan(64 * 1024);
  const api = createMemoryUploadsApi([{ entry: { id: 'archive', name: 'complete.zip', size: data.length, createdAt: now, origin: 'sent' }, data }]);
  const read = vi.spyOn(api, 'read');
  const root = await mount(api);
  row(root, 'complete.zip').click();
  await vi.waitFor(() => expect(read).toHaveBeenCalledWith('archive', 0, data.length));
  await vi.waitFor(() => expect(root.querySelector('.ox-archive')?.textContent).toContain('payload.bin'));
  expect(root.querySelector('[data-state="damaged"]')).toBeNull();
});


it('shows an oversized document without reading decoder bytes', async () => {
  const api = createMemoryUploadsApi();
  vi.spyOn(api, 'list').mockResolvedValue([{ id: 'large', name: 'large.pdf', size: OFFICE_PREVIEW_BYTES.pdf + 1, createdAt: now, origin: 'sent' }]);
  const read = vi.spyOn(api, 'read');
  const root = await mount(api);
  row(root, 'large.pdf').click();
  await vi.waitFor(() => expect(root.querySelector('[data-state="too-large"]')?.textContent).toContain('PDF preview is limited'));
  expect(read).not.toHaveBeenCalled();
});
