import { describe, expect, it, vi } from 'vitest';
import { pdfPageCount, type PdfLoaded } from './pdf-loader';

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
});
