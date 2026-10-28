import { writeFile } from 'node:fs/promises';

const headers = { Accept: 'application/vnd.github+json' };
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (token) headers.Authorization = `Bearer ${token}`;
const response = await fetch('https://api.github.com/repos/1kentom/span/releases?per_page=3', {
  headers,
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`GitHub Releases returned ${response.status}`);
const data = await response.json();
if (!Array.isArray(data)) throw new Error('Invalid GitHub Releases response');
const releases = data.filter(release => !release.draft).map(release => ({
  id: release.id,
  name: release.name,
  tag_name: release.tag_name,
  body: release.body,
  html_url: release.html_url,
  draft: false,
  prerelease: release.prerelease,
  published_at: release.published_at,
  assets: release.assets.map(asset => ({
    name: asset.name,
    browser_download_url: asset.browser_download_url,
    size: asset.size,
    digest: asset.digest,
  })),
}));
await writeFile(new URL('../releases.json', import.meta.url), `${JSON.stringify(releases, null, 2)}\n`);
console.log(`Saved ${releases.length} published release entries`);
