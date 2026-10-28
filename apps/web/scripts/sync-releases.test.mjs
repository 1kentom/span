import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncReleaseManifest, validateRelease, mergeReleaseManifest, writeManifestAtomic } from './sync-releases.mjs';

const original = JSON.parse(await readFile(new URL('../releases.json', import.meta.url), 'utf8')).find(entry => /nightly/i.test(entry.tag_name));
assert(original, 'The verified manifest must retain a Nightly channel head');
const relativeDate = days => new Date(Date.parse(original.published_at) + days * 86400000).toISOString();
function release(tag, { id = original.id + 1, date = relativeDate(1), prerelease = true } = {}) {
  const value = JSON.parse(JSON.stringify(original).replaceAll(original.tag_name.slice(1), tag.replace(/^v/, '')));
  value.tag_name = tag;
  value.id = id;
  value.published_at = date;
  value.prerelease = prerelease;
  return value;
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'span-release-sync-'));
  const manifestPath = join(directory, 'releases.json');
  const content = `${JSON.stringify([original], null, 2)}\n`;
  await writeFile(manifestPath, content);
  try { await run({ directory, manifestPath, content }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const candidate = () => release('v0.1.0-nightly.sync-test-next');
function options(manifestPath, data = candidate()) {
  return { manifestPath, expectedTag: data.tag_name, expectedChannel: 'nightly', token: 'unit-test-token', attempts: 1, fetchImpl: async () => new Response(JSON.stringify(data), { status: 200 }) };
}

test('authenticated exact-tag refresh publishes a complete curated manifest', async () => fixture(async ({ manifestPath }) => {
  const data = candidate();
  data.author = { token: 'must-not-be-published' };
  const result = await syncReleaseManifest({ ...options(manifestPath, data), fetchImpl: async (url, request) => {
    assert.equal(url, `https://api.github.com/repos/1kentom/span/releases/tags/${data.tag_name}`);
    assert.equal(request.headers.Authorization, 'Bearer unit-test-token');
    return new Response(JSON.stringify(data));
  } });
  assert.equal(result.changed, true);
  const content = await readFile(manifestPath, 'utf8');
  const entries = JSON.parse(content);
  assert.equal(entries[0].tag_name, data.tag_name);
  assert.equal(entries[0].assets.filter(asset => /\.(dmg|exe|deb|AppImage)$/i.test(asset.name)).length, 5);
  assert(!content.includes('unit-test-token'));
  assert(!content.includes('must-not-be-published'));
}));

test('older completion never downgrades a newer head and unchanged data is not rewritten', async () => fixture(async ({ manifestPath, content }) => {
  const older = release('v0.1.0-nightly.sync-test-older', { date: relativeDate(-1), id: original.id - 1 });
  const result = await syncReleaseManifest({ ...options(manifestPath, older), atomicWrite: () => { throw new Error('Unchanged data must not be written'); } });
  assert.equal(result.changed, false);
  assert.equal(await readFile(manifestPath, 'utf8'), content);
}));

test('newest head of each channel survives another nightly publication', () => {
  const stable = release('v0.1.0', { id: original.id - 3, date: relativeDate(-3), prerelease: false });
  const preview = release('v0.1.0-preview.1', { id: original.id - 2, date: relativeDate(-2) });
  const merged = mergeReleaseManifest([stable, preview, original], candidate());
  assert.deepEqual(merged.map(entry => entry.tag_name), [candidate().tag_name, preview.tag_name, stable.tag_name]);
});

for (const [name, response] of [
  ['HTTP failure', () => new Response('{"message":"limited"}', { status: 403 })],
  ['malformed JSON', () => new Response('not JSON')],
  ['empty response', () => new Response('[]')],
  ['unpublished release', () => new Response(JSON.stringify({ ...candidate(), draft: true }))],
  ['different tag', () => new Response(JSON.stringify(original))],
  ['wrong channel', () => new Response(JSON.stringify(release('v0.1.0', { prerelease: false })))],
  ['incomplete matrix', () => { const data = candidate(); data.assets = data.assets.filter(asset => !asset.name.endsWith('.exe')); return new Response(JSON.stringify(data)); }],
  ['invalid digest', () => { const data = candidate(); data.assets[0].digest = 'sha256:not-a-hash'; return new Response(JSON.stringify(data)); }],
  ['missing checksums', () => { const data = candidate(); data.assets = data.assets.filter(asset => asset.name !== 'SHA256SUMS'); return new Response(JSON.stringify(data)); }],
  ['external artifact', () => { const data = candidate(); data.assets[0].browser_download_url = 'https://malicious.invalid/setup.dmg'; return new Response(JSON.stringify(data)); }],
  ['non-prerelease nightly', () => new Response(JSON.stringify({ ...candidate(), prerelease: false }))],
]) {
  test(`${name} preserves the prior manifest byte for byte`, async () => fixture(async ({ manifestPath, content }) => {
    await assert.rejects(syncReleaseManifest({ ...options(manifestPath), fetchImpl: async () => response() }));
    assert.equal(await readFile(manifestPath, 'utf8'), content);
  }));
}

test('authentication is required before any request or file change', async () => fixture(async ({ manifestPath, content }) => {
  await assert.rejects(syncReleaseManifest({ ...options(manifestPath), token: '', fetchImpl: async () => { throw new Error('must not request'); } }), /authenticated/);
  assert.equal(await readFile(manifestPath, 'utf8'), content);
}));

test('publication visibility retries are bounded and write only the final validated response', async () => fixture(async ({ manifestPath }) => {
  let requests = 0;
  let pauses = 0;
  const result = await syncReleaseManifest({ ...options(manifestPath), attempts: 3, delay: async () => { pauses += 1; }, fetchImpl: async () => {
    requests += 1;
    return requests < 3 ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(candidate()));
  } });
  assert.equal(result.changed, true);
  assert.equal(requests, 3);
  assert.equal(pauses, 2);
}));

test('atomic rename failure keeps the old file and removes temporary output', async () => fixture(async ({ directory, manifestPath, content }) => {
  await assert.rejects(syncReleaseManifest({ ...options(manifestPath), atomicWrite: (path, next) => writeManifestAtomic(path, next, { rename: async () => { throw new Error('simulated rename failure'); } }) }), /rename failure/);
  assert.equal(await readFile(manifestPath, 'utf8'), content);
  assert.deepEqual(await readdir(directory), ['releases.json']);
}));

test('invalid existing JSON is preserved and blocks refresh before network access', async () => fixture(async ({ manifestPath }) => {
  const content = '{broken manifest';
  await writeFile(manifestPath, content);
  await assert.rejects(syncReleaseManifest({ ...options(manifestPath), fetchImpl: async () => { throw new Error('must not request'); } }));
  assert.equal(await readFile(manifestPath, 'utf8'), content);
}));

test('the checked-in release is complete and has no rejected metadata', () => {
  assert.deepEqual(validateRelease(original), original);
});


test('an exact-tag channel mismatch fails without modifying the manifest', async () => fixture(async ({ manifestPath, content }) => {
  await assert.rejects(syncReleaseManifest({ ...options(manifestPath), expectedChannel: 'preview' }), /channel/);
  assert.equal(await readFile(manifestPath, 'utf8'), content);
}));

test('a manifest changed during fetch is preserved rather than overwritten', async () => fixture(async ({ manifestPath }) => {
  const newer = release('v0.1.0-nightly.sync-test-newer', { id: original.id + 2, date: relativeDate(2) });
  const newerContent = `${JSON.stringify([newer], null, 2)}\n`;
  await assert.rejects(syncReleaseManifest({ ...options(manifestPath), fetchImpl: async () => {
    await writeFile(manifestPath, newerContent);
    return new Response(JSON.stringify(candidate()));
  } }), /changed during metadata fetch/);
  assert.equal(await readFile(manifestPath, 'utf8'), newerContent);
}));
