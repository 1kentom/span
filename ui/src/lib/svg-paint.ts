/**
 * Reads the solid colors an SVG paints, so a test can measure a logo against the theme surfaces
 * instead of judging it by eye. It follows fill and stroke inheritance, style attributes and
 * gradient stops, and paints black where nothing sets a fill, as a browser does.
 */

export type Rgb = readonly [number, number, number];

const NAMED: Readonly<Record<string, string>> = { black: "#000000", white: "#ffffff", red: "#ff0000", navy: "#000080", gray: "#808080", grey: "#808080" };

export function parseColor(value: string | undefined): Rgb | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  const hex = NAMED[raw] ?? raw;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (short) return [parseInt(short[1] + short[1], 16), parseInt(short[2] + short[2], 16), parseInt(short[3] + short[3], 16)];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/.exec(hex);
  if (long) return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(raw);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SHAPES = new Set(["path", "circle", "rect", "polygon", "polyline", "ellipse", "line", "text", "use"]);
const CONTAINERS_SKIPPED = new Set(["defs", "clippath", "mask", "lineargradient", "radialgradient", "pattern", "symbol"]);

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[match[1].toLowerCase()] = match[3] ?? match[4] ?? "";
  const style = out.style;
  if (style) for (const part of style.split(";")) {
    const [key, ...rest] = part.split(":");
    if (key && rest.length) out[key.trim().toLowerCase()] = rest.join(":").trim();
  }
  return out;
}

/** The distinct colors the artwork paints. Gradients count each of their stops. */
export function paintedColors(svg: string): Rgb[] {
  const gradients = new Map<string, Rgb[]>();
  for (const match of svg.matchAll(/<(linearGradient|radialGradient)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const id = attributes(match[2]).id;
    if (!id) continue;
    const stops = [...match[3].matchAll(/<stop\b([^>]*)\/?>/gi)].map(stop => parseColor(attributes(stop[1])["stop-color"] ?? "#000000")).filter((c): c is Rgb => Boolean(c));
    gradients.set(id, stops);
  }
  const paint = (value: string | undefined): Rgb[] | undefined => {
    if (value === undefined) return undefined;
    if (value === "none" || value === "transparent") return [];
    const ref = /^url\(\s*#([^)]+)\)/.exec(value);
    if (ref) return gradients.get(ref[1]) ?? [];
    const color = parseColor(value);
    return color ? [color] : undefined;
  };
  const found = new Map<string, Rgb>();
  const add = (colors: Rgb[]) => { for (const color of colors) found.set(color.join(","), color); };
  const stack: { tag: string; fill: string; stroke: string; skip: boolean }[] = [{ tag: "#root", fill: "#000000", stroke: "none", skip: false }];
  for (const match of svg.matchAll(/<(\/?)([\w:-]+)\b([^>]*?)(\/?)>/g)) {
    const [, closing, rawTag, rest, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (closing) { if (stack.length > 1 && stack[stack.length - 1].tag === tag) stack.pop(); continue; }
    const parent = stack[stack.length - 1];
    const attrs = attributes(rest);
    const fill = attrs.fill ?? parent.fill;
    const stroke = attrs.stroke ?? parent.stroke;
    const skip = parent.skip || CONTAINERS_SKIPPED.has(tag);
    if (!skip && SHAPES.has(tag)) {
      if (Number(attrs.opacity ?? 1) > 0) { add(paint(fill) ?? []); add(paint(stroke) ?? []); }
    }
    if (!selfClosing) stack.push({ tag, fill, stroke, skip });
  }
  return [...found.values()];
}

/** The best contrast any painted color reaches against a surface. A logo below 3:1 (WCAG non-text) disappears. */
export function bestContrast(svg: string, surface: Rgb): number {
  const colors = paintedColors(svg);
  return colors.length ? Math.max(...colors.map(color => contrast(color, surface))) : 1;
}

export const MIN_LOGO_CONTRAST = 3;
