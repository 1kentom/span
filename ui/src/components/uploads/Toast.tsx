import { Show, createSignal, onCleanup } from 'solid-js';
import Icon from '../Icon';

/** How long a success toast stays (design: 1.8 s). Errors stay until dismissed. */
export const TOAST_MS = 1800;

export interface ToastMessage { id: number; text: string; kind: 'success' | 'error' }
export interface Toaster { current: () => ToastMessage | null; show: (text: string, kind?: ToastMessage['kind']) => void; dismiss: () => void }

/** One toast at a time: a new message replaces the current one and restarts the timer. */
export function createToaster(): Toaster {
  const [current, setCurrent] = createSignal<ToastMessage | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next = 1;
  const dismiss = () => { clearTimeout(timer); setCurrent(null); };
  onCleanup(() => clearTimeout(timer));
  return {
    current, dismiss,
    show(text, kind = 'success') {
      clearTimeout(timer);
      setCurrent({ id: next++, text, kind });
      if (kind === 'success') timer = setTimeout(() => setCurrent(null), TOAST_MS);
    },
  };
}

/** Polite status region for confirmations and an alert region for failures. Both stay mounted so they announce. */
export function ToastHost(props: { toaster: Toaster }) {
  const toast = () => props.toaster.current();
  return <div class="up-toast-host">
    <div role="status" aria-live="polite" aria-atomic="true">
      <Show when={toast()?.kind === 'success' && toast()} keyed>{item => <div class="up-toast"><Icon name="Check" size={12} class="up-toast-ok" /><span>{item.text}</span></div>}</Show>
    </div>
    <div role="alert" aria-atomic="true">
      <Show when={toast()?.kind === 'error' && toast()} keyed>{item => <div class="up-toast up-toast-error"><Icon name="Warning2" size={12} /><span>{item.text}</span>
        <button type="button" class="up-toast-close" aria-label="Dismiss" onClick={() => props.toaster.dismiss()}><Icon name="Close" size={9} /></button></div>}</Show>
    </div>
  </div>;
}
