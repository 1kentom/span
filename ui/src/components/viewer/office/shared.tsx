import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import { formatAssetBytes } from '../../../lib/asset-preview';
import { OfficeError } from '../../../lib/office/zip';
import { ViewerState, type StateAction } from '../ViewerStates';

/** Props every document view takes from the shell. */
export interface DocumentViewProps {
  name: string;
  bytes: Uint8Array;
  /** Footer facts, for example ["3 pages", "612 words"]. */
  onMeta?: (parts: string[]) => void;
  onOpenWithSystem?: () => void;
}

export type Parsed<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; error: unknown };

/**
 * Parse off the current tick so the loading state paints first. A newer source cancels an older parse.
 * Parsing still runs on the main thread: DOMParser is not available in workers.
 */
export function createParse<T>(source: Accessor<Uint8Array>, parse: (bytes: Uint8Array) => T | Promise<T>, maxBytes: number, label: string, dispose?: (value: T) => void): Accessor<Parsed<T>> {
  const [result, setResult] = createSignal<Parsed<T>>({ state: 'loading' });
  createEffect(on(source, bytes => {
    let live = true;
    let value: T | undefined;
    onCleanup(() => { live = false; if (value !== undefined) dispose?.(value); });
    setResult({ state: 'loading' });
    if (bytes.length > maxBytes) { setResult({ state: 'error', error: new OfficeError('too-large', `This ${label} is ${formatAssetBytes(bytes.length)}. The preview opens files up to ${formatAssetBytes(maxBytes)}.`) }); return; }
    const timer = setTimeout(async () => {
      try {
        const parsed = await parse(bytes);
        // A result that arrives after the file changed or the view closed is released at once.
        if (!live) { dispose?.(parsed); return; }
        value = parsed;
        setResult({ state: 'ready', value: parsed });
      }
      catch (error) { if (live) setResult({ state: 'error', error }); }
    }, 0);
    onCleanup(() => clearTimeout(timer));
  }));
  return result;
}

/** The edge state for a failed parse, using the shared ViewerState card. */
export function OfficeFailure(props: { error: unknown; label: string; onOpenWithSystem?: () => void }) {
  const actions = (): StateAction[] => props.onOpenWithSystem ? [{ label: 'Open with system app', onClick: props.onOpenWithSystem, primary: true }] : [];
  const error = () => props.error;
  const kind = () => error() instanceof OfficeError ? (error() as OfficeError).kind : 'damaged';
  const message = () => error() instanceof Error ? (error() as Error).message : String(error());
  return <>
    {kind() === 'too-large' && <ViewerState kind="too-large" title="Large file" text={message()} actions={actions()} />}
    {kind() === 'locked' && <ViewerState kind="unsupported" title="Password protected" text={`${message()} Open it in an app that can unlock it.`} actions={actions()} />}
    {kind() === 'unsupported' && <ViewerState kind="unsupported" title="Preview not available" text={message()} actions={actions()} />}
    {kind() === 'damaged' && <ViewerState kind="damaged" title={`Cannot open this ${props.label}`} text={message()} actions={actions()} />}
  </>;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
export const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
