import { describe, expect, it, vi } from 'vitest';
import type { UploadEntry, UploadsCapabilities } from '../../lib/uploads-api';
import { NO_CAPABILITIES } from '../../lib/uploads-api';
import { fileMenuItems, formatUploadTime, groupUploads, navigateTree, revealLabel, sourceLine, tabMenuItems, uploadGroupOf, validateRename, visibleRows, type MenuItem } from './upload-model';

const entry = (id: string, name: string, extra: Partial<UploadEntry> = {}): UploadEntry => ({ id, name, size: 10, createdAt: 0, origin: 'sent', session: { title: 'Match the toggle spec' }, ...extra });
const files = [
  entry('1', 'notes.md'), entry('2', 'spec.html'), entry('3', 'export.csv', { session: { title: 'Filter resume list' } }), entry('4', 'trace.json'),
  entry('5', 'shot.png'), entry('6', 'standup.m4a'), entry('7', 'Mono.ttf'), entry('8', 'build.zip'), entry('9', 'main.rs'), entry('10', 'core.bin'), entry('11', 'Agent panel.fig'),
];

describe('grouping and filter', () => {
  it('sorts uploads into Documents, Data, Media, and Code and archives', () => {
    expect(['notes.md', 'a.mdx', 'spec.html', 'a.pdf', 'a.docx', 'a.pptx', 'a.txt'].map(name => uploadGroupOf(name))).toEqual(Array(7).fill('documents'));
    expect(['a.csv', 'a.tsv', 'a.json', 'a.xlsx', 'a.yaml', 'a.xml'].map(name => uploadGroupOf(name))).toEqual(Array(6).fill('data'));
    expect(['a.png', 'a.svg', 'a.mp4', 'a.m4a', 'a.ttf', 'a.woff2', 'a.fig'].map(name => uploadGroupOf(name))).toEqual(Array(7).fill('media'));
    expect(['a.zip', 'a.rs', 'a.bin', 'noext'].map(name => uploadGroupOf(name))).toEqual(Array(4).fill('code'));
    expect(uploadGroupOf('x', 'image/png')).toBe('media');
  });
  it('groups with counts, hides empty groups and filters by name or session, case-insensitively', () => {
    const groups = groupUploads(files, '');
    expect(groups.map(g => [g.label, g.count])).toEqual([['Documents', 2], ['Data', 2], ['Media', 4], ['Code and archives', 3]]);
    expect(groupUploads(files, 'MD').map(g => g.items.map(i => i.name))).toEqual([['notes.md']]);
    expect(groupUploads(files, 'filter resume').map(g => g.items.map(i => i.name))).toEqual([['export.csv']]);
    expect(groupUploads(files, 'nothing matches')).toEqual([]);
  });
  it('builds visible rows and skips the items of collapsed groups', () => {
    const groups = groupUploads(files.slice(0, 4), '');
    expect(visibleRows(groups, new Set()).map(r => r.key)).toEqual(['g:documents', 'f:1', 'f:2', 'g:data', 'f:3', 'f:4']);
    expect(visibleRows(groups, new Set(['documents'])).map(r => r.key)).toEqual(['g:documents', 'g:data', 'f:3', 'f:4']);
  });
});

describe('rename validation', () => {
  const current = files[0];
  it.each([
    ['', 'Enter a name.'],
    ['   ', 'Enter a name.'],
    [' lead.md', 'Names cannot start or end with a space.'],
    ['a/b.md', 'Names cannot contain / or \\.'],
    ['a\\b.md', 'Names cannot contain / or \\.'],
    ['..', 'That name is reserved.'],
    ['a\u0007.md', 'Names cannot contain control characters.'],
    ['x'.repeat(256), 'Names are limited to 255 characters.'],
    ['SPEC.HTML', 'Another upload already has this name.'],
  ])('%j gives %s', (name, message) => { expect(validateRename(name, current, files)).toBe(message); });
  it('accepts a valid new name and the unchanged name', () => {
    expect(validateRename('release-notes.md', current, files)).toBeNull();
    expect(validateRename('notes.md', current, files)).toBeNull();
  });
});

describe('keyboard navigation in the uploads tree', () => {
  const groups = groupUploads(files.slice(0, 4), '');
  const rows = visibleRows(groups, new Set());
  const press = (key: string, focused: string, extra: Partial<KeyboardEvent> = {}, options: { canReveal?: boolean; platform?: 'mac' | 'windows' } = {}) =>
    navigateTree(rows, focused, { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra }, { canReveal: false, platform: 'mac', ...options });
  it('moves with arrows, Home and End', () => {
    expect(press('ArrowDown', 'f:1')).toEqual({ type: 'focus', key: 'f:2' });
    expect(press('ArrowDown', 'f:4')).toEqual({ type: 'focus', key: 'f:4' });
    expect(press('ArrowUp', 'f:1')).toEqual({ type: 'focus', key: 'g:documents' });
    expect(press('Home', 'f:4')).toEqual({ type: 'focus', key: 'g:documents' });
    expect(press('End', 'f:1')).toEqual({ type: 'focus', key: 'f:4' });
  });
  it('collapses and expands groups with Left, Right and Enter, and Left on a file goes to its group', () => {
    expect(press('ArrowLeft', 'g:data')).toEqual({ type: 'collapse', group: 'data' });
    expect(press('ArrowRight', 'g:data')).toEqual({ type: 'expand', group: 'data' });
    expect(press('Enter', 'g:data')).toEqual({ type: 'toggle', group: 'data' });
    expect(press('ArrowLeft', 'f:4')).toEqual({ type: 'focus', key: 'g:data' });
  });
  it('opens with Enter, pins with Space, renames with F2, removes with Delete or Backspace', () => {
    expect(press('Enter', 'f:3')).toEqual({ type: 'open', id: '3' });
    expect(press(' ', 'f:3')).toEqual({ type: 'pin', id: '3' });
    expect(press('F2', 'f:3')).toEqual({ type: 'rename', id: '3' });
    expect(press('Delete', 'f:3')).toEqual({ type: 'remove', id: '3' });
    expect(press('Backspace', 'f:3', { metaKey: true })).toEqual({ type: 'remove', id: '3' });
    expect(press('F10', 'f:3', { shiftKey: true })).toEqual({ type: 'menu', id: '3' });
    expect(press('ContextMenu', 'f:3')).toEqual({ type: 'menu', id: '3' });
  });
  it('reveals with Cmd+Alt+R on macOS and Ctrl+Alt+R elsewhere, only when the handler exists', () => {
    expect(press('r', 'f:3', { metaKey: true, altKey: true })).toBeNull();
    expect(press('r', 'f:3', { metaKey: true, altKey: true }, { canReveal: true })).toEqual({ type: 'reveal', id: '3' });
    expect(press('®', 'f:3', { metaKey: true, altKey: true, code: 'KeyR' } as never, { canReveal: true })).toEqual({ type: 'reveal', id: '3' });
    expect(press('r', 'f:3', { ctrlKey: true, altKey: true }, { canReveal: true, platform: 'windows' })).toEqual({ type: 'reveal', id: '3' });
    expect(press('r', 'f:3', { ctrlKey: true, altKey: true }, { canReveal: true, platform: 'mac' })).toBeNull();
  });
  it('ignores other keys', () => { expect(press('x', 'f:3')).toBeNull(); });
});

describe('menu gating', () => {
  const labels = (items: MenuItem[]) => items.map(item => item.label);
  const all: UploadsCapabilities = { add: true, rename: true, duplicate: true, remove: true, saveToWorkspace: true, reveal: true, openWithSystem: true, chooseApplication: true, copyPath: true, usage: true };
  const run = () => vi.fn();
  const handlers = () => ({ openPreview: run(), openKeep: run(), setViewAs: run(), saveToWorkspace: run(), reveal: run(), copyPath: run(), showInSession: run(), rename: run(), duplicate: run(), remove: run(), openWithSystem: run(), chooseApplication: run() });
  it('shows every design entry when everything is supported, with shortcuts only for bound keys', () => {
    const items = fileMenuItems(files[0], all, handlers(), { viewAs: 'preview', platform: 'mac' });
    expect(labels(items)).toEqual(['Open preview', 'Open and keep', 'Open with', 'Save to workspace…', 'Reveal in Finder', 'Copy path', 'Show in session', 'Rename…', 'Duplicate', 'Remove upload']);
    expect(items.find(i => i.label === 'Open preview')?.shortcut).toBe('↵');
    expect(items.find(i => i.label === 'Rename…')?.shortcut).toBe('F2');
    expect(items.find(i => i.label === 'Remove upload')).toMatchObject({ shortcut: '⌫', danger: true });
    expect(items.find(i => i.label === 'Reveal in Finder')?.shortcut).toBe('⌥⌘R');
    expect(items.find(i => i.label === 'Save to workspace…')?.shortcut).toBeUndefined();
    expect(items.find(i => i.label === 'Copy path')?.shortcut).toBeUndefined();
    const openWith = items.find(i => i.label === 'Open with')!;
    expect(labels(openWith.children!)).toEqual(['Span preview', 'Binary (hex)', 'System default app', 'Choose application…']);
    expect(openWith.children!.map(i => !!i.checked)).toEqual([true, false, false, false]);
  });
  it('hides each entry whose capability is missing, even when a handler exists', () => {
    const items = fileMenuItems(files[0], NO_CAPABILITIES, handlers(), { viewAs: 'hex', platform: 'windows' });
    expect(labels(items)).toEqual(['Open preview', 'Open and keep', 'Open with', 'Show in session']);
    const openWith = items.find(i => i.label === 'Open with')!;
    expect(labels(openWith.children!)).toEqual(['Span preview', 'Binary (hex)']);
    expect(openWith.children!.map(i => !!i.checked)).toEqual([false, true]);
  });
  it('hides entries without a handler and uses platform wording', () => {
    const items = fileMenuItems(files[0], all, { openPreview: run(), setViewAs: run(), reveal: run() }, { viewAs: 'preview', platform: 'windows' });
    expect(labels(items)).toEqual(['Open preview', 'Open with', 'Show in File Explorer']);
    expect(items.at(-1)?.shortcut).toBe('Ctrl+Alt+R');
    expect(revealLabel('linux')).toBe('Show in file manager');
  });
  it('builds the tab menu with close variants, Keep open only for preview tabs, and gated path actions', () => {
    const tab = { close: run(), closeOthers: run(), closeRight: run(), closeAll: run(), keepOpen: run(), setViewAs: run(), copyPath: run(), reveal: run() };
    const items = tabMenuItems(files[0], all, tab, { viewAs: 'preview', platform: 'mac', preview: true, hasOthers: true, hasRight: false });
    expect(labels(items)).toEqual(['Close', 'Close others', 'Close to the right', 'Close all', 'Keep open', 'Open with', 'Copy path', 'Reveal in Finder']);
    expect(items.find(i => i.label === 'Close to the right')?.disabled).toBe(true);
    const pinned = tabMenuItems(files[0], NO_CAPABILITIES, tab, { viewAs: 'preview', platform: 'mac', preview: false, hasOthers: false, hasRight: false });
    expect(labels(pinned)).toEqual(['Close', 'Close others', 'Close to the right', 'Close all', 'Open with']);
  });
});

describe('source line', () => {
  it('says where a sent file came from and who created a generated one', () => {
    expect(sourceLine(entry('1', 'a.png', { createdAt: 1 }), () => '14:02')).toEqual({ verb: 'Attached in', session: 'Match the toggle spec', time: '14:02' });
    expect(sourceLine(entry('1', 'a.svg', { origin: 'generated', agent: { name: 'Codex' }, session: { title: 'Filter resume list' } }), () => '12:10')).toEqual({ verb: 'Created by Codex in', session: 'Filter resume list', time: '12:10' });
    expect(sourceLine(entry('1', 'a.svg', { origin: 'generated', session: undefined }), () => '')).toEqual({ verb: 'Created by an agent', session: undefined, time: undefined });
  });
  it('formats times relative to now', () => {
    const now = new Date(2026, 9, 28, 15, 0).getTime();
    expect(formatUploadTime(new Date(2026, 9, 28, 14, 2).getTime(), now)).toBe('14:02');
    expect(formatUploadTime(new Date(2026, 9, 27, 9, 0).getTime(), now)).toBe('Yesterday');
    expect(formatUploadTime(new Date(2026, 9, 21, 9, 0).getTime(), now)).toBe('Oct 21');
    expect(formatUploadTime(new Date(2025, 0, 2, 9, 0).getTime(), now)).toBe('Jan 2, 2025');
  });
});
