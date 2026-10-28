import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES } from './asset-preview';
import { MAX_ATTACHMENT_COUNT, MAX_FILE_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, PASTE_CHIP_MIN_LINES, addAttachments, bytesToBase64, classifyFile, createFileAttachment, createPastedText, createSelection, createWorkspaceFile, dedupeKey, gateAttachments, isInWorkspace, pastedTextName, planAttachment, previewText, rejectionReason, shouldChipPastedText, type Attachment, type PromptCapabilities } from './attachments';

const all: PromptCapabilities = { image: true, audio: true, embeddedContext: true };
const none: PromptCapabilities = { image: false, audio: false, embeddedContext: false };
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
const png = (n = 10, fill = 1) => createFileAttachment({ name: 'a.png', mime: 'image/png', bytes: bytes(n, fill), source: 'picked' });
const sized = (item: Attachment, size: number): Attachment => ({ ...item, size });

describe('classification', () => {
  it('classifies by mime, then extension', () => {
    expect(classifyFile('x.bin', 'image/webp')).toBe('image');
    expect(classifyFile('photo.JPG', '')).toBe('image');
    expect(classifyFile('notes.md', '')).toBe('file');
    expect(classifyFile('data', 'application/pdf')).toBe('file');
  });
  it('decodes text files and leaves binary content as bytes', () => {
    const text = createFileAttachment({ name: 'a.ts', mime: '', bytes: new TextEncoder().encode('let a = 1;'), source: 'dropped' });
    expect(text.kind).toBe('file'); expect(text.text).toBe('let a = 1;');
    const binary = createFileAttachment({ name: 'a.ts', mime: '', bytes: new Uint8Array([0xff, 0xfe, 0xfd]), source: 'dropped' });
    expect(binary.text).toBeUndefined();
  });
});

describe('pasted text', () => {
  it('chips only text over the line or character threshold', () => {
    expect(shouldChipPastedText('one line')).toBe(false);
    expect(shouldChipPastedText('x\n'.repeat(PASTE_CHIP_MIN_LINES - 2))).toBe(false);
    expect(shouldChipPastedText('x\n'.repeat(PASTE_CHIP_MIN_LINES))).toBe(true);
    expect(shouldChipPastedText('x'.repeat(2000))).toBe(true);
  });
  it('names the chip with the line count', () => {
    expect(pastedTextName('a\nb\nc')).toBe('Pasted text, 3 lines');
    expect(pastedTextName('a')).toBe('Pasted text, 1 line');
    const item = createPastedText('a\r\nb');
    expect(item).toMatchObject({ kind: 'text-paste', source: 'pasted', name: 'Pasted text, 2 lines', text: 'a\r\nb' });
  });
});

describe('limits and dedupe', () => {
  it('reuses the image cap and applies the file cap', () => {
    expect(rejectionReason([], sized(png(), MAX_IMAGE_BYTES + 1))).toMatch(/limit for images/);
    expect(rejectionReason([], sized(png(), MAX_IMAGE_BYTES))).toBeUndefined();
    const file = createFileAttachment({ name: 'a.txt', mime: '', bytes: bytes(5), source: 'picked' });
    expect(rejectionReason([], sized(file, MAX_FILE_BYTES + 1))).toMatch(/limit for files/);
  });
  it('rejects empty files, the count cap and the total cap', () => {
    expect(rejectionReason([], sized(png(), 0))).toBe('The file is empty.');
    const many = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, i) => png(10, i + 2));
    expect(rejectionReason(many, png(10, 200))).toMatch(/at most 12/);
    const big = [sized(png(10, 3), MAX_IMAGE_BYTES), sized(png(10, 4), MAX_IMAGE_BYTES)];
    const bigFile = (fill: number) => sized(createFileAttachment({ name: `f${fill}.txt`, mime: '', bytes: bytes(5, fill), source: 'picked' }), MAX_FILE_BYTES);
    expect(MAX_TOTAL_ATTACHMENT_BYTES).toBeGreaterThan(2 * MAX_IMAGE_BYTES);
    expect(rejectionReason([...big, bigFile(5), bigFile(6)], bigFile(7))).toMatch(/total attachment limit/);
  });
  it('dedupes by content and by workspace path, but not different content with the same name', () => {
    const a = png(10, 1);
    expect(rejectionReason([a], png(10, 1))).toBe('Already attached.');
    expect(rejectionReason([a], png(10, 2))).toBeUndefined();
    expect(dedupeKey(createWorkspaceFile('src/a.ts', 5))).toBe(dedupeKey(createWorkspaceFile('src/a.ts', 9)));
    const one = createSelection({ path: 'a.ts', text: 'x', start: 1, end: 2 });
    const two = createSelection({ path: 'a.ts', text: 'x', start: 3, end: 4 });
    expect(addAttachments([one], [two]).accepted).toHaveLength(1);
  });
  it('accepts what fits and reports each refusal with its name', () => {
    const result = addAttachments([png(10, 1)], [png(10, 1), sized(png(10, 9), MAX_IMAGE_BYTES + 1), png(10, 7)]);
    expect(result.accepted).toHaveLength(1);
    expect(result.items).toHaveLength(2);
    expect(result.rejected.map(item => item.name)).toEqual(['a.png', 'a.png']);
    expect(result.rejected[0].reason).toBe('Already attached.');
  });
});

describe('capability gate', () => {
  const text = createPastedText('hello\n'.repeat(20));
  it('sends rasters as image blocks only when the agent accepts images', () => {
    expect(planAttachment(png(), all)).toEqual({ mode: 'image' });
    expect(planAttachment(png(), { ...all, image: false })).toEqual({ mode: 'refuse', reason: 'This agent does not accept images.' });
  });
  it('sends text as a resource with embedded context and falls back to inline text without it', () => {
    expect(planAttachment(text, all)).toEqual({ mode: 'resource' });
    expect(planAttachment(text, none)).toEqual({ mode: 'text' });
    const selection = createSelection({ path: 'a.ts', text: 'x', start: 1, end: 1 });
    expect(planAttachment(selection, none)).toEqual({ mode: 'text' });
  });
  it('sends SVG as text, never as an image block', () => {
    const svg = createFileAttachment({ name: 'a.svg', mime: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>'), source: 'picked' });
    expect(svg.kind).toBe('image');
    expect(planAttachment(svg, all)).toEqual({ mode: 'resource' });
    expect(planAttachment(svg, none)).toEqual({ mode: 'text' });
  });
  it('refuses binary files without embedded context and audio without audio support', () => {
    const pdf = createFileAttachment({ name: 'a.pdf', mime: 'application/pdf', bytes: bytes(8), source: 'picked' });
    expect(planAttachment(pdf, all)).toEqual({ mode: 'resource' });
    expect(planAttachment(pdf, none)).toMatchObject({ mode: 'refuse', reason: expect.stringMatching(/binary/) });
    const audio = createFileAttachment({ name: 'a.mp3', mime: 'audio/mpeg', bytes: bytes(8), source: 'picked' });
    expect(planAttachment(audio, all)).toEqual({ mode: 'audio' });
    expect(planAttachment(audio, { ...all, audio: false })).toMatchObject({ mode: 'refuse', reason: 'This agent does not accept audio.' });
  });
  it('uses a resource link for path-only workspace files and refuses failed items', () => {
    expect(planAttachment(createWorkspaceFile('src/a.ts'), none)).toEqual({ mode: 'link' });
    expect(planAttachment({ ...png(), status: 'error', error: 'boom' }, all)).toEqual({ mode: 'refuse', reason: 'boom' });
  });
  it('splits a list into sendable and blocked with reasons', () => {
    const result = gateAttachments([png(), text], { image: false, audio: false, embeddedContext: true });
    expect(result.send.map(entry => entry.plan.mode)).toEqual(['resource']);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toMatch(/images/);
  });
});

describe('helpers', () => {
  it('bounds preview lines and line length', () => {
    const result = previewText(['a', 'b'.repeat(30), 'c', 'd'].join('\n'), 3, 10);
    expect(result.lines).toEqual(['a', `${'b'.repeat(10)}…`, 'c']);
    expect(result).toMatchObject({ totalLines: 4, truncated: true });
    expect(previewText('a\nb').truncated).toBe(false);
  });
  it('encodes bytes to base64 across chunk boundaries', () => {
    const data = bytes(0x8000 * 2 + 5, 65);
    expect(atob(bytesToBase64(data))).toBe('A'.repeat(data.length));
  });
  it('knows which items already live in the workspace', () => {
    expect(isInWorkspace(createWorkspaceFile('a.ts'))).toBe(true);
    expect(isInWorkspace(createSelection({ path: 'a.ts', text: 'x', start: 1, end: 1 }))).toBe(true);
    expect(isInWorkspace(png())).toBe(false);
  });
});

describe('audio attachments', () => {
  const mp3 = () => createFileAttachment({ name: 'note.mp3', mime: '', bytes: bytes(8), source: 'picked' });
  it('classifies audio by mime and by extension', () => {
    expect(classifyFile('x.bin', 'audio/ogg')).toBe('audio');
    for (const name of ['a.mp3', 'a.WAV', 'a.m4a', 'a.flac', 'a.ogg']) expect(classifyFile(name, '')).toBe('audio');
    expect(classifyFile('a.png', '')).toBe('image');
    expect(classifyFile('a.ts', '')).toBe('file');
    expect(mp3()).toMatchObject({ kind: 'audio', mime: 'audio/mpeg' });
    expect(createWorkspaceFile('sounds/a.wav').kind).toBe('audio');
  });
  it('sends audio inline only when the agent accepts it', () => {
    expect(planAttachment(mp3(), all)).toEqual({ mode: 'audio' });
    expect(planAttachment(mp3(), none)).toMatchObject({ mode: 'refuse', reason: 'This agent does not accept audio.' });
  });
  it('falls back to a resource link when the audio has a path but the agent lacks audio', () => {
    const withPath = { ...mp3(), path: 'sounds/note.mp3' };
    expect(planAttachment(withPath, none)).toEqual({ mode: 'link' });
    expect(planAttachment(withPath, all)).toEqual({ mode: 'audio' });
    expect(planAttachment(createWorkspaceFile('sounds/note.mp3'), none)).toEqual({ mode: 'link' });
  });
  it('gates audio like any other kind', () => {
    const result = gateAttachments([mp3()], none);
    expect(result.send).toHaveLength(0);
    expect(result.blocked[0].reason).toBe('This agent does not accept audio.');
  });
});
