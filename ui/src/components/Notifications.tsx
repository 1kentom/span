import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icon";
import {
  clearNotifications, dismissToast, markAllRead, notifications, pauseToast, removeNotification, resumeToast, unreadCount, visibleToasts,
  type AppNotification, type NotificationLevel,
} from "../stores/notifications";

const levelIcon: Record<NotificationLevel, string> = { info: "InfoCircle", success: "TickCircle", warning: "Warning2", error: "Warning2" };
const levelLabel: Record<NotificationLevel, string> = { info: "Information", success: "Success", warning: "Warning", error: "Error" };

function ago(at: number, now: number) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function Body(props: { item: AppNotification; onAction?: () => void }) {
  const [open, setOpen] = createSignal(false);
  return <>
    <span class="notice-text">
      <span class="notice-message">{props.item.message}<Show when={props.item.count > 1}><span class="notice-count" title={`${props.item.count} times`}>{props.item.count}</span></Show></span>
      <Show when={props.item.detail}><button class="notice-link" aria-expanded={open()} onClick={() => setOpen(value => !value)}>{open() ? "Hide details" : "Details"}</button></Show>
      <Show when={open()}><code class="notice-detail">{props.item.detail}</code></Show>
      <Show when={props.item.actions.length}><span class="notice-actions"><For each={props.item.actions}>{action => <button class="notice-link" onClick={() => { action.run(); props.onAction?.(); }}>{action.label}</button>}</For></span></Show>
    </span>
  </>;
}

/** Short lived notices above the status bar. They leave on their own, pause while hovered, and stay in the history. */
export function ToastStack() {
  return <div class="toast-stack" aria-label="Notifications">
    <For each={visibleToasts()}>{toast => {
      const item = () => notifications().find(entry => entry.id === toast.id);
      return <Show when={item()}>{entry => <div class={`toast level-${entry().level}`} classList={{ leaving: toast.leaving }} role={entry().level === "error" || entry().level === "warning" ? "alert" : "status"} aria-label={levelLabel[entry().level]}
        onMouseEnter={() => pauseToast(toast.id)} onMouseLeave={() => resumeToast(toast.id)} onFocusIn={() => pauseToast(toast.id)} onFocusOut={() => resumeToast(toast.id)}>
        <Icon name={levelIcon[entry().level]} size={15} class="notice-icon" />
        <Body item={entry()} onAction={() => dismissToast(toast.id)} />
        <button class="notice-close" aria-label="Dismiss notification" title="Dismiss" onClick={() => dismissToast(toast.id)}><Icon name="Close" size={12} /></button>
      </div>}</Show>;
    }}</For>
  </div>;
}

/** Bell in the status bar with an unread count. The panel lists everything that was shown, newest first. */
export function NotificationBell() {
  const [open, setOpen] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  let root: HTMLDivElement | undefined;
  const toggle = () => { const next = !open(); setOpen(next); if (next) { setNow(Date.now()); markAllRead(); } };
  onMount(() => {
    const away = (event: PointerEvent) => { if (open() && root && !root.contains(event.target as Node)) setOpen(false); };
    const keys = (event: KeyboardEvent) => { if (open() && event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", keys, true);
    const tick = setInterval(() => open() && setNow(Date.now()), 15000);
    onCleanup(() => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", keys, true); clearInterval(tick); });
  });
  const label = () => unreadCount() ? `Notifications, ${unreadCount()} unread` : "Notifications";
  return <div class="notice-bell" ref={root}>
    <button class="notice-bell-button" aria-label={label()} aria-haspopup="dialog" aria-expanded={open()} title={label()} onClick={toggle}>
      <Icon name="u-bell" size={14} /><Show when={unreadCount()}><span class="notice-badge" aria-hidden="true">{unreadCount() > 9 ? "9+" : unreadCount()}</span></Show>
    </button>
    <Show when={open()}>
      <div class="notice-panel" role="dialog" aria-label="Notifications">
        <div class="notice-panel-head"><strong>Notifications</strong><Show when={notifications().length}><button class="notice-link" onClick={() => clearNotifications()}>Clear all</button></Show></div>
        <Show when={notifications().length} fallback={<p class="notice-empty">Nothing to show.</p>}>
          <ul class="notice-list"><For each={notifications()}>{item => <li class={`level-${item.level}`}>
            <Icon name={levelIcon[item.level]} size={14} class="notice-icon" />
            <Body item={item} onAction={() => setOpen(false)} />
            <span class="notice-time">{ago(item.at, now())}</span>
            <button class="notice-close" aria-label="Remove notification" title="Remove" onClick={() => removeNotification(item.id)}><Icon name="Close" size={12} /></button>
          </li>}</For></ul>
        </Show>
      </div>
    </Show>
  </div>;
}
