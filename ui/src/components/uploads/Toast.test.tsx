// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { TOAST_MS, ToastHost, createToaster } from './Toast';

let dispose: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.useRealTimers(); });

describe('toasts', () => {
  it('shows one message at a time for 1.8 s in a polite live region', () => {
    const toaster = createToaster();
    const root = document.createElement('div'); document.body.append(root);
    dispose = render(() => <ToastHost toaster={toaster} />, root);
    const region = root.querySelector('[aria-live="polite"]')!;
    expect(region.getAttribute('role')).toBe('status');
    toaster.show('notes.md saved to workspace');
    expect(region.textContent).toContain('notes.md saved to workspace');
    vi.advanceTimersByTime(1000);
    toaster.show('Copied path of notes.md');
    expect(region.textContent).not.toContain('saved to workspace');
    expect(region.textContent).toContain('Copied path of notes.md');
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(region.textContent).toContain('Copied path');
    vi.advanceTimersByTime(1);
    expect(region.textContent).toBe('');
    expect(TOAST_MS).toBe(1800);
  });
  it('keeps errors until dismissed and announces them assertively', () => {
    const toaster = createToaster();
    const root = document.createElement('div'); document.body.append(root);
    dispose = render(() => <ToastHost toaster={toaster} />, root);
    toaster.show('Could not save notes.md: disk full', 'error');
    vi.advanceTimersByTime(10000);
    const alert = root.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('disk full');
    (root.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement).click();
    expect(root.querySelector('[role="alert"]')?.textContent ?? '').toBe('');
  });
});
