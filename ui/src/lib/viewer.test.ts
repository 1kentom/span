import { describe, expect, it } from 'vitest';
import { OFFICE_PREVIEW_BYTES } from './office/limits';
import {
  FONT_READ_BYTES, HEX_PREVIEW_BYTES, MAX_IMAGE_BYTES, MAX_SVG_BYTES, MEDIA_MAX_BYTES, PLAYBACK_SPEEDS, TEXT_PREVIEW_BYTES, ZOOM_MAX, ZOOM_MIN, bytesToDataUrl, classifyFile, clampVolume, clampZoom, closeAllTabs, closeOtherTabs,
  closeTab, closeTabsToRight, decodeTextPreview, fitPercent, formatDuration, hexRows, isLikelyBinary, isPreviewTab, jsonRows, lineEnding, mediaKeyAction, modeLabelFor, modeUsesIcons, openTab, parseJson, pinTab,
  readLimit, removeFromTabs, seekTarget, splitLines, stepZoom, supportedModes, wheelZoom, type ViewerTabs,
} from './viewer';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('classifyFile', () => {
  it('maps supported kinds by extension or mime', () => {
    expect(classifyFile('a.PNG').kind).toBe('image');
    expect(classifyFile('x', 'image/webp').kind).toBe('image');
    expect(classifyFile('logo.svg').kind).toBe('svg');
    expect(classifyFile('clip.mp4').kind).toBe('video');
    expect(classifyFile('talk.m4a').kind).toBe('audio');
    expect(classifyFile('notes.md').kind).toBe('markdown');
    expect(classifyFile('data.json').kind).toBe('json');
    expect(classifyFile('main.rs').kind).toBe('text');
    expect(classifyFile('noext').kind).toBe('text');
  });
  it('maps the new viewers: CSV and TSV, HTML, MDX and fonts', () => {
    expect(classifyFile('a.csv').kind).toBe('csv');
    expect(classifyFile('a.tsv').kind).toBe('csv');
    expect(classifyFile('x', 'text/csv').kind).toBe('csv');
    expect(classifyFile('a.html').kind).toBe('html');
    expect(classifyFile('a.htm').kind).toBe('html');
    expect(classifyFile('a.mdx').kind).toBe('mdx');
    for (const name of ['a.ttf', 'a.otf', 'a.woff', 'a.woff2']) expect(classifyFile(name).kind).toBe('font');
  });
  it('sends out-of-scope formats to the unsupported state, never to a fake preview', () => {
    for (const name of ['a.pdf', 'a.docx', 'a.pptx', 'a.xlsx', 'a.zip', 'a.tgz']) expect(classifyFile(name)).toMatchObject({ kind: 'unsupported', reason: 'not-yet' });
    expect(classifyFile('a.psd')).toMatchObject({ kind: 'unsupported', reason: 'format', label: 'Photoshop' });
    expect(classifyFile('a.heic', 'image/heic')).toMatchObject({ kind: 'unsupported', reason: 'format' });
    expect(classifyFile('Agent panel.fig')).toMatchObject({ kind: 'unsupported', reason: 'format', label: 'Figma' });
  });
  it('offers modes only where a second representation exists', () => {
    for (const kind of ['svg', 'markdown', 'mdx', 'html'] as const) expect(supportedModes(kind)).toEqual(['preview', 'split', 'source']);
    expect(supportedModes('json')).toEqual(['preview', 'source']);
    expect(supportedModes('csv')).toEqual(['preview', 'source']);
    for (const kind of ['image', 'text', 'audio', 'video', 'font', 'unsupported'] as const) expect(supportedModes(kind)).toEqual([]);
  });
  it('labels modes per kind', () => {
    expect(modeLabelFor('json', 'preview')).toBe('Tree');
    expect(modeLabelFor('json', 'source')).toBe('Raw');
    expect(modeLabelFor('csv', 'preview')).toBe('Table');
    expect(modeLabelFor('csv', 'source')).toBe('Raw');
    expect(modeLabelFor('markdown', 'split')).toBe('Split');
    expect(modeUsesIcons('markdown')).toBe(true);
    expect(modeUsesIcons('json')).toBe(false);
  });
  it('reads only as many bytes as each viewer can use', () => {
    expect(readLimit('a.png', '', 100)).toBe(100);
    expect(readLimit('a.png', '', MAX_IMAGE_BYTES + 5)).toBe(0);
    expect(readLimit('a.svg', '', 10 * 1024 * 1024)).toBe(MAX_SVG_BYTES + 1);
    expect(readLimit('a.csv', '', 50 * 1024 * 1024)).toBe(TEXT_PREVIEW_BYTES + 4);
    expect(readLimit('a.txt', '', 50)).toBe(50);
    expect(readLimit('a.ttf', '', FONT_READ_BYTES + 10)).toBe(0);
    expect(readLimit('a.mp4', '', MEDIA_MAX_BYTES + 1)).toBe(0);
    expect(readLimit('a.pdf', '', 10 * 1024 * 1024)).toBe(10 * 1024 * 1024);
    expect(readLimit('a.png', '', 10 * 1024 * 1024, true)).toBe(HEX_PREVIEW_BYTES);
  });
});

describe('zoom', () => {
  it('uses one range, 10 to 800, in steps of 25, starting from 100 when fitting', () => {
    expect(ZOOM_MIN).toBe(10); expect(ZOOM_MAX).toBe(800);
    expect(stepZoom('fit', 1)).toBe(125);
    expect(stepZoom('fit', -1)).toBe(75);
    expect(stepZoom(20, -1)).toBe(10);
    expect(stepZoom(790, 1)).toBe(800);
    expect(stepZoom(800, 1)).toBe(800);
  });
  it('clamps, fits and wheel-zooms within the range', () => {
    expect(clampZoom(5)).toBe(10); expect(clampZoom(9000)).toBe(800); expect(clampZoom(123.4)).toBe(123);
    expect(fitPercent(2000, 1000, 500, 500)).toBe(25);
    expect(fitPercent(100, 50, 800, 600)).toBe(100);
    expect(fitPercent(40000, 10, 400, 400)).toBe(10);
    expect(fitPercent(0, 0, 400, 400)).toBe(100);
    expect(wheelZoom(100, -100)).toBeGreaterThan(100);
    expect(wheelZoom(100, 100)).toBeLessThan(100);
    expect(wheelZoom(800, -1000)).toBe(800);
    expect(wheelZoom(10, 1000)).toBe(10);
  });
});

describe('text decoding', () => {
  it('limits to 2 MiB without splitting a multibyte character', () => {
    const data = new Uint8Array(TEXT_PREVIEW_BYTES + 10).fill(97);
    data.set(bytes('é'), TEXT_PREVIEW_BYTES - 1);
    const preview = decodeTextPreview(data)!;
    expect(preview.truncated).toBe(true);
    expect(preview.totalBytes).toBe(TEXT_PREVIEW_BYTES + 10);
    expect(preview.text).not.toContain('�');
  });
  it('rejects invalid UTF-8 and detects binary', () => {
    expect(decodeTextPreview(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
    expect(isLikelyBinary(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1]))).toBe(true);
    expect(isLikelyBinary(bytes('plain text\n'))).toBe(false);
  });
  it('splits lines and detects endings', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual(['']);
    expect(lineEnding('a\r\nb')).toBe('CRLF');
    expect(lineEnding('a\nb')).toBe('LF');
    expect(lineEnding('ab')).toBe('none');
  });
});

describe('hex rows', () => {
  it('formats offset, bytes and ascii and caps the view', () => {
    const view = hexRows(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x41]));
    expect(view.rows[0]).toEqual({ offset: '00000000', bytes: '7f 45 4c 46 02 01 01 00 41', ascii: '.ELF....A' });
    expect(view.truncated).toBe(false);
    const big = hexRows(new Uint8Array(HEX_PREVIEW_BYTES + 1));
    expect(big.rows).toHaveLength(HEX_PREVIEW_BYTES / 16);
    expect(big.truncated).toBe(true);
    expect(big.rows[1].offset).toBe('00000010');
  });
});

describe('json rows', () => {
  const value = { name: 'span', list: [1, 2], deep: { a: { b: { c: 1 } } }, ok: true, none: null };
  it('opens two levels by default and flips a path when toggled', () => {
    const rows = jsonRows(value).rows;
    expect(rows[0]).toMatchObject({ text: '{', meta: '5 keys', open: true });
    expect(rows.find(row => row.key === 'a')).toMatchObject({ kind: 'collapsed', text: '{…}', expandable: true });
    expect(rows.find(row => row.key === 'b')).toBeUndefined();
    const toggled = jsonRows(value, new Set(['$/deep/a', '$/deep/a/b'])).rows;
    expect(toggled.find(row => row.key === 'c')).toMatchObject({ text: '1', kind: 'number' });
    expect(jsonRows(value, new Set(['$'])).rows).toHaveLength(1);
  });
  it('caps rows and reports it', () => {
    const view = jsonRows(Array.from({ length: 50 }, (_, i) => i), new Set(), 10);
    expect(view.rows).toHaveLength(10);
    expect(view.truncated).toBe(true);
  });
  it('reports parse errors without throwing', () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJson('{oops')).toMatchObject({ ok: false });
  });
});

describe('media helpers', () => {
  it('maps the keyboard', () => {
    expect(mediaKeyAction(' ')).toEqual({ type: 'toggle' });
    expect(mediaKeyAction('ArrowRight')).toEqual({ type: 'seek', delta: 10 });
    expect(mediaKeyAction('ArrowLeft')).toEqual({ type: 'seek', delta: -10 });
    expect(mediaKeyAction('ArrowUp')).toEqual({ type: 'volume', delta: 0.1 });
    expect(mediaKeyAction('m')).toEqual({ type: 'mute' });
    expect(mediaKeyAction('j')).toEqual({ type: 'seek', delta: -10 });
    expect(mediaKeyAction('L')).toEqual({ type: 'seek', delta: 10 });
    expect(mediaKeyAction('k')).toEqual({ type: 'toggle' });
    expect(mediaKeyAction('x')).toBeUndefined();
  });
  it('offers the design speeds', () => { expect([...PLAYBACK_SPEEDS]).toEqual([0.75, 1, 1.5, 2]); });
  it('clamps seeking, volume and formats time', () => {
    expect(seekTarget(5, -10, 60)).toBe(0);
    expect(seekTarget(55, 10, 60)).toBe(60);
    expect(seekTarget(5, 10, NaN)).toBe(15);
    expect(clampVolume(1.4)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(formatDuration(64)).toBe('1:04');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(NaN)).toBe('0:00');
  });
  it('builds data URLs for large inputs', () => {
    expect(bytesToDataUrl(new Uint8Array([1, 2, 3]), 'image/png')).toBe('data:image/png;base64,AQID');
    expect(bytesToDataUrl(new Uint8Array(100000), 'image/png').length).toBeGreaterThan(100000);
  });
});

describe('tab model', () => {
  const empty: ViewerTabs = { tabs: [], active: null };
  it('replaces the preview tab on single click and keeps pinned tabs', () => {
    let state = openTab(empty, 'a');
    expect(state.tabs).toEqual([{ id: 'a', pinned: false }]);
    expect(isPreviewTab(state.tabs[0])).toBe(true);
    state = openTab(state, 'b');
    expect(state.tabs).toEqual([{ id: 'b', pinned: false }]);
    state = pinTab(state, 'b');
    state = openTab(state, 'c');
    expect(state.tabs).toEqual([{ id: 'b', pinned: true }, { id: 'c', pinned: false }]);
    expect(state.active).toBe('c');
    state = openTab(state, 'd');
    expect(state.tabs.map(tab => tab.id)).toEqual(['b', 'd']);
  });
  it('double-click keeps open, also when opening with pin', () => {
    let state = openTab(empty, 'a', true);
    expect(state.tabs[0].pinned).toBe(true);
    state = openTab(state, 'b');
    state = openTab(state, 'b', true);
    expect(state.tabs).toEqual([{ id: 'a', pinned: true }, { id: 'b', pinned: true }]);
    expect(pinTab(state, 'missing')).toBe(state);
  });
  it('activating an existing tab does not unpin or duplicate it', () => {
    const state = openTab(openTab(empty, 'a', true), 'a');
    expect(state.tabs).toEqual([{ id: 'a', pinned: true }]);
  });
  it('closing the active tab activates its neighbour, closing the last leaves none', () => {
    let state: ViewerTabs = { tabs: [{ id: 'a', pinned: true }, { id: 'b', pinned: true }, { id: 'c', pinned: true }], active: 'b' };
    state = closeTab(state, 'b');
    expect(state.active).toBe('c');
    state = closeTab(state, 'c');
    expect(state.active).toBe('a');
    state = closeTab(state, 'a');
    expect(state).toEqual({ tabs: [], active: null });
    expect(closeTab({ tabs: [{ id: 'a', pinned: true }], active: 'a' }, 'zzz').active).toBe('a');
  });
  const three: ViewerTabs = { tabs: [{ id: 'a', pinned: true }, { id: 'b', pinned: false }, { id: 'c', pinned: true }], active: 'c' };
  it('closes others, to the right and all', () => {
    expect(closeOtherTabs(three, 'b')).toEqual({ tabs: [{ id: 'b', pinned: false }], active: 'b' });
    expect(closeTabsToRight(three, 'a')).toEqual({ tabs: [{ id: 'a', pinned: true }], active: 'a' });
    expect(closeTabsToRight({ ...three, active: 'a' }, 'b')).toEqual({ tabs: three.tabs.slice(0, 2), active: 'a' });
    expect(closeTabsToRight(three, 'c')).toBe(three);
    expect(closeAllTabs()).toEqual({ tabs: [], active: null });
    expect(closeOtherTabs(three, 'missing')).toBe(three);
  });
  it('drops tabs of uploads that no longer exist', () => {
    expect(removeFromTabs(three, new Set(['a', 'b']))).toEqual({ tabs: three.tabs.slice(0, 2), active: 'b' });
    expect(removeFromTabs(three, new Set(['a', 'b', 'c']))).toBe(three);
  });
});


it.each([
  ['document.docx', '', 'docx'], ['slides.pptx', '', 'pptx'], ['book.xlsx', '', 'xlsx'], ['macros.xlsm', '', 'xlsx'],
  ['document.pdf', '', 'pdf'], ['archive.zip', '', 'archive'],
  ['download', 'application/pdf', 'pdf'], ['download', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['download', 'application/zip', 'archive'],
] as const)('reads the complete bounded %s document and leaves explicit hex reads capped', (name, mime, kind) => {
  const limit = OFFICE_PREVIEW_BYTES[kind];
  expect(readLimit(name, mime, 80 * 1024)).toBe(80 * 1024);
  expect(readLimit(name, mime, limit)).toBe(limit);
  expect(readLimit(name, mime, limit + 1)).toBe(0);
  expect(readLimit(name, mime, limit + 1, true)).toBe(HEX_PREVIEW_BYTES);
});
