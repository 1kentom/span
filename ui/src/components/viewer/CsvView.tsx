import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import { extensionOf } from '../../lib/viewer';
import Icon from '../Icon';
import { CSV_MAX_ROWS, CSV_PAGE_ROWS, csvSummary, detectHeader, isNumericCell, nextSort, pageLabel, parseCsvChunked, sniffDelimiter, sortedOrder, type CsvDelimiter, type CsvResult, type CsvSort } from './csv';
import { ViewerState } from './ViewerStates';

/**
 * CSV and TSV table: own RFC 4180 parser run in chunks, delimiter sniffing, header detection, a sticky header,
 * column sort and paging of 200 rows. Rows past CSV_MAX_ROWS are not parsed and the viewer says so.
 */
export function CsvView(props: { text: string; name: string; truncatedNote?: string; onMeta?: (parts: string[]) => void }) {
  const [result, setResult] = createSignal<CsvResult | null>(null);
  const [progress, setProgress] = createSignal(0);
  const [failure, setFailure] = createSignal('');
  const [header, setHeader] = createSignal(false);
  const [sort, setSort] = createSignal<CsvSort>(null);
  const [shown, setShown] = createSignal(CSV_PAGE_ROWS);
  const delimiter = createMemo<CsvDelimiter>(() => extensionOf(props.name) === 'tsv' ? '\t' : sniffDelimiter(props.text.slice(0, 64 * 1024)));

  createEffect(on(() => [props.text, delimiter()] as const, ([text, separator]) => {
    const controller = new AbortController();
    setResult(null); setFailure(''); setProgress(0); setSort(null); setShown(CSV_PAGE_ROWS);
    parseCsvChunked(text, { delimiter: separator, signal: controller.signal, onProgress: setProgress })
      .then(parsed => { setHeader(detectHeader(parsed.rows)); setResult(parsed); })
      .catch(cause => { if (!controller.signal.aborted) setFailure(cause instanceof Error ? cause.message : String(cause)); });
    onCleanup(() => controller.abort());
  }));

  const body = createMemo(() => { const rows = result()?.rows ?? []; return header() ? rows.slice(1) : rows; });
  const columns = createMemo(() => result()?.columns ?? 0);
  const labels = createMemo(() => Array.from({ length: columns() }, (_, i) => (header() ? result()?.rows[0]?.[i] : undefined) || `Column ${i + 1}`));
  const numericColumns = createMemo(() => Array.from({ length: columns() }, (_, column) => {
    const sample = body().slice(0, 200).map(row => row[column] ?? '').filter(cell => cell.trim());
    return sample.length > 0 && sample.every(isNumericCell);
  }));
  const order = createMemo(() => sortedOrder(body(), sort()));
  const visible = createMemo(() => order().slice(0, shown()));
  createEffect(() => {
    const parsed = result();
    if (parsed) props.onMeta?.([`${body().length.toLocaleString('en-US')} rows`, `${columns()} columns`, extensionOf(props.name) === 'tsv' ? 'TSV' : 'CSV']);
  });
  const ariaSort = (column: number) => sort()?.column === column ? (sort()!.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return <div class="vw-csv">
    <Show when={!failure()} fallback={<ViewerState kind="damaged" title="Cannot read this table" text={failure()} />}>
      <Show when={result()} fallback={<ViewerState kind="loading" text={`Reading rows… ${Math.round(progress() * 100)}%`} />}>
        {parsed => <>
          <div class="vw-csv-bar">
            <span>{csvSummary(parsed().delimiter, header())}</span>
            <button type="button" class="vw-btn" aria-pressed={header()} onClick={() => { setHeader(!header()); setSort(null); }}>First row is header</button>
            <span class="vw-spacer" />
            <span role="status" aria-live="polite">{pageLabel(Math.min(shown(), body().length), body().length)}</span>
            <Show when={shown() < body().length}><button type="button" class="vw-btn vw-btn-outline" onClick={() => setShown(shown() + CSV_PAGE_ROWS)}>Load more</button></Show>
          </div>
          <Show when={props.truncatedNote}><p class="vw-note" role="note">{props.truncatedNote} Rows after that are not loaded.</p></Show>
          <Show when={parsed().capped}><p class="vw-note" role="note">Only the first {CSV_MAX_ROWS.toLocaleString('en-US')} rows are loaded. Open the file with a system app to see the rest.</p></Show>
          <Show when={parsed().unterminated}><p class="vw-note" role="note">The file ends inside a quoted field, so the last row may be incomplete.</p></Show>
          <Show when={parsed().ragged > 0}><p class="vw-note" role="note">{parsed().ragged.toLocaleString('en-US')} {parsed().ragged === 1 ? 'row has' : 'rows have'} a different number of columns than the first row.</p></Show>
          <Show when={body().length} fallback={<ViewerState kind="unsupported" title="Empty table" text="This file has no rows." />}>
            <div class="vw-csv-scroll" tabIndex={0} role="region" aria-label={`Table of ${props.name}`}>
              <table class="vw-csv-table" aria-rowcount={body().length + 1} aria-colcount={columns()}>
                <thead><tr>
                  <th class="vw-csv-corner" scope="col"><span class="vw-sr">Row</span></th>
                  <For each={labels()}>{(label, column) => <th scope="col" aria-sort={ariaSort(column())} classList={{ 'vw-num': numericColumns()[column()] }}>
                    <button type="button" class="vw-csv-sort" onClick={() => setSort(nextSort(sort(), column()))} aria-label={`${label}, sort ${ariaSort(column()) === 'ascending' ? 'descending' : ariaSort(column()) === 'descending' ? 'off' : 'ascending'}`}>
                      <span>{label}</span>
                      <Show when={sort()?.column === column()} fallback={<Icon name="arrow-down4" size={8} class="vw-csv-sort-idle" />}><Icon name={sort()!.direction === 'asc' ? 'arrow-up3' : 'arrow-down4'} size={8} /></Show>
                    </button>
                  </th>}</For>
                </tr></thead>
                <tbody>
                  <For each={visible()}>{index => <tr>
                    <th scope="row" class="vw-csv-n">{index + 1}</th>
                    <For each={labels()}>{(_, column) => <td classList={{ 'vw-num': numericColumns()[column()] }}>{body()[index][column()] ?? ''}</td>}</For>
                  </tr>}</For>
                </tbody>
              </table>
            </div>
          </Show>
        </>}
      </Show>
    </Show>
  </div>;
}
