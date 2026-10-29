import type { OfficeKind } from './kind';

/** Whole-file input bounds, shared by byte loading and the lazy document parsers. */
export const DOCX_MAX_BYTES = 64 * 1024 * 1024;
export const PPTX_MAX_BYTES = 256 * 1024 * 1024;
export const XLSX_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_MAX_BYTES = 128 * 1024 * 1024;
export const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const OFFICE_PREVIEW_BYTES: Readonly<Record<OfficeKind, number>> = {
  docx: DOCX_MAX_BYTES, pptx: PPTX_MAX_BYTES, xlsx: XLSX_MAX_BYTES, pdf: PDF_MAX_BYTES, archive: ARCHIVE_MAX_BYTES,
};
