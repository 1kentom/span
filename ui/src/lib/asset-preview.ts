import type { ImageSource } from '../bindings';

export const MAX_SVG_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16384;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const svgNamespace = 'http://www.w3.org/2000/svg';
const tags = new Set(['svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'use', 'symbol']);
const attributes = new Set(['id', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'clip-path', 'clip-rule', 'mask', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity', 'fx', 'fy', 'fr', 'patternUnits', 'patternContentUnits', 'patternTransform', 'preserveAspectRatio', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'dx', 'dy', 'rotate', 'vector-effect', 'color', 'visibility', 'display']);
const presentation = new Set(['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'clip-path', 'clip-rule', 'mask', 'stop-color', 'stop-opacity', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'color', 'visibility', 'display']);
const localReference = /^#[A-Za-z_][\w:.-]*$/;

export function isSvgPath(path: string): boolean { return /\.svg$/i.test(path); }
export function isBinaryAssetPath(path: string): boolean { return /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|tiff?|heic)$/i.test(path); }
export function isAssetPath(path: string): boolean { return isSvgPath(path) || isBinaryAssetPath(path); }
export function isSupportedRasterPath(path: string): boolean { return /\.(?:png|jpe?g|gif|webp)$/i.test(path); }

function safeValue(value: string): boolean {
  if (/[\\\u0000-\u001f\u007f]|@|expression\s*\(|(?:https?|data|javascript|file):/i.test(value)) return false;
  let stripped = value.replace(/url\(\s*(['"]?)(#[A-Za-z_][\w:.-]*)\1\s*\)/gi, '');
  return !/url\s*\(|[<>]/i.test(stripped);
}

/** Build a separate SVG document from a bounded allowlist. It is used only as an inert img source. */
export function sanitizeSvg(source: string): { source: string; bytes: number } {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > MAX_SVG_BYTES) throw new Error('SVG preview is limited to 1 MiB. Source editing remains available.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('SVG document declarations and entities are not supported.');
  const input = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (input.querySelector('parsererror') || input.documentElement.localName !== 'svg' || input.documentElement.namespaceURI !== svgNamespace) throw new Error('This file is not valid SVG.');
  const elements = input.getElementsByTagName('*');
  if (elements.length > 5000) throw new Error('SVG preview is limited to 5,000 elements.');
  let attributeCount = 0;
  for (const element of elements) attributeCount += element.attributes.length;
  if (attributeCount > 25000) throw new Error('SVG contains too many attributes to preview.');
  const output = document.implementation.createDocument(svgNamespace, 'svg', null);
  const copy = (element: Element, target: Element, depth: number): void => {
    if (depth > 64) throw new Error('SVG nesting exceeds the preview limit.');
    for (const attribute of element.attributes) {
      const { name, value } = attribute;
      if ((name === 'href' || name === 'xlink:href') && element.localName === 'use' && localReference.test(value)) target.setAttribute('href', value);
      else if (attributes.has(name) && !attribute.namespaceURI && safeValue(value)) target.setAttribute(name, value);
      else if (name === 'style') {
        // Parse declarations using the browser, then retain only inert presentation properties.
        const style = document.createElement('span').style;
        style.cssText = value;
        for (const property of style) {
          const declaration = style.getPropertyValue(property);
          if (presentation.has(property) && safeValue(declaration)) target.setAttribute(property, declaration);
        }
      }
    }
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) target.append(output.createTextNode(child.textContent ?? ''));
      else if (child instanceof Element && child.namespaceURI === svgNamespace && tags.has(child.localName)) {
        const next = output.createElementNS(svgNamespace, child.localName);
        target.append(next);
        copy(child, next, depth + 1);
      }
    }
  };
  copy(input.documentElement, output.documentElement, 0);
  const ids = new Map<string, Element>();
  for (const element of output.getElementsByTagName('*')) if (element.id) ids.set(element.id, element);
  const uses = output.querySelectorAll('use');
  if (uses.length > 256) throw new Error('SVG preview is limited to 256 reused shapes.');
  const compositeIds = new Set([...ids].filter(([, element]) => element.querySelector('use')).map(([id]) => id));
  let expandedElements = elements.length;
  for (const use of uses) {
    const target = ids.get((use.getAttribute('href') ?? '').slice(1));
    if (!target || target === use || compositeIds.has(target.id) || target.localName === 'use') { use.remove(); continue; }
    expandedElements += target.getElementsByTagName('*').length + 1;
    if (expandedElements > 10000) throw new Error('SVG reused shapes exceed the preview limit.');
  }
  for (const dimension of ['width', 'height']) {
    const value = output.documentElement.getAttribute(dimension);
    if (!value || value.endsWith('%')) continue;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:px)?$/i.test(value)) { output.documentElement.removeAttribute(dimension); continue; }
    if (!Number.isFinite(parseFloat(value)) || parseFloat(value) > MAX_IMAGE_DIMENSION) throw new Error('SVG dimensions exceed the preview limit.');
  }
  const rootWidth = parseFloat(output.documentElement.getAttribute('width') ?? '0');
  const rootHeight = parseFloat(output.documentElement.getAttribute('height') ?? '0');
  if (rootWidth * rootHeight > MAX_IMAGE_PIXELS) throw new Error('SVG dimensions exceed the preview limit.');
  return { source: new XMLSerializer().serializeToString(output), bytes };
}

export function safeRasterSource(image: ImageSource): { url: string; bytes: number; mime: string } {
  if (!/^image\/(?:png|jpeg|gif|webp)$/.test(image.mime)) throw new Error('This raster format is not supported.');
  const prefix = `data:${image.mime};base64,`;
  if (!image.dataUrl.startsWith(prefix)) throw new Error('Invalid workspace image source.');
  const payload = image.dataUrl.slice(prefix.length);
  if (payload.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new Error('Image is too large or has invalid data.');
  const bytes = payload.length * 3 / 4 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  if (!bytes || bytes > MAX_IMAGE_BYTES) throw new Error('Image preview is limited to 8 MiB.');
  return { url: image.dataUrl, bytes, mime: image.mime };
}

export function validateImageDimensions(width: number, height: number): void {
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) throw new Error('Image dimensions exceed the preview limit (16,384 px per side, 64 megapixels).');
}

export function formatAssetBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
