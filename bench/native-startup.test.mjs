import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_CAPTURE_BYTES, MAX_LINE_BYTES, MAX_CAPTURES, parseCapture, summarize } from './native-startup.mjs';

const native = (event, ms, extra = {}) => ({ schema: 'span.startup.v1', event, processElapsedMs: ms, ...extra });
const webview = overrides => ({ entryEvaluatedMs: 5, shellRenderedMs: 10, sessionReadyMs: 20, webviewPaintMs: null, paintStatus: 'unavailable', paintSource: 'first-paint-or-first-contentful-paint', navigationProcessMs: 30, sessionReadyProcessMs: 50, ...overrides });
const lines = records => records.map(record => JSON.stringify(record)).join('\n');

test('summarizes per-process timing records and labels unavailable paint', () => {
  const capture = parseCapture(lines([
    native('window_created', 30), native('window_shown', 55, { shownBy: 'frontend' }),
    native('webview_startup', 60, { webview: webview() }),
  ]));
  const summary = summarize([capture]);
  assert.equal(summary.completeCaptures, 1);
  assert.deepEqual(summary.metrics.showCallProcessMs, { samples: 1, p50Ms: 55, p95Ms: 55 });
  assert.equal(summary.metrics.browserPaintNavigationMs.samples, 0);
  assert.equal(summary.paintUnavailableCaptures, 1);
  assert.equal(summary.metrics.approximateSessionReadyProcessMs.p50Ms, 50);
});

test('retains missing metrics without fabricating zeros', () => {
  const summary = summarize([parseCapture('')]);
  assert.equal(summary.completeCaptures, 0);
  assert.deepEqual(summary.metrics.showCallProcessMs, { samples: 0, p50Ms: null, p95Ms: null });
});

test('ignores unrelated stderr and never returns arbitrary fields', () => {
  const capture = parseCapture('credential=private\n' + lines([
    { schema: 'other', path: '/private' }, native('window_created', 10, { credential: 'private' }),
  ]));
  assert.equal(capture.ignoredLines, 2);
  assert.equal(JSON.stringify(capture).includes('private'), false);
});

test('rejects malformed, invalid, unknown and duplicate records', () => {
  const capture = parseCapture('{bad\n' + lines([
    native('unknown', 10), native('window_created', -1), native('window_created', 10), native('window_created', 20),
    native('window_shown', 15, { shownBy: 'arbitrary' }),
    native('webview_startup', 60, { webview: webview({ sessionReadyMs: '20' }) }),
    native('webview_startup', 60, { webview: webview({ sessionReadyProcessMs: 70 }) }),
    native('webview_startup', 60, { webview: webview({ paintStatus: 'reported' }) }),
  ]));
  assert.equal(capture.rejectedRecords, 8);
  assert.equal(capture.events.window_created.processElapsedMs, 10);
});

test('bounds capture and line sizes before parsing', () => {
  assert.throws(() => parseCapture(Buffer.alloc(MAX_CAPTURE_BYTES + 1)), /limit/);
  assert.throws(() => parseCapture('x'.repeat(MAX_CAPTURE_BYTES + 1)), /limit/);
  assert.throws(() => parseCapture({}), TypeError);
  assert.throws(() => summarize(Array(MAX_CAPTURES + 1).fill(parseCapture(''))), /Too many/);
  const capture = parseCapture('x'.repeat(MAX_LINE_BYTES + 1));
  assert.equal(capture.oversizedLines, 1);
  assert.deepEqual(capture.events, {});
});

test('counts failsafe and reported browser paint separately', () => {
  const capture = parseCapture(lines([
    native('window_shown', 1000, { shownBy: 'failsafe' }),
    native('webview_startup', 1100, { webview: webview({ webviewPaintMs: 80, paintStatus: 'reported' }) }),
  ]));
  const summary = summarize([capture]);
  assert.equal(summary.failsafeShownCaptures, 1);
  assert.equal(summary.metrics.browserPaintNavigationMs.p50Ms, 80);
  assert.equal(summary.paintUnavailableCaptures, 0);
});


test('CLI reads captures and reports generic errors without source text or paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'span-startup-'));
  const helper = fileURLToPath(new URL('./native-startup.mjs', import.meta.url));
  try {
    const path = join(directory, 'private-capture.log');
    writeFileSync(path, 'credential=private-value\n' + lines([native('window_created', 10)]));
    const result = spawnSync(process.execPath, [helper, path], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).metrics.setupHookProcessMs.p50Ms, 10);
    assert.equal(result.stdout.includes('private'), false);
    assert.equal(result.stderr, '');
    const missing = spawnSync(process.execPath, [helper, join(directory, 'private-missing')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.includes(directory), false);
    assert.equal(missing.stderr.includes('private'), false);
    assert.equal(missing.stdout, '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
