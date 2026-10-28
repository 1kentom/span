import { For, Show } from 'solid-js';
import Icon from '../Icon';
import type { PromptCapabilities } from '../../lib/attachments';
import '../../styles/attachments.css';

/** Which file types the agent takes inline. Text is always sendable (inline text or a link), so it is never marked as a link. */
export function dropCapabilityChips(capabilities?: PromptCapabilities): { label: string; inline: boolean }[] {
  return [
    { label: 'Images', inline: !capabilities || capabilities.image },
    { label: 'Text and code', inline: true },
    { label: 'PDF', inline: !capabilities || capabilities.embeddedContext },
    { label: 'Audio', inline: !capabilities || capabilities.audio },
  ];
}

export interface DropOverlayProps {
  /** True while a drag is over the composer. */
  visible: boolean;
  capabilities?: PromptCapabilities;
  /** Replaces the default helper sentence. */
  description?: string;
}

/** Full panel overlay shown while files are dragged over the sidebar. It never takes pointer events. */
export function DropOverlay(props: DropOverlayProps) {
  return <Show when={props.visible}>
    <div class="att-drop" role="status">
      <span class="att-drop-badge"><Icon name="Add" size={22} /></span>
      <span class="att-drop-title">Drop to attach</span>
      <span class="att-drop-text">{props.description ?? 'Files the agent cannot read inline are sent as links.'}</span>
      <ul class="att-drop-chips" aria-label="Supported types">
        <For each={dropCapabilityChips(props.capabilities)}>{chip =>
          <li class="att-drop-chip" classList={{ 'att-drop-chip-link': !chip.inline }}>
            <Show when={chip.inline}><Icon name="TickCircle" size={10} class="att-drop-tick" /></Show>
            {chip.inline ? chip.label : `${chip.label} · as link`}
          </li>
        }</For>
      </ul>
    </div>
  </Show>;
}
