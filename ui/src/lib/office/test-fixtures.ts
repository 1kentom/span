/**
 * Builders for tiny Office files used only by tests. Nothing in app code imports this module.
 * Each builder writes the minimum OOXML parts a real reader needs, zipped with fflate.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';

const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export const tinyPng = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
  0, 0, 0, 13, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0, 5, 0, 1, 0xff, 0x89, 0x99, 0x3d, 0x1d,
  0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function zip(parts: Record<string, string | Uint8Array>): Uint8Array {
  const files: Zippable = {};
  for (const [name, value] of Object.entries(parts)) files[name] = typeof value === 'string' ? strToU8(value) : value;
  return zipSync(files);
}
const rels = (items: [id: string, type: string, target: string, external?: boolean][]) =>
  `${xmlHead}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
const contentTypes = `${xmlHead}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/></Types>`;

const para = (text: string, style?: string, extra = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${extra}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

export interface DocxFixture { body?: string; comments?: boolean; pages?: number; tracked?: boolean; image?: boolean; extraParts?: Record<string, string | Uint8Array> }
export function buildDocx(options: DocxFixture = {}): Uint8Array {
  const styles = `${xmlHead}<w:styles ${W}>${[1, 2, 3].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`).join('')}</w:styles>`;
  const anchored = options.comments
    ? `<w:p><w:r><w:t xml:space="preserve">Layout stays. </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>the JSONC editor is unchanged</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`
    : '';
  const tracked = options.tracked ? '<w:p><w:ins w:id="9" w:author="Ken"><w:r><w:t>Inserted words</w:t></w:r></w:ins><w:del w:id="10" w:author="Ken"><w:r><w:delText>Deleted words</w:delText></w:r></w:del></w:p>' : '';
  const image = options.image
    ? '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Picture 1" descr="A pixel"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="p.png" descr="A pixel"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    : '';
  const body = options.body ?? [
    para('Settings migration', 'Heading1'),
    para('Summary', 'Heading2'),
    para('The settings page moves to the shared form components.'),
    anchored,
    para('What changed', 'Heading2'),
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Setting</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>After</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Row gap</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12 px</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    tracked, image,
    para('Open questions', 'Heading3'),
  ].join('');
  const docRels: [string, string, string][] = [['rIdStyles', 'styles', 'styles.xml']];
  if (options.comments) docRels.push(['rIdComments', 'comments', 'comments.xml']);
  if (options.image) docRels.push(['rIdImg', 'image', 'media/p.png']);
  const parts: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': `${xmlHead}<w:document ${W}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': styles,
    'word/_rels/document.xml.rels': rels(docRels),
  };
  if (options.comments) {
    parts['word/comments.xml'] = `${xmlHead}<w:comments ${W}>`
      + `<w:comment w:id="0" w:author="Maya" w:date="2026-10-27T10:00:00Z" w:initials="M"><w:p w14:paraId="0000A001"><w:r><w:t>Confirm with Ken that JSONC stays as is.</w:t></w:r></w:p></w:comment>`
      + `<w:comment w:id="1" w:author="Ken" w:date="2026-10-27T11:00:00Z" w:initials="K"><w:p w14:paraId="0000A002"><w:r><w:t>Confirmed.</w:t></w:r></w:p></w:comment>`
      + '</w:comments>';
    parts['word/commentsExtended.xml'] = `${xmlHead}<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="0000A001" w15:done="0"/><w15:commentEx w15:paraId="0000A002" w15:paraIdParent="0000A001" w15:done="0"/></w15:commentsEx>`;
  }
  if (options.pages) parts['docProps/app.xml'] = `${xmlHead}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>${options.pages}</Pages><Words>9</Words></Properties>`;
  if (options.image) parts['word/media/p.png'] = tinyPng;
  return zip({ ...parts, ...options.extraParts });
}

export interface SlideFixture { title?: string; bullets?: string[]; notes?: string; image?: boolean; chart?: boolean; externalImage?: boolean; layoutTitle?: boolean }
export function buildPptx(slides: SlideFixture[], size: [number, number] = [12192000, 6858000]): Uint8Array {
  const parts: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `${xmlHead}<p:presentation ${P}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${size[0]}" cy="${size[1]}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rIdM', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, i) => [`rIdS${i + 1}`, 'slide', `slides/slide${i + 1}.xml`] as [string, string, string])]),
    'ppt/slideMasters/slideMaster1.xml': `${xmlHead}<p:sldMaster ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="2000"/></a:lvl2pPr></p:bodyStyle></p:txStyles></p:sldMaster>`,
    'ppt/slideLayouts/slideLayout1.xml': `${xmlHead}<p:sldLayout ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr></p:sp>`
      + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr></p:sp>`
      + `</p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  };
  slides.forEach((slide, i) => {
    const n = i + 1;
    const shapes: string[] = [];
    if (slide.title !== undefined) {
      const xfrm = slide.layoutTitle ? '' : '<a:xfrm><a:off x="609600" y="304800"/><a:ext cx="10972800" cy="1143000"/></a:xfrm>';
      shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" b="1"/><a:t>${slide.title}</a:t></a:r></a:p></p:txBody></p:sp>`);
    }
    if (slide.bullets) {
      shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${slide.bullets.map((b, level) => `<a:p><a:pPr lvl="${level > 1 ? 1 : 0}"/><a:r><a:t>${b}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`);
    }
    if (slide.image || slide.externalImage) {
      shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3" descr="Chart screenshot"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:${slide.externalImage ? 'link' : 'embed'}="rIdImg"/></p:blipFill><p:spPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="3048000" cy="1714500"/></a:xfrm></p:spPr></p:pic>`);
    }
    if (slide.chart) {
      shapes.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart 4"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="3429000"/><a:ext cx="6096000" cy="3429000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>`);
    }
    parts[`ppt/slides/slide${n}.xml`] = `${xmlHead}<p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;
    const slideRels: [string, string, string, boolean?][] = [['rIdL', 'slideLayout', '../slideLayouts/slideLayout1.xml']];
    if (slide.image) { slideRels.push(['rIdImg', 'image', '../media/image1.png']); parts['ppt/media/image1.png'] = tinyPng; }
    if (slide.externalImage) slideRels.push(['rIdImg', 'image', 'https://example.com/tracker.png', true]);
    if (slide.notes !== undefined) {
      slideRels.push(['rIdN', 'notesSlide', `../notesSlides/notesSlide${n}.xml`]);
      parts[`ppt/notesSlides/notesSlide${n}.xml`] = `${xmlHead}<p:notes ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`
        + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`
        + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${slide.notes}</a:t></a:r></a:p></p:txBody></p:sp>`
        + `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${n}</a:t></a:r></a:p></p:txBody></p:sp>`
        + `</p:spTree></p:cSld></p:notes>`;
    }
    parts[`ppt/slides/_rels/slide${n}.xml.rels`] = rels(slideRels);
  });
  return zip(parts);
}

export interface SheetFixture { name: string; rows: string; merges?: string[]; cf?: string; dimension?: string; hidden?: boolean }
export function buildXlsx(sheets: SheetFixture[], shared: string[] = [], numFmts: [id: number, code: string][] = [], xfs: number[] = [0], dxfs = '', date1904 = false): Uint8Array {
  const parts: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `${xmlHead}<workbook ${S}>${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([...sheets.map((_, i) => [`rId${i + 1}`, 'worksheet', `worksheets/sheet${i + 1}.xml`] as [string, string, string]), ['rIdSS', 'sharedStrings', 'sharedStrings.xml'], ['rIdSt', 'styles', 'styles.xml']]),
    'xl/sharedStrings.xml': `${xmlHead}<sst ${S} count="${shared.length}" uniqueCount="${shared.length}">${shared.map(s => s.startsWith('<') ? `<si>${s}</si>` : `<si><t>${s}</t></si>`).join('')}</sst>`,
    'xl/styles.xml': `${xmlHead}<styleSheet ${S}>${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replace(/"/g, '&quot;')}"/>`).join('')}</numFmts>` : ''}<cellXfs count="${xfs.length}">${xfs.map(id => `<xf numFmtId="${id}"/>`).join('')}</cellXfs>${dxfs ? `<dxfs>${dxfs}</dxfs>` : ''}</styleSheet>`,
  };
  sheets.forEach((sheet, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = `${xmlHead}<worksheet ${S}>${sheet.dimension ? `<dimension ref="${sheet.dimension}"/>` : ''}<sheetData>${sheet.rows}</sheetData>${sheet.merges ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}${sheet.cf ?? ''}</worksheet>`;
  });
  return zip(parts);
}

/** A small valid PDF with one page. Used only as bytes: jsdom cannot render it, so PDF tests mock the loader. */
export const tinyPdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

export { zip as buildZip };
