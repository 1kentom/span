/**
 * Small read-only .pptx reader on fflate and DOMParser. It extracts what can be shown honestly:
 * text boxes with positions from the xfrm EMU values, bullets and levels, local images, simple tables,
 * speaker notes and solid backgrounds. Charts, diagrams, media and other shapes become labelled
 * placeholders. Linked (external) resources are never loaded.
 */
import { ImageBudget } from './images';
import { desc, kid, kids, num, parseRels, parseXml, path, plainAttr, relAttr, relsPathFor, resolvePart, type Relationship } from './xml';
import { OfficeError, openZip, type OfficeZip } from './zip';

export { resolvePart };
export const PPTX_MAX_SLIDES = 500;
const EMU_PER_PT = 12700;

export interface SlideSize { cx: number; cy: number }
export interface Xfrm { x: number; y: number; cx: number; cy: number }
/** Percent of the slide width (left, width) and height (top, height). */
export interface Box { left: number; top: number; width: number; height: number }

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export function emuBox(xfrm: Xfrm, size: SlideSize): Box {
  const left = clamp(xfrm.x / size.cx * 100, 0, 100), top = clamp(xfrm.y / size.cy * 100, 0, 100);
  return { left: round(left), top: round(top), width: round(clamp(xfrm.cx / size.cx * 100, 0, 100 - left)), height: round(clamp(xfrm.cy / size.cy * 100, 0, 100 - top)) };
}
/** Font size as a percentage of the slide height, used with container query units on the stage. */
export function ptToStage(pt: number, slideHeightEmu: number): number { return pt * EMU_PER_PT / slideHeightEmu * 100; }
export function aspectLabel(size: SlideSize): string {
  const r = size.cx / size.cy;
  for (const [w, h] of [[16, 9], [4, 3], [16, 10]]) if (Math.abs(r - w / h) < 0.01) return `${w}:${h}`;
  return `${(size.cx / 914400).toFixed(1)} × ${(size.cy / 914400).toFixed(1)} in`;
}

export interface Run { text: string; bold?: boolean; italic?: boolean; underline?: boolean; size?: number; color?: string }
export interface Paragraph { text: string; level: number; bullet: boolean; align?: 'left' | 'center' | 'right' | 'justify'; runs: Run[] }
export type TextRole = 'title' | 'subtitle' | 'body' | 'text';
export type SlideShape =
  | { kind: 'text'; box: Box; role: TextRole; paragraphs: Paragraph[]; fill?: string; anchor: 'top' | 'middle' | 'bottom'; name: string }
  | { kind: 'image'; box: Box; alt: string; src?: string; omitted?: string }
  | { kind: 'placeholder'; box: Box; label: string; fill?: string }
  | { kind: 'table'; box: Box; rows: string[][] };
export interface Slide { index: number; title: string; shapes: SlideShape[]; notes: string; background?: string; textColor?: string }
export interface Deck { size: SlideSize; aspect: string; slides: Slide[]; totalSlides: number; omittedNotes: number }
export interface PptxLimits { maxSlides: number }

interface Placeholder { type?: string; idx?: string; xfrm?: Xfrm; lstStyle?: Element; bodyPr?: Element }
interface Theme { colors: Map<string, string> }
interface MasterInfo { placeholders: Placeholder[]; titleStyle?: Element; bodyStyle?: Element; otherStyle?: Element; clrMap: Map<string, string>; theme: Theme; background?: string }

const hex6 = (value: string | undefined) => value && /^[0-9A-Fa-f]{6}$/.test(value) ? `#${value.toUpperCase()}` : undefined;

function readXfrm(element: Element | undefined): Xfrm | undefined {
  const off = kid(element, 'off'), ext = kid(element, 'ext');
  if (!off || !ext) return undefined;
  return { x: num(plainAttr(off, 'x')), y: num(plainAttr(off, 'y')), cx: num(plainAttr(ext, 'cx')), cy: num(plainAttr(ext, 'cy')) };
}

function readPlaceholders(spTree: Element | undefined): Placeholder[] {
  const out: Placeholder[] = [];
  for (const sp of kids(spTree, 'sp')) {
    const ph = path(sp, 'nvSpPr', 'nvPr', 'ph');
    if (!ph) continue;
    out.push({ type: plainAttr(ph, 'type'), idx: plainAttr(ph, 'idx'), xfrm: readXfrm(path(sp, 'spPr', 'xfrm')), lstStyle: path(sp, 'txBody', 'lstStyle'), bodyPr: path(sp, 'txBody', 'bodyPr') });
  }
  return out;
}
const titleTypes = new Set(['title', 'ctrTitle']);
function matchPlaceholder(list: Placeholder[], type: string | undefined, idx: string | undefined): Placeholder | undefined {
  if (idx !== undefined) { const byIdx = list.find(p => p.idx === idx && (type === undefined || p.type === undefined || p.type === type || (titleTypes.has(type) && titleTypes.has(p.type ?? '')))); if (byIdx) return byIdx; }
  const t = type ?? 'body';
  return list.find(p => (p.type ?? 'body') === t || (titleTypes.has(t) && titleTypes.has(p.type ?? '')));
}

function resolveColor(holder: Element | undefined, master?: MasterInfo): string | undefined {
  if (!holder) return undefined;
  const srgb = kid(holder, 'srgbClr');
  if (srgb) return hex6(plainAttr(srgb, 'val'));
  const sys = kid(holder, 'sysClr');
  if (sys) return hex6(plainAttr(sys, 'lastClr'));
  const scheme = kid(holder, 'schemeClr');
  if (scheme && master) {
    const name = plainAttr(scheme, 'val') ?? '';
    return master.theme.colors.get(master.clrMap.get(name) ?? name);
  }
  return undefined;
}
function readBackground(cSld: Element | undefined, master?: MasterInfo): string | undefined {
  const bg = kid(cSld, 'bg');
  if (!bg) return undefined;
  const fill = path(bg, 'bgPr', 'solidFill');
  if (fill) return resolveColor(fill, master);
  const ref = kid(bg, 'bgRef');
  return ref ? resolveColor(ref, master) : undefined;
}

function readTheme(xml: string | undefined): Theme {
  const colors = new Map<string, string>();
  if (!xml) return { colors };
  const scheme = desc(parseXml(xml, 'Theme'), 'clrScheme')[0];
  for (let child = scheme?.firstElementChild; child; child = child.nextElementSibling) {
    const value = resolveColor(child);
    if (value) colors.set(child.localName, value);
  }
  return { colors };
}

function levelSize(style: Element | undefined, level: number): number | undefined {
  const sz = plainAttr(path(style, `lvl${level + 1}pPr`, 'defRPr'), 'sz');
  return sz ? num(sz) / 100 : undefined;
}
function levelBullet(style: Element | undefined, level: number): boolean | undefined {
  const pPr = kid(style, `lvl${level + 1}pPr`);
  if (!pPr) return undefined;
  if (kid(pPr, 'buNone')) return false;
  if (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum')) return true;
  return undefined;
}

interface TextContext { role: TextRole; lstStyles: (Element | undefined)[]; master?: MasterInfo; fontScale: number }
function readParagraphs(txBody: Element | undefined, ctx: TextContext): Paragraph[] {
  const masterStyle = ctx.role === 'title' ? ctx.master?.titleStyle : ctx.role === 'text' ? ctx.master?.otherStyle : ctx.master?.bodyStyle;
  const styles = [...ctx.lstStyles, masterStyle];
  const out: Paragraph[] = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const level = clamp(num(plainAttr(pPr, 'lvl')), 0, 8);
    const fallbackSize = ctx.role === 'title' ? 44 : ctx.role === 'subtitle' ? 24 : ctx.role === 'body' ? (level ? 20 : 24) : 18;
    const inheritedSize = styles.map(s => levelSize(s, level)).find(v => v !== undefined) ?? fallbackSize;
    const runs: Run[] = [];
    for (let child = p.firstElementChild; child; child = child.nextElementSibling) {
      if (child.localName === 'br') { runs.push({ text: '\n' }); continue; }
      if (child.localName !== 'r' && child.localName !== 'fld') continue;
      const rPr = kid(child, 'rPr');
      const text = kid(child, 't')?.textContent ?? '';
      if (!text) continue;
      const sz = plainAttr(rPr, 'sz');
      const run: Run = { text, size: Math.round((sz ? num(sz) / 100 : inheritedSize) * ctx.fontScale * 10) / 10 };
      if (plainAttr(rPr, 'b') === '1' || plainAttr(rPr, 'b') === 'true') run.bold = true;
      if (plainAttr(rPr, 'i') === '1' || plainAttr(rPr, 'i') === 'true') run.italic = true;
      const u = plainAttr(rPr, 'u');
      if (u && u !== 'none') run.underline = true;
      const color = resolveColor(kid(rPr, 'solidFill'), ctx.master);
      if (color) run.color = color;
      runs.push(run);
    }
    const text = runs.map(r => r.text).join('');
    let bullet: boolean;
    if (kid(pPr, 'buNone')) bullet = false;
    else if (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum')) bullet = true;
    else bullet = styles.map(s => levelBullet(s, level)).find(v => v !== undefined) ?? ctx.role === 'body';
    const algn = plainAttr(pPr, 'algn');
    const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : algn === 'l' ? 'left' : undefined;
    out.push({ text, level, bullet: bullet && text.trim().length > 0, runs, ...(align ? { align } : {}) });
  }
  // Drop trailing empty paragraphs so boxes do not end in blank lines.
  while (out.length && !out.at(-1)!.text.trim()) out.pop();
  return out;
}

type Transform = (x: Xfrm) => Xfrm;
const identity: Transform = x => x;

interface SlideContext {
  zip: OfficeZip; part: string; rels: Map<string, Relationship>; size: SlideSize; layout: Placeholder[]; master?: MasterInfo; images: ImageBudget;
}

function roleOf(type: string | undefined, isPlaceholder: boolean): TextRole {
  if (!isPlaceholder) return 'text';
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (type === 'subTitle') return 'subtitle';
  if (type === undefined || type === 'body' || type === 'obj') return 'body';
  return 'text';
}

function readShapes(spTree: Element | undefined, ctx: SlideContext, transform: Transform, out: SlideShape[], depth = 0): void {
  if (!spTree || depth > 16) return;
  for (let el = spTree.firstElementChild; el; el = el.nextElementSibling) {
    const name = el.localName;
    if (name === 'sp') {
      const ph = path(el, 'nvSpPr', 'nvPr', 'ph');
      const type = plainAttr(ph, 'type'), idx = plainAttr(ph, 'idx');
      if (type && ['sldImg', 'dt', 'sldNum', 'ftr', 'hdr'].includes(type) && !kid(el, 'txBody')) continue;
      const inherited = ph ? (matchPlaceholder(ctx.layout, type, idx) ?? (ctx.master ? matchPlaceholder(ctx.master.placeholders, type, idx) : undefined)) : undefined;
      const own = readXfrm(path(el, 'spPr', 'xfrm'));
      const xfrm = own ?? inherited?.xfrm ?? (ctx.master && ph ? matchPlaceholder(ctx.master.placeholders, type, idx)?.xfrm : undefined);
      if (!xfrm) continue;
      const box = emuBox(transform(xfrm), ctx.size);
      const txBody = kid(el, 'txBody');
      const fill = resolveColor(path(el, 'spPr', 'solidFill'), ctx.master);
      const role = roleOf(type, !!ph);
      const bodyPr = kid(txBody, 'bodyPr') ?? inherited?.bodyPr;
      const scale = num(plainAttr(kid(bodyPr, 'normAutofit'), 'fontScale'), 100000) / 100000;
      const paragraphs = txBody ? readParagraphs(txBody, { role, lstStyles: [kid(txBody, 'lstStyle'), inherited?.lstStyle], master: ctx.master, fontScale: scale }) : [];
      if (paragraphs.some(p => p.text.trim())) {
        const anchorAttr = plainAttr(bodyPr, 'anchor');
        const anchor = anchorAttr === 'ctr' ? 'middle' : anchorAttr === 'b' ? 'bottom' : anchorAttr === 't' ? 'top' : role === 'title' ? 'middle' : 'top';
        out.push({ kind: 'text', box, role, paragraphs, anchor, name: plainAttr(path(el, 'nvSpPr', 'cNvPr'), 'name') ?? '', ...(fill ? { fill } : {}) });
      } else if (!ph) {
        const geom = plainAttr(path(el, 'spPr', 'prstGeom'), 'prst');
        out.push({ kind: 'placeholder', box, label: geom ? `Shape (${geom})` : 'Shape', ...(fill ? { fill } : {}) });
      }
    } else if (name === 'pic') {
      const xfrm = readXfrm(path(el, 'spPr', 'xfrm'));
      if (!xfrm) continue;
      const box = emuBox(transform(xfrm), ctx.size);
      const cNvPr = path(el, 'nvPicPr', 'cNvPr');
      const alt = plainAttr(cNvPr, 'descr') || plainAttr(cNvPr, 'name') || 'Image';
      const nvPr = path(el, 'nvPicPr', 'nvPr');
      if (kid(nvPr, 'videoFile') || kid(nvPr, 'audioFile') || desc(nvPr, 'media').length) { out.push({ kind: 'placeholder', box, label: 'Media (not played in the preview)' }); continue; }
      const blip = path(el, 'blipFill', 'blip');
      const embed = relAttr(blip, 'embed');
      const rel = embed ? ctx.rels.get(embed) : undefined;
      if (!rel || rel.external) { out.push({ kind: 'image', box, alt, omitted: relAttr(blip, 'link') || rel?.external ? 'Linked image not loaded' : 'Image missing from the file' }); continue; }
      const taken = ctx.images.take(ctx.zip.bytes(resolvePart(ctx.part, rel.target)));
      out.push('src' in taken ? { kind: 'image', box, alt, src: taken.src } : { kind: 'image', box, alt, omitted: taken.omitted });
    } else if (name === 'graphicFrame') {
      const xfrm = readXfrm(kid(el, 'xfrm'));
      if (!xfrm) continue;
      const box = emuBox(transform(xfrm), ctx.size);
      const data = path(el, 'graphic', 'graphicData');
      const uri = plainAttr(data, 'uri') ?? '';
      const tbl = kid(data, 'tbl');
      if (tbl) {
        const rows = kids(tbl, 'tr').slice(0, 50).map(tr => kids(tr, 'tc').slice(0, 20).map(tc => kids(kid(tc, 'txBody'), 'p').map(p => desc(p, 't').map(t => t.textContent ?? '').join('')).join('\n')));
        out.push({ kind: 'table', box, rows });
      } else out.push({ kind: 'placeholder', box, label: uri.endsWith('/chart') ? 'Chart' : uri.includes('diagram') ? 'Diagram' : uri.endsWith('/ole') ? 'Embedded object' : 'Graphic' });
    } else if (name === 'grpSp') {
      const g = path(el, 'grpSpPr', 'xfrm');
      const off = readXfrm(g);
      const chOff = kid(g, 'chOff'), chExt = kid(g, 'chExt');
      if (!off || !chOff || !chExt) { readShapes(el, ctx, transform, out, depth + 1); continue; }
      const cx0 = num(plainAttr(chOff, 'x')), cy0 = num(plainAttr(chOff, 'y'));
      const sx = num(plainAttr(chExt, 'cx')) ? off.cx / num(plainAttr(chExt, 'cx')) : 1, sy = num(plainAttr(chExt, 'cy')) ? off.cy / num(plainAttr(chExt, 'cy')) : 1;
      const inner: Transform = x => transform({ x: off.x + (x.x - cx0) * sx, y: off.y + (x.y - cy0) * sy, cx: x.cx * sx, cy: x.cy * sy });
      readShapes(el, ctx, inner, out, depth + 1);
    }
  }
}

function notesText(zip: OfficeZip, part: string): string {
  const xml = zip.text(part);
  if (!xml) return '';
  const doc = parseXml(xml, 'Notes');
  for (const sp of desc(doc, 'sp')) {
    if (plainAttr(path(sp, 'nvSpPr', 'nvPr', 'ph'), 'type') !== 'body') continue;
    return kids(kid(sp, 'txBody'), 'p').map(p => desc(p, 't').map(t => t.textContent ?? '').join('')).join('\n').trim();
  }
  return '';
}

export function parsePptx(bytes: Uint8Array, overrides: Partial<PptxLimits> = {}, zip: OfficeZip = openZip(bytes)): Deck {
  const limits: PptxLimits = { maxSlides: PPTX_MAX_SLIDES, ...overrides };
  const rootRels = parseRels(zip.text('_rels/.rels'));
  const presentationPath = [...rootRels.values()].find(r => r.type === 'officeDocument')?.target.replace(/^\//, '') ?? 'ppt/presentation.xml';
  const presentationXml = zip.text(presentationPath);
  if (!presentationXml) throw new OfficeError('damaged', 'This file has no presentation part. It may be damaged or not a presentation.');
  const presentation = parseXml(presentationXml, 'Presentation').documentElement;
  const rels = parseRels(zip.text(relsPathFor(presentationPath)));
  const sz = kid(presentation, 'sldSz');
  const size: SlideSize = { cx: num(plainAttr(sz, 'cx'), 12192000) || 12192000, cy: num(plainAttr(sz, 'cy'), 6858000) || 6858000 };
  const ids = kids(kid(presentation, 'sldIdLst'), 'sldId');
  const images = new ImageBudget();
  const masters = new Map<string, MasterInfo>();
  const layouts = new Map<string, { placeholders: Placeholder[]; master?: MasterInfo; background?: string }>();

  const loadMaster = (part: string): MasterInfo | undefined => {
    if (masters.has(part)) return masters.get(part);
    const xml = zip.text(part);
    if (!xml) return undefined;
    const root = parseXml(xml, 'Slide master').documentElement;
    const masterRels = parseRels(zip.text(relsPathFor(part)));
    const themeRel = [...masterRels.values()].find(r => r.type === 'theme');
    const clrMap = new Map<string, string>();
    for (const a of kid(root, 'clrMap')?.attributes ?? []) clrMap.set(a.localName, a.value);
    const txStyles = kid(root, 'txStyles');
    const info: MasterInfo = {
      placeholders: readPlaceholders(path(root, 'cSld', 'spTree')), clrMap,
      titleStyle: kid(txStyles, 'titleStyle'), bodyStyle: kid(txStyles, 'bodyStyle'), otherStyle: kid(txStyles, 'otherStyle'),
      theme: readTheme(themeRel && !themeRel.external ? zip.text(resolvePart(part, themeRel.target)) : undefined),
    };
    info.background = readBackground(kid(root, 'cSld'), info);
    masters.set(part, info);
    return info;
  };
  const loadLayout = (part: string) => {
    if (layouts.has(part)) return layouts.get(part)!;
    const xml = zip.text(part);
    const layoutRels = parseRels(zip.text(relsPathFor(part)));
    const masterRel = [...layoutRels.values()].find(r => r.type === 'slideMaster');
    const master = masterRel && !masterRel.external ? loadMaster(resolvePart(part, masterRel.target)) : undefined;
    const root = xml ? parseXml(xml, 'Slide layout').documentElement : undefined;
    const value = { placeholders: readPlaceholders(path(root, 'cSld', 'spTree')), master, background: readBackground(kid(root, 'cSld'), master) };
    layouts.set(part, value);
    return value;
  };

  const slides: Slide[] = [];
  let omittedNotes = 0;
  for (const [i, sldId] of ids.slice(0, limits.maxSlides).entries()) {
    const rel = rels.get(relAttr(sldId, 'id') ?? '');
    if (!rel || rel.external) continue;
    const part = resolvePart(presentationPath, rel.target);
    const xml = zip.text(part);
    if (!xml) continue;
    const root = parseXml(xml, `Slide ${i + 1}`).documentElement;
    const slideRels = parseRels(zip.text(relsPathFor(part)));
    const layoutRel = [...slideRels.values()].find(r => r.type === 'slideLayout');
    const layout = layoutRel && !layoutRel.external ? loadLayout(resolvePart(part, layoutRel.target)) : { placeholders: [] as Placeholder[], master: undefined, background: undefined };
    const shapes: SlideShape[] = [];
    readShapes(path(root, 'cSld', 'spTree'), { zip, part, rels: slideRels, size, layout: layout.placeholders, master: layout.master, images }, identity, shapes);
    const notesRel = [...slideRels.values()].find(r => r.type === 'notesSlide');
    let notes = '';
    try { notes = notesRel && !notesRel.external ? notesText(zip, resolvePart(part, notesRel.target)) : ''; }
    catch { omittedNotes++; }
    const titleShape = shapes.find(s => s.kind === 'text' && s.role === 'title') ?? shapes.find(s => s.kind === 'text');
    const title = titleShape && titleShape.kind === 'text' ? titleShape.paragraphs.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim() : '';
    const background = readBackground(kid(root, 'cSld'), layout.master) ?? layout.background ?? layout.master?.background ?? layout.master?.theme.colors.get(layout.master.clrMap.get('bg1') ?? 'lt1');
    const textColor = layout.master?.theme.colors.get(layout.master.clrMap.get('tx1') ?? 'dk1');
    slides.push({ index: i, title: title || `Slide ${i + 1}`, shapes, notes, ...(background ? { background } : {}), ...(textColor ? { textColor } : {}) });
  }
  if (!slides.length && ids.length) throw new OfficeError('damaged', 'No slide in this presentation could be read.');
  return { size, aspect: aspectLabel(size), slides, totalSlides: ids.length, omittedNotes };
}
