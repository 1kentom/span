import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js';
import { parsePptx, ptToStage, type Deck, type Paragraph, type Slide, type SlideShape } from '../../../lib/office/pptx';
import Icon from '../../Icon';
import { ViewerState } from '../ViewerStates';
import { OfficeFailure, createParse, plural, type DocumentViewProps } from './shared';
import '../../../styles/office.css';

export const PPTX_MAX_BYTES = 256 * 1024 * 1024;

const boxStyle = (box: { left: number; top: number; width: number; height: number }): JSX.CSSProperties => ({ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` });

function Paragraphs(props: { paragraphs: Paragraph[]; slideHeight: number }) {
  return <For each={props.paragraphs}>{p => (
    <p class="ox-slide-p" classList={{ 'ox-slide-bullet': p.bullet }} style={{ 'margin-left': `${p.level * 4}%`, 'text-align': p.align, 'font-size': `${ptToStage(p.runs.find(r => r.size)?.size ?? 18, props.slideHeight)}cqh` }}>
      <For each={p.runs}>{run => run.text === '\n' ? <br /> : (
        <span style={{ 'font-size': `${ptToStage(run.size ?? 18, props.slideHeight)}cqh`, 'font-weight': run.bold ? 700 : undefined, 'font-style': run.italic ? 'italic' : undefined, 'text-decoration': run.underline ? 'underline' : undefined, color: run.color }}>{run.text}</span>
      )}</For>
    </p>
  )}</For>;
}

function ShapeView(props: { shape: SlideShape; slideHeight: number }) {
  const s = () => props.shape;
  return <Switch>
    <Match when={s().kind === 'text'}>{(() => { const t = s() as Extract<SlideShape, { kind: 'text' }>;
      return <div class={`ox-shape ox-shape-text ox-anchor-${t.anchor}`} data-role={t.role} style={{ ...boxStyle(t.box), background: t.fill }}><div><Paragraphs paragraphs={t.paragraphs} slideHeight={props.slideHeight} /></div></div>; })()}</Match>
    <Match when={s().kind === 'image'}>{(() => { const im = s() as Extract<SlideShape, { kind: 'image' }>;
      return <div class="ox-shape ox-shape-image" style={boxStyle(im.box)}>
        <Show when={im.src} fallback={<span class="ox-shape-label">{im.omitted}: {im.alt}</span>}><img src={im.src} alt={im.alt} draggable={false} /></Show>
      </div>; })()}</Match>
    <Match when={s().kind === 'table'}>{(() => { const tb = s() as Extract<SlideShape, { kind: 'table' }>;
      return <div class="ox-shape ox-shape-table" style={boxStyle(tb.box)}><table><tbody><For each={tb.rows}>{row => <tr><For each={row}>{cell => <td style={{ 'font-size': `${ptToStage(12, props.slideHeight)}cqh` }}>{cell}</td>}</For></tr>}</For></tbody></table></div>; })()}</Match>
    <Match when={s().kind === 'placeholder'}>{(() => { const ph = s() as Extract<SlideShape, { kind: 'placeholder' }>;
      return ph.fill
        ? <div class="ox-shape ox-shape-fill" style={{ ...boxStyle(ph.box), background: ph.fill }} role="img" aria-label={ph.label} title={ph.label} />
        : <div class="ox-shape ox-shape-placeholder" style={boxStyle(ph.box)}><span class="ox-shape-label">{ph.label}</span></div>; })()}</Match>
  </Switch>;
}

/** One slide on a 16:9 (or the deck's) stage. Positions are percentages; text sizes use container query units. */
export function SlideCanvas(props: { deck: Deck; slide: Slide; label?: string; thumbnail?: boolean }) {
  return <div class="ox-slide" classList={{ 'ox-slide-thumb': props.thumbnail }} role={props.thumbnail ? undefined : 'group'} aria-label={props.thumbnail ? undefined : props.label}
    style={{ 'aspect-ratio': `${props.deck.size.cx} / ${props.deck.size.cy}`, background: props.slide.background, color: props.slide.textColor }}>
    <For each={props.slide.shapes}>{shape => <ShapeView shape={shape} slideHeight={props.deck.size.cy} />}</For>
  </div>;
}

function DeckBody(props: { deck: Deck; onMeta?: (parts: string[]) => void }) {
  const [index, setIndex] = createSignal(0);
  const [presenting, setPresenting] = createSignal(false);
  const count = () => props.deck.slides.length;
  const current = () => props.deck.slides[Math.min(index(), count() - 1)];
  const go = (next: number) => setIndex(Math.min(count() - 1, Math.max(0, next)));
  let rail: HTMLElement | undefined;
  let overlay: HTMLDivElement | undefined;
  let presentButton: HTMLButtonElement | undefined;

  createEffect(on(() => props.deck, deck => {
    setIndex(0);
    props.onMeta?.([plural(deck.totalSlides, 'slide'), deck.aspect, 'PowerPoint']);
  }));
  createEffect(on(index, i => { rail?.querySelector<HTMLElement>(`[data-slide="${i}"]`)?.scrollIntoView?.({ block: 'nearest' }); }));

  const navKey = (event: KeyboardEvent, vertical: boolean) => {
    const prev = vertical ? ['ArrowUp', 'ArrowLeft', 'PageUp'] : ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'];
    const next = vertical ? ['ArrowDown', 'ArrowRight', 'PageDown'] : ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'];
    if (prev.includes(event.key)) go(index() - 1);
    else if (next.includes(event.key)) go(index() + 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(count() - 1);
    else return false;
    event.preventDefault();
    return true;
  };

  let fullscreen = false;
  const exitPresent = () => {
    setPresenting(false);
    fullscreen = false;
    if (typeof document !== 'undefined' && document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    presentButton?.focus();
  };
  const present = () => {
    setPresenting(true);
    queueMicrotask(() => {
      overlay?.focus();
      void overlay?.requestFullscreen?.().then(() => { fullscreen = true; }, () => undefined);
    });
  };
  // Escape in browser fullscreen leaves fullscreen before any keydown arrives; leave presenting with it.
  const onFullscreen = () => { if (presenting() && fullscreen && !document.fullscreenElement) exitPresent(); };
  document.addEventListener('fullscreenchange', onFullscreen);
  onCleanup(() => document.removeEventListener('fullscreenchange', onFullscreen));

  return <div class="ox-slides">
    <div class="ox-toolbar">
      <span class="ox-dim" aria-live="polite">Slide {index() + 1} of {count()}</span>
      <Show when={props.deck.totalSlides > count()}><span class="ox-dim">, first {count()} of {props.deck.totalSlides} shown</span></Show>
      <span class="vw-spacer" />
      <button type="button" class="vw-btn vw-btn-outline" ref={presentButton} onClick={present}><Icon name="Maximize4" size={12} />Present</button>
    </div>
    <div class="ox-slides-main">
      <nav class="ox-slide-rail" ref={rail} aria-label="Slides" onKeyDown={event => { if (navKey(event, true)) rail?.querySelector<HTMLElement>(`[data-slide="${index()}"]`)?.focus(); }}>
        <For each={props.deck.slides}>{(slide, i) => (
          <button type="button" class="ox-thumb" data-slide={i()} aria-current={i() === index() ? 'true' : undefined} tabindex={i() === index() ? 0 : -1} aria-label={`Slide ${i() + 1}: ${slide.title}`} onClick={() => go(i())}>
            <span class="ox-thumb-n" aria-hidden="true">{i() + 1}</span>
            <span class="ox-thumb-frame" aria-hidden="true"><SlideCanvas deck={props.deck} slide={slide} thumbnail /></span>
          </button>
        )}</For>
      </nav>
      <div class="ox-slide-col">
        <div class="ox-slide-stage" tabindex="0" aria-label="Slide stage, arrow keys change slides" onKeyDown={event => navKey(event, false)}>
          <Show when={current()}><SlideCanvas deck={props.deck} slide={current()!} label={`Slide ${index() + 1} of ${count()}: ${current()!.title}`} /></Show>
        </div>
        <section class="ox-notes" aria-label="Speaker notes">
          <div class="ox-rail-label">Speaker notes</div>
          <p class="ox-notes-text" classList={{ 'ox-dim': !current()?.notes }}>{current()?.notes || 'No speaker notes for this slide.'}</p>
        </section>
      </div>
    </div>
    <Show when={presenting()}>
      <div class="ox-present" ref={overlay} role="dialog" aria-modal="true" aria-label={`Presenting slide ${index() + 1} of ${count()}`} tabindex="-1"
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); exitPresent(); } else navKey(event, false); }}
        onClick={event => { if (event.target === overlay) go(index() + 1); }}>
        <div class="ox-present-stage"><Show when={current()}><SlideCanvas deck={props.deck} slide={current()!} label={`Slide ${index() + 1}: ${current()!.title}`} /></Show></div>
        <div class="ox-present-bar"><span>{index() + 1} / {count()}</span><span class="vw-spacer" /><span>Arrow keys to move, Escape to exit</span>
          <button type="button" class="vw-btn" onClick={exitPresent}>Exit</button></div>
      </div>
    </Show>
  </div>;
}

export default function PptxView(props: DocumentViewProps) {
  const parsed = createParse(() => props.bytes, bytes => parsePptx(bytes), PPTX_MAX_BYTES, 'presentation');
  return <Switch>
    <Match when={parsed().state === 'loading'}><ViewerState kind="loading" text={`Reading ${props.name}…`} /></Match>
    <Match when={parsed().state === 'error'}><OfficeFailure error={(parsed() as { error: unknown }).error} label="presentation" onOpenWithSystem={props.onOpenWithSystem} /></Match>
    <Match when={parsed().state === 'ready'}>{(() => { const deck = () => (parsed() as { value: Deck }).value;
      return <Show when={deck().slides.length} fallback={<ViewerState kind="unsupported" title="No slides" text="This presentation has no slides." />}><DeckBody deck={deck()} onMeta={props.onMeta} /></Show>; })()}</Match>
  </Switch>;
}
