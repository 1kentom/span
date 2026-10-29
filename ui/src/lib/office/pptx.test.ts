// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { aspectLabel, emuBox, parsePptx, ptToStage, resolvePart } from './pptx';
import { buildPptx } from './test-fixtures';

describe('EMU to stage scaling', () => {
  it('maps xfrm offsets and extents to percentages of the slide', () => {
    expect(emuBox({ x: 0, y: 0, cx: 12192000, cy: 6858000 }, { cx: 12192000, cy: 6858000 })).toEqual({ left: 0, top: 0, width: 100, height: 100 });
    expect(emuBox({ x: 3048000, y: 1714500, cx: 6096000, cy: 3429000 }, { cx: 12192000, cy: 6858000 })).toEqual({ left: 25, top: 25, width: 50, height: 50 });
  });
  it('clamps boxes that run off the slide and ignores negative extents', () => {
    expect(emuBox({ x: -1000, y: 0, cx: 20000000, cy: -5 }, { cx: 10000, cy: 10000 })).toEqual({ left: 0, top: 0, width: 100, height: 0 });
  });
  it('converts point sizes to a share of the stage height', () => {
    // 6858000 EMU tall = 540 pt, so 54 pt is a tenth of the height.
    expect(ptToStage(54, 6858000)).toBeCloseTo(10, 5);
  });
  it('labels the aspect ratio', () => {
    expect(aspectLabel({ cx: 12192000, cy: 6858000 })).toBe('16:9');
    expect(aspectLabel({ cx: 9144000, cy: 6858000 })).toBe('4:3');
    expect(aspectLabel({ cx: 10000000, cy: 6250000 })).toBe('16:10');
  });
  it('resolves relationship targets against the part folder', () => {
    expect(resolvePart('ppt/slides/slide1.xml', '../media/image1.png')).toBe('ppt/media/image1.png');
    expect(resolvePart('ppt/presentation.xml', 'slides/slide2.xml')).toBe('ppt/slides/slide2.xml');
    expect(resolvePart('ppt/slides/slide1.xml', '/ppt/media/a.png')).toBe('ppt/media/a.png');
    expect(resolvePart('ppt/slides/slide1.xml', '../../../../etc/passwd')).toBe('etc/passwd');
  });
});

describe('presentation parsing', () => {
  it('reads slides in order with titles, bullets, levels and notes mapped to their slide', () => {
    const deck = parsePptx(buildPptx([
      { title: 'Agent panel review', bullets: ['Steering', 'Queueing', 'Nested'], notes: 'Start with the queue.' },
      { title: 'No notes' },
      { title: 'Third', notes: 'Last words.' },
    ]));
    expect(deck.slides.map(s => s.title)).toEqual(['Agent panel review', 'No notes', 'Third']);
    expect(deck.slides.map(s => s.notes)).toEqual(['Start with the queue.', '', 'Last words.']);
    const body = deck.slides[0].shapes.find(s => s.kind === 'text' && s.role === 'body');
    expect(body && body.kind === 'text' && body.paragraphs.map(p => [p.text, p.level, p.bullet])).toEqual([['Steering', 0, true], ['Queueing', 0, true], ['Nested', 1, true]]);
    expect(deck.aspect).toBe('16:9');
  });
  it('inherits placeholder positions from the layout and sizes from the master text styles', () => {
    const deck = parsePptx(buildPptx([{ title: 'Inherited', layoutTitle: true, bullets: ['One'] }]));
    const title = deck.slides[0].shapes.find(s => s.kind === 'text' && s.role === 'title')!;
    expect(title.box.left).toBeCloseTo(838200 / 12192000 * 100, 4);
    const body = deck.slides[0].shapes.find(s => s.kind === 'text' && s.role === 'body')!;
    expect(body.box.top).toBeCloseTo(1825625 / 6858000 * 100, 4);
    expect(title.kind === 'text' && title.paragraphs[0].runs[0].size).toBe(40);
    expect(body.kind === 'text' && body.paragraphs[0].runs[0].size).toBe(24);
  });
  it('embeds local images as data URLs, never loads linked ones and labels charts', () => {
    const deck = parsePptx(buildPptx([{ title: 'Media', image: true, chart: true }, { title: 'Linked', externalImage: true }]));
    const image = deck.slides[0].shapes.find(s => s.kind === 'image');
    expect(image && image.kind === 'image' && image.src?.startsWith('data:image/png;base64,')).toBe(true);
    expect(image && image.kind === 'image' && image.alt).toBe('Chart screenshot');
    expect(deck.slides[0].shapes.find(s => s.kind === 'placeholder')).toMatchObject({ label: 'Chart' });
    const linked = deck.slides[1].shapes.find(s => s.kind === 'image');
    expect(linked).toMatchObject({ omitted: 'Linked image not loaded' });
    expect(linked && 'src' in linked).toBe(false);
    expect(JSON.stringify(deck)).not.toContain('example.com');
  });
  it('caps the number of slides and says so', () => {
    const deck = parsePptx(buildPptx(Array.from({ length: 5 }, (_, i) => ({ title: `S${i}` }))), { maxSlides: 3 });
    expect(deck.slides).toHaveLength(3);
    expect(deck.totalSlides).toBe(5);
  });
});
