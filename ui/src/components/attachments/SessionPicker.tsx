import { For, createSignal, onCleanup, onMount } from 'solid-js';
import Icon from '../Icon';
import '../../styles/attachments.css';

export interface SessionChoice { key: string; title: string; turns: number }

/** Earlier session picker behind the attach menu: the chats this window holds, attached as a Markdown transcript. */
export function SessionPicker(props: { sessions: readonly SessionChoice[]; onPick: (key: string) => void; onClose: () => void; returnFocus?: () => HTMLElement | null | undefined }) {
  let root!: HTMLDivElement;
  const [active, setActive] = createSignal(0);
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
  const move = (index: number) => {
    const list = buttons();
    if (!list.length) return;
    const next = (index + list.length) % list.length;
    setActive(next);
    list[next].focus();
  };
  onMount(() => {
    // After the attach menu's own focus return, which is queued when it closes to open this picker.
    queueMicrotask(() => move(0));
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) props.onClose(); };
    document.addEventListener('pointerdown', outside);
    onCleanup(() => { document.removeEventListener('pointerdown', outside); queueMicrotask(() => props.returnFocus?.()?.focus()); });
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); move(active() + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(active() - 1); }
    else if (event.key === 'Tab') props.onClose();
  };
  return <div ref={root} class="att-menu att-session-picker" role="menu" aria-label="Attach an earlier session" onKeyDown={onKeyDown}>
    <For each={props.sessions}>{(session, index) =>
      <button type="button" role="menuitem" class="att-menu-item" tabIndex={index() === active() ? 0 : -1} aria-label={`${session.title}, ${session.turns} ${session.turns === 1 ? 'message' : 'messages'}`}
        onFocus={() => setActive(index())} onClick={() => { props.onClose(); props.onPick(session.key); }}>
        <Icon name="Clock" size={14} class="att-menu-icon" />
        <span class="att-menu-label">{session.title}</span>
        <span class="att-menu-key">{session.turns}</span>
      </button>
    }</For>
    <p class="att-menu-note">Attached as a Markdown transcript made here. Absolute paths are redacted.</p>
  </div>;
}
