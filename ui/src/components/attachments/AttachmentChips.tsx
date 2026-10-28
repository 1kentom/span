import { For, Show } from 'solid-js';
import Icon from '../Icon';
import { formatAssetBytes } from '../../lib/asset-preview';
import { planAttachment, type Attachment, type AttachmentKind, type PromptCapabilities } from '../../lib/attachments';
import '../../styles/attachments.css';

export const kindLabels: Record<AttachmentKind, string> = { image: 'Image', 'text-paste': 'Pasted text', file: 'File', selection: 'Selection' };
const kindIcons: Record<AttachmentKind, string> = { image: 'Gallery', 'text-paste': 'DocumentText', file: 'Paperclip2', selection: 'Code1' };

export function AttachmentIcon(props: { kind: AttachmentKind; size?: number }) { return <Icon name={kindIcons[props.kind]} size={props.size ?? 12} class="att-icon" />; }

/** Why this item cannot be sent to the connected agent, or undefined. Unknown capabilities mean no gate. */
export function attachmentBlockReason(item: Attachment, capabilities?: PromptCapabilities): string | undefined {
  if (!capabilities) return item.status === 'error' ? item.error || 'This attachment failed to load.' : undefined;
  const plan = planAttachment(item, capabilities);
  return plan.mode === 'refuse' ? plan.reason : undefined;
}

function describe(item: Attachment, reason?: string): string {
  const parts = [kindLabels[item.kind], item.size ? formatAssetBytes(item.size) : '', reason ? `unavailable, ${reason}` : ''].filter(Boolean);
  return `${item.name}, ${parts.join(', ')}. Open preview`;
}

export interface AttachmentChipsProps {
  items: readonly Attachment[];
  /** Capabilities of the connected agent. Items the agent cannot take are shown disabled with the reason. */
  capabilities?: PromptCapabilities;
  onOpen: (item: Attachment) => void;
  onRemove: (item: Attachment) => void;
  /** Called after the last chip is removed so the caller can return focus to the prompt box. */
  onEmpty?: () => void;
}

/** Removable chips for the composer. Delete or Backspace on a focused chip removes it. */
export function AttachmentChips(props: AttachmentChipsProps) {
  let list!: HTMLUListElement;
  function remove(item: Attachment) {
    const index = props.items.findIndex(other => other.id === item.id);
    props.onRemove(item);
    queueMicrotask(() => {
      const buttons = list?.querySelectorAll<HTMLElement>('.att-chip-open');
      if (!props.items.length || !buttons?.length) props.onEmpty?.();
      else buttons[Math.min(index, buttons.length - 1)].focus();
    });
  }
  return <Show when={props.items.length}>
    <ul ref={list} class="att-chips" aria-label={`Attachments, ${props.items.length}`}>
      <For each={props.items}>{item => {
        const reason = () => attachmentBlockReason(item, props.capabilities);
        return <li class="att-chip" classList={{ 'att-chip-disabled': !!reason() }} data-kind={item.kind} title={reason() ?? item.name}>
          <button type="button" class="att-chip-open" aria-label={describe(item, reason())}
            onClick={() => props.onOpen(item)}
            onKeyDown={event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(item); } }}>
            <AttachmentIcon kind={item.kind} />
            <span class="att-chip-name">{item.name}</span>
          </button>
          <button type="button" class="att-chip-remove" aria-label={`Remove ${item.name}`} onClick={() => remove(item)}><Icon name="CloseCircle" size={11} /></button>
        </li>;
      }}</For>
    </ul>
  </Show>;
}

/** Read-only chips for attachments on a sent message. Clicking opens the viewer. */
export function MessageAttachments(props: { items: readonly Attachment[]; onOpen: (item: Attachment) => void }) {
  return <Show when={props.items.length}>
    <ul class="att-chips att-chips-message" aria-label={`Attachments, ${props.items.length}`}>
      <For each={props.items}>{item => <li class="att-chip att-chip-readonly" data-kind={item.kind} title={item.name}>
        <button type="button" class="att-chip-open" aria-label={describe(item)} onClick={() => props.onOpen(item)}>
          <AttachmentIcon kind={item.kind} />
          <span class="att-chip-name">{item.name}</span>
        </button>
      </li>}</For>
    </ul>
  </Show>;
}
