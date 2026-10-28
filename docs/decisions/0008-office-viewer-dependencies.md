# 0008: Document viewer dependencies (Word, slides, spreadsheets, PDF, archives)

Status: accepted for the File and Upload Viewer document kinds. Verified with
unit and component tests in jsdom and a production build. Not yet exercised
in the native app (see UNVERIFIED).

## Context

The File and Upload Viewer designs show previews for `.docx`, `.pptx`,
`.xlsx`, PDF and archives. The browser cannot read any of these natively.
The user approved new dependencies for this work, kept to a minimum. Every
format is untrusted input: an attachment can come from any agent session.

## Decisions

### 1. Three direct dependencies, pinned exactly

| Package | Version | Licence | Install scripts | Unpacked size | Used for |
| --- | --- | --- | --- | --- | --- |
| `fflate` | 0.8.3 | MIT | none | 797 KB (npm `dist.unpackedSize` 796,742) | ZIP inflation for docx, pptx and xlsx, and ZIP listing in the browser preview |
| `mammoth` | 1.13.0 | BSD-2-Clause | none run (`prepare` only applies to git installs) | 1.67 MB (1,671,388) | `.docx` body to HTML |
| `pdfjs-dist` | 6.4.299 | Apache-2.0 | none | 34.9 MB (34,913,648) | PDF parsing and canvas rendering |

Each was checked with `npm view <pkg> license version dist.unpackedSize
time.modified dependencies scripts` before adding. All resolve from the
registry in use (`https://registry.npmjs.org/`). They were added with
`pnpm add --ignore-scripts --no-optional --save-exact`. `node_modules` grew
from 170 MB to 213 MB.

`pdfjs-dist` declares one optional dependency, `@napi-rs/canvas` (MIT,
prebuilt native binaries per platform, no download script). It is only used
when pdf.js runs in Node, so it was not installed (`--no-optional`). It is
still recorded in `pnpm-lock.yaml`, so a later plain `pnpm install` would
fetch the matching platform binary. That does not affect the app.

Transitive packages, all from `mammoth` (resolved versions from the lockfile):

| Package | Version | Licence | Note |
| --- | --- | --- | --- |
| `jszip` | 3.10.2 | MIT or GPL-3.0-or-later | used under MIT |
| `pako` | 1.0.11 | MIT and Zlib | via jszip |
| `lie` | 3.3.0 | MIT | via jszip |
| `immediate` | 3.0.6 | MIT | via lie |
| `setimmediate` | 1.0.5 | MIT | via jszip |
| `readable-stream` | 2.3.8 | MIT | via jszip, not reached in the browser build |
| `core-util-is` 1.0.3, `inherits` 2.0.4 (ISC), `isarray` 1.0.0, `process-nextick-args` 2.0.1, `safe-buffer` 5.1.2, `string_decoder` 1.1.1, `util-deprecate` 1.0.2 | | MIT unless noted | via readable-stream |
| `lop` | 0.4.2 | BSD-2-Clause | parser combinators for style maps |
| `duck` | 0.1.12 | BSD | via lop |
| `option` | 0.2.4 | BSD-2-Clause | via lop |
| `underscore` | 1.13.8 | MIT | |
| `@xmldom/xmldom` | 0.8.15 | MIT | XML parsing inside mammoth |
| `xmlbuilder` | 10.1.1 | MIT | |
| `base64-js` | 1.5.1 | MIT | |
| `dingbat-to-unicode` | 1.0.2 | BSD-2-Clause | |
| `argparse` | 1.0.10 | MIT | mammoth CLI only, `sprintf-js` 1.0.3 (BSD-3-Clause) with it |

None is GPL-only or AGPL, and none runs a postinstall. Maintenance: the
three direct packages were all published or updated in 2026 (fflate
2026-07, mammoth 2026-09, pdfjs-dist 2026-10). Some small transitives of
mammoth and jszip (`duck`, `option`, `lie`, `setimmediate`) have had no
release for over two years. They are tiny, stable and only reached through
mammoth, which is maintained. If mammoth stops being maintained, the Word
view is the only consumer to replace.

### 2. No spreadsheet or presentation library

`.xlsx` and `.pptx` are read by small in-repo parsers on fflate and
DOMParser (`ui/src/lib/office/xlsx.ts`, `pptx.ts`). SheetJS, exceljs and
pptx libraries were not added. The parsers read only what the views show:
workbook, sheets, shared strings, number formats (date and percent, plain
otherwise), formulas with their cached values (nothing is evaluated), merged
cells and `cellIs` conditional formatting with constant operands; slides in
order, text boxes with xfrm positions inherited from layouts and masters,
master text sizes, theme colours, local images, simple tables and speaker
notes. Charts, diagrams, media and other shapes are labelled placeholders.

### 3. Lazy loading and bundle placement

Each viewer is its own chunk, loaded by `OfficeView` through Solid `lazy`
only when a file of that kind opens. mammoth and jszip form one lazy chunk
(about 308 KB minified) imported by `parseDocx`. pdfjs-dist is a lazy chunk
(about 430 KB) imported by `loadPdf`. Its worker is emitted as a bundled
asset (`pdfjs-dist/build/pdf.worker.min.mjs?url`, about 1.26 MB) and set as
`GlobalWorkerOptions.workerSrc`. Nothing loads from a CDN. The main chunk
grew by about 8 KB minified (2.5 KB gzip) for the kind table, the dispatcher
and the preload map.

### 4. Security model

All parsing is read-only and never writes to disk.

- ZIP containers: the central directory is parsed in `zip.ts`. Before any
  inflation, declared sizes are checked (64 MiB per entry, 256 MiB total,
  10,000 entries, ratio over 200 to 1 refused once an entry passes 1 MiB).
  Entries are inflated in 4 KiB input chunks and the real output is counted,
  so a lying header still stops at the cap. Failures use the too-large
  state. Encrypted entries and OLE (encrypted Office) files show the
  password protected state.
- Before mammoth sees a `.docx`, every entry is inflated once with those
  bounds, so mammoth only opens packages whose real size is known.
- XML: DTD and entity declarations are refused (no entity expansion, no
  external entities), parts are capped at 32 MiB and nesting at 256.
- Word HTML is never assigned through `innerHTML`. `sanitizeDocHtml` parses
  mammoth's output into an inert document and rebuilds an allowlisted DOM:
  no scripts, styles, frames, objects, forms, SVG or MathML; no `style` or
  `on*` attributes; ids are prefixed; links keep only in-document anchors,
  and other links become inert text. Images are accepted only through tokens
  that the converter issued for images embedded in the file, and only as
  PNG, JPEG, GIF, WebP or BMP data URLs whose type was sniffed from the
  bytes, within size caps (8 MiB each, 48 MiB and 300 images per document).
  External images and data URLs from anywhere else are dropped.
- Slides: external relationships (`TargetMode="External"`, `r:link`) are
  never loaded and show "Linked image not loaded". Colours are validated
  six-digit hex values from the file.
- PDF: no annotation layer, so links are not clickable and never navigate.
  Scripting is never enabled (the scripting sandbox is not loaded).
  `isEvalSupported: false` is passed, although pdfjs-dist 6 has no eval path
  (the built chunk and worker contain no `eval(` or `new Function(`).
  `enableXfa: false`, `useWasm: false`, `useWorkerFetch: false`, streaming,
  ranges and auto fetch are disabled, and the document is passed as bytes.
  Canvases are capped at 16.7 million pixels each, only visible pages (plus
  one either side) hold a canvas, and the document is destroyed when the
  view closes.
- Archives: entries that point outside the archive (`..` segments, absolute
  paths, drive letters, NUL) are flagged and can never be selected or
  extracted. In the browser preview only ZIP listing and reading entries
  works; extraction needs the desktop backend.

### 5. Content Security Policy

The desktop CSP (`apps/desktop/tauri.conf.json`) is `default-src 'self'`
with no `worker-src` or `script-src`, so both fall back to `'self'`. The
pdf.js worker is a same-origin bundled module started with
`new Worker(url, { type: "module" })`, which `'self'` allows, so no CSP
change should be needed and nothing was changed. pdf.js 6 wraps the worker
in a `blob:` URL only when the worker URL is cross-origin, which it is not
here. If the WebView still refuses the worker, pdf.js falls back to a
main-thread "fake worker" that imports the same module (allowed by
`'self'`, slower but working). To keep a real worker in that case, add
`worker-src 'self'`, plus `blob:` only if the app is ever served from a
different origin than its assets. WebAssembly decoders are disabled
(`useWasm: false`), so `'wasm-unsafe-eval'` is not needed. Rendering uses
`canvas` and `data:` image URLs, which `img-src` already allows.

## Consequences

- JPEG 2000 and JBIG2 images inside PDFs may not render, because the
  WebAssembly decoders are disabled. CJK text in PDFs without embedded fonts
  may render with fallback glyphs, because no CMap files are bundled.
- Word tracked changes are not marked. mammoth shows insertions and omits
  deletions, and the view says so.
- Parsing runs on the main thread (DOMParser is not available in workers).
  Files are capped (Word 64 MiB, slides 256 MiB, workbooks 64 MiB, PDF
  128 MiB) and rows are windowed, but a large file can still pause the UI
  briefly while it parses.

## UNVERIFIED

- Nothing here has been seen in the native app. The CSP worker behaviour in
  Tauri's WebView is inferred from the policy text, not observed.
- Rendering fidelity of real-world Word, PowerPoint and PDF files is not
  verified. Tests use small generated fixtures, and the PDF view is tested
  with a mocked pdf.js loader because jsdom has no canvas.
