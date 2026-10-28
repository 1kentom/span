/**
 * Small read-only .xlsx reader on fflate and DOMParser: workbook, sheets, shared strings, number formats,
 * formulas with cached values, merged cells and simple cellIs conditional formatting.
 * No formula is evaluated: the cached value stored by the authoring app is what is shown.
 */
import { attr, desc, kid, kids, num, parseRels, parseXml, plainAttr, relAttr, relsPathFor, resolvePart } from './xml';
import { OfficeError, openZip, type OfficeZip } from './zip';

export const XLSX_MAX_ROWS = 50_000;
export const XLSX_MAX_COLS = 200;
export const XLSX_MAX_SHEETS = 100;

export interface CellPos { row: number; col: number }
export interface CellRange { start: CellPos; end: CellPos }

export function colToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function indexToCol(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export function parseRef(ref: string): CellPos | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) return undefined;
  const row = Number(m[2]) - 1;
  return row < 0 ? undefined : { row, col: colToIndex(m[1]) };
}
export const formatRef = (row: number, col: number) => `${indexToCol(col)}${row + 1}`;
export function parseRange(ref: string): CellRange | undefined {
  const [a, b = a] = ref.split(':');
  const start = parseRef(a), end = parseRef(b);
  if (!start || !end) return undefined;
  return { start: { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) }, end: { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) } };
}

/* Number formats */
const builtInFormats: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'yyyy-mm-dd h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};
// Locale-dependent built-in date ids that have no fixed code.
for (const id of [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]) builtInFormats[id] = 'yyyy-mm-dd';

/** Strip quoted text, escapes and bracket sections except elapsed time ([h], [mm], [ss]). */
function formatSkeleton(code: string): string {
  return code.split(';')[0].replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_.|\*./g, '').replace(/\[(?!(?:h+|m+|s+)\])[^\]]*\]/gi, '');
}
export function isDateFormat(code: string): boolean {
  if (!code || /^general$/i.test(code.trim())) return false;
  return /[dmyhs]/i.test(formatSkeleton(code).replace(/E[+-]/gi, ''));
}
export function isPercentFormat(code: string): boolean { return formatSkeleton(code).includes('%'); }

function plainNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(15)));
}
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Show a cached value with its number format: dates and percents are formatted, everything else is plain. */
export function formatCellValue(value: number, code: string, date1904 = false): string {
  if (isDateFormat(code)) {
    const skeleton = formatSkeleton(code).toLowerCase();
    const hasDate = /[dy]/.test(skeleton) || (/m/.test(skeleton) && !/[hs]/.test(skeleton));
    const hasTime = /[hs]/.test(skeleton);
    // 1900 system: serial 1 is 1900-01-01 and Excel counts a 29 February 1900 that never existed.
    const base = date1904 ? Date.UTC(1904, 0, 1) : value < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const ms = Math.round((base + value * 86_400_000) / 1000) * 1000;
    const d = new Date(ms);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const seconds = /s/.test(skeleton) ? `:${pad(d.getUTCSeconds())}` : '';
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds}`;
    if (hasDate && hasTime) return `${date} ${time}`;
    return hasTime ? time : date;
  }
  if (isPercentFormat(code)) {
    const decimals = /\.(0+)/.exec(formatSkeleton(code))?.[1].length ?? 0;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  return plainNumber(value);
}

export function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const doc = parseXml(xml, 'Shared strings');
  return kids(doc.documentElement, 'si').map(si => {
    const direct = kid(si, 't');
    if (direct) return direct.textContent ?? '';
    return kids(si, 'r').map(r => kid(r, 't')?.textContent ?? '').join('');
  });
}

export interface CfRule { operator: string; formulas: string[]; style: CfStyle; priority: number }
export interface CfStyle { color?: string; background?: string; bold?: boolean }
interface Styles { formats: string[]; dxfs: CfStyle[] }

const argbToHex = (value: string | undefined) => value && /^[0-9A-Fa-f]{8}$/.test(value) ? `#${value.slice(2).toUpperCase()}` : value && /^[0-9A-Fa-f]{6}$/.test(value) ? `#${value.toUpperCase()}` : undefined;

function parseStyles(xml: string | undefined): Styles {
  if (!xml) return { formats: [], dxfs: [] };
  const root = parseXml(xml, 'Styles').documentElement;
  const custom = new Map<number, string>();
  for (const fmt of kids(kid(root, 'numFmts'), 'numFmt')) custom.set(num(attr(fmt, 'numFmtId')), attr(fmt, 'formatCode') ?? 'General');
  const formats = kids(kid(root, 'cellXfs'), 'xf').map(xf => { const id = num(attr(xf, 'numFmtId')); return custom.get(id) ?? builtInFormats[id] ?? 'General'; });
  const dxfs = kids(kid(root, 'dxfs'), 'dxf').map(dxf => {
    const font = kid(dxf, 'font');
    const fill = kid(kid(dxf, 'fill'), 'patternFill');
    const style: CfStyle = {};
    const color = argbToHex(attr(kid(font, 'color'), 'rgb'));
    const background = argbToHex(attr(kid(fill, 'bgColor'), 'rgb')) ?? argbToHex(attr(kid(fill, 'fgColor'), 'rgb'));
    if (color) style.color = color;
    if (background) style.background = background;
    if (kid(font, 'b') && attr(kid(font, 'b'), 'val') !== '0') style.bold = true;
    return style;
  });
  return { formats, dxfs };
}

/** Evaluate a cellIs rule whose operands are constants. Rules that reference cells or functions never match. */
export function evaluateCellIs(rule: Pick<CfRule, 'operator' | 'formulas'>, value: number | string | boolean | null): boolean {
  const operands = rule.formulas.map(f => {
    const t = f.trim();
    if (/^-?\d+(?:\.\d+)?(?:E[+-]?\d+)?$/i.test(t)) return Number(t);
    const quoted = /^"((?:[^"]|"")*)"$/.exec(t);
    return quoted ? quoted[1].replace(/""/g, '"') : undefined;
  });
  if (operands.some(o => o === undefined) || value === null || typeof value === 'boolean') return false;
  const [a, b] = operands as (number | string)[];
  const cmp = (x: number | string, y: number | string) => typeof x === typeof y ? (x < y ? -1 : x > y ? 1 : 0) : NaN;
  const c = cmp(value, a);
  switch (rule.operator) {
    case 'greaterThan': return c > 0;
    case 'greaterThanOrEqual': return c >= 0;
    case 'lessThan': return c < 0;
    case 'lessThanOrEqual': return c <= 0;
    case 'equal': return c === 0;
    case 'notEqual': return c !== 0 && !Number.isNaN(c);
    case 'between': return b !== undefined && c >= 0 && cmp(value, b) <= 0;
    case 'notBetween': return b !== undefined && (c < 0 || cmp(value, b) > 0);
    default: return false;
  }
}

/** Shift the relative references of a shared formula by a row and column delta. Absolute parts stay. */
export function translateFormula(formula: string, dRow: number, dCol: number): string {
  if (!dRow && !dCol) return formula;
  // Split out string literals so references inside quotes are left alone.
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => i % 2 ? part : part.replace(/(^|[^A-Za-z0-9_.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g, (_m, lead: string, colAbs: string, col: string, rowAbs: string, row: string) => {
    const c = colAbs ? col : indexToCol(Math.max(0, colToIndex(col) + dCol));
    const r = rowAbs ? row : String(Math.max(1, Number(row) + dRow));
    return `${lead}${colAbs}${c}${rowAbs}${r}`;
  })).join('');
}

export type Merge = { rowSpan: number; colSpan: number } | 'skip';
/** Layout of merged cells for rows [rowStart, rowEnd). A merge that starts above the window is re-anchored at its first row. */
export function mergeLayout(merges: readonly CellRange[], rowStart: number, rowEnd: number): Map<string, Merge> {
  const map = new Map<string, Merge>();
  for (const m of merges) {
    const top = Math.max(m.start.row, rowStart), bottom = Math.min(m.end.row, rowEnd - 1);
    if (top > bottom) continue;
    for (let r = top; r <= bottom; r++) for (let c = m.start.col; c <= m.end.col; c++) map.set(`${r},${c}`, 'skip');
    map.set(`${top},${m.start.col}`, { rowSpan: bottom - top + 1, colSpan: m.end.col - m.start.col + 1 });
  }
  return map;
}

export interface Cell {
  ref: string;
  value: number | string | boolean | null;
  display: string;
  type: 'n' | 's' | 'b' | 'e' | 'str' | 'd';
  formula?: string;
  numeric: boolean;
}
export interface Sheet {
  name: string;
  cells: Map<number, Map<number, Cell>>;
  /** Rows kept, capped by maxRows. */
  rowCount: number;
  colCount: number;
  /** Rows in the file, from the last row seen or the dimension. */
  totalRows: number;
  totalCols: number;
  rowsCapped: boolean;
  colsCapped: boolean;
  merges: CellRange[];
  colWidths: Map<number, number>;
  cfStyle(row: number, col: number): CfStyle | undefined;
}
export interface Workbook { sheets: Sheet[]; hiddenSheets: number; totalSheets: number; date1904: boolean }
export interface XlsxLimits { maxRows: number; maxCols: number; maxSheets: number }

interface CfBlock { ranges: CellRange[]; rules: CfRule[] }

function parseSheet(name: string, xml: string, shared: string[], styles: Styles, date1904: boolean, limits: XlsxLimits): Sheet {
  const root = parseXml(xml, `Sheet ${name}`).documentElement;
  const cells = new Map<number, Map<number, Cell>>();
  const sharedFormulas = new Map<string, { formula: string; row: number; col: number }>();
  let maxRow = -1, maxCol = -1, keptRows = 0, keptCols = 0;
  const dimension = parseRange(attr(kid(root, 'dimension'), 'ref') ?? '');
  for (const rowEl of kids(kid(root, 'sheetData'), 'row')) {
    const rowIndex = num(attr(rowEl, 'r'), maxRow + 2) - 1;
    maxRow = Math.max(maxRow, rowIndex);
    if (rowIndex >= limits.maxRows) continue;
    let nextCol = 0;
    for (const c of kids(rowEl, 'c')) {
      const pos = parseRef(attr(c, 'r') ?? '') ?? { row: rowIndex, col: nextCol };
      nextCol = pos.col + 1;
      maxCol = Math.max(maxCol, pos.col);
      const t = (attr(c, 't') ?? 'n') as Cell['type'] | 'inlineStr';
      const v = kid(c, 'v')?.textContent ?? undefined;
      const f = kid(c, 'f');
      let formula: string | undefined;
      if (f) {
        const text = f.textContent ?? '';
        const si = attr(f, 'si');
        if (attr(f, 't') === 'shared' && si !== undefined) {
          if (text) { sharedFormulas.set(si, { formula: text, row: pos.row, col: pos.col }); formula = text; }
          else { const master = sharedFormulas.get(si); if (master) formula = translateFormula(master.formula, pos.row - master.row, pos.col - master.col); }
        } else if (text) formula = text;
      }
      if (pos.col >= limits.maxCols) continue;
      const format = styles.formats[num(attr(c, 's'))] ?? 'General';
      let cell: Cell;
      if (t === 's') { const s = shared[num(v, -1)] ?? ''; cell = { ref: formatRef(pos.row, pos.col), value: s, display: s, type: 's', numeric: false }; }
      else if (t === 'inlineStr') { const s = kid(c, 'is') ? (kid(kid(c, 'is'), 't')?.textContent ?? kids(kid(c, 'is'), 'r').map(r => kid(r, 't')?.textContent ?? '').join('')) : ''; cell = { ref: formatRef(pos.row, pos.col), value: s, display: s, type: 's', numeric: false }; }
      else if (t === 'b') { const b = v === '1'; cell = { ref: formatRef(pos.row, pos.col), value: b, display: b ? 'TRUE' : 'FALSE', type: 'b', numeric: false }; }
      else if (t === 'e') cell = { ref: formatRef(pos.row, pos.col), value: v ?? '', display: v ?? '', type: 'e', numeric: false };
      else if (t === 'str' || t === 'd') cell = { ref: formatRef(pos.row, pos.col), value: v ?? '', display: v ?? '', type: t, numeric: false };
      else if (v !== undefined && v !== '' && Number.isFinite(Number(v))) { const n = Number(v); cell = { ref: formatRef(pos.row, pos.col), value: n, display: formatCellValue(n, format, date1904), type: 'n', numeric: true }; }
      else if (formula === undefined) continue;
      else cell = { ref: formatRef(pos.row, pos.col), value: null, display: '', type: 'n', numeric: false };
      if (formula !== undefined) cell.formula = `=${formula}`;
      let row = cells.get(pos.row);
      if (!row) { row = new Map(); cells.set(pos.row, row); }
      row.set(pos.col, cell);
      keptRows = Math.max(keptRows, pos.row + 1);
      keptCols = Math.max(keptCols, pos.col + 1);
    }
  }
  const totalRows = Math.max(maxRow + 1, dimension ? dimension.end.row + 1 : 0);
  const totalCols = Math.max(maxCol + 1, dimension ? dimension.end.col + 1 : 0);
  const merges = kids(kid(root, 'mergeCells'), 'mergeCell').map(m => parseRange(attr(m, 'ref') ?? '')).filter((m): m is CellRange => !!m);
  for (const m of merges) { keptRows = Math.max(keptRows, Math.min(m.end.row + 1, limits.maxRows)); keptCols = Math.max(keptCols, Math.min(m.end.col + 1, limits.maxCols)); }
  const colWidths = new Map<number, number>();
  for (const col of kids(kid(root, 'cols'), 'col')) {
    const width = num(attr(col, 'width'), 0);
    if (!width) continue;
    for (let i = num(attr(col, 'min'), 1) - 1, end = Math.min(num(attr(col, 'max'), 1), limits.maxCols); i < end; i++) colWidths.set(i, Math.round(Math.min(600, width * 7 + 5)));
  }
  const cf: CfBlock[] = kids(root, 'conditionalFormatting').map(block => ({
    ranges: (attr(block, 'sqref') ?? '').split(/\s+/).map(parseRange).filter((r): r is CellRange => !!r),
    rules: kids(block, 'cfRule').filter(rule => attr(rule, 'type') === 'cellIs').map(rule => ({
      operator: attr(rule, 'operator') ?? '',
      formulas: kids(rule, 'formula').map(f => f.textContent ?? ''),
      style: styles.dxfs[num(attr(rule, 'dxfId'), -1)] ?? {},
      priority: num(attr(rule, 'priority'), 1),
    })).sort((a, b) => a.priority - b.priority),
  })).filter(block => block.rules.length && block.ranges.length);
  const rowsCapped = totalRows > limits.maxRows;
  const colsCapped = totalCols > limits.maxCols;
  return {
    name, cells, merges, colWidths, totalRows, totalCols, rowsCapped, colsCapped,
    rowCount: Math.min(Math.max(keptRows, rowsCapped ? limits.maxRows : totalRows), limits.maxRows),
    colCount: Math.min(Math.max(keptCols, totalCols), limits.maxCols),
    cfStyle(row, col) {
      if (!cf.length) return undefined;
      const cell = cells.get(row)?.get(col);
      if (!cell) return undefined;
      for (const block of cf) {
        if (!block.ranges.some(r => row >= r.start.row && row <= r.end.row && col >= r.start.col && col <= r.end.col)) continue;
        for (const rule of block.rules) if (evaluateCellIs(rule, cell.value)) return Object.keys(rule.style).length ? rule.style : undefined;
      }
      return undefined;
    },
  };
}

export function parseXlsx(bytes: Uint8Array, overrides: Partial<XlsxLimits> = {}, zip: OfficeZip = openZip(bytes)): Workbook {
  const limits: XlsxLimits = { maxRows: XLSX_MAX_ROWS, maxCols: XLSX_MAX_COLS, maxSheets: XLSX_MAX_SHEETS, ...overrides };
  const rootRels = parseRels(zip.text('_rels/.rels'));
  const workbookPath = [...rootRels.values()].find(r => r.type === 'officeDocument')?.target.replace(/^\//, '') ?? 'xl/workbook.xml';
  const workbookXml = zip.text(workbookPath);
  if (!workbookXml) throw new OfficeError('damaged', 'This file has no workbook part. It may be damaged or not a spreadsheet.');
  const workbook = parseXml(workbookXml, 'Workbook').documentElement;
  const rels = parseRels(zip.text(relsPathFor(workbookPath)));
  const date1904 = ['1', 'true'].includes(attr(kid(workbook, 'workbookPr'), 'date1904') ?? '');
  const relOfType = (type: string) => [...rels.values()].find(r => r.type === type);
  const sharedRel = relOfType('sharedStrings'), stylesRel = relOfType('styles');
  const shared = parseSharedStrings(sharedRel ? zip.text(resolvePart(workbookPath, sharedRel.target)) : zip.text('xl/sharedStrings.xml'));
  const styles = parseStyles(stylesRel ? zip.text(resolvePart(workbookPath, stylesRel.target)) : zip.text('xl/styles.xml'));
  const all = desc(kid(workbook, 'sheets'), 'sheet');
  const visible = all.filter(s => !['hidden', 'veryHidden'].includes(plainAttr(s, 'state') ?? ''));
  const sheets: Sheet[] = [];
  for (const sheet of visible.slice(0, limits.maxSheets)) {
    const rel = rels.get(relAttr(sheet, 'id') ?? '');
    if (!rel || rel.external || rel.type !== 'worksheet') continue;
    const xml = zip.text(resolvePart(workbookPath, rel.target));
    if (xml === undefined) continue;
    sheets.push(parseSheet(plainAttr(sheet, 'name') ?? `Sheet ${sheets.length + 1}`, xml, shared, styles, date1904, limits));
  }
  if (!sheets.length && visible.length) throw new OfficeError('damaged', 'No worksheet in this workbook could be read. Chart sheets are not shown.');
  return { sheets, hiddenSheets: all.length - visible.length, totalSheets: all.length, date1904 };
}
