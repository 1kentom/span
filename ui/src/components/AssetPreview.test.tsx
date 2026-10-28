// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { AssetPreview } from './AssetPreview';
import { MAX_IMAGE_BYTES, MAX_SVG_BYTES, isAssetPath, isBinaryAssetPath, safeRasterSource, sanitizeSvg, validateImageDimensions } from '../lib/asset-preview';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.useRealTimers(); });
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${body}</svg>`;
const parse = (text: string) => new DOMParser().parseFromString(text, 'image/svg+xml');

describe('isolated SVG preview', () => {
  it('retains shapes, gradients and safe local references', () => {
    const result = sanitizeSvg(svg('<defs><linearGradient id="paint"><stop offset="0" stop-color="#fff" /></linearGradient><path id="shape" d="M0 0h4v4z" /></defs><use href="#shape" fill="url(#paint)" /><rect width="16" height="16" style="fill: red; stroke: blue" />'));
    const doc = parse(result.source);
    expect(doc.querySelector('path')?.getAttribute('d')).toBe('M0 0h4v4z');
    expect(doc.querySelector('use')?.getAttribute('href')).toBe('#shape');
    expect(doc.querySelector('use')?.getAttribute('fill')).toBe('url(#paint)');
    expect(doc.querySelector('rect')?.getAttribute('fill')).toBe('red');
    expect(result.bytes).toBeGreaterThan(100);
  });
  it('removes execution, foreign objects, events, stylesheets and remote or data sources', () => {
    const result = sanitizeSvg(svg('<script>alert(1)</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject><style>@import "https://tracker.test/x"</style><image href="https://tracker.test/pixel" /><use href="data:image/svg+xml,evil" /><rect onclick="alert(1)" onload="alert(1)" style="fill:url(https://tracker.test/x); stroke: red" filter="url(https://tracker.test/x)" fill="url(//tracker.test/x)" /><a href="javascript:alert(1)"><path /></a><animate attributeName="href" to="https://tracker.test" />'));
    const doc = parse(result.source);
    expect(doc.querySelector('script,foreignObject,style,image,a,animate,[onclick],[onload],[filter]')).toBeNull();
    expect(doc.querySelector('use')).toBeNull();
    expect(doc.querySelector('rect')?.hasAttribute('fill')).toBe(false);
    expect(result.source).not.toMatch(/https:|data:|javascript:|tracker/);
  });
  it('rejects declarations, malformed XML, wrong namespaces and resource exhaustion', () => {
    for (const source of ['<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg />', '<svg><broken>', '<svg xmlns="http://www.w3.org/1999/xhtml" />', svg('x'.repeat(MAX_SVG_BYTES)), svg('<g/>'.repeat(5001)), svg('<g>'.repeat(66) + '</g>'.repeat(66)), '<svg xmlns="http://www.w3.org/2000/svg" width="999999" height="4"/>']) expect(() => sanitizeSvg(source)).toThrow();
  });
  it('removes recursive reuse and bounds expanded shapes', () => {
    const result = sanitizeSvg(svg('<g id="cycle"><use href="#cycle" /></g><use href="#cycle" />'));
    expect(parse(result.source).querySelector('use')).toBeNull();
    expect(() => sanitizeSvg(svg('<path id="p"/>' + '<use href="#p"/>'.repeat(257)))).toThrow(/256/);
  });
});

describe('raster preview boundaries', () => {
  it('accepts bounded workspace data and rejects URLs, SVG, malformed or oversized base64', () => {
    expect(safeRasterSource({ mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }).bytes).toBe(8);
    for (const image of [{ mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, { mime: 'image/png', dataUrl: 'https://tracker.test/a.png' }, { mime: 'image/png', dataUrl: 'data:image/png;base64,a===' }, { mime: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4)}` }]) expect(() => safeRasterSource(image)).toThrow();
  });
  it('rejects excessive decoded dimensions and recognizes binaries before text loading', () => {
    expect(() => validateImageDimensions(300, 200)).not.toThrow();
    for (const dimensions of [[0, 3], [17000, 10], [10000, 10000]]) expect(() => validateImageDimensions(...dimensions as [number, number])).toThrow();
    expect(isAssetPath('icons/logo.SVG')).toBe(true);
    expect(isBinaryAssetPath('photo.PNG')).toBe(true);
    expect(isBinaryAssetPath('image.avif')).toBe(true);
    expect(isBinaryAssetPath('logo.svg')).toBe(false);
  });
});

describe('asset preview component', () => {
  it('loads bytes through the image bridge and displays decode metadata and zoom', async () => {
    const loadImage = vi.fn(async () => ({ mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }));
    const root = document.createElement('div'); document.body.append(root);
    cleanup.push(render(() => <AssetPreview path="art.png" loadImage={loadImage} />, root));
    await Promise.resolve(); await Promise.resolve();
    expect(loadImage).toHaveBeenCalledWith('art.png');
    const image = root.querySelector('img')!;
    Object.defineProperties(image, { naturalWidth: { value: 320 }, naturalHeight: { value: 200 } });
    image.dispatchEvent(new Event('load'));
    expect(root.textContent).toContain('320 × 200 px');
    [...root.querySelectorAll('button')].find(button => button.textContent === 'Actual size')!.click();
    expect(image.style.width).toBe('320px');
    expect(root.textContent).toContain('100%');
  });
  it('keeps unsafe SVG outside the application DOM and refreshes when source changes', async () => {
    vi.useFakeTimers();
    const [source, setSource] = createSignal(svg('<rect width="3" height="4"/><script>alert(1)</script>'));
    const root = document.createElement('div'); document.body.append(root);
    cleanup.push(render(() => <AssetPreview path="art.svg" source={source()} />, root));
    await vi.advanceTimersByTimeAsync(130);
    expect(root.querySelector('svg,script')).toBeNull();
    const image = root.querySelector('img')!;
    expect(decodeURIComponent(image.src)).toContain('<rect');
    expect(decodeURIComponent(image.src)).not.toContain('<script');
    setSource(svg('<circle r="5"/>'));
    await vi.advanceTimersByTimeAsync(130);
    expect(decodeURIComponent(root.querySelector('img')!.src)).toContain('<circle');
  });
  it('reports unsupported formats without loading text or image bytes', async () => {
    const loadImage = vi.fn(); const root = document.createElement('div'); document.body.append(root);
    cleanup.push(render(() => <AssetPreview path="art.tiff" loadImage={loadImage} />, root));
    await Promise.resolve();
    expect(loadImage).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('not supported');
  });
});
