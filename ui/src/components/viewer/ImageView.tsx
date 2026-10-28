import { For, Show, createMemo, createSignal } from 'solid-js';
import { validateImageDimensions } from '../../lib/asset-preview';
import { ZOOM_MAX, ZOOM_MIN, stepZoom } from '../../lib/viewer';

type Background = 'checker' | 'light' | 'dark';
const backgrounds: { id: Background; label: string }[] = [{ id: 'checker', label: 'Checkerboard' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

/** Image canvas. `src` is an inert data URL (raster) or a sanitised SVG data URL, always shown through img. */
export function ImageView(props: { src: string; name: string; isSvg?: boolean; onDimensions?: (width: number, height: number) => void; onDamaged: (message: string) => void }) {
  const [zoom, setZoom] = createSignal<number | 'fit'>('fit');
  const [background, setBackground] = createSignal<Background>('checker');
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const style = createMemo(() => {
    const scale = zoom();
    return scale === 'fit' ? undefined : { width: `${size().width * scale / 100}px`, height: `${size().height * scale / 100}px`, 'max-width': 'none', 'max-height': 'none' };
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') { setZoom(stepZoom(zoom(), 1)); event.preventDefault(); }
    else if (event.key === '-' || event.key === '_') { setZoom(stepZoom(zoom(), -1)); event.preventDefault(); }
    else if (event.key === '0') { setZoom('fit'); event.preventDefault(); }
    else if (event.key === '1') { setZoom(100); event.preventDefault(); }
  };
  return <div class="vw-image">
    <div class="vw-toolbar">
      <div class="vw-group" role="group" aria-label="Image zoom">
        <button type="button" class="vw-btn" aria-pressed={zoom() === 'fit'} onClick={() => setZoom('fit')}>Fit</button>
        <button type="button" class="vw-btn" aria-pressed={zoom() === 100} onClick={() => setZoom(100)}>Actual size</button>
        <button type="button" class="vw-btn vw-btn-icon" aria-label="Zoom out" disabled={zoom() !== 'fit' && (zoom() as number) <= ZOOM_MIN} onClick={() => setZoom(stepZoom(zoom(), -1))}>−</button>
        <span class="vw-readout" role="status" aria-label="Zoom level">{zoom() === 'fit' ? 'Fit' : `${zoom()}%`}</span>
        <button type="button" class="vw-btn vw-btn-icon" aria-label="Zoom in" disabled={zoom() !== 'fit' && (zoom() as number) >= ZOOM_MAX} onClick={() => setZoom(stepZoom(zoom(), 1))}>+</button>
      </div>
      <div class="vw-group" role="group" aria-label="Preview background">
        <span class="vw-dim" aria-hidden="true">Background</span>
        <For each={backgrounds}>{item => <button type="button" class="vw-btn" aria-pressed={background() === item.id} onClick={() => setBackground(item.id)}>{item.label}</button>}</For>
      </div>
    </div>
    <div class="vw-stage" classList={{ 'vw-fit': zoom() === 'fit' }} data-background={background()} tabIndex={0} aria-label="Image canvas, plus and minus zoom, 0 fits" onKeyDown={onKey}>
      <img src={props.src} alt={props.name} draggable={false} style={style()}
        onLoad={event => {
          const image = event.currentTarget;
          try { validateImageDimensions(image.naturalWidth, image.naturalHeight); setSize({ width: image.naturalWidth, height: image.naturalHeight }); props.onDimensions?.(image.naturalWidth, image.naturalHeight); }
          catch (cause) { props.onDamaged(cause instanceof Error ? cause.message : String(cause)); }
        }}
        onError={() => props.onDamaged('The browser could not decode this image. The file may be damaged or unsupported.')} />
    </div>
    <Show when={props.isSvg}><span class="vw-sr" role="note">Isolated SVG preview. Scripts, event handlers and external references were removed.</span></Show>
  </div>;
}
