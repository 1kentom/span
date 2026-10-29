import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, on } from 'solid-js';
import { rowWindow, scrollTopFor } from '../../../lib/office/window';
import { formatRef, indexToCol, mergeLayout, parseXlsx, type Sheet, type Workbook } from '../../../lib/office/xlsx';
import { ViewerState } from '../ViewerStates';
import { OfficeFailure, createParse, plural, type DocumentViewProps } from './shared';
import '../../../styles/office.css';

import { XLSX_MAX_BYTES } from '../../../lib/office/limits';
export { XLSX_MAX_BYTES };
const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 24;
const PAGE_ROWS = 20;

function SheetGrid(props: { sheet: Sheet; sheetIndex: number }) {
  const [selected, setSelected] = createSignal({ row: 0, col: 0 });
  const [scroll, setScroll] = createSignal({ top: 0, height: 600 });
  let scroller: HTMLDivElement | undefined;
  createEffect(on(() => props.sheet, () => { setSelected({ row: 0, col: 0 }); if (scroller) scroller.scrollTop = 0; setScroll(s => ({ ...s, top: 0 })); }));

  const span = createMemo(() => rowWindow(scroll().top, ROW_HEIGHT, scroll().height, props.sheet.rowCount));
  const rows = createMemo(() => { const { start, end } = span(); return Array.from({ length: end - start }, (_, i) => start + i); });
  const cols = createMemo(() => Array.from({ length: props.sheet.colCount }, (_, i) => i));
  const merges = createMemo(() => mergeLayout(props.sheet.merges, span().start, span().end));
  const cellAt = (row: number, col: number) => props.sheet.cells.get(row)?.get(col);
  const active = () => cellAt(selected().row, selected().col);
  const cellId = (row: number, col: number) => `ox-cell-${props.sheetIndex}-${row}-${col}`;

  const select = (row: number, col: number) => {
    const next = { row: Math.min(Math.max(0, props.sheet.rowCount - 1), Math.max(0, row)), col: Math.min(Math.max(0, props.sheet.colCount - 1), Math.max(0, col)) };
    setSelected(next);
    if (scroller) {
      const viewport = Math.max(ROW_HEIGHT, scroller.clientHeight - HEADER_HEIGHT);
      const top = scrollTopFor(next.row, ROW_HEIGHT, scroller.scrollTop, viewport);
      if (top !== scroller.scrollTop) { scroller.scrollTop = top; setScroll({ top, height: scroller.clientHeight || 600 }); }
      queueMicrotask(() => document.getElementById(cellId(next.row, next.col))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
    }
  };
  const onKey = (event: KeyboardEvent) => {
    const { row, col } = selected();
    const mod = event.metaKey || event.ctrlKey;
    const moves: Record<string, () => void> = {
      ArrowUp: () => select(mod ? 0 : row - 1, col), ArrowDown: () => select(mod ? props.sheet.rowCount - 1 : row + 1, col),
      ArrowLeft: () => select(row, mod ? 0 : col - 1), ArrowRight: () => select(row, mod ? props.sheet.colCount - 1 : col + 1),
      Home: () => select(mod ? 0 : row, 0), End: () => select(mod ? props.sheet.rowCount - 1 : row, props.sheet.colCount - 1),
      PageUp: () => select(row - PAGE_ROWS, col), PageDown: () => select(row + PAGE_ROWS, col),
      Tab: () => select(row, col + (event.shiftKey ? -1 : 1)),
    };
    const move = moves[event.key];
    if (!move || (event.key === 'Tab' && ((event.shiftKey && col === 0) || (!event.shiftKey && col >= props.sheet.colCount - 1)))) return;
    event.preventDefault();
    move();
  };

  const status = () => {
    const s = props.sheet;
    const parts = [s.totalRows ? `Showing rows 1 to ${s.rowCount.toLocaleString('en-US')} of ${s.totalRows.toLocaleString('en-US')}` : 'This sheet is empty'];
    if (s.rowsCapped) parts.push(`rows past ${s.rowCount.toLocaleString('en-US')} are beyond the preview limit`);
    if (s.colsCapped) parts.push(`columns past ${indexToCol(s.colCount - 1)} are not shown`);
    return parts.join(', ');
  };

  return <>
    <div class="ox-formula">
      <span class="ox-ref" aria-label="Selected cell">{formatRef(selected().row, selected().col)}</span>
      <span class="ox-fx" aria-hidden="true">fx</span>
      <output class="ox-fx-text" aria-label={active()?.formula ? 'Formula' : 'Value'}>{active()?.formula ?? active()?.display ?? ''}</output>
    </div>
    <div class="ox-sheet-status"><span>{status()}</span><span class="vw-spacer" /><span>Read-only, formulas show their saved values</span></div>
    <div class="ox-grid-scroll" ref={scroller} onScroll={event => setScroll({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight || 600 })}>
      <table class="ox-grid" role="grid" tabindex="0" aria-label={`Sheet ${props.sheet.name}`} aria-rowcount={props.sheet.rowCount + 1} aria-colcount={props.sheet.colCount + 1}
        aria-activedescendant={cellId(selected().row, selected().col)} onKeyDown={onKey}>
        <thead><tr aria-rowindex={1}>
          <th class="ox-corner" scope="col"><span class="vw-sr">Row</span></th>
          <Index each={cols()}>{col => <th scope="col" class="ox-col-head" classList={{ 'ox-head-on': selected().col === col() }} style={{ 'min-width': `${props.sheet.colWidths.get(col()) ?? 80}px` }}>{indexToCol(col())}</th>}</Index>
        </tr></thead>
        <tbody>
          <Show when={span().start > 0}><tr aria-hidden="true" class="ox-spacer" style={{ height: `${span().start * ROW_HEIGHT}px` }}><td colspan={props.sheet.colCount + 1} /></tr></Show>
          <For each={rows()}>{row => (
            <tr aria-rowindex={row + 2}>
              <th scope="row" class="ox-row-head" classList={{ 'ox-head-on': selected().row === row }}>{row + 1}</th>
              <For each={cols()}>{col => {
                const merge = () => merges().get(`${row},${col}`);
                const cell = () => cellAt(row, col);
                const cf = () => props.sheet.cfStyle(row, col);
                const on = () => selected().row === row && selected().col === col;
                return <Show when={merge() !== 'skip'}>
                  <td id={cellId(row, col)} role="gridcell" aria-selected={on()} aria-colindex={col + 2}
                    rowspan={typeof merge() === 'object' ? (merge() as { rowSpan: number }).rowSpan : undefined}
                    colspan={typeof merge() === 'object' ? (merge() as { colSpan: number }).colSpan : undefined}
                    class="ox-cell" classList={{ 'ox-num': cell()?.numeric, 'ox-bool': cell()?.type === 'b', 'ox-err': cell()?.type === 'e', 'ox-sel': on(), 'ox-cf': !!cf() }}
                    style={{ color: cf()?.color, background: cf()?.background, 'font-weight': cf()?.bold ? 600 : undefined }}
                    title={cell()?.formula} onClick={() => select(row, col)}>{cell()?.display ?? ''}</td>
                </Show>;
              }}</For>
            </tr>
          )}</For>
          <Show when={span().end < props.sheet.rowCount}><tr aria-hidden="true" class="ox-spacer" style={{ height: `${(props.sheet.rowCount - span().end) * ROW_HEIGHT}px` }}><td colspan={props.sheet.colCount + 1} /></tr></Show>
        </tbody>
      </table>
    </div>
  </>;
}

function WorkbookBody(props: { book: Workbook; onMeta?: (parts: string[]) => void }) {
  const [index, setIndex] = createSignal(0);
  const sheet = () => props.book.sheets[Math.min(index(), props.book.sheets.length - 1)];
  createEffect(on(() => props.book, () => setIndex(0)));
  createEffect(() => props.onMeta?.([plural(props.book.sheets.length, 'sheet'), plural(sheet()?.totalRows ?? 0, 'row'), 'Excel workbook']));
  const tabKey = (event: KeyboardEvent) => {
    const n = props.book.sheets.length;
    const next = event.key === 'ArrowRight' ? (index() + 1) % n : event.key === 'ArrowLeft' ? (index() - 1 + n) % n : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    setIndex(next);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-sheet="${next}"]`)?.focus();
  };
  return <div class="ox-sheet">
    <Show when={sheet()} keyed>{s => <SheetGrid sheet={s} sheetIndex={index()} />}</Show>
    <div class="ox-sheet-tabs" role="tablist" aria-label="Sheets" onKeyDown={tabKey}>
      <For each={props.book.sheets}>{(s, i) => <button type="button" role="tab" class="ox-tab" data-sheet={i()} aria-selected={i() === index()} tabindex={i() === index() ? 0 : -1} onClick={() => setIndex(i())}>{s.name}</button>}</For>
      <Show when={props.book.hiddenSheets}><span class="ox-dim ox-tab-note">{plural(props.book.hiddenSheets, 'hidden sheet')} not shown</span></Show>
    </div>
  </div>;
}

export default function XlsxView(props: DocumentViewProps) {
  const parsed = createParse(() => props.bytes, bytes => parseXlsx(bytes), XLSX_MAX_BYTES, 'workbook');
  return <Switch>
    <Match when={parsed().state === 'loading'}><ViewerState kind="loading" text={`Reading ${props.name}…`} /></Match>
    <Match when={parsed().state === 'error'}><OfficeFailure error={(parsed() as { error: unknown }).error} label="workbook" onOpenWithSystem={props.onOpenWithSystem} /></Match>
    <Match when={parsed().state === 'ready'}>{(() => { const book = () => (parsed() as { value: Workbook }).value;
      return <Show when={book().sheets.length} fallback={<ViewerState kind="unsupported" title="No worksheets" text="This workbook has no visible worksheet to show." />}><WorkbookBody book={book()} onMeta={props.onMeta} /></Show>; })()}</Match>
  </Switch>;
}
