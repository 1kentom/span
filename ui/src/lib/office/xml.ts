/** Namespace-agnostic helpers over DOMParser for OOXML parts. Parsing is inert: no DTDs, no entities, bounded depth. */
import { OfficeError } from './zip';

export const MAX_XML_DEPTH = 256;
export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function parseXml(text: string, part = 'part'): Document {
  // A DTD can declare entities (billion laughs, external entities). OOXML never needs one.
  if (/<!DOCTYPE|<!ENTITY/i.test(text.slice(0, 4096)) || /<!ENTITY/i.test(text)) throw new OfficeError('damaged', `${part} declares a DTD or entities, which the preview refuses.`);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new OfficeError('damaged', `${part} is not well-formed XML.`);
  // Iterative depth check so a deeply nested part cannot overflow later recursive walks.
  const stack: [Element, number][] = [[doc.documentElement, 1]];
  while (stack.length) {
    const [element, depth] = stack.pop()!;
    if (depth > MAX_XML_DEPTH) throw new OfficeError('damaged', `${part} is nested deeper than the preview reads.`);
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) stack.push([child, depth + 1]);
  }
  return doc;
}

export function kids(element: Element | null | undefined, name: string): Element[] {
  const out: Element[] = [];
  if (!element) return out;
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) if (child.localName === name) out.push(child);
  return out;
}
export function kid(element: Element | null | undefined, name: string): Element | undefined {
  if (!element) return undefined;
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) if (child.localName === name) return child;
  return undefined;
}
/** Follow a path of local names, first match at each step. */
export function path(element: Element | null | undefined, ...names: string[]): Element | undefined {
  let current: Element | undefined = element ?? undefined;
  for (const name of names) { current = kid(current, name); if (!current) return undefined; }
  return current;
}
export function desc(element: Element | Document | null | undefined, name: string): Element[] {
  return element ? Array.from(element.getElementsByTagNameNS('*', name)) : [];
}
/** Attribute by local name. Prefers a namespaced attribute (w:val), then the plain one. */
export function attr(element: Element | null | undefined, name: string): string | undefined {
  if (!element) return undefined;
  let plain: string | undefined;
  for (const attribute of element.attributes) {
    if (attribute.localName !== name) continue;
    if (attribute.namespaceURI) return attribute.value;
    plain = attribute.value;
  }
  return plain;
}
/** Plain (unprefixed) attribute only, so id and r:id never mix. */
export function plainAttr(element: Element | null | undefined, name: string): string | undefined {
  if (!element) return undefined;
  for (const attribute of element.attributes) if (attribute.localName === name && !attribute.namespaceURI) return attribute.value;
  return undefined;
}
/** Relationship attribute such as r:id or r:embed. */
export function relAttr(element: Element | null | undefined, name: string): string | undefined {
  return element?.getAttributeNS(REL_NS, name) ?? undefined;
}
export function num(value: string | undefined, fallback = 0): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export interface Relationship { id: string; type: string; target: string; external: boolean }
/** Parse a .rels part. Types are reduced to their last path segment (slide, image, notesSlide). */
export function parseRels(text: string | undefined): Map<string, Relationship> {
  const map = new Map<string, Relationship>();
  if (!text) return map;
  for (const rel of desc(parseXml(text, 'Relationships'), 'Relationship')) {
    const id = rel.getAttribute('Id');
    if (!id) continue;
    map.set(id, { id, type: (rel.getAttribute('Type') ?? '').split('/').at(-1) ?? '', target: rel.getAttribute('Target') ?? '', external: rel.getAttribute('TargetMode') === 'External' });
  }
  return map;
}
/** The .rels part path for a part: ppt/slides/slide1.xml becomes ppt/slides/_rels/slide1.xml.rels. */
export function relsPathFor(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}
/** Resolve a relationship target against the folder of its source part. Never climbs above the package root. */
export function resolvePart(source: string, target: string): string {
  const parts = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of target.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop(); else parts.push(segment);
  }
  return parts.join('/');
}
