/**
 * pdfjs-dist, loaded lazily so it is its own chunk and only downloads when a PDF opens.
 * The worker ships as a bundled asset URL (no CDN). Options keep the document inert:
 * no XFA, no WebAssembly decoders, no fetches, no scripting (the annotation layer and the
 * scripting sandbox are never loaded). pdfjs-dist 6 has no eval code path; isEvalSupported
 * is still passed as false for older builds and is ignored by this one.
 */
import { OfficeError } from './zip';

export interface PdfViewportLike { width: number; height: number; scale: number; transform: number[] }
export interface PdfRenderTaskLike { promise: Promise<unknown>; cancel(): void }
export interface PdfTextItemLike { str?: string; transform?: number[]; width?: number }
export interface PdfPageLike {
  getViewport(options: { scale: number }): PdfViewportLike;
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewportLike; transform?: number[]; canvas?: HTMLCanvasElement }): PdfRenderTaskLike;
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>;
  cleanup(): void;
}
export interface PdfDocumentLike { numPages: number; getPage(pageNumber: number): Promise<PdfPageLike> }
export interface PdfLoaded { doc: PdfDocumentLike; version?: string; destroy(): Promise<void> }
export type PdfLoader = (bytes: Uint8Array) => Promise<PdfLoaded>;

export function mapPdfError(cause: unknown): OfficeError {
  const name = (cause as { name?: string } | undefined)?.name ?? '';
  const message = cause instanceof Error ? cause.message : String(cause);
  if (name === 'PasswordException') return new OfficeError('locked', 'This PDF is password protected. The preview does not ask for passwords.');
  if (name === 'InvalidPDFException' || name === 'FormatError') return new OfficeError('damaged', 'This file is not a valid PDF or is damaged.');
  return new OfficeError('damaged', `The PDF could not be opened: ${message}`);
}

export const loadPdf: PdfLoader = async bytes => {
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const inert = { isEvalSupported: false } as Record<string, unknown>;
  const task = pdfjs.getDocument({
    ...inert,
    data: bytes.slice(),
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    stopAtErrors: false,
    maxImageSize: 64 * 1024 * 1024,
    canvasMaxAreaInBytes: 256 * 1024 * 1024,
  });
  try {
    const doc = await task.promise;
    let version: string | undefined;
    try { const meta = await doc.getMetadata(); version = (meta.info as { PDFFormatVersion?: string } | undefined)?.PDFFormatVersion; } catch { /* metadata is optional */ }
    return { doc: doc as unknown as PdfDocumentLike, version, destroy: () => task.destroy() };
  } catch (cause) {
    await task.destroy().catch(() => undefined);
    throw mapPdfError(cause);
  }
};

/** Name a page size from its width and height in points. */
export function paperLabel(widthPt: number, heightPt: number): string | undefined {
  const [w, h] = [Math.min(widthPt, heightPt), Math.max(widthPt, heightPt)];
  const near = (a: number, b: number) => Math.abs(a - b) < 3;
  if (near(w, 595) && near(h, 842)) return 'A4';
  if (near(w, 612) && near(h, 792)) return 'Letter';
  if (near(w, 612) && near(h, 1008)) return 'Legal';
  if (near(w, 842) && near(h, 1191)) return 'A3';
  if (near(w, 420) && near(h, 595)) return 'A5';
  return undefined;
}

/**
 * Page count for an attachment tile, read with the same inert loader. Undefined when the PDF cannot be opened
 * (locked, damaged), so the tile leaves the count out instead of guessing.
 */
export async function pdfPageCount(bytes: Uint8Array, loader: PdfLoader = loadPdf): Promise<number | undefined> {
  let loaded: PdfLoaded | undefined;
  try {
    loaded = await loader(bytes);
    const pages = loaded.doc.numPages;
    return Number.isInteger(pages) && pages > 0 ? pages : undefined;
  } catch {
    return undefined;
  } finally {
    await loaded?.destroy().catch(() => undefined);
  }
}
