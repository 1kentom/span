// @vitest-environment jsdom
/**
 * jsdom has no canvas, so these tests mock the pdfjs loader with a fake document. They cover the view
 * logic (pages, lazy window, zoom, find, keyboard, cleanup, edge states), not pdfjs rendering fidelity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import PdfView from './PdfView';
import { mapPdfError, paperLabel, type PdfLoaded, type PdfLoader } from '../../../lib/office/pdf-loader';
import { OfficeError } from '../../../lib/office/zip';
import { tinyPdf } from '../../../lib/office/test-fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); });
const settle = async (rounds = 3) => { for (let r = 0; r < rounds; r++) { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise(res => setTimeout(res, 0)); } };
const mount = (view: () => any) => { const root = document.createElement('div'); document.body.append(root); cleanup.push(render(view, root)); return root; };
const until = async (check: () => unknown, tries = 40) => { for (let i = 0; i < tries && !check(); i++) await settle(1); };
const button = (root: ParentNode, name: string) => [...root.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const bytes = new TextEncoder().encode(tinyPdf);

function fakePdf(pages: string[][], version = '1.7') {
  const rendered: { page: number; scale: number }[] = [];
  const destroy = vi.fn(async () => undefined);
  const loaded: PdfLoaded = {
    version, destroy,
    doc: {
      numPages: pages.length,
      async getPage(n) {
        return {
          getViewport: ({ scale }) => ({ width: 595 * scale, height: 842 * scale, scale, transform: [scale, 0, 0, -scale, 0, 842 * scale] }),
          render: ({ viewport }) => { rendered.push({ page: n, scale: viewport.scale }); return { promise: Promise.resolve(), cancel: () => undefined }; },
          getTextContent: async () => ({ items: pages[n - 1].map((str, i) => ({ str, transform: [12, 0, 0, 12, 72, 700 - i * 20], width: str.length * 6 })) }),
          cleanup: () => undefined,
        };
      },
    },
  };
  return { loader: vi.fn(async () => loaded) as unknown as PdfLoader, rendered, destroy };
}

beforeEach(() => {
  // jsdom has no 2D context. A stub lets the render path run; nothing is drawn.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({}) as never);
});

describe('PdfView', () => {
  it('shows pages, meta, page input and renders only the pages in the window', async () => {
    const pdf = fakePdf(Array.from({ length: 12 }, (_, i) => [`Page ${i + 1} text`]));
    const meta = vi.fn();
    const root = mount(() => <PdfView name="audit.pdf" bytes={bytes} loader={pdf.loader} onMeta={meta} />);
    await until(() => root.querySelectorAll('.ox-pdf-page').length === 12);
    expect(meta).toHaveBeenLastCalledWith(['12 pages', 'A4', 'PDF 1.7', 'Scripts and links disabled']);
    expect(root.querySelector('.ox-toolbar')?.textContent).toContain('of 12');
    expect(root.querySelector<HTMLInputElement>('input[aria-label="Page number"]')?.value).toBe('1');
    await settle(2);
    const mainPages = new Set(pdf.rendered.filter(r => r.scale > 0.5).map(r => r.page));
    expect([...mainPages].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(root.querySelectorAll('.ox-pdf-page canvas')).toHaveLength(2);
    expect(root.querySelectorAll('.ox-pdf-thumb')).toHaveLength(12);
  });
  it('zooms in steps within 50 to 400 and back to fit width', async () => {
    const pdf = fakePdf([['a']]);
    const root = mount(() => <PdfView name="a.pdf" bytes={bytes} loader={pdf.loader} />);
    await until(() => root.querySelector('.vw-readout'));
    // jsdom reports a zero-width stage, so fit width falls back to 100 percent.
    expect(root.querySelector('.vw-readout')?.textContent).toBe('100%');
    button(root, 'Zoom in')!.click(); await settle(1);
    expect(root.querySelector('.vw-readout')?.textContent).toBe('125%');
    expect(button(root, 'Fit width')!.getAttribute('aria-pressed')).toBe('false');
    for (let i = 0; i < 10; i++) button(root, 'Zoom in')!.click();
    await settle(1);
    expect(root.querySelector('.vw-readout')?.textContent).toBe('400%');
    expect(button(root, 'Zoom in')!.disabled).toBe(true);
    button(root, 'Fit width')!.click(); await settle(1);
    expect(root.querySelector('.vw-readout')?.textContent).toBe('100%');
    root.querySelector('.ox-pdf-stage')!.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })); await settle(1);
    expect(root.querySelector('.vw-readout')?.textContent).toBe('90%');
  });
  it('finds text across pages with a count, highlights and next and previous', async () => {
    const pdf = fakePdf([['Contrast check'], ['Nothing here'], ['contrast ratio', 'CONTRAST']]);
    const root = mount(() => <PdfView name="a.pdf" bytes={bytes} loader={pdf.loader} />);
    await until(() => root.querySelector('input[aria-label="Find in document"]'));
    const find = root.querySelector<HTMLInputElement>('input[aria-label="Find in document"]')!;
    find.value = 'contrast'; find.dispatchEvent(new Event('input', { bubbles: true }));
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => root.querySelector('.ox-find-count')?.textContent === '1 of 3');
    expect(root.querySelector('.ox-find-count')?.textContent).toBe('1 of 3');
    await until(() => root.querySelector('.ox-pdf-hit-on'));
    expect(root.querySelector('.ox-pdf-hit-on')).not.toBeNull();
    button(root, 'Next match')!.click(); await settle(1);
    expect(root.querySelector('.ox-find-count')?.textContent).toBe('2 of 3');
    button(root, 'Previous match')!.click(); button(root, 'Previous match')!.click(); await settle(1);
    expect(root.querySelector('.ox-find-count')?.textContent).toBe('3 of 3');
    find.value = 'zzz'; find.dispatchEvent(new Event('input', { bubbles: true }));
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => root.querySelector('.ox-find-count')?.textContent === 'No matches');
    expect(root.querySelector('.ox-find-count')?.textContent).toBe('No matches');
  });
  it('destroys the document when the view closes', async () => {
    const pdf = fakePdf([['a']]);
    const root = mount(() => <PdfView name="a.pdf" bytes={bytes} loader={pdf.loader} />);
    await until(() => root.querySelector('.ox-pdf-page'));
    cleanup.splice(0).forEach(dispose => dispose());
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });
  it('shows a locked state for password protected PDFs and the too-large state for huge files', async () => {
    const locked = mount(() => <PdfView name="l.pdf" bytes={bytes} loader={async () => { throw mapPdfError(Object.assign(new Error('No password given'), { name: 'PasswordException' })); }} />);
    await until(() => locked.querySelector('[data-state="unsupported"]'));
    expect(locked.querySelector('[data-state="unsupported"]')?.textContent).toContain('Password protected');
    const huge = { length: 200 * 1024 * 1024 } as Uint8Array;
    const big = mount(() => <PdfView name="big.pdf" bytes={huge} loader={fakePdf([['a']]).loader} />);
    await until(() => big.querySelector('[data-state="too-large"]'));
    expect(big.querySelector('[data-state="too-large"]')?.textContent).toContain('200.0 MiB');
  });
});

describe('pdf loader helpers', () => {
  it('maps pdfjs errors to the edge states', () => {
    expect(mapPdfError(Object.assign(new Error('x'), { name: 'PasswordException' }))).toMatchObject({ kind: 'locked' });
    expect(mapPdfError(Object.assign(new Error('x'), { name: 'InvalidPDFException' }))).toMatchObject({ kind: 'damaged' });
    expect(mapPdfError(new Error('boom'))).toBeInstanceOf(OfficeError);
  });
  it('names common paper sizes', () => {
    expect(paperLabel(595, 842)).toBe('A4');
    expect(paperLabel(792, 612)).toBe('Letter');
    expect(paperLabel(500, 500)).toBeUndefined();
  });
});
