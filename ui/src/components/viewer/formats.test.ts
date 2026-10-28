// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSV_PAGE_ROWS, CsvParser, csvSummary, detectHeader, isNumericCell, nextSort, pageLabel, parseCsv, parseCsvChunked, sniffDelimiter, sortedOrder } from './csv';
import { sanitizeHtmlForSandbox } from './html-sandbox';
import { mdxToMarkdown } from './mdx';
import { waveformPeaks, WAVEFORM_BARS } from './waveform';
import { FONT_MAX_BYTES, loadFontFromBytes, parseFontMeta } from './font-meta';

describe('CSV parser', () => {
  const rows = (text: string, delimiter: ',' | ';' | '\t' = ',') => parseCsv(text, delimiter).rows;
  it.each([
    ['plain', 'a,b\n1,2\n', [['a', 'b'], ['1', '2']]],
    ['quoted delimiter', '"a,1",b', [['a,1', 'b']]],
    ['escaped quotes', '"say ""hi""",x', [['say "hi"', 'x']]],
    ['embedded newline', '"line 1\nline 2",x\ny,z', [['line 1\nline 2', 'x'], ['y', 'z']]],
    ['CRLF endings', 'a,b\r\nc,d\r\n', [['a', 'b'], ['c', 'd']]],
    ['lone CR endings', 'a,b\rc,d', [['a', 'b'], ['c', 'd']]],
    ['BOM', '﻿name,age\nann,3', [['name', 'age'], ['ann', '3']]],
    ['ragged rows kept as is', 'a,b,c\n1\n2,3,4,5', [['a', 'b', 'c'], ['1'], ['2', '3', '4', '5']]],
    ['empty fields', ',,\n', [['', '', '']]],
    ['blank lines skipped', 'a\n\n\nb\n', [['a'], ['b']]],
    ['empty input', '', []],
    ['quote inside unquoted field is literal', 'a"b,c', [['a"b', 'c']]],
  ])('%s', (_name, text, expected) => { expect(rows(text)).toEqual(expected); });
  it('parses semicolon and tab files', () => {
    expect(rows('a;b\n"1;2";3', ';')).toEqual([['a', 'b'], ['1;2', '3']]);
    expect(rows('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('reports ragged rows, unterminated quotes and the widest row', () => {
    const result = parseCsv('a,b\n1\n"open,x', ',');
    expect(result.rows.at(-1)).toEqual(['open,x']);
    expect(result.ragged).toBe(2);
    expect(result.unterminated).toBe(true);
    expect(result.columns).toBe(2);
  });
  it('gives the same rows whatever the chunk boundaries are, including a split CRLF and a split escaped quote', () => {
    const text = 'id,note\r\n1,"he said ""yes"""\r\n2,"two\r\nlines"\r\n3,plain\r\n';
    const whole = parseCsv(text, ',').rows;
    for (let size = 1; size < 9; size++) {
      const parser = new CsvParser(',');
      for (let at = 0; at < text.length; at += size) parser.push(text.slice(at, at + size));
      expect(parser.finish().rows, `chunk size ${size}`).toEqual(whole);
    }
  });
  it('stops at the row cap and says so', () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i},x`).join('\n');
    const result = parseCsv(text, ',', 10);
    expect(result.rows).toHaveLength(10);
    expect(result.capped).toBe(true);
  });
  it('streams a large input in chunks, yielding between them, with progress', async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `${i},"v ${i}"`).join('\n');
    const progress: number[] = [];
    const result = await parseCsvChunked(text, { delimiter: ',', chunkChars: 4096, onProgress: p => progress.push(p) });
    expect(result.rows).toHaveLength(5000);
    expect(result.rows[4999]).toEqual(['4999', 'v 4999']);
    expect(progress.length).toBeGreaterThan(5);
    expect(progress.at(-1)).toBe(1);
  });
  it('can be cancelled', async () => {
    const controller = new AbortController();
    const pending = parseCsvChunked('a\n'.repeat(50000), { delimiter: ',', chunkChars: 100, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});

describe('CSV sniffing, header, sort and paging', () => {
  it('sniffs comma, semicolon and tab, ignoring delimiters inside quotes', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(sniffDelimiter('a;b;c\n1,5;2;3\n')).toBe(';');
    expect(sniffDelimiter('a\tb\n"x,y,z"\t2\n')).toBe('\t');
    expect(sniffDelimiter('"a;b";"c;d",e\n"x;y";"z;w",q\n')).toBe(',');
    expect(sniffDelimiter('single column\nno delimiters\n')).toBe(',');
    expect(sniffDelimiter('')).toBe(',');
  });
  it('detects a header row', () => {
    expect(detectHeader([['name', 'age'], ['ann', '3'], ['bo', '41']])).toBe(true);
    expect(detectHeader([['1', '2'], ['3', '4']])).toBe(false);
    expect(detectHeader([['x', 'x'], ['1', '2']])).toBe(false);
    expect(detectHeader([['', 'b'], ['1', '2']])).toBe(false);
    expect(detectHeader([['a', 'b'], ['a', 'c']])).toBe(false);
    expect(detectHeader([])).toBe(false);
  });
  it('recognises numbers', () => {
    for (const value of ['1', '-2.5', '1e3', '12,480', ' 7 ', '+0.5']) expect(isNumericCell(value), value).toBe(true);
    for (const value of ['', 'abc', '1.2.3', '12,48', '\u2014', '0x10']) expect(isNumericCell(value), value).toBe(false);
  });
  it('sorts numerically when a column is numeric, text otherwise, empty cells last, stably', () => {
    const body = [['b', '10'], ['a', '9'], ['c', ''], ['a', '100']];
    expect(sortedOrder(body, { column: 1, direction: 'asc' })).toEqual([1, 0, 3, 2]);
    expect(sortedOrder(body, { column: 1, direction: 'desc' })).toEqual([3, 0, 1, 2]);
    expect(sortedOrder(body, { column: 0, direction: 'asc' })).toEqual([1, 3, 0, 2]);
    expect(sortedOrder(body, null)).toEqual([0, 1, 2, 3]);
  });
  it('cycles sort ascending, descending, none, and resets on another column', () => {
    expect(nextSort(null, 2)).toEqual({ column: 2, direction: 'asc' });
    expect(nextSort({ column: 2, direction: 'asc' }, 2)).toEqual({ column: 2, direction: 'desc' });
    expect(nextSort({ column: 2, direction: 'desc' }, 2)).toBeNull();
    expect(nextSort({ column: 2, direction: 'desc' }, 0)).toEqual({ column: 0, direction: 'asc' });
  });
  it('labels paging', () => {
    expect(CSV_PAGE_ROWS).toBe(200);
    expect(pageLabel(200, 12480)).toBe('Showing rows 1 to 200 of 12,480');
    expect(pageLabel(37, 37)).toBe('Showing rows 1 to 37 of 37');
    expect(pageLabel(0, 0)).toBe('No rows');
  });
  it('summarises the delimiter and header', () => {
    expect(csvSummary(',', true)).toBe('Comma-separated · UTF-8 · header row detected');
    expect(csvSummary(';', false)).toBe('Semicolon-separated · UTF-8 · no header row');
    expect(csvSummary('\t', false)).toBe('Tab-separated · UTF-8 · no header row');
  });
});

describe('HTML sandbox sanitiser', () => {
  const run = (html: string) => sanitizeHtmlForSandbox(html);
  const body = (html: string) => new DOMParser().parseFromString(run(html).html, 'text/html');
  it.each([
    ['script element', '<p>a</p><script>alert(1)</script>', /<script/i],
    ['script with src', '<script src="https://x.test/a.js"></script>', /<script/i],
    ['onclick handler', '<button onclick="alert(1)">b</button>', /onclick/i],
    ['onerror handler', '<img src=x onerror="alert(1)">', /onerror/i],
    ['svg onload', '<svg onload="alert(1)"></svg>', /onload/i],
    ['javascript: link', '<a href="javascript:alert(1)">x</a>', /javascript:/i],
    ['javascript: with whitespace and case', '<a href=" JaVa\tScRiPt:alert(1)">x</a>', /script:/i],
    ['vbscript', '<a href="vbscript:msgbox(1)">x</a>', /vbscript/i],
    ['external image', '<img src="https://tracker.test/p.png">', /tracker\.test/],
    ['protocol relative image', '<img src="//tracker.test/p.png">', /tracker\.test/],
    ['external stylesheet link', '<link rel="stylesheet" href="https://cdn.test/a.css">', /cdn\.test/],
    ['external css url in style element', '<style>body{background:url("https://x.test/bg.png")}</style>', /x\.test/],
    ['external css url in style attribute', '<div style="background-image:url(http://x.test/a.png)">a</div>', /x\.test/],
    ['css import', '<style>@import url("https://x.test/a.css"); p{color:red}</style>', /@import|x\.test/],
    ['css import string form', '<style>@import "theme.css";</style>', /@import|theme\.css/],
    ['css escapes', '<style>p{background:u\\72l(https://x.test/a.png)}</style>', /x\.test/],
    ['iframe inside', '<iframe src="https://x.test"></iframe><iframe srcdoc="<script>1</script>"></iframe>', /<iframe/i],
    ['object and embed', '<object data="a.swf"></object><embed src="b.swf">', /<object|<embed/i],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://x.test">', /refresh|x\.test/i],
    ['base tag', '<base href="https://x.test/"><a href="a.html">a</a>', /<base|x\.test/i],
    ['form action', '<form action="https://x.test/post"><input></form>', /x\.test/],
    ['srcset', '<img srcset="https://x.test/a.png 1x">', /x\.test/],
    ['video poster', '<video poster="https://x.test/p.png"></video>', /x\.test/],
    ['svg use external', '<svg><use href="https://x.test/s.svg#a"></use></svg>', /x\.test/],
    ['data html url', '<a href="data:text/html,<script>1</script>">x</a>', /data:text\/html/],
  ])('removes %s', (_name, html, forbidden) => {
    const result = run(html);
    const withoutPolicy = result.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
    expect(withoutPolicy).not.toMatch(forbidden);
  });
  it('keeps inert content, local anchors and inline data images', () => {
    const doc = body('<h1 id="t">Theme toggle</h1><p style="color:red">ok</p><a href="#t">jump</a><img alt="dot" src="data:image/png;base64,AAAA">');
    expect(doc.querySelector('h1')?.textContent).toBe('Theme toggle');
    expect(doc.querySelector('p')?.getAttribute('style')).toContain('color');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('#t');
    expect(doc.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png/);
  });
  it('adds a no-network content security policy as a second line of defence', () => {
    expect(run('<p>a</p>').html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'[^"]*">/);
  });
  it('lists referenced local files that are not available, once each', () => {
    const result = run('<link rel="stylesheet" href="spec.css"><img src="img/logo.png"><img src="img/logo.png"><script src="analytics.js"></script><style>@import "theme.css";</style>');
    expect(result.missing).toEqual(['spec.css', 'img/logo.png', 'analytics.js', 'theme.css']);
    expect(result.removed.scripts).toBeGreaterThan(0);
  });
  it('counts what it removed', () => {
    const result = run('<script>1</script><b onclick="x()">a</b><img src="https://x.test/a.png"><iframe></iframe>');
    expect(result.removed).toEqual({ scripts: 1, handlers: 1, external: 1, frames: 1 });
  });
});

describe('MDX safety', () => {
  const hostile = [
    'import { Callout } from "../components/Callout";',
    'export const meta = { section: "Agent panel" };',
    'export default function Layout() { alert("ran"); }',
    '',
    '# Steering and queueing',
    '',
    'Press <Kbd>Enter</Kbd> to steer. {alert("expression")}',
    '',
    '<Callout type="note">',
    '  External agents cannot take input mid-turn.',
    '</Callout>',
    '<Widget onLoad={() => alert(1)} />',
  ].join('\n');
  it('keeps the markdown, drops imports, exports, component tags and expressions, and names the components', () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const result = mdxToMarkdown(hostile);
    expect(result.markdown).toContain('# Steering and queueing');
    expect(result.markdown).toContain('Press Enter to steer.');
    expect(result.markdown).toContain('External agents cannot take input mid-turn.');
    expect(result.markdown).not.toMatch(/import|export|alert|<Callout|<Kbd|<Widget|onLoad/);
    expect(result.components).toEqual(['Callout', 'Kbd', 'Widget']);
    expect(result.removedExpressions).toBe(1);
    expect(alert).not.toHaveBeenCalled();
  });
  it('leaves fenced code untouched', () => {
    const result = mdxToMarkdown('```tsx\nimport x from "y";\n<Comp />\n```\n');
    expect(result.markdown).toContain('import x from "y";');
    expect(result.markdown).toContain('<Comp />');
    expect(result.components).toEqual([]);
  });
});

describe('waveform downsampling', () => {
  it('produces one peak per bar, normalised to the loudest bar', () => {
    const samples = new Float32Array(1100);
    for (let i = 0; i < samples.length; i++) samples[i] = i < 550 ? 0.25 : -0.5;
    const peaks = waveformPeaks([samples], 110);
    expect(peaks).toHaveLength(110);
    expect(peaks[0]).toBeCloseTo(0.5);
    expect(peaks[109]).toBeCloseTo(1);
  });
  it('takes the loudest channel and handles silence, empty and short input', () => {
    const left = new Float32Array([0, 0, 0, 0]); const right = new Float32Array([0, 0.8, 0, 0]);
    expect(waveformPeaks([left, right], 2)).toEqual([1, 0]);
    expect(waveformPeaks([new Float32Array(10)], 5)).toEqual([0, 0, 0, 0, 0]);
    expect(waveformPeaks([], 3)).toEqual([0, 0, 0]);
    expect(waveformPeaks([new Float32Array([0.5])], 4)).toHaveLength(4);
    expect(WAVEFORM_BARS).toBe(110);
  });
});

/** Minimal sfnt with a name table (Windows UTF-16BE) and maxp. */
function fakeFont(): Uint8Array {
  const names: [number, string][] = [[1, 'Span Mono'], [2, 'Regular'], [5, 'Version 2.304; ttfautohint'], [13, 'This Font Software is licensed under the SIL Open Font License, Version 1.1.']];
  const strings = names.map(([, text]) => { const out = new Uint8Array(text.length * 2); for (let i = 0; i < text.length; i++) { out[i * 2] = 0; out[i * 2 + 1] = text.charCodeAt(i); } return out; });
  const nameSize = 6 + names.length * 12 + strings.reduce((sum, s) => sum + s.length, 0);
  const maxpSize = 6;
  const tableStart = 12 + 2 * 16;
  const buffer = new Uint8Array(tableStart + nameSize + maxpSize);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, 0x00010000); view.setUint16(4, 2);
  const tag = (at: number, value: string) => { for (let i = 0; i < 4; i++) buffer[at + i] = value.charCodeAt(i); };
  tag(12, 'maxp'); view.setUint32(12 + 8, tableStart + nameSize); view.setUint32(12 + 12, maxpSize);
  tag(28, 'name'); view.setUint32(28 + 8, tableStart); view.setUint32(28 + 12, nameSize);
  view.setUint16(tableStart, 0); view.setUint16(tableStart + 2, names.length); view.setUint16(tableStart + 4, 6 + names.length * 12);
  let offset = 0;
  names.forEach(([id], i) => {
    const at = tableStart + 6 + i * 12;
    view.setUint16(at, 3); view.setUint16(at + 2, 1); view.setUint16(at + 4, 0x409); view.setUint16(at + 6, id);
    view.setUint16(at + 8, strings[i].length); view.setUint16(at + 10, offset);
    buffer.set(strings[i], tableStart + 6 + names.length * 12 + offset); offset += strings[i].length;
  });
  view.setUint32(tableStart + nameSize, 0x00005000); view.setUint16(tableStart + nameSize + 4, 1140);
  return buffer;
}

describe('font metadata', () => {
  it('reads family, style, version, licence and glyph count from the name and maxp tables', () => {
    expect(parseFontMeta(fakeFont())).toEqual({ format: 'TrueType', family: 'Span Mono', style: 'Regular', version: 'v2.304', license: 'SIL Open Font License', glyphs: 1140 });
  });
  it('recognises formats by signature and rejects anything else', () => {
    const sig = (text: string) => new Uint8Array([...text].map(c => c.charCodeAt(0)).concat(Array(40).fill(0)));
    expect(parseFontMeta(sig('OTTO')).format).toBe('OpenType');
    expect(parseFontMeta(sig('wOFF')).format).toBe('WOFF');
    expect(parseFontMeta(sig('wOF2')).format).toBe('WOFF2');
    expect(() => parseFontMeta(sig('ttcf'))).toThrow(/collection/i);
    expect(() => parseFontMeta(sig('<htm'))).toThrow(/not a font/i);
    expect(() => parseFontMeta(new Uint8Array(3))).toThrow(/not a font/i);
  });
  it('survives a truncated or lying table directory', () => {
    const font = fakeFont();
    new DataView(font.buffer).setUint32(28 + 8, 0xfffffff0);
    expect(parseFontMeta(font)).toEqual({ format: 'TrueType', glyphs: 1140 });
    expect(parseFontMeta(font.subarray(0, 20))).toEqual({ format: 'TrueType' });
  });
});

describe('font loader', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('loads from bytes, registers the face and removes it on dispose', async () => {
    const added = new Set<unknown>();
    const fonts = { add: (face: unknown) => added.add(face), delete: (face: unknown) => added.delete(face) };
    class FakeFace { constructor(public family: string, public source: ArrayBuffer) {} load() { return Promise.resolve(this); } }
    const loaded = await loadFontFromBytes(fakeFont(), { FontFace: FakeFace as never, fonts: fonts as never });
    expect(added.size).toBe(1);
    expect(loaded.family).toMatch(/^span-viewer-font-\d+$/);
    loaded.dispose();
    expect(added.size).toBe(0);
    loaded.dispose();
  });
  it('rejects oversize fonts and failed loads without leaving a face behind', async () => {
    const added = new Set<unknown>();
    const fonts = { add: (face: unknown) => added.add(face), delete: (face: unknown) => added.delete(face) };
    class Broken { constructor(public family: string) {} load() { return Promise.reject(new Error('OTS parsing error')); } }
    await expect(loadFontFromBytes(new Uint8Array(FONT_MAX_BYTES + 1), { FontFace: Broken as never, fonts: fonts as never })).rejects.toThrow(/larger than/);
    await expect(loadFontFromBytes(fakeFont(), { FontFace: Broken as never, fonts: fonts as never })).rejects.toThrow(/could not load this font/);
    expect(added.size).toBe(0);
    await expect(loadFontFromBytes(fakeFont(), { fonts: fonts as never })).rejects.toThrow(/not available/);
  });
});
