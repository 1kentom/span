import { createSignal } from "solid-js";
import { friendlyError } from "../lib/friendly-error";

export type NotificationLevel = "info" | "success" | "warning" | "error";
export interface NotificationAction { label: string; run: () => void }
export interface NotificationInput {
  level?: NotificationLevel;
  message: string;
  detail?: string;
  /** Repeats with the same key fold into one entry with a count. Defaults to level plus message. */
  key?: string;
  actions?: NotificationAction[];
  /** Keeps the toast up until it is dismissed. */
  sticky?: boolean;
}
export interface AppNotification extends Required<Pick<NotificationInput, "level" | "message">> {
  id: number; key: string; detail?: string; actions: NotificationAction[]; count: number; at: number; read: boolean;
}
export interface ToastState { id: number; leaving: boolean }

export const TOAST_MS: Record<NotificationLevel, number> = { info: 4000, success: 3500, warning: 7000, error: 10000 };
export const MAX_TOASTS = 3;
export const MAX_HISTORY = 50;
export const EXIT_MS = 180;
/** A repeat of a dismissed notification stays quiet for this long and only raises the count. */
export const REPEAT_QUIET_MS = 30000;

const [history, setHistory] = createSignal<AppNotification[]>([]);
const [toasts, setToasts] = createSignal<ToastState[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const lastToast = new Map<string, number>();
let nextId = 1;

export const notifications = history;
export const visibleToasts = toasts;
export const unreadCount = () => history().filter(item => !item.read).length;

function clearTimer(id: number) { const timer = timers.get(id); if (timer !== undefined) { clearTimeout(timer); timers.delete(id); } }
function arm(id: number, level: NotificationLevel) { clearTimer(id); timers.set(id, setTimeout(() => dismissToast(id), TOAST_MS[level])); }

export function notify(input: NotificationInput): number {
  const level = input.level ?? "info";
  const key = input.key ?? `${level}:${input.message}`;
  const now = Date.now();
  const existing = history().find(item => item.key === key);
  const quiet = existing !== undefined && now - (lastToast.get(key) ?? 0) < REPEAT_QUIET_MS && !toasts().some(toast => toast.id === existing.id);
  let id: number;
  if (existing) {
    id = existing.id;
    setHistory(current => [{ ...existing, count: existing.count + 1, at: now, read: false, detail: input.detail ?? existing.detail, actions: input.actions ?? existing.actions }, ...current.filter(item => item.id !== id)]);
  } else {
    id = nextId++;
    setHistory(current => [{ id, key, level, message: input.message, detail: input.detail, actions: input.actions ?? [], count: 1, at: now, read: false }, ...current].slice(0, MAX_HISTORY));
  }
  if (quiet) return id;
  lastToast.set(key, now);
  setToasts(current => {
    const rest = current.filter(toast => toast.id !== id);
    const next = [...rest, { id, leaving: false }];
    for (const old of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) clearTimer(old.id);
    return next.slice(-MAX_TOASTS);
  });
  if (input.sticky) clearTimer(id); else arm(id, level);
  return id;
}

/** Reports an unknown thrown value, with a plain sentence for common operating system failures. */
export function notifyError(error: unknown, extra: Pick<NotificationInput, "actions" | "key"> = {}): number {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : JSON.stringify(error);
  const friendly = friendlyError(raw);
  return notify({ level: "error", message: friendly.message, detail: friendly.detail, ...extra });
}

/** Starts the exit animation, then removes the toast. The entry stays in the history. */
export function dismissToast(id: number) {
  clearTimer(id);
  if (!toasts().some(toast => toast.id === id && !toast.leaving)) return;
  setToasts(current => current.map(toast => toast.id === id ? { ...toast, leaving: true } : toast));
  setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), EXIT_MS);
}
export function pauseToast(id: number) { clearTimer(id); }
export function resumeToast(id: number) {
  const item = history().find(entry => entry.id === id);
  if (item && toasts().some(toast => toast.id === id && !toast.leaving)) arm(id, item.level);
}
export function removeNotification(id: number) { dismissToast(id); setHistory(current => current.filter(item => item.id !== id)); }
export function markAllRead() { setHistory(current => current.some(item => !item.read) ? current.map(item => ({ ...item, read: true })) : current); }
export function clearNotifications() { for (const toast of toasts()) clearTimer(toast.id); setToasts([]); setHistory([]); lastToast.clear(); }
