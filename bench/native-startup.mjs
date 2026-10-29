import { openSync, readSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_CAPTURE_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 4096;
export const MAX_CAPTURES = 100;
const EVENTS = new Set(['window_created', 'window_shown', 'webview_startup']);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const optionalMs = value => value === null || nonnegative(value);
const WEBVIEW_FIELDS = ['entryEvaluatedMs', 'shellRenderedMs', 'sessionReadyMs', 'webviewPaintMs', 'navigationProcessMs', 'sessionReadyProcessMs'];

// One capture must come from one fresh process. Never return raw stderr or user paths.
export function parseCapture(input) {
  if (!Buffer.isBuffer(input) && typeof input !== 'string') throw new TypeError('Startup capture must be bytes or text.');
  if (typeof input === 'string' && Buffer.byteLength(input) > MAX_CAPTURE_BYTES) throw new Error('Startup capture exceeds the 1 MiB limit.');
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > MAX_CAPTURE_BYTES) throw new Error('Startup capture exceeds the 1 MiB limit.');
  const events = {};
  let ignoredLines = 0;
  let rejectedRecords = 0;
  let oversizedLines = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { oversizedLines++; continue; }
    if (!line.trimStart().startsWith('{')) { ignoredLines++; continue; }
    let record;
    try { record = JSON.parse(line); } catch { rejectedRecords++; continue; }
    if (!record || record.schema !== 'span.startup.v1') { ignoredLines++; continue; }
    if (!EVENTS.has(record.event) || events[record.event] || !nonnegative(record.processElapsedMs)) { rejectedRecords++; continue; }
    if (record.event === 'window_shown' && !['frontend', 'failsafe'].includes(record.shownBy)) { rejectedRecords++; continue; }
    let webview;
    if (record.event === 'webview_startup') {
      const source = record.webview;
      if (!source || !WEBVIEW_FIELDS.every(field => optionalMs(source[field]))
        || source.paintSource !== 'first-paint-or-first-contentful-paint'
        || source.paintStatus !== (source.webviewPaintMs === null ? 'unavailable' : 'reported')
        || ['navigationProcessMs', 'sessionReadyProcessMs'].some(field => source[field] !== null && source[field] > record.processElapsedMs)) {
        rejectedRecords++; continue;
      }
      webview = Object.fromEntries(WEBVIEW_FIELDS.map(field => [field, source[field]]));
      webview.paintStatus = source.paintStatus;
    }
    events[record.event] = { processElapsedMs: record.processElapsedMs, ...(webview && { webview }), ...(record.event === 'window_shown' && { shownBy: record.shownBy }) };
  }
  return { events, ignoredLines, rejectedRecords, oversizedLines };
}

function distribution(values) {
  const sorted = values.filter(nonnegative).sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

export function summarize(captures) {
  if (captures.length > MAX_CAPTURES) throw new Error('Too many startup captures.');
  const values = read => captures.map(capture => read(capture.events));
  return {
    schema: 'span.startup.summary.v1',
    captures: captures.length,
    completeCaptures: captures.filter(capture => [...EVENTS].every(event => capture.events[event])).length,
    rejectedRecords: captures.reduce((total, capture) => total + capture.rejectedRecords, 0),
    oversizedLines: captures.reduce((total, capture) => total + capture.oversizedLines, 0),
    metrics: {
      setupHookProcessMs: distribution(values(events => events.window_created?.processElapsedMs)),
      showCallProcessMs: distribution(values(events => events.window_shown?.processElapsedMs)),
      reportReceivedProcessMs: distribution(values(events => events.webview_startup?.processElapsedMs)),
      sessionReadyNavigationMs: distribution(values(events => events.webview_startup?.webview?.sessionReadyMs)),
      approximateSessionReadyProcessMs: distribution(values(events => events.webview_startup?.webview?.sessionReadyProcessMs)),
      browserPaintNavigationMs: distribution(values(events => events.webview_startup?.webview?.webviewPaintMs)),
    },
    paintUnavailableCaptures: captures.filter(capture => capture.events.webview_startup?.webview?.paintStatus === 'unavailable').length,
    failsafeShownCaptures: captures.filter(capture => capture.events.window_shown?.shownBy === 'failsafe').length,
    method: 'Rust app-entry marks and webview-reported navigation marks. Not OS launch latency or physical paint.',
  };
}

function readBounded(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_CAPTURE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const paths = process.argv.slice(2);
    if (!paths.length || paths.length > MAX_CAPTURES) throw new Error('Provide 1 to 100 stderr capture files, one per fresh process.');
    const captures = paths.map(path => parseCapture(readBounded(path)));
    console.log(JSON.stringify(summarize(captures), null, 2));
  } catch {
    // OS errors can contain private paths, so keep CLI failures generic.
    console.error('Could not summarize startup captures. Provide 1 to 100 readable capture files of at most 1 MiB each.');
    process.exitCode = 1;
  }
}
