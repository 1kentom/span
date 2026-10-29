// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildOutline, countWords, hasTrackedChanges, parseAppPages, parseComments, parseDocx } from './docx';
import { buildDocx } from './test-fixtures';
import { openZip } from './zip';

const fragmentOf = (html: string) => { const t = document.createElement('template'); t.innerHTML = html; return t.content; };

describe('docx outline', () => {
  it('builds an outline from headings with levels, text and ids', () => {
    const root = fragmentOf('<h1>Settings migration</h1><p>x</p><h2>Summary</h2><h3> Deep  heading </h3><h2></h2><h6>Six</h6>');
    const outline = buildOutline(root);
    expect(outline.map(h => [h.level, h.text])).toEqual([[1, 'Settings migration'], [2, 'Summary'], [3, 'Deep heading'], [6, 'Six']]);
    expect(new Set(outline.map(h => h.id)).size).toBe(4);
    expect(root.querySelector('h2')?.id).toBe(outline[1].id);
  });
  it('counts words from text', () => {
    expect(countWords('The settings page moves, to the shared form-components.')).toBe(8);
    expect(countWords('  ')).toBe(0);
    expect(countWords('日本語 text')).toBe(2);
  });
});

describe('docx parts', () => {
  it('reads pages from app.xml only when present', () => {
    expect(parseAppPages('<Properties xmlns="x"><Pages>3</Pages></Properties>')).toBe(3);
    expect(parseAppPages('<Properties xmlns="x"><Words>3</Words></Properties>')).toBeUndefined();
    expect(parseAppPages(undefined)).toBeUndefined();
  });
  it('reads comments with author, date, anchored text and replies', () => {
    const zip = openZip(buildDocx({ comments: true }));
    const comments = parseComments(zip.text('word/comments.xml'), zip.text('word/document.xml'), zip.text('word/commentsExtended.xml'));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'Maya', initials: 'M', text: 'Confirm with Ken that JSONC stays as is.', anchor: 'the JSONC editor is unchanged' });
    expect(comments[0].date).toBe('2026-10-27T10:00:00Z');
    expect(comments[0].replies.map(r => [r.author, r.text])).toEqual([['Ken', 'Confirmed.']]);
  });
  it('detects tracked changes', () => {
    expect(hasTrackedChanges(openZip(buildDocx({ tracked: true })).text('word/document.xml'))).toBe(true);
    expect(hasTrackedChanges(openZip(buildDocx()).text('word/document.xml'))).toBe(false);
  });
});

describe('parseDocx with mammoth', () => {
  it('converts headings, tables and images into sanitised html with meta', async () => {
    const doc = await parseDocx(buildDocx({ comments: true, pages: 3, image: true }));
    const host = document.createElement('div'); host.append(doc.fragment);
    expect(host.querySelector('h1')?.textContent).toBe('Settings migration');
    expect(host.querySelector('table td')?.textContent).toBe('Setting');
    expect(host.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(host.querySelector('script, [onclick], iframe')).toBeNull();
    expect(doc.outline.map(h => h.text)).toEqual(['Settings migration', 'Summary', 'What changed', 'Open questions']);
    expect(doc.pages).toBe(3);
    expect(doc.words).toBeGreaterThan(10);
    expect(doc.comments).toHaveLength(1);
    expect(doc.trackedChanges).toBe(false);
  });
  it('omits pages when app.xml has none and notes tracked changes', async () => {
    const doc = await parseDocx(buildDocx({ tracked: true }));
    expect(doc.pages).toBeUndefined();
    expect(doc.trackedChanges).toBe(true);
  });
  it('refuses a file without a document part as damaged', async () => {
    const { buildZip } = await import('./test-fixtures');
    await expect(parseDocx(buildZip({ 'a.txt': 'x' }))).rejects.toMatchObject({ kind: 'damaged' });
  });
});
