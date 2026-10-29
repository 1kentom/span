import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { validateImageDimensions } from '../../lib/asset-preview';
import { ZOOM_MAX, ZOOM_MIN, fitPercent, stepZoom, wheelZoom } from '../../lib/viewer';
import Icon from '../Icon';
import { ModeSwitch } from './ModeSwitch';

export type ImageBackground = 'checker' | 'light' | 'dark';
export type ImageZoom = number | 'fit';
const backgrounds = [{ id: 'checker' as const, label: 'Checkerboard', icon: 'Element3' }, { id: 'light' as const, label: 'Light', icon: 'Sun' }, { id: 'dark' as const, label: 'Dark', icon: 'Moon' }];

export interface ImageViewProps {
  /** Inert data URL (raster) or a sanitised SVG data URL, always shown through img. */
  src: string; name: string; isSvg?: boolean;
  /** Controlled zoom, so the source bar's Fit and Actual size switch stays in step. Uncontrolled when omitted. */
  zoom?: ImageZoom; onZoom?: (zoom: ImageZoom) => void;
  onDimensions?: (width: number, height: number) => void; onDamaged: (message: string) => void;
}

/**
 * Image canvas: zoom 10 to 800 percent in steps of 25 (buttons, plus and minus keys), Ctrl or pinch wheel zoom,
 * drag to pan when zoomed, and a Checkerboard, Light or Dark background.
 */
export function ImageView(props: ImageViewProps) {
  const [ownZoom, setOwnZoom] = createSignal<ImageZoom>('fit');
  const zoom = () => props.zoom ?? ownZoom();
  const setZoom = (value: ImageZoom) => { setOwnZoom(value); props.onZoom?.(value); };
  const [background, setBackground] = createSignal<ImageBackground>('checker');
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [dragging, setDragging] = createSignal(false);
  let stage!: HTMLDivElement;
  const style = createMemo(() => {
    const scale = zoom();
    return scale === 'fit' ? undefined : { width: `${size().width * scale / 100}px`, height: `${size().height * scale / 100}px`, 'max-width': 'none', 'max-height': 'none' };
  });
  const current = () => { const value = zoom(); return value === 'fit' ? fitPercent(size().width, size().height, stage?.clientWidth - 48, stage?.clientHeight - 48) : value; };
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') { setZoom(stepZoom(zoom(), 1)); event.preventDefault(); }
    else if (event.key === '-' || event.key === '_') { setZoom(stepZoom(zoom(), -1)); event.preventDefault(); }
    else if (event.key === '0') { setZoom('fit'); event.preventDefault(); }
    else if (event.key === '1') { setZoom(100); event.preventDefault(); }
  };
  onMount(() => {
    // Not passive: Ctrl and pinch wheel zoom must stop the page from zooming.
    const onWheel = (event: WheelEvent) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setZoom(wheelZoom(current(), event.deltaY)); };
    stage.addEventListener('wheel', onWheel, { passive: false });
    onCleanup(() => stage.removeEventListener('wheel', onWheel));
  });
  let origin: { x: number; y: number; left: number; top: number } | undefined;
  const onPointerDown = (event: PointerEvent) => {
    if (zoom() === 'fit' || event.button !== 0) return;
    origin = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture?.(event.pointerId); setDragging(true);
  };
  const onPointerMove = (event: PointerEvent) => { if (!origin) return; stage.scrollLeft = origin.left - (event.clientX - origin.x); stage.scrollTop = origin.top - (event.clientY - origin.y); };
  const endDrag = () => { origin = undefined; setDragging(false); };
  return <div class="vw-image">
    <div class="vw-toolbar">
      <div class="vw-group" role="group" aria-label="Image zoom">
        <button type="button" class="vw-btn vw-btn-icon" aria-label="Zoom out" title="Zoom out (minus)" disabled={zoom() !== 'fit' && (zoom() as number) <= ZOOM_MIN} onClick={() => setZoom(stepZoom(zoom(), -1))}><Icon name="Minus" size={13} /></button>
        <span class="vw-readout" role="status" aria-label="Zoom level">{zoom() === 'fit' ? 'Fit' : `${zoom()}%`}</span>
        <button type="button" class="vw-btn vw-btn-icon" aria-label="Zoom in" title="Zoom in (plus)" disabled={zoom() !== 'fit' && (zoom() as number) >= ZOOM_MAX} onClick={() => setZoom(stepZoom(zoom(), 1))}><Icon name="Add" size={13} /></button>
        <Show when={props.zoom === undefined}>
          <button type="button" class="vw-btn" aria-pressed={zoom() === 'fit'} onClick={() => setZoom('fit')}>Fit</button>
          <button type="button" class="vw-btn" aria-pressed={zoom() === 100} onClick={() => setZoom(100)}>Actual size</button>
        </Show>
      </div>
      <div class="vw-group">
        <span class="vw-dim" aria-hidden="true">Background</span>
        <ModeSwitch label="Preview background" icons class="vw-modes-bg" options={backgrounds} value={background()} onChange={setBackground} />
      </div>
    </div>
    <div ref={stage} class="vw-stage" classList={{ 'vw-fit': zoom() === 'fit', 'vw-pannable': zoom() !== 'fit', 'vw-panning': dragging() }} data-background={background()} tabIndex={0}
      aria-label="Image canvas, plus and minus zoom, 0 fits, 1 shows actual size" onKeyDown={onKey} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
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
