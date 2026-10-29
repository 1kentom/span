import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { parseDocx, type DocComment, type DocxDocument } from '../../../lib/office/docx';
import { ViewerState } from '../ViewerStates';
import { OfficeFailure, createParse, plural, prefersReducedMotion, type DocumentViewProps } from './shared';
import '../../../styles/office.css';

import { DOCX_MAX_BYTES } from '../../../lib/office/limits';
export { DOCX_MAX_BYTES };
/** Letter page height in CSS pixels, used for the "about N pages" estimate. */
const PAGE_HEIGHT = 792;
type DocMode = 'page' | 'outline';

const formatDate = (iso?: string) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

function CommentCard(props: { comment: DocComment }) {
  const c = () => props.comment;
  return <article class="ox-comment" aria-label={`Comment by ${c().author}`}>
    <header class="ox-comment-head">
      <span class="ox-avatar" aria-hidden="true">{(c().initials || c().author).slice(0, 1).toUpperCase()}</span>
      <strong>{c().author}</strong>
      <Show when={formatDate(c().date)}><time class="ox-dim" dateTime={c().date}>{formatDate(c().date)}</time></Show>
    </header>
    <Show when={c().anchor}><blockquote class="ox-comment-anchor">{c().anchor}</blockquote></Show>
    <p class="ox-comment-text">{c().text}</p>
    <Show when={c().replies.length}>
      <ul class="ox-replies" aria-label="Replies">
        <For each={c().replies}>{reply => <li><strong>{reply.author}</strong> <span class="ox-dim">{formatDate(reply.date)}</span><p class="ox-comment-text">{reply.text}</p></li>}</For>
      </ul>
    </Show>
    <footer class="ox-comment-foot ox-dim"><span>{plural(c().replies.length, 'reply', 'replies')}</span><span class="vw-spacer" /><span>Read-only</span></footer>
  </article>;
}

function DocxBody(props: { doc: DocxDocument; onMeta?: (parts: string[]) => void }) {
  const [mode, setMode] = createSignal<DocMode>('page');
  const [estimate, setEstimate] = createSignal(0);
  let page: HTMLElement | undefined;
  let stage: HTMLDivElement | undefined;

  createEffect(on(() => props.doc, doc => {
    const parts: string[] = [];
    if (doc.pages) parts.push(plural(doc.pages, 'page'));
    parts.push(plural(doc.words, 'word'));
    if (doc.comments.length) parts.push(plural(doc.comments.length, 'comment'));
    parts.push('Word document');
    props.onMeta?.(parts);
    if (!page) return;
    page.replaceChildren(doc.fragment.cloneNode(true));
    const measure = () => { if (page) setEstimate(page.scrollHeight ? Math.max(1, Math.ceil(page.scrollHeight / PAGE_HEIGHT)) : 0); };
    measure();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(measure);
      observer.observe(page);
      onCleanup(() => observer.disconnect());
    }
  }));

  const jump = (id: string) => {
    const target = page?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    target.scrollIntoView?.({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };
  // In-document anchors (footnotes, bookmarks) scroll inside the stage and never navigate.
  const onClick = (event: MouseEvent) => {
    const link = (event.target as Element).closest?.('a[href^="#"]');
    if (!link) return;
    event.preventDefault();
    jump(link.getAttribute('href')!.slice(1));
  };

  return <div class="ox-doc">
    <div class="ox-toolbar">
      <div class="vw-group" role="group" aria-label="Document view">
        <button type="button" class="vw-btn" aria-pressed={mode() === 'page'} onClick={() => setMode('page')}>Page</button>
        <button type="button" class="vw-btn" aria-pressed={mode() === 'outline'} onClick={() => setMode('outline')} disabled={!props.doc.outline.length} title={props.doc.outline.length ? undefined : 'This document has no headings'}>Outline</button>
      </div>
      <span class="vw-spacer" />
      <Show when={estimate()}><span class="ox-dim" title="Estimated from the rendered length at Letter size">about {plural(estimate(), 'page')}</span></Show>
    </div>
    <Show when={props.doc.trackedChanges}><p class="vw-note" role="note">This document has tracked changes. They are not marked: insertions are shown as text and deletions are left out.</p></Show>
    <Show when={props.doc.truncated}><p class="vw-note" role="note">Part of this document is nested too deeply for the preview and is not shown.</p></Show>
    <Show when={props.doc.imagesOmitted}><p class="vw-note" role="note">{plural(props.doc.imagesOmitted, 'image')} not shown: unsupported format or above the preview size limit.</p></Show>
    <div class="ox-doc-main">
      <Show when={mode() === 'outline' && props.doc.outline.length}>
        <nav class="ox-outline" aria-label="Outline">
          <div class="ox-rail-label">Outline</div>
          <For each={props.doc.outline}>{entry => <button type="button" class="ox-outline-item" style={{ 'padding-left': `${8 + (entry.level - 1) * 10}px` }} onClick={() => jump(entry.id)}>{entry.text}</button>}</For>
        </nav>
      </Show>
      <div class="ox-doc-stage" ref={stage} tabindex="0" aria-label="Document pages" onClick={onClick}>
        <article class="ox-page" ref={page} aria-label="Document content" />
        <Show when={props.doc.comments.length}>
          <aside class="ox-comments" aria-label="Comments">
            <For each={props.doc.comments}>{comment => <CommentCard comment={comment} />}</For>
          </aside>
        </Show>
      </div>
    </div>
  </div>;
}

export default function DocxView(props: DocumentViewProps) {
  const parsed = createParse(() => props.bytes, parseDocx, DOCX_MAX_BYTES, 'document');
  return <Switch>
    <Match when={parsed().state === 'loading'}><ViewerState kind="loading" text={`Reading ${props.name}…`} /></Match>
    <Match when={parsed().state === 'error'}><OfficeFailure error={(parsed() as { error: unknown }).error} label="document" onOpenWithSystem={props.onOpenWithSystem} /></Match>
    <Match when={parsed().state === 'ready'}><DocxBody doc={(parsed() as { value: DocxDocument }).value} onMeta={props.onMeta} /></Match>
  </Switch>;
}
