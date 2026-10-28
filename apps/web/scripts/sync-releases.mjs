import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installerInfo, releaseChannel } from '../release-data.js';

const repository = '1kentom/span';
const defaultManifest = fileURLToPath(new URL('../releases.json', import.meta.url));
const channels = new Set(['nightly', 'preview', 'stable']);
const requiredBuilds = ['mac:arm64:dmg', 'mac:x64:dmg', 'windows:x64:exe', 'linux:x64:appimage', 'linux:x64:deb'];

function assert(condition, message) { if (!condition) throw new Error(message); }
function exactGithubUrl(value, path) {
  try {
    const url = new URL(value);
    return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash && decodeURIComponent(url.pathname) === path;
  } catch { return false; }
}
export function validateRelease(value) {
  assert(value && typeof value === 'object', 'Invalid release object');
  assert(value.draft === false, 'Release is not published');
  assert(typeof value.prerelease === 'boolean', 'Release status is missing');
  assert(Number.isSafeInteger(value.id) && value.id > 0, 'Release ID is invalid');
  assert(typeof value.tag_name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.tag_name), 'Release tag is invalid');
  const tag = value.tag_name;
  if (/nightly/i.test(tag)) assert(value.prerelease, 'Nightly must be marked as a prerelease');
  assert(exactGithubUrl(value.html_url, `/${repository}/releases/tag/${tag}`), 'Release URL does not match this repository and tag');
  assert(typeof value.published_at === 'string' && Number.isFinite(Date.parse(value.published_at)), 'Publication date is invalid');
  assert(Array.isArray(value.assets) && value.assets.length > 0, 'Release assets are missing');
  const names = new Set();
  const builds = new Set();
  const assets = value.assets.map(asset => {
    assert(asset && typeof asset.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name), 'Artifact name is invalid');
    assert(!names.has(asset.name), 'Artifact names are duplicated');
    names.add(asset.name);
    assert(exactGithubUrl(asset.browser_download_url, `/${repository}/releases/download/${tag}/${asset.name}`), 'Artifact URL does not match this release');
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, 'Artifact size is invalid');
    const info = installerInfo(asset.name);
    const digest = typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.toLowerCase() : null;
    if (info) {
      assert(digest, 'Installer SHA-256 digest is missing or invalid');
      builds.add(`${info.platform}:${info.arch}:${info.format}`);
    }
    if (asset.name === 'SHA256SUMS') assert(digest, 'SHA256SUMS digest is missing or invalid');
    return { name: asset.name, browser_download_url: asset.browser_download_url, size: asset.size, digest };
  });
  assert(names.has('SHA256SUMS'), 'Published checksum file is missing');
  for (const required of requiredBuilds) assert(builds.has(required), `Published installer matrix is incomplete: ${required}`);
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : tag,
    tag_name: tag,
    body: typeof value.body === 'string' ? value.body : '',
    html_url: value.html_url,
    draft: false,
    prerelease: value.prerelease,
    published_at: value.published_at,
    assets,
  };
}
function compareReleases(left, right) {
  return Date.parse(left.published_at) - Date.parse(right.published_at) || left.id - right.id;
}
export function mergeReleaseManifest(existing, candidate) {
  assert(Array.isArray(existing), 'Existing release manifest must be an array');
  const heads = new Map();
  for (const entry of [...existing, candidate]) {
    const release = validateRelease(entry);
    const channel = releaseChannel(release);
    const current = heads.get(channel);
    if (!current || compareReleases(release, current) > 0) heads.set(channel, release);
  }
  return [...heads.values()].sort((left, right) => compareReleases(right, left));
}
export async function writeManifestAtomic(path, content, operations = {}) {
  const temporary = resolve(dirname(path), `.releases-${randomUUID()}.tmp`);
  try {
    await (operations.writeFile || writeFile)(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    await (operations.rename || rename)(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export async function syncReleaseManifest({
  expectedTag,
  expectedChannel,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  manifestPath = defaultManifest,
  fetchImpl = fetch,
  attempts = 3,
  delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds)),
  atomicWrite = writeManifestAtomic,
} = {}) {
  assert(typeof token === 'string' && token.trim().length > 0, 'Set GH_TOKEN or GITHUB_TOKEN for authenticated release metadata access');
  assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 3, 'Use one to three metadata fetch attempts');
  const apiToken = token.trim();
  assert(!/[\u0000-\u0020\u007f]/.test(apiToken), 'Authentication token contains invalid characters');
  assert(typeof expectedTag === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(expectedTag), 'An exact published --tag is required');
  assert(channels.has(expectedChannel), 'A valid --channel is required (nightly, preview, stable)');
  const path = resolve(manifestPath);
  let previous = '';
  try { previous = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const existing = previous ? JSON.parse(previous) : [];
  assert(Array.isArray(existing), 'Existing release manifest must be an array');
  existing.forEach(validateRelease);
  let candidate;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(expectedTag)}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${apiToken}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(30000),
      });
      assert(response.ok, `GitHub release metadata returned HTTP ${response.status}`);
      candidate = validateRelease(await response.json());
      assert(candidate.tag_name === expectedTag, 'GitHub returned a different release tag');
      assert(releaseChannel(candidate) === expectedChannel, 'Published release channel does not match the requested channel');
      break;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(2000);
    }
  }
  if (!candidate || candidate.tag_name !== expectedTag || releaseChannel(candidate) !== expectedChannel) throw lastError || new Error('Published release metadata is unavailable');
  const releases = mergeReleaseManifest(existing, candidate);
  const content = `${JSON.stringify(releases, null, 2)}\n`;
  let latest = '';
  try { latest = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(latest === previous, 'Manifest changed during metadata fetch; retry from the current main snapshot');
  if (content === previous) return { changed: false, releases: releases.length, tag: candidate.tag_name };
  await atomicWrite(path, content);
  return { changed: true, releases: releases.length, tag: candidate.tag_name };
}
function commandOptions(args) {
  const options = { expectedTag: process.env.RELEASE_TAG, expectedChannel: process.env.RELEASE_CHANNEL };
  for (let index = 0; index < args.length; index += 1) {
    const key = { '--tag': 'expectedTag', '--channel': 'expectedChannel', '--manifest': 'manifestPath' }[args[index]];
    assert(key && args[index + 1], 'Use --tag TAG --channel CHANNEL and optionally --manifest PATH');
    options[key] = args[++index];
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await syncReleaseManifest(commandOptions(process.argv.slice(2)));
    console.log(`${result.changed ? 'Updated' : 'Preserved'} release manifest: ${result.releases} channel heads, published tag ${result.tag}`);
  } catch (error) {
    console.error(`Release manifest was not updated: ${error.message}`);
    process.exitCode = 1;
  }
}
