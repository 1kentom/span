import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { ImageSource } from '../bindings';
import { api } from '../lib/client';
import { formatAssetBytes, isSupportedRasterPath, isSvgPath, safeRasterSource, sanitizeSvg, validateImageDimensions } from '../lib/asset-preview';
import '../styles/asset-preview.css';

export { isAssetPath, isBinaryAssetPath, isSvgPath } from '../lib/asset-preview';
export interface AssetPreviewProps { path: string; source?: string; active?: boolean; loadImage?: (path: string) => Promise<ImageSource> }

export function AssetPreview(props: AssetPreviewProps) {
  const [url, setUrl] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [metadata, setMetadata] = createSignal({ bytes: 0, mime: '', width: 0, height: 0 });
  const [zoom, setZoom] = createSignal<number | 'fit'>('fit');
  const [background, setBackground] = createSignal('checkerboard');
  const label = createMemo(() => props.path.split(/[\\/]/).at(-1) || props.path);
  let generation = 0;
  createEffect(() => {
    const path = props.path;
    const source = props.source;
    if (props.active === false) return;
    const current = ++generation;
    setUrl(''); setError(''); setLoading(true);
    setMetadata({ bytes: 0, mime: '', width: 0, height: 0 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        let image: { url: string; bytes: number; mime: string };
        if (isSvgPath(path)) {
          if (source === undefined) throw new Error('SVG source is not available. Open Source to inspect the file.');
          const sanitized = sanitizeSvg(source);
          image = { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized.source)}`, bytes: sanitized.bytes, mime: 'image/svg+xml' };
        } else {
          if (!isSupportedRasterPath(path)) throw new Error('Preview supports PNG, JPEG, GIF, WebP and SVG. This format is not supported.');
          image = safeRasterSource(await (props.loadImage ?? api.readImage)(path));
        }
        if (current !== generation) return;
        setMetadata({ bytes: image.bytes, mime: image.mime, width: 0, height: 0 });
        setUrl(image.url);
      } catch (cause) {
        if (current !== generation) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
    };
    if (isSvgPath(path)) timer = setTimeout(() => void load(), 120);
    else void load();
    onCleanup(() => { generation++; if (timer) clearTimeout(timer); });
  });
  function loaded(image: HTMLImageElement) {
    try {
      validateImageDimensions(image.naturalWidth, image.naturalHeight);
      setMetadata(previous => ({ ...previous, width: image.naturalWidth, height: image.naturalHeight }));
      setLoading(false);
    } catch (cause) { setUrl(''); setError(String(cause)); setLoading(false); }
  }
  const imageStyle = createMemo(() => {
    const scale = zoom();
    return scale === 'fit' ? undefined : { width: `${metadata().width * scale / 100}px`, height: `${metadata().height * scale / 100}px`, 'max-width': 'none', 'max-height': 'none' };
  });
  return <section class="asset-preview" aria-label={`Preview of ${label()}`}>
    <div class="asset-preview-toolbar">
      <div class="asset-preview-controls" role="group" aria-label="Image zoom">
        <button type="button" classList={{ selected: zoom() === 'fit' }} onClick={() => setZoom('fit')}>Fit</button>
        <button type="button" classList={{ selected: zoom() === 100 }} onClick={() => setZoom(100)}>Actual size</button>
        <button type="button" aria-label="Zoom out" onClick={() => setZoom(Math.max(10, (typeof zoom() === 'number' ? zoom() as number : 100) - 25))}>−</button>
        <span class="asset-preview-zoom">{zoom() === 'fit' ? 'Fit' : `${zoom()}%`}</span>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom(Math.min(800, (typeof zoom() === 'number' ? zoom() as number : 100) + 25))}>+</button>
      </div>
      <label class="asset-preview-background-label">Background<select aria-label="Image preview background" value={background()} onChange={event => setBackground(event.currentTarget.value)}><option value="checkerboard">Checkerboard</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    </div>
    <div class="asset-preview-stage" classList={{ 'asset-preview-fit': zoom() === 'fit' }} data-background={background()} tabIndex={0} aria-label="Image canvas">
      <Show when={loading()}><div class="asset-preview-message" role="status">Loading image…</div></Show>
      <Show when={error()}><div class="asset-preview-message asset-preview-error" role="alert">{error()}</div></Show>
      <Show when={url()}><img src={url()} alt={label()} draggable={false} style={imageStyle()} onLoad={event => loaded(event.currentTarget)} onError={() => { setError('The browser could not decode this image. The file may be damaged or unsupported.'); setLoading(false); setUrl(''); }} /></Show>
    </div>
    <footer class="asset-preview-metadata"><span>{label()}</span><Show when={metadata().width}><span>{metadata().width} × {metadata().height} px</span></Show><Show when={metadata().bytes}><span>{formatAssetBytes(metadata().bytes)}</span><span>{metadata().mime.replace('image/', '').toUpperCase()}</span></Show><Show when={isSvgPath(props.path)}><span>Isolated SVG preview</span></Show></footer>
  </section>;
}
