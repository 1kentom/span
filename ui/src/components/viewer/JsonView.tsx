import { For, Show, createMemo, createSignal } from 'solid-js';
import Icon from '../Icon';
import { jsonRows } from '../../lib/viewer';

export function JsonView(props: { value: unknown; name: string }) {
  const [toggled, setToggled] = createSignal<ReadonlySet<string>>(new Set());
  const view = createMemo(() => jsonRows(props.value, toggled()));
  const toggle = (path: string) => setToggled(previous => { const next = new Set(previous); if (!next.delete(path)) next.add(path); return next; });
  return <div class="vw-json" role="tree" aria-label={`JSON tree of ${props.name}`}>
    <For each={view().rows}>{row => <div class="vw-json-row" role="treeitem" aria-level={row.depth + 1} aria-expanded={row.expandable ? row.open : undefined} style={{ 'padding-left': `${row.depth * 16 + 8}px` }}>
      <Show when={row.expandable} fallback={<span class="vw-json-spacer" aria-hidden="true" />}>
        <button type="button" class="vw-json-toggle" aria-label={`${row.open ? 'Collapse' : 'Expand'} ${row.key ?? 'root'}`} onClick={() => toggle(row.path)}><Icon name={row.open ? 'arrow-down4' : 'arrow-right4'} size={9} /></button>
      </Show>
      <Show when={row.key !== null}><span class="vw-json-key">{/^\d+$/.test(row.key!) ? row.key : JSON.stringify(row.key)}</span><span class="vw-json-colon">: </span></Show>
      <span class={`vw-json-${row.kind}`}>{row.text}</span>
      <Show when={row.meta}><span class="vw-json-meta">{row.meta}</span></Show>
    </div>}</For>
    <Show when={view().truncated}><p class="vw-note" role="note">Showing the first 5,000 rows. Use Source to read the rest.</p></Show>
  </div>;
}
