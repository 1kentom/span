/** Which document viewer of this package handles a file, by extension first and MIME type second. */
import { extensionOf } from '../viewer';

export type OfficeKind = 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'archive';

const byExt: Record<string, OfficeKind> = { docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', xlsm: 'xlsx', pdf: 'pdf', zip: 'archive', tar: 'archive', tgz: 'archive', gz: 'archive' };
const byMime: Record<string, OfficeKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/pdf': 'pdf',
  'application/zip': 'archive', 'application/x-zip-compressed': 'archive', 'application/x-tar': 'archive', 'application/gzip': 'archive', 'application/x-gzip': 'archive',
};
export const officeLabels: Record<OfficeKind, string> = { docx: 'Word document', pptx: 'PowerPoint', xlsx: 'Excel workbook', pdf: 'PDF', archive: 'Archive' };

export function officeKindOf(name: string, mime = ''): OfficeKind | undefined {
  return byExt[extensionOf(name)] ?? byMime[mime.toLowerCase().split(';')[0].trim()];
}
