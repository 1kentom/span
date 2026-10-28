import { For, Show } from 'solid-js';
import Icon from '../Icon';
import { formatAssetBytes } from '../../lib/asset-preview';
import { extensionOf, planAttachment, type Attachment, type PromptCapabilities } from '../../lib/attachments';
import { AttachmentIcon, attachmentBlockReason, kindLabels } from './AttachmentChips';
import '../../styles/attachments.css';

/** Why an item that still goes out is sent as a resource link rather than inline, or undefined when it is sent inline. */
export function linkReason(item: Attachment, capabilities?: PromptCapabilities): string | undefined {
  if (!capabilities || planAttachment(item, capabilities).mode !== 'link') return undefined;
  if (!item.bytes) return 'Only the file path is available, so the agent gets a link.';
  if (item.kind === 'audio') return 'This agent does not accept audio, so it gets a link.';
  return 'This agent cannot take this content inline, so it gets a link.';
}

function badge(item: Attachment): string {
  if (item.kind === 'text-paste') return 'TXT';
  return (extensionOf(item.path ?? item.name.replace(/:[\d–-]+$/, '')) || item.kind).toUpperCase().slice(0, 5);
}

type TileState = 'ready' | 'uploading' | 'link' | 'blocked';

export interface AttachmentTrayProps {
  items: readonly Attachment[];
  capabilities?: PromptCapabilities;
  /** Upload progress from 0 to 1, keyed by attachment id. Items still loading without an entry show an indeterminate bar. */
  progress?: Readonly<Record<string, number>>;
  onOpen: (item: Attachment) => void;
  onRemove: (item: Attachment) => void;
  /** Called after the last tile is removed so the caller can return focus to the prompt box. */
  onEmpty?: () => void;
}

/**
 * Tile view of the pending attachments, shown above the prompt. The tile has a thumbnail area, progress and a
 * state line. It reuses the chip helpers (block reason, icons, labels) so the rules stay in one place.
 */
export function AttachmentTray(props: AttachmentTrayProps) {
  let list!: HTMLUListElement;
  function remove(item: Attachment) {
    const index = props.items.findIndex(other => other.id === item.id);
    props.onRemove(item);
    queueMicrotask(() => {
      const buttons = list?.querySelectorAll<HTMLElement>('.att-tile-open');
      if (!props.items.length || !buttons?.length) props.onEmpty?.();
      else buttons[Math.min(index, buttons.length - 1)].focus();
    });
  }
  function view(item: Attachment) {
    const blocked = attachmentBlockReason(item, props.capabilities);
    const link = item.status === 'ready' ? linkReason(item, props.capabilities) : undefined;
    const state: TileState = item.status === 'loading' ? 'uploading' : blocked ? 'blocked' : link ? 'link' : 'ready';
    const pct = Math.round(Math.max(0, Math.min(1, props.progress?.[item.id] ?? 0)) * 100);
    const known = props.progress?.[item.id] !== undefined;
    const meta = state === 'uploading' ? (known ? `${pct}%` : 'Uploading') : state === 'link' ? 'Sent as link' : state === 'blocked' ? 'Not sent' : item.lines ? `Lines ${item.lines.start}–${item.lines.end}` : item.size ? formatAssetBytes(item.size) : kindLabels[item.kind];
    const title = state === 'link' ? link : state === 'blocked' ? blocked : item.name;
    return { state, pct, known, meta, title: title ?? item.name, label: `${item.name}, ${kindLabels[item.kind]}, ${meta}${state === 'link' || state === 'blocked' ? `. ${title}` : ''}. Open preview` };
  }
  return <Show when={props.items.length}>
    <ul ref={list} class="att-tray" aria-label={`Attachments, ${props.items.length}`}>
      <For each={props.items}>{item => {
        const v = () => view(item);
        return <li class="att-tile" classList={{ 'att-tile-link': v().state === 'link', 'att-tile-blocked': v().state === 'blocked' }} data-kind={item.kind} data-state={v().state} title={v().title}>
          <button type="button" class="att-tile-open" aria-label={v().label} onClick={() => props.onOpen(item)}
            onKeyDown={event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(item); } }}>
            <span class="att-tile-thumb">
              <AttachmentIcon kind={item.kind} size={16} />
              <Show when={v().state === 'uploading'}>
                <span class="att-tile-bar" role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v().known ? v().pct : undefined}>
                  <span class="att-tile-bar-fill" classList={{ 'att-tile-bar-indeterminate': !v().known }} style={v().known ? { width: `${v().pct}%` } : undefined} />
                </span>
              </Show>
              <Show when={v().state !== 'uploading'}><span class="att-tile-ext">{badge(item)}</span></Show>
            </span>
            <span class="att-tile-name">{item.name}</span>
            <span class="att-tile-meta">{v().meta}</span>
          </button>
          <button type="button" class="att-tile-remove" aria-label={`Remove ${item.name}`} onClick={() => remove(item)}><Icon name="CloseCircle" size={9} /></button>
        </li>;
      }}</For>
    </ul>
  </Show>;
}
