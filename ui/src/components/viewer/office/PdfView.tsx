import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { loadPdf, paperLabel, type PdfLoaded, type PdfLoader, type PdfPageLike } from '../../../lib/office/pdf-loader';
import {
  CSS_PER_PT, PDF_ZOOM_MAX, PDF_ZOOM_MIN, canvasScale, findMatches, fitWidthZoom, matchRect, nextMatchIndex, pageLayout, parsePageInput, stepPdfZoom,
  visiblePages, type FindMatch,
} from '../../../lib/office/pdf-math';
import Icon from '../../Icon';
import { ViewerState } from '../ViewerStates';
import { OfficeFailure, createParse, plural, type DocumentViewProps } from './shared';
import '../../../styles/office.css';

import { PDF_MAX_BYTES } from '../../../lib/office/limits';
export { PDF_MAX_BYTES };
/** Text of at most this many pages is searched. */
export const PDF_FIND_MAX_PAGES = 1000;
const GAP = 16;
const PAD = 24;
const THUMB_WIDTH = 60;
const THUMB_ITEM = 112;

interface PageSize { w: number; h: number }
interface TextItem { str: string; transform: number[]; width: number }

/** One serial queue per document so only one page renders at a time. */
function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(job: () => Promise<T>): Promise<T> => { const run = tail.then(job, job); tail = run.catch(() => undefined); return run; };
}

function PdfPageCanvas(props: {
  loaded: PdfLoaded; pageNumber: number; scale: number; queue: ReturnType<typeof createQueue>; onSize?: (size: PageSize) => void;
  items?: TextItem[]; matches?: FindMatch[]; active?: FindMatch;
}) {
  let canvas: HTMLCanvasElement | undefined;
  const [page, setPage] = createSignal<PdfPageLike>();
  const [rendered, setRendered] = createSignal(false);
  let alive = true;
  onCleanup(() => { alive = false; });
  onMount(() => {
    void props.queue(() => props.loaded.doc.getPage(props.pageNumber)).then(p => {
      if (!alive) return;
      const base = p.getViewport({ scale: 1 });
      props.onSize?.({ w: base.width, h: base.height });
      setPage(p);
    }, () => undefined);
  });
  createEffect(on([page, () => props.scale] as const, ([p, scale]) => {
    if (!p || !canvas) return;
    let task: { cancel(): void } | undefined;
    let cancelled = false;
    onCleanup(() => { cancelled = true; task?.cancel(); });
    void props.queue(async () => {
      if (cancelled || !canvas) return;
      const viewport = p.getViewport({ scale });
      const backing = canvasScale(viewport.width, viewport.height, globalThis.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(viewport.width * backing));
      canvas.height = Math.max(1, Math.floor(viewport.height * backing));
      const context = canvas.getContext('2d');
      if (!context) return;
      const render = p.render({ canvasContext: context, canvas, viewport, transform: backing !== 1 ? [backing, 0, 0, backing, 0, 0] : undefined });
      task = render;
      try { await render.promise; if (!cancelled) setRendered(true); } catch { /* cancelled renders reject */ }
    });
  }));
  // Release the backing store as soon as the page leaves the window.
  onCleanup(() => { if (canvas) { canvas.width = 0; canvas.height = 0; } page()?.cleanup(); });
  const highlights = createMemo(() => {
    const p = page();
    if (!p || !props.items || !props.matches?.length) return [];
    const viewport = p.getViewport({ scale: props.scale });
    return props.matches.map(m => ({ match: m, rect: props.items![m.item] ? matchRect(viewport.transform, viewport.scale, props.items![m.item], m.start, m.length) : undefined })).filter(h => h.rect);
  });
  return <>
    <canvas ref={canvas} class="ox-pdf-canvas" classList={{ 'ox-pdf-pending': !rendered() }} aria-hidden="true" />
    <For each={highlights()}>{h => <span class="ox-pdf-hit" classList={{ 'ox-pdf-hit-on': h.match === props.active }} style={{ left: `${h.rect!.left}px`, top: `${h.rect!.top}px`, width: `${h.rect!.width}px`, height: `${h.rect!.height}px` }} />}</For>
  </>;
}

function PdfBody(props: { loaded: PdfLoaded; onMeta?: (parts: string[]) => void }) {
  const count = () => props.loaded.doc.numPages;
  const [sizes, setSizes] = createSignal<PageSize[]>([]);
  const [zoom, setZoom] = createSignal<number | 'fit'>('fit');
  const [stageWidth, setStageWidth] = createSignal(0);
  const [scroll, setScroll] = createSignal({ top: 0, height: 0 });
  const [railScroll, setRailScroll] = createSignal({ top: 0, height: 0 });
  const [pageText, setPageText] = createSignal('1');
  const [query, setQuery] = createSignal('');
  const [texts, setTexts] = createSignal<TextItem[][]>([]);
  const [searching, setSearching] = createSignal(false);
  const [matches, setMatches] = createSignal<FindMatch[]>([]);
  const [activeMatch, setActiveMatch] = createSignal(-1);
  // The query the current matches belong to, so Enter after typing searches instead of stepping stale matches.
  const [searched, setSearched] = createSignal('');
  const queue = createQueue();
  let stage: HTMLDivElement | undefined;
  let rail: HTMLElement | undefined;
  let findInput: HTMLInputElement | undefined;

  onMount(() => {
    void queue(() => props.loaded.doc.getPage(1)).then(p => {
      const v = p.getViewport({ scale: 1 });
      setSizes(Array.from({ length: count() }, () => ({ w: v.width, h: v.height })));
      props.onMeta?.([plural(count(), 'page'), ...(paperLabel(v.width, v.height) ? [paperLabel(v.width, v.height)!] : []), props.loaded.version ? `PDF ${props.loaded.version}` : 'PDF', 'Scripts and links disabled']);
    }, () => undefined);
    if (stage) {
      setStageWidth(stage.clientWidth);
      setScroll({ top: stage.scrollTop, height: stage.clientHeight });
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => { if (stage) { setStageWidth(stage.clientWidth); setScroll({ top: stage.scrollTop, height: stage.clientHeight }); } });
        observer.observe(stage);
        onCleanup(() => observer.disconnect());
      }
    }
    if (rail) setRailScroll({ top: rail.scrollTop, height: rail.clientHeight });
  });

  const effectiveZoom = () => { const z = zoom(); return z === 'fit' ? fitWidthZoom(sizes()[0]?.w ?? 612, stageWidth()) : z; };
  const scale = () => effectiveZoom() / 100 * CSS_PER_PT;
  const layout = createMemo(() => pageLayout(sizes().map(s => s.h * scale()), GAP));
  const visible = createMemo(() => visiblePages(layout(), scroll().top - PAD, scroll().height, 1));
  const current = createMemo(() => {
    const l = layout(), probe = scroll().top - PAD + scroll().height * 0.3;
    let index = 0;
    while (index + 1 < l.tops.length && l.tops[index + 1] <= probe) index++;
    return index + 1;
  });
  createEffect(on(current, page => setPageText(String(page))));
  const thumbs = createMemo(() => visiblePages(pageLayout(sizes().map(() => THUMB_ITEM - 10), 10), railScroll().top, railScroll().height || 600, 2));

  const goTo = (page: number) => {
    const l = layout();
    if (!stage || !l.tops.length) return;
    const top = l.tops[Math.min(l.tops.length, Math.max(1, page)) - 1] + PAD - 8;
    stage.scrollTop = top;
    setScroll({ top, height: stage.clientHeight });
  };
  const setSize = (index: number, size: PageSize) => setSizes(list => list[index] && (list[index].w !== size.w || list[index].h !== size.h) ? list.map((s, i) => i === index ? size : s) : list);
  // Keep the same page in view when the zoom changes.
  const changeZoom = (next: number | 'fit') => { const page = current(); setZoom(next); queueMicrotask(() => goTo(page)); };

  async function ensureText(): Promise<TextItem[][]> {
    if (texts().length) return texts();
    setSearching(true);
    const out: TextItem[][] = [];
    for (let n = 1; n <= Math.min(count(), PDF_FIND_MAX_PAGES); n++) {
      try {
        const page = await queue(() => props.loaded.doc.getPage(n));
        const content = await page.getTextContent();
        out.push(content.items.filter(i => typeof i.str === 'string').map(i => ({ str: i.str!, transform: i.transform ?? [1, 0, 0, 1, 0, 0], width: i.width ?? 0 })));
      } catch { out.push([]); }
    }
    setTexts(out);
    setSearching(false);
    return out;
  }
  let findTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(findTimer));
  const runFind = async (q: string) => {
    clearTimeout(findTimer);
    setSearched(q);
    if (!q.trim()) { setMatches([]); setActiveMatch(-1); return; }
    const pages = await ensureText();
    if (searched() !== q) return;
    const found = findMatches(pages.map(items => items.map(i => i.str)), q);
    setMatches(found);
    setActiveMatch(found.length ? 0 : -1);
    if (found.length) goTo(found[0].page + 1);
  };
  const stepMatch = (direction: 1 | -1) => {
    const next = nextMatchIndex(activeMatch(), matches().length, direction);
    setActiveMatch(next);
    if (next >= 0) goTo(matches()[next].page + 1);
  };

  const onStageKey = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); findInput?.focus(); return; }
    const page = current();
    const map: Record<string, () => void> = {
      PageDown: () => goTo(page + 1), ArrowRight: () => goTo(page + 1), PageUp: () => goTo(page - 1), ArrowLeft: () => goTo(page - 1),
      Home: () => goTo(1), End: () => goTo(count()), '+': () => changeZoom(stepPdfZoom(effectiveZoom(), 1)), '=': () => changeZoom(stepPdfZoom(effectiveZoom(), 1)),
      '-': () => changeZoom(stepPdfZoom(effectiveZoom(), -1)), '0': () => changeZoom('fit'),
    };
    const action = map[event.key];
    if (!action || event.altKey) return;
    event.preventDefault();
    action();
  };
  const commitPage = () => { const n = parsePageInput(pageText(), count()); if (n) goTo(n); else setPageText(String(current())); };
  const pageMatches = (index: number) => matches().filter(m => m.page === index);
  const activeValue = () => matches()[activeMatch()];

  return <div class="ox-pdf">
    <div class="ox-toolbar">
      <div class="vw-group">
        <input class="ox-input ox-page-input" aria-label="Page number" inputmode="numeric" value={pageText()} onInput={e => setPageText(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitPage(); } }} onBlur={commitPage} />
        <span class="ox-dim">of {count()}</span>
      </div>
      <div class="vw-group" role="group" aria-label="Zoom">
        <button type="button" class="vw-btn vw-btn-icon" aria-label="Zoom out" disabled={effectiveZoom() <= PDF_ZOOM_MIN} onClick={() => changeZoom(stepPdfZoom(effectiveZoom(), -1))}>−</button>
        <span class="vw-readout" aria-live="polite">{effectiveZoom()}%</span>
        <button type="button" class="vw-btn vw-btn-icon" aria-label="Zoom in" disabled={effectiveZoom() >= PDF_ZOOM_MAX} onClick={() => changeZoom(stepPdfZoom(effectiveZoom(), 1))}>+</button>
        <button type="button" class="vw-btn" aria-pressed={zoom() === 'fit'} onClick={() => changeZoom('fit')}>Fit width</button>
      </div>
      <div class="ox-find" role="search">
        <Icon name="SearchNormal1" size={12} />
        <input ref={findInput} class="ox-find-input" type="search" placeholder="Find in document" aria-label="Find in document" value={query()}
          onInput={e => { const q = e.currentTarget.value; setQuery(q); clearTimeout(findTimer); findTimer = setTimeout(() => void runFind(q), 250); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (searched() === query() && matches().length) stepMatch(e.shiftKey ? -1 : 1); else void runFind(query()); } else if (e.key === 'Escape') { setQuery(''); void runFind(''); stage?.focus(); } }} />
        <Show when={query().trim()}>
          <span class="ox-dim ox-find-count" aria-live="polite">{searching() ? 'Searching…' : matches().length ? `${activeMatch() + 1} of ${matches().length}` : 'No matches'}</span>
          <button type="button" class="vw-btn vw-btn-icon" aria-label="Previous match" disabled={!matches().length} onClick={() => stepMatch(-1)}><Icon name="arrow-up3" size={12} /></button>
          <button type="button" class="vw-btn vw-btn-icon" aria-label="Next match" disabled={!matches().length} onClick={() => stepMatch(1)}><Icon name="arrow-down4" size={12} /></button>
        </Show>
      </div>
    </div>
    <Show when={count() > PDF_FIND_MAX_PAGES && query().trim()}><p class="vw-note" role="note">Find searches the first {PDF_FIND_MAX_PAGES.toLocaleString('en-US')} pages.</p></Show>
    <div class="ox-pdf-main">
      <nav class="ox-pdf-rail" ref={rail} aria-label="Pages" onScroll={e => setRailScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        <div style={{ height: `${sizes().length * THUMB_ITEM}px`, position: 'relative' }}>
          <Index each={sizes()}>{(size, i) => (
            <button type="button" class="ox-pdf-thumb" style={{ top: `${i * THUMB_ITEM + 10}px` }} aria-label={`Page ${i + 1}`} aria-current={current() === i + 1 ? 'page' : undefined} onClick={() => goTo(i + 1)}>
              <span class="ox-pdf-thumb-page" style={{ width: `${THUMB_WIDTH}px`, height: `${Math.round(THUMB_WIDTH * size().h / size().w)}px` }}>
                <Show when={i >= thumbs().first && i <= thumbs().last}><PdfPageCanvas loaded={props.loaded} pageNumber={i + 1} scale={THUMB_WIDTH / size().w} queue={queue} /></Show>
              </span>
              <span class="ox-dim">{i + 1}</span>
            </button>
          )}</Index>
        </div>
      </nav>
      <div class="ox-pdf-stage" ref={stage} tabindex="0" aria-label="PDF pages. Page Up and Page Down change pages, plus and minus zoom." onKeyDown={onStageKey}
        onScroll={e => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        <div class="ox-pdf-pages" style={{ height: `${layout().total + PAD * 2}px`, 'min-width': `${Math.max(0, ...sizes().map(s => s.w * scale())) + PAD * 2}px` }}>
          <Index each={sizes()}>{(size, i) => (
            <div class="ox-pdf-page" role="img" aria-label={`Page ${i + 1} of ${count()}`} style={{ top: `${(layout().tops[i] ?? 0) + PAD}px`, width: `${size().w * scale()}px`, height: `${size().h * scale()}px` }}>
              <Show when={i >= visible().first && i <= visible().last}>
                <PdfPageCanvas loaded={props.loaded} pageNumber={i + 1} scale={scale()} queue={queue} onSize={s => setSize(i, s)} items={texts()[i]} matches={pageMatches(i)} active={activeValue()} />
              </Show>
            </div>
          )}</Index>
        </div>
      </div>
    </div>
  </div>;
}

export default function PdfView(props: DocumentViewProps & { loader?: PdfLoader }) {
  const parsed = createParse(() => props.bytes, bytes => (props.loader ?? loadPdf)(bytes), PDF_MAX_BYTES, 'PDF', loaded => { void loaded.destroy(); });
  return <Switch>
    <Match when={parsed().state === 'loading'}><ViewerState kind="loading" text={`Opening ${props.name}…`} /></Match>
    <Match when={parsed().state === 'error'}><OfficeFailure error={(parsed() as { error: unknown }).error} label="PDF" onOpenWithSystem={props.onOpenWithSystem} /></Match>
    <Match when={parsed().state === 'ready'}>{(() => { const loaded = () => (parsed() as { value: PdfLoaded }).value;
      return <Show when={loaded().doc.numPages > 0} fallback={<ViewerState kind="damaged" title="Cannot open this PDF" text="This PDF has no pages." />}><Show when={loaded()} keyed>{l => <PdfBody loaded={l} onMeta={props.onMeta} />}</Show></Show>; })()}</Match>
  </Switch>;
}
