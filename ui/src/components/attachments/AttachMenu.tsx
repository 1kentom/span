import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import Icon from '../Icon';
import { formatAssetBytes } from '../../lib/asset-preview';
import { MAX_FILE_BYTES, type PromptCapabilities } from '../../lib/attachments';
import '../../styles/attachments.css';

export type AttachMenuItemId = 'upload' | 'image' | 'screenshot' | 'file' | 'selection' | 'folder' | 'session';

const definitions: { id: AttachMenuItemId; label: string; icon: string; needs?: 'image' }[] = [
  { id: 'upload', label: 'Upload files', icon: 'Paperclip2' },
  { id: 'image', label: 'Add image', icon: 'Gallery', needs: 'image' },
  { id: 'screenshot', label: 'Paste screenshot', icon: 'Copy', needs: 'image' },
  { id: 'file', label: 'Current file', icon: 'DocumentText' },
  { id: 'selection', label: 'Selection', icon: 'Code1' },
  { id: 'folder', label: 'Folder', icon: 'Folder2' },
  { id: 'session', label: 'Earlier session', icon: 'Clock' },
];

function joinList(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** Footer note for the menu, derived from what the connected agent says it accepts. */
export function attachMenuNote(agentName: string, capabilities?: PromptCapabilities): string {
  const limit = `Up to ${formatAssetBytes(MAX_FILE_BYTES)} per file`;
  if (!capabilities) return `Other types are sent as links. ${limit}`;
  const reads = [capabilities.image && 'images', capabilities.embeddedContext && 'file contents', capabilities.audio && 'audio'].filter(Boolean) as string[];
  const lead = reads.length ? `${agentName} reads ${joinList(reads)}.` : `${agentName} takes links only.`;
  return `${lead} Other types are sent as links. ${limit}`;
}

export interface AttachMenuProps {
  /** Name of the connected agent, used in the footer note. */
  agentName: string;
  capabilities?: PromptCapabilities;
  /** An item is shown only when its handler is provided. */
  handlers: Partial<Record<AttachMenuItemId, () => void>>;
  /** Extra reasons that disable an item, for example "No file is open". Wins over the capability reason. */
  disabledReasons?: Partial<Record<AttachMenuItemId, string>>;
  /** Optional shortcut text shown at the end of a row. Pass only shortcuts that exist. */
  shortcuts?: Partial<Record<AttachMenuItemId, string>>;
  onClose: () => void;
  /** Element to focus after the menu closes, normally the plus button. */
  returnFocus?: () => HTMLElement | null | undefined;
}

/** Popover menu behind the composer plus button. Mount it only while open. */
export function AttachMenu(props: AttachMenuProps) {
  let root!: HTMLDivElement;
  const [active, setActive] = createSignal(0);
  const entries = () => definitions.filter(item => props.handlers[item.id]).map(item => {
    const capReason = item.needs === 'image' && props.capabilities && !props.capabilities.image ? `${props.agentName} does not accept images.` : undefined;
    return { ...item, reason: props.disabledReasons?.[item.id] ?? capReason };
  });
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
  function move(index: number) {
    const list = buttons();
    if (!list.length) return;
    const next = (index + list.length) % list.length;
    setActive(next);
    list[next].focus();
  }
  onMount(() => {
    const first = entries().findIndex(entry => !entry.reason);
    move(first < 0 ? 0 : first);
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) props.onClose(); };
    document.addEventListener('pointerdown', outside);
    onCleanup(() => { document.removeEventListener('pointerdown', outside); queueMicrotask(() => props.returnFocus?.()?.focus()); });
  });
  function choose(entry: ReturnType<typeof entries>[number]) {
    if (entry.reason) return;
    const handler = props.handlers[entry.id];
    props.onClose();
    handler?.();
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); move(active() + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(active() - 1); }
    else if (event.key === 'Home') { event.preventDefault(); move(0); }
    else if (event.key === 'End') { event.preventDefault(); move(buttons().length - 1); }
    else if (event.key === 'Tab') props.onClose();
  }
  return <div ref={root} class="att-menu" role="menu" aria-label="Attach files and context" onKeyDown={onKeyDown}>
    <For each={entries()}>{(entry, index) =>
      <button type="button" role="menuitem" class="att-menu-item" classList={{ 'att-menu-item-disabled': !!entry.reason }}
        tabIndex={index() === active() ? 0 : -1} aria-disabled={entry.reason ? 'true' : undefined}
        aria-label={entry.reason ? `${entry.label}, unavailable: ${entry.reason}` : entry.label} title={entry.reason}
        onFocus={() => setActive(index())} onClick={() => choose(entry)}>
        <Icon name={entry.icon} size={14} class="att-menu-icon" />
        <span class="att-menu-label">{entry.label}</span>
        <Show when={entry.reason} fallback={<Show when={props.shortcuts?.[entry.id]}><span class="att-menu-key">{props.shortcuts?.[entry.id]}</span></Show>}>
          <span class="att-menu-reason">{entry.reason}</span>
        </Show>
      </button>
    }</For>
    <p class="att-menu-note">{attachMenuNote(props.agentName, props.capabilities)}</p>
  </div>;
}
