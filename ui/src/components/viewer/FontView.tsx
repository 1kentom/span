import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { type FontMeta, fontMetaLine, loadFontFromBytes, parseFontMeta } from './font-meta';
import { ViewerState } from './ViewerStates';

const SIZES = [12, 16, 24, 36];
const PANGRAM = 'The quick brown fox jumps over the lazy dog';

/** Font specimen. The face is loaded from bytes with FontFace and removed from document.fonts on cleanup. */
export function FontView(props: { bytes: Uint8Array; name: string; onMeta?: (parts: string[]) => void; onDamaged: (message: string) => void }) {
  const [family, setFamily] = createSignal('');
  const [meta, setMeta] = createSignal<FontMeta | null>(null);
  const [sample, setSample] = createSignal('');
  createEffect(on(() => props.bytes, bytes => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    setFamily(''); setMeta(null);
    try {
      const parsed = parseFontMeta(bytes);
      setMeta(parsed);
      props.onMeta?.([parsed.format, ...(parsed.glyphs !== undefined ? [`${parsed.glyphs.toLocaleString('en-US')} glyphs`] : [])]);
    } catch (cause) { props.onDamaged(cause instanceof Error ? cause.message : String(cause)); return; }
    loadFontFromBytes(bytes).then(loaded => { if (cancelled) loaded.dispose(); else { dispose = loaded.dispose; setFamily(loaded.family); } })
      .catch(cause => { if (!cancelled) props.onDamaged(cause instanceof Error ? cause.message : String(cause)); });
    onCleanup(() => { cancelled = true; dispose?.(); });
  }));
  const face = () => ({ 'font-family': `"${family()}"` });
  const title = () => meta()?.family ?? props.name.replace(/\.[^.]+$/, '');
  return <Show when={family()} fallback={<ViewerState kind="loading" text={`Loading ${props.name}…`} />}>
    <div class="vw-font" style={face()}>
      <div class="vw-font-hero">
        <span class="vw-font-aa" aria-hidden="true">Aa</span>
        <span class="vw-font-id"><strong>{title()}</strong><span class="vw-dim">{meta() ? fontMetaLine(meta()!).join(' · ') || meta()!.format : ''}</span></span>
      </div>
      <p class="vw-font-glyphs">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br />{'0123456789 (){}[] => != <= ++ -- && ||'}</p>
      <label class="vw-font-input"><span class="vw-dim">Sample text</span>
        <input type="text" value={sample()} placeholder={PANGRAM} aria-label="Sample text" onInput={event => setSample(event.currentTarget.value)} />
      </label>
      <div class="vw-font-ramp">
        <For each={SIZES}>{size => <div class="vw-font-row"><span class="vw-font-size">{size}</span><span style={{ 'font-size': `${size}px` }}>{sample() || PANGRAM}</span></div>}</For>
      </div>
    </div>
  </Show>;
}
