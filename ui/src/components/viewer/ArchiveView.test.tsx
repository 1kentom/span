// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { strToU8, zipSync } from 'fflate';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ArchiveView from './ArchiveView';
import { ARCHIVE_MAX_BYTES } from '../../lib/office/limits';
import { createMemoryArchiveApi } from '../../lib/archive-api.memory';
import type { ArchiveEntry } from '../../lib/archive-api';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const names = (root: ParentNode) => [...root.querySelectorAll('.ox-row .ox-name')].map(n => n.textContent);

const f = (path: string, size = 100, packed = 40): ArchiveEntry => ({ path, dir: false, size, packed, modified: Date.UTC(2026, 9, 28, 12) });
const entries = [f('dist/index.html'), f('dist/assets/index.js', 2000, 600), f('dist/assets/logo.svg'), f('logs/build.log'), f('../escape.sh'), f('/etc/passwd')];

describe('ArchiveView with a backend', () => {
  it('shows the tree, totals, the unsafe warning and expands and collapses all', async () => {
    const meta = vi.fn();
    const mem = createMemoryArchiveApi(entries);
    const root = mount(() => <ArchiveView name="build-artifacts.zip" api={mem.api} onMeta={meta} />);
    await settle();
    expect(names(root)).toEqual(['dist', 'assets', 'index.html', 'logs', 'build.log', '../escape.sh', '/etc/passwd']);
    expect(meta).toHaveBeenLastCalledWith(['4 files · 3 folders', '2.2 KiB unpacked', '720 B packed', 'ZIP · Deflate']);
    expect(root.querySelector('.ox-warning')?.textContent).toContain('2 entries point outside the archive and are always skipped.');
    expect([...root.querySelectorAll('.ox-unsafe-list li')].map(li => li.textContent)).toEqual(['../escape.sh', '/etc/passwd']);
    expect(root.querySelectorAll('.ox-row-unsafe')).toHaveLength(2);
    button(root, 'Expand all')!.click(); await settle();
    expect(names(root)).toContain('index.js');
    button(root, 'Collapse all')!.click(); await settle();
    expect(names(root)).toEqual(['dist', 'logs', '../escape.sh', '/etc/passwd']);
  });
  it('filters entries and keeps their folders', async () => {
    const root = mount(() => <ArchiveView name="a.zip" api={createMemoryArchiveApi(entries).api} />);
    await settle();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Filter entries"]')!;
    expect(input.placeholder).toBe('Filter 4 files');
    input.value = 'logo'; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    expect(names(root)).toEqual(['dist', 'assets', 'logo.svg']);
  });
  it('selects a folder, extracts the selection with the chosen options and shows progress, cancel and dismiss', async () => {
    const mem = createMemoryArchiveApi(entries);
    const root = mount(() => <ArchiveView name="a.zip" api={mem.api} />);
    await settle();
    root.querySelector<HTMLInputElement>('input[aria-label="Select assets"]')!.click(); await settle();
    const extractSelected = button(root, 'Extract 2 selected')!;
    expect(extractSelected).toBeDefined();
    button(root, 'Extract options')!.click(); await settle();
    const popover = root.querySelector('[role="dialog"][aria-label="Extract options"]')!;
    expect([...popover.querySelectorAll('.ox-pop-item')].map(b => b.querySelector('.ox-pop-text span')?.textContent)).toEqual(['Extract to workspace', 'Extract here', 'Extract to…', 'Extract into a new folder']);
    [...popover.querySelectorAll('label')].find(l => l.textContent?.includes('Open folder when done'))!.querySelector('input')!.click();
    [...popover.querySelectorAll('[role="radio"]')].find(r => r.textContent === 'Replace')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    expect(root.querySelector('[aria-label="Extract options"][role="dialog"]')).toBeNull();
    extractSelected.click(); await settle();
    const call = mem.calls.find(c => c.method === 'extract')!;
    expect(call.options).toEqual({ target: 'workspace', paths: ['dist/assets/index.js', 'dist/assets/logo.svg'], keepStructure: true, skipHidden: true, openWhenDone: true, conflict: 'replace' });
    mem.emit({ done: 1, total: 2 }); await settle();
    expect(root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(root.querySelector('.ox-progress')?.textContent).toContain('Extracting 2 selected files to agent-panel/build-artifacts/');
    expect(button(root, 'Extract all to workspace')!.disabled).toBe(true);
    button(root, 'Cancel')!.click(); await settle();
    expect(mem.calls.some(c => c.method === 'cancel')).toBe(true);
    expect(root.querySelector('.ox-progress')?.textContent).toContain('Extraction cancelled');
    button(root, 'Dismiss')!.click(); await settle();
    expect(root.querySelector('.ox-progress')).toBeNull();
  });
  it('asks about conflicts before extracting all and resumes with the answer', async () => {
    const mem = createMemoryArchiveApi(entries, { conflicts: ['dist/index.html'] });
    const root = mount(() => <ArchiveView name="a.zip" api={mem.api} />);
    await settle();
    button(root, 'Extract all to workspace')!.click(); await settle();
    expect(root.querySelector('[role="alertdialog"]')?.textContent).toContain('1 file already exist in agent-panel/build-artifacts/');
    expect(mem.calls.some(c => c.method === 'extract')).toBe(false);
    button(root, 'Skip existing')!.click(); await settle();
    expect(mem.calls.find(c => c.method === 'extract')?.options).toMatchObject({ paths: 'all', conflict: 'skip' });
    mem.finish({ extracted: 3 }); await settle();
    expect(root.querySelector('.ox-progress')?.textContent).toContain('Extracted 3 files to agent-panel/build-artifacts/');
  });
  it('moves through rows with the keyboard, expands with arrows and toggles with Space', async () => {
    const root = mount(() => <ArchiveView name="a.zip" api={createMemoryArchiveApi(entries).api} />);
    await settle();
    const rows = () => [...root.querySelectorAll<HTMLElement>('.ox-row')];
    expect(rows()[0].tabIndex).toBe(0);
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await settle();
    expect(rows()[0].getAttribute('aria-expanded')).toBe('false');
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await settle();
    expect(rows()[0].getAttribute('aria-expanded')).toBe('true');
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); await settle();
    expect(button(root, 'Extract 3 selected')).toBeDefined();
    rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await settle();
    expect(rows()[1].tabIndex).toBe(0);
  });
  it('opens an entry through readEntry', async () => {
    const opened = vi.fn();
    const mem = createMemoryArchiveApi(entries, { files: { 'logs/build.log': strToU8('ok') } });
    const root = mount(() => <ArchiveView name="a.zip" api={mem.api} onOpenEntry={opened} />);
    await settle();
    button(root, 'Open build.log in a tab')!.click(); await settle();
    expect(opened).toHaveBeenCalledWith('logs/build.log', strToU8('ok'));
  });
});

describe('ArchiveView with the native backend flags', () => {
  const native = (entriesList: ArchiveEntry[], options: Parameters<typeof createMemoryArchiveApi>[1] = {}) => {
    const mem = createMemoryArchiveApi(entriesList, options);
    Object.assign(mem.api, { canOpenWhenDone: false, canKeepExecutable: true, canKeepBoth: true, atomic: true, targets: () => [{ kind: 'here', label: 'Extract here', detail: 'docs/site/' }, { kind: 'choose', label: 'Extract to…', detail: 'Choose a folder in the project' }] });
    return mem;
  };
  const refused: ArchiveEntry[] = [f('docs/a.txt'), { ...f('link'), unsafeReason: 'symbolic link (links are never extracted)' }, { ...f('README.md'), unsafeReason: 'name collides with another entry after case folding or Unicode normalisation' }];

  it('lists native refusals with reasons, hides open-folder and offers keep executable and keep both', async () => {
    const mem = native(refused);
    const root = mount(() => <ArchiveView name="site.zip" api={mem.api} />);
    await settle();
    expect(root.querySelector('.ox-warning')?.textContent).toContain('2 entries cannot be extracted safely and are always skipped.');
    expect([...root.querySelectorAll('.ox-unsafe-list li')].map(li => li.textContent)).toEqual(['link: symbolic link (links are never extracted)', 'README.md: name collides with another entry after case folding or Unicode normalisation']);
    expect(button(root, 'Extract all here')).toBeDefined();
    button(root, 'Extract options')!.click(); await settle();
    const popover = root.querySelector('[role="dialog"][aria-label="Extract options"]')!;
    expect(popover.textContent).not.toContain('Open folder when done');
    expect([...popover.querySelectorAll('[role="radio"]')].map(r => r.textContent)).toEqual(['Ask', 'Keep both', 'Skip', 'Replace']);
    [...popover.querySelectorAll('label')].find(l => l.textContent?.includes('Keep executable permission'))!.querySelector('input')!.click();
    popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    button(root, 'Extract all here')!.click(); await settle();
    expect(mem.calls.find(c => c.method === 'extract')?.options).toMatchObject({ target: 'here', openWhenDone: false, keepExecutable: true, conflict: 'ask' });
  });

  it('offers Keep both when the folder exists', async () => {
    const mem = native(refused, { conflicts: ['site'], destination: 'docs/site/' });
    const root = mount(() => <ArchiveView name="site.zip" api={mem.api} />);
    await settle();
    button(root, 'Extract all here')!.click(); await settle();
    expect(root.querySelector('[role="alertdialog"]')?.textContent).toContain('docs/site/ already exists.');
    button(root, 'Keep both')!.click(); await settle();
    expect(mem.calls.find(c => c.method === 'extract')?.options).toMatchObject({ conflict: 'keepBoth' });
  });

  it('stays cancelling until the extractor reports and then says nothing was extracted', async () => {
    const mem = native(refused);
    mem.api.cancel = async () => { mem.calls.push({ method: 'cancel' }); };
    const root = mount(() => <ArchiveView name="site.zip" api={mem.api} />);
    await settle();
    button(root, 'Extract all here')!.click(); await settle();
    button(root, 'Cancel')!.click(); await settle();
    expect(button(root, 'Cancelling…')?.disabled).toBe(true);
    expect(root.textContent).not.toContain('Extraction cancelled');
    mem.finish({ extracted: 0, cancelled: true }); await settle();
    expect(root.querySelector('.ox-progress')?.textContent).toContain('Extraction cancelled. Nothing was extracted.');
  });

  it('opens a row menu with Preview, both targets and Copy path, and previews text inline', async () => {
    const copied = vi.fn();
    const mem = native(refused, { files: { 'docs/a.txt': strToU8('hello archive') } });
    const root = mount(() => <ArchiveView name="site.zip" api={mem.api} onCopyPath={copied} />);
    await settle();
    const row = [...root.querySelectorAll<HTMLElement>('.ox-row')].find(r => r.querySelector('.ox-name')?.textContent === 'a.txt')!;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 })); await settle();
    const menu = root.querySelector('[role="menu"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(b => b.textContent)).toEqual(['Preview', 'Extract here', 'Extract to…', 'Copy path']);
    [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === 'Copy path')!.click(); await settle();
    expect(copied).toHaveBeenCalledWith('docs/a.txt');
    expect(root.querySelector('[role="menu"]')).toBeNull();
    button(root, 'Preview a.txt')!.click(); await settle();
    expect(root.querySelector('.ox-preview-text')?.textContent).toBe('hello archive');
    button(root, 'Close preview')!.click(); await settle();
    expect(root.querySelector('.ox-preview')).toBeNull();
    const unsafe = [...root.querySelectorAll<HTMLElement>('.ox-row')].find(r => r.querySelector('.ox-name')?.textContent === 'link')!;
    unsafe.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); await settle();
    expect([...root.querySelectorAll('[role="menuitem"]')].map(b => b.textContent)).toEqual(['Copy path']);
  });

  it('extracts one folder from its row menu and shows a preview error from the backend', async () => {
    const mem = native(refused);
    const root = mount(() => <ArchiveView name="site.zip" api={mem.api} />);
    await settle();
    const docs = [...root.querySelectorAll<HTMLElement>('.ox-row')].find(r => r.querySelector('.ox-name')?.textContent === 'docs')!;
    docs.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })); await settle();
    [...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === 'Extract to…')!.click(); await settle();
    expect(mem.calls.find(c => c.method === 'planExtract')?.options).toMatchObject({ target: 'choose', paths: ['docs/a.txt'] });
    button(root, 'Preview a.txt')!.click(); await settle();
    expect(root.querySelector('.ox-preview [role="alert"]')?.textContent).toBe('docs/a.txt is not in the archive.');
  });

  it('says when a listing was cut at the entry cap', async () => {
    const mem = native([f('a.txt')]);
    const list = mem.api.list.bind(mem.api);
    mem.api.list = async () => ({ ...(await list()), truncated: true });
    const root = mount(() => <ArchiveView name="huge.zip" api={mem.api} />);
    await settle();
    expect(root.textContent).toContain('Only the first 1 entry are listed. An archive this large cannot be extracted here.');
  });
});

describe('ArchiveView in the browser preview', () => {
  it('lists a ZIP locally, disables extraction honestly and opens entries', async () => {
    const zip = zipSync({ 'docs/readme.md': strToU8('# hi'), 'a.txt': strToU8('a') });
    const opened = vi.fn();
    const root = mount(() => <ArchiveView name="local.zip" bytes={zip} onOpenEntry={opened} />);
    await settle();
    expect(names(root)).toEqual(['docs', 'readme.md', 'a.txt']);
    expect(button(root, 'Extract all to workspace')!.disabled).toBe(true);
    expect(root.querySelector('.vw-note')?.textContent).toBe('Extraction needs the desktop app. This preview lists and opens entries only.');
    expect(root.querySelector('[aria-label="Extract a.txt"]')).toBeNull();
    button(root, 'Open readme.md in a tab')!.click(); await settle();
    expect(new TextDecoder().decode(opened.mock.calls[0][1])).toBe('# hi');
  });
  it('says plainly that TAR listing needs the desktop app', () => {
    const root = mount(() => <ArchiveView name="logs.tar" bytes={new Uint8Array(512)} />);
    expect(root.querySelector('[data-state="unsupported"]')?.textContent).toContain('Listing TAR archives needs the desktop app');
  });
  it('shows a damaged ZIP as damaged', async () => {
    const root = mount(() => <ArchiveView name="bad.zip" bytes={new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0])} />);
    await settle();
    expect(root.querySelector('[data-state="damaged"]')).not.toBeNull();
  });
});

describe('test-only archive implementation', () => {
  it('is never imported by app code', () => {
    const src = resolve(process.cwd(), 'src');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const offenders = walk(src).filter(p => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.endsWith('archive-api.memory.ts') && readFileSync(p, 'utf8').includes('archive-api.memory'));
    expect(offenders).toEqual([]);
  });
});


it('refuses an oversized whole archive before starting directory parsing', async () => {
  const root = mount(() => <ArchiveView name="large.zip" bytes={new Uint8Array(ARCHIVE_MAX_BYTES + 1)} />);
  await settle();
  expect(root.querySelector('[data-state="too-large"]')?.textContent).toContain('Archive preview is limited');
  expect(root.querySelector('[data-state="damaged"]')).toBeNull();
});
