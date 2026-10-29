// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeDocHtml } from './sanitize-html';

const serialize = (fragment: DocumentFragment) => { const host = document.createElement('div'); host.append(fragment); return host.innerHTML; };
const clean = (html: string, images: Map<string, string> = new Map()) => serialize(sanitizeDocHtml(html, { images }).fragment);

describe('document html sanitiser', () => {
  it.each([
    ['script element', '<p>a</p><script>alert(1)</script>', '<p>a</p>'],
    ['inline event handler', '<p onclick="alert(1)" onmouseover="x()">a</p>', '<p>a</p>'],
    ['javascript url', '<a href="javascript:alert(1)">x</a>', '<span class="ox-doc-link">x</span>'],
    ['data url link', '<a href="data:text/html,<script>alert(1)</script>">x</a>', '<span class="ox-doc-link">x</span>'],
    ['external link kept as inert text', '<a href="https://example.com/">site</a>', '<span class="ox-doc-link" title="https://example.com/">site</span>'],
    ['data url image not from the document', '<img src="data:image/png;base64,AAAA">', ''],
    ['external image', '<img src="https://example.com/x.png">', ''],
    ['svg data image', '<img src="data:image/svg+xml,<svg onload=alert(1)>">', ''],
    ['style attribute with css url', '<p style="background:url(https://example.com/t.png)">a</p>', '<p>a</p>'],
    ['style element', '<style>p{background:url(https://e.com)}</style><p>a</p>', '<p>a</p>'],
    ['iframe', '<iframe src="https://example.com"></iframe><p>a</p>', '<p>a</p>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://example.com"><p>a</p>', '<p>a</p>'],
    ['base', '<base href="https://example.com/"><p>a</p>', '<p>a</p>'],
    ['object and embed', '<object data="x.swf"></object><embed src="x.swf"><p>a</p>', '<p>a</p>'],
    ['form controls', '<form action="https://e.com"><input value="x"><button>go</button></form>', 'go'],
    ['svg and math', '<svg><a href="javascript:x"><text>t</text></a></svg><math><mi>x</mi></math><p>a</p>', '<p>a</p>'],
    ['unknown element unwrapped', '<custom-el>kept text</custom-el>', 'kept text'],
    ['id clobbering prefixed', '<h1 id="cookie">T</h1><a href="#cookie">jump</a>', '<h1 id="docx-cookie">T</h1><a href="#docx-cookie">jump</a>'],
    ['tables and lists kept with spans only', '<table><tr><td colspan="2" rowspan="x" width="9">c</td></tr></table><ol><li>i</li></ol>', '<table><tbody><tr><td colspan="2">c</td></tr></tbody></table><ol><li>i</li></ol>'],
  ])('%s', (_label, input, expected) => {
    expect(clean(input)).toBe(expected);
  });
  it('resolves document images from the token map and keeps alt text', () => {
    const out = clean('<p><img src="docx-image:0" alt="A pixel"></p>', new Map([['docx-image:0', 'data:image/png;base64,iVBORw0KGgo=']]));
    expect(out).toBe('<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="A pixel"></p>');
  });
  it('drops a token whose data is not a raster image', () => {
    expect(clean('<img src="docx-image:0">', new Map([['docx-image:0', 'data:text/html;base64,PHNjcmlwdD4=']]))).toBe('');
  });
  it('bounds nesting depth', () => {
    const deep = '<div>'.repeat(300) + 'x' + '</div>'.repeat(300);
    const result = sanitizeDocHtml(deep, { images: new Map(), maxDepth: 64 });
    expect(result.truncated).toBe(true);
  });
});
