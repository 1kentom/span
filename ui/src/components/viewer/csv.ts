/** RFC 4180 CSV parsing for the viewer: quotes, escaped quotes, embedded newlines, CRLF/LF/CR, BOM, ragged rows. */

export type CsvDelimiter = ',' | ';' | '\t';
export const CSV_PAGE_ROWS = 200;
/** Hard cap on parsed rows. Rows past it are not parsed, and the viewer says so. */
export const CSV_MAX_ROWS = 100_000;
/** Characters parsed between yields so a large file never blocks the UI thread for long. */
export const CSV_CHUNK_CHARS = 256 * 1024;

export interface CsvResult {
  rows: string[][];
  delimiter: CsvDelimiter;
  /** Widest row. */
  columns: number;
  /** Rows whose width differs from the first row. */
  ragged: number;
  /** Parsing stopped at the row cap. */
  capped: boolean;
  /** The input ended inside a quoted field. */
  unterminated: boolean;
}

/** Streaming parser. Feed any chunk boundaries; the result is the same as parsing the whole text. */
export class CsvParser {
  private rows: string[][] = [];
  private row: string[] = [];
  private field = '';
  private inQuotes = false;
  private quotePending = false;
  private afterCR = false;
  private started = false;
  private fieldTouched = false;
  private capped = false;

  constructor(readonly delimiter: CsvDelimiter, readonly maxRows = CSV_MAX_ROWS) {}

  get rowCount(): number { return this.rows.length; }
  get done(): boolean { return this.capped; }

  push(chunk: string): void {
    if (this.capped) return;
    const delimiter = this.delimiter;
    let i = 0;
    if (!this.started && chunk.length) { this.started = true; if (chunk.charCodeAt(0) === 0xfeff) i = 1; }
    for (; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (c === '"') { this.field += '"'; continue; }
          this.inQuotes = false;
        } else if (c === '"') { this.quotePending = true; continue; }
        else {
          // Copy a run of ordinary characters at once.
          const end = chunk.indexOf('"', i);
          const stop = end < 0 ? chunk.length : end;
          this.field += chunk.slice(i, stop); i = stop - 1; continue;
        }
      }
      if (this.afterCR) { this.afterCR = false; if (c === '\n') continue; }
      if (c === delimiter) { this.endField(); }
      else if (c === '\n') { this.endRow(); }
      else if (c === '\r') { this.endRow(); this.afterCR = true; }
      else if (c === '"' && !this.fieldTouched) { this.inQuotes = true; this.fieldTouched = true; }
      else { this.field += c; this.fieldTouched = true; }
      if (this.capped) return;
    }
  }

  finish(): CsvResult {
    const unterminated = this.inQuotes && !this.quotePending;
    if (!this.capped && (this.fieldTouched || this.row.length)) this.endRow();
    const rows = this.rows;
    const width = rows[0]?.length ?? 0;
    let columns = 0, ragged = 0;
    for (const row of rows) { if (row.length > columns) columns = row.length; if (row.length !== width) ragged++; }
    return { rows, delimiter: this.delimiter, columns, ragged, capped: this.capped, unterminated };
  }

  private endField(): void { this.row.push(this.field); this.field = ''; this.fieldTouched = false; }
  private endRow(): void {
    this.endField();
    const row = this.row; this.row = [];
    if (row.length === 1 && row[0] === '') return; // blank line
    if (this.rows.length >= this.maxRows) { this.capped = true; return; }
    this.rows.push(row);
  }
}

export function parseCsv(text: string, delimiter: CsvDelimiter, maxRows = CSV_MAX_ROWS): CsvResult {
  const parser = new CsvParser(delimiter, maxRows);
  parser.push(text);
  return parser.finish();
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
/** Parses in chunks and yields to the event loop between them. Rejects with "Parsing cancelled" when aborted. */
export async function parseCsvChunked(text: string, options: { delimiter: CsvDelimiter; maxRows?: number; chunkChars?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<CsvResult> {
  const parser = new CsvParser(options.delimiter, options.maxRows ?? CSV_MAX_ROWS);
  const size = Math.max(1, options.chunkChars ?? CSV_CHUNK_CHARS);
  for (let at = 0; at < text.length && !parser.done; at += size) {
    if (options.signal?.aborted) throw new Error('Parsing cancelled');
    parser.push(text.slice(at, at + size));
    options.onProgress?.(Math.min(1, (at + size) / text.length));
    await tick();
    if (options.signal?.aborted) throw new Error('Parsing cancelled');
  }
  options.onProgress?.(1);
  return parser.finish();
}

/** Count of a delimiter outside quotes in one line. */
function countOutside(line: string, delimiter: string): number {
  let inQuotes = false, count = 0;
  for (const c of line) { if (c === '"') inQuotes = !inQuotes; else if (c === delimiter && !inQuotes) count++; }
  return count;
}
/** Picks the delimiter whose per-line count is most consistent across the first lines. Defaults to comma. */
export function sniffDelimiter(sample: string): CsvDelimiter {
  const lines = sample.replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(line => line.length).slice(0, 20);
  let best: CsvDelimiter = ',', bestScore = 0;
  for (const delimiter of [',', ';', '\t'] as CsvDelimiter[]) {
    const counts = lines.map(line => countOutside(line, delimiter));
    const frequency = new Map<number, number>();
    for (const count of counts) if (count > 0) frequency.set(count, (frequency.get(count) ?? 0) + 1);
    let mode = 0, modeHits = 0;
    for (const [count, hits] of frequency) if (hits > modeHits || (hits === modeHits && count > mode)) { mode = count; modeHits = hits; }
    const score = mode ? modeHits * 1000 + mode : 0;
    if (score > bestScore) { best = delimiter; bestScore = score; }
  }
  return best;
}

const numeric = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
export function isNumericCell(value: string): boolean {
  const text = value.trim();
  return /\d/.test(text) && numeric.test(text);
}
const toNumber = (value: string) => Number(value.trim().replace(/,/g, ''));

/** A header row is all filled in, unique, not numeric, and differs from the rows below it. */
export function detectHeader(rows: string[][]): boolean {
  const first = rows[0];
  if (!first?.length) return false;
  if (first.some(cell => !cell.trim() || isNumericCell(cell))) return false;
  if (new Set(first.map(cell => cell.trim().toLowerCase())).size !== first.length) return false;
  const body = rows.slice(1, 51);
  return !first.some((cell, column) => body.some(row => row[column] === cell));
}

export type CsvSort = { column: number; direction: 'asc' | 'desc' } | null;
export function nextSort(current: CsvSort, column: number): CsvSort {
  if (!current || current.column !== column) return { column, direction: 'asc' };
  return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}
/** Row order for a sort. Numeric when every non-empty cell of the column is numeric. Empty cells last. Stable. */
export function sortedOrder(rows: string[][], sort: CsvSort): number[] {
  const order = rows.map((_, i) => i);
  if (!sort) return order;
  const { column, direction } = sort;
  const cell = (i: number) => rows[i][column] ?? '';
  const asNumbers = rows.every(row => !(row[column] ?? '').trim() || isNumericCell(row[column]));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sign = direction === 'asc' ? 1 : -1;
  return order.sort((a, b) => {
    const x = cell(a), y = cell(b);
    const emptyX = !x.trim(), emptyY = !y.trim();
    if (emptyX || emptyY) return emptyX === emptyY ? a - b : emptyX ? 1 : -1;
    const result = asNumbers ? toNumber(x) - toNumber(y) : collator.compare(x, y);
    return result ? result * sign : a - b;
  });
}

export function pageLabel(shown: number, total: number): string {
  if (!total) return 'No rows';
  return `Showing rows 1 to ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}
export function csvSummary(delimiter: CsvDelimiter, header: boolean): string {
  const name = delimiter === ',' ? 'Comma' : delimiter === ';' ? 'Semicolon' : 'Tab';
  return `${name}-separated · UTF-8 · ${header ? 'header row detected' : 'no header row'}`;
}
