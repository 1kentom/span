/**
 * Word (.docx) reading: mammoth converts the document body to HTML (loaded lazily as its own chunk),
 * sanitizeDocHtml rebuilds it from an allowlist, and the small parts mammoth does not cover
 * (page count, comments, tracked changes) are read here from the package with bounds.
 */
import { MAX_DOC_IMAGE_BYTES, ImageBudget } from './images';
import { sanitizeDocHtml } from './sanitize-html';
import { attr, desc, parseRels, parseXml, relsPathFor, resolvePart } from './xml';
import { OfficeError, openZip } from './zip';

export interface OutlineEntry { level: number; text: string; id: string }
export interface DocComment { id: string; author: string; initials: string; date?: string; text: string; anchor?: string; replies: DocComment[] }
export interface DocxDocument {
  fragment: DocumentFragment;
  outline: OutlineEntry[];
  words: number;
  /** From docProps/app.xml only. Undefined when the file does not record it. */
  pages?: number;
  comments: DocComment[];
  trackedChanges: boolean;
  imagesOmitted: number;
  truncated: boolean;
}

export function buildOutline(root: ParentNode): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading, i) => {
    const text = (heading.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!heading.id) heading.id = `docx-outline-${i}`;
    out.push({ level: Number(heading.localName.slice(1)), text, id: heading.id });
  });
  return out;
}

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function parseAppPages(xml: string | undefined): number | undefined {
  if (!xml) return undefined;
  const value = Number(desc(parseXml(xml, 'Document properties'), 'Pages')[0]?.textContent);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function hasTrackedChanges(documentXml: string | undefined): boolean {
  return !!documentXml && /<(?:\w+:)?(?:ins|del|moveFrom|moveTo)[\s>]/.test(documentXml);
}

const MAX_ANCHOR = 300;
export function parseComments(commentsXml: string | undefined, documentXml: string | undefined, extendedXml?: string): DocComment[] {
  if (!commentsXml) return [];
  const all = desc(parseXml(commentsXml, 'Comments'), 'comment').slice(0, 1000).map(c => {
    const paragraphs = desc(c, 'p');
    return {
      comment: {
        id: attr(c, 'id') ?? '', author: attr(c, 'author') ?? 'Unknown', initials: attr(c, 'initials') ?? '', date: attr(c, 'date'),
        text: paragraphs.map(p => desc(p, 't').map(t => t.textContent ?? '').join('')).join('\n').trim(), replies: [],
      } as DocComment,
      paraId: attr(paragraphs.at(-1), 'paraId'),
    };
  });
  const parentOf = new Map<string, string>();
  if (extendedXml) for (const ex of desc(parseXml(extendedXml, 'Comment threads'), 'commentEx')) {
    const id = attr(ex, 'paraId'), parent = attr(ex, 'paraIdParent');
    if (id && parent) parentOf.set(id, parent);
  }
  if (documentXml) {
    // Elements come back in document order, so open ranges collect the text between start and end.
    const anchors = new Map<string, string>();
    const open = new Set<string>();
    for (const element of desc(parseXml(documentXml, 'Document'), '*')) {
      const name = element.localName;
      if (name === 'commentRangeStart') open.add(attr(element, 'id') ?? '');
      else if (name === 'commentRangeEnd') open.delete(attr(element, 'id') ?? '');
      else if (name === 't' && open.size) for (const id of open) { const prev = anchors.get(id) ?? ''; if (prev.length < MAX_ANCHOR) anchors.set(id, (prev + (element.textContent ?? '')).slice(0, MAX_ANCHOR)); }
    }
    for (const { comment } of all) { const anchor = anchors.get(comment.id)?.trim(); if (anchor) comment.anchor = anchor; }
  }
  const byPara = new Map(all.filter(c => c.paraId).map(c => [c.paraId!, c.comment]));
  const top: DocComment[] = [];
  for (const { comment, paraId } of all) {
    const parent = paraId ? byPara.get(parentOf.get(paraId) ?? '') : undefined;
    if (parent && parent !== comment) parent.replies.push(comment); else top.push(comment);
  }
  return top;
}

function base64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function parseDocx(bytes: Uint8Array): Promise<DocxDocument> {
  const zip = openZip(bytes);
  // Inflate every entry once with the bounds, so mammoth only ever sees a package whose real size is known.
  zip.verifyAll();
  const rootRels = parseRels(zip.text('_rels/.rels'));
  const rels = [...rootRels.values()];
  const docPath = rels.find(r => r.type === 'officeDocument' && !r.external)?.target.replace(/^\//, '') ?? 'word/document.xml';
  const documentXml = zip.text(docPath);
  if (documentXml === undefined) throw new OfficeError('damaged', 'This file has no document part. It may be damaged or not a Word document.');
  const docRels = [...parseRels(zip.text(relsPathFor(docPath))).values()];
  const partOf = (type: string) => { const rel = docRels.find(r => r.type === type && !r.external); return rel ? zip.text(resolvePart(docPath, rel.target)) : undefined; };
  const appRel = rels.find(r => r.type === 'extended-properties' && !r.external);

  const images = new Map<string, string>();
  const budget = new ImageBudget();
  let imagesOmitted = 0;
  const { default: mammoth } = await import('mammoth');
  const buffer = bytes.slice().buffer;
  let html: string;
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: buffer, buffer }, {
      ignoreEmptyParagraphs: true,
      convertImage: mammoth.images.imgElement(async image => {
        const b64 = await image.read('base64');
        const taken = b64.length * 0.75 > MAX_DOC_IMAGE_BYTES ? { omitted: 'too large' } : budget.take(base64Bytes(b64));
        if (!('src' in taken)) { imagesOmitted++; return { src: '' }; }
        const token = `docx-image:${images.size}`;
        images.set(token, taken.src);
        return { src: token };
      }),
    });
    html = result.value;
  } catch (cause) {
    throw new OfficeError('damaged', `The document could not be converted: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const { fragment, truncated } = sanitizeDocHtml(html, { images });
  const outline = buildOutline(fragment);
  return {
    fragment, outline, truncated, imagesOmitted,
    words: countWords(fragment.textContent ?? ''),
    pages: parseAppPages(appRel ? zip.text(resolvePart('', appRel.target)) : zip.text('docProps/app.xml')),
    comments: parseComments(partOf('comments'), documentXml, partOf('commentsExtended') ?? zip.text('word/commentsExtended.xml')),
    trackedChanges: hasTrackedChanges(documentXml),
  };
}

