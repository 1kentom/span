import { describe, expect, it, vi } from 'vitest';
import { pdfPageCount, pdfPageCountWithFallback, type PdfLoaded } from './pdf-loader';

describe('pdf page count for attachment tiles', () => {
  it('returns the page count and always releases the document', async () => {
    const destroy = vi.fn(async () => undefined);
    const loader = vi.fn(async () => ({ doc: { numPages: 12, getPage: vi.fn() }, destroy }) as unknown as PdfLoaded);
    expect(await pdfPageCount(new Uint8Array([1]), loader)).toBe(12);
    expect(destroy).toHaveBeenCalledOnce();
  });
  it('leaves the count out for a locked or damaged PDF, or a nonsense count', async () => {
    expect(await pdfPageCount(new Uint8Array([1]), async () => { throw new Error('locked'); })).toBeUndefined();
    expect(await pdfPageCount(new Uint8Array([1]), async () => ({ doc: { numPages: 0, getPage: vi.fn() }, destroy: async () => undefined }) as unknown as PdfLoaded)).toBeUndefined();
  });
  it('asks the native reader only when the PDF library cannot open the file', async () => {
    const native = vi.fn(async () => 4);
    const ok = async () => ({ doc: { numPages: 2, getPage: vi.fn() }, destroy: async () => undefined }) as unknown as PdfLoaded;
    expect(await pdfPageCountWithFallback(new Uint8Array([1]), native, ok)).toBe(2);
    expect(native).not.toHaveBeenCalled();
    const broken = async (): Promise<PdfLoaded> => { throw new Error('bad xref'); };
    expect(await pdfPageCountWithFallback(new Uint8Array([1]), native, broken)).toBe(4);
    expect(native).toHaveBeenCalledOnce();
  });
  it('leaves the count out when neither reader is sure', async () => {
    const broken = async (): Promise<PdfLoaded> => { throw new Error('bad xref'); };
    expect(await pdfPageCountWithFallback(new Uint8Array([1]), undefined, broken)).toBeUndefined();
    expect(await pdfPageCountWithFallback(new Uint8Array([1]), async () => undefined, broken)).toBeUndefined();
    expect(await pdfPageCountWithFallback(new Uint8Array([1]), async () => 0, broken)).toBeUndefined();
    expect(await pdfPageCountWithFallback(new Uint8Array([1]), async () => { throw new Error('no'); }, broken)).toBeUndefined();
  });
});
