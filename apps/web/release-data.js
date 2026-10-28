export const platformLabels = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };
export const channelLabels = { nightly: 'Nightly', preview: 'Preview', stable: 'Stable' };
export function officialUrl(value, asset = false) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      url.pathname.startsWith('/1kentom/span/releases/') &&
      (!asset || url.pathname.startsWith('/1kentom/span/releases/download/'));
  } catch { return false; }
}
export function releaseChannel(release) {
  if (/nightly/i.test(release.tag_name)) return 'nightly';
  return release.prerelease ? 'preview' : 'stable';
}
export function installerInfo(name) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;
  if (/aarch64-apple-darwin.*\.dmg$/i.test(name)) return { platform: 'mac', arch: 'arm64', architecture: 'Apple silicon (ARM64)', format: 'dmg', formatLabel: 'Disk image (.dmg)' };
  if (/x86_64-apple-darwin.*\.dmg$/i.test(name)) return { platform: 'mac', arch: 'x64', architecture: 'Intel (x64)', format: 'dmg', formatLabel: 'Disk image (.dmg)' };
  if (/x86_64-pc-windows-msvc.*\.(exe|msi)$/i.test(name)) {
    const format = name.toLowerCase().endsWith('.msi') ? 'msi' : 'exe';
    return { platform: 'windows', arch: 'x64', architecture: 'Intel / AMD (x64)', format, formatLabel: format === 'exe' ? 'Installer (.exe)' : 'Windows Installer (.msi)' };
  }
  if (/x86_64-unknown-linux-gnu.*\.(appimage|deb)$/i.test(name)) {
    const format = name.toLowerCase().endsWith('.deb') ? 'deb' : 'appimage';
    return { platform: 'linux', arch: 'x64', architecture: 'Intel / AMD (x64)', format, formatLabel: format === 'deb' ? 'Debian package (.deb)' : 'AppImage' };
  }
  return null;
}
export function normalizeReleases(data) {
  if (!Array.isArray(data)) return [];
  return data.filter(release => {
    if (!release || release.draft || typeof release.prerelease !== 'boolean' || typeof release.tag_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(release.tag_name) || !officialUrl(release.html_url)) return false;
    return new URL(release.html_url).pathname === `/1kentom/span/releases/tag/${release.tag_name}`;
  }).map(release => ({
    ...release,
    name: typeof release.name === 'string' ? release.name : release.tag_name,
    body: typeof release.body === 'string' ? release.body : '',
    channel: releaseChannel(release),
    published_at: Number.isFinite(Date.parse(release.published_at)) ? release.published_at : null,
    assets: (Array.isArray(release.assets) ? release.assets : []).filter(asset => {
      if (!asset || typeof asset.name !== 'string' || !officialUrl(asset.browser_download_url, true)) return false;
      try {
        const path = decodeURIComponent(new URL(asset.browser_download_url).pathname);
        return path === `/1kentom/span/releases/download/${release.tag_name}/${asset.name}`;
      } catch { return false; }
    }).map(asset => ({
      ...asset,
      size: Number.isSafeInteger(asset.size) && asset.size >= 0 ? asset.size : null,
      digest: /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') ? asset.digest.toLowerCase() : null,
      installer: installerInfo(asset.name),
    })).filter(asset => !asset.installer || (asset.digest && asset.size > 0)),
  })).sort((a, b) => (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0));
}
export function installersFor(release, platform) {
  return (release?.assets || []).filter(asset => asset.installer && (!platform || asset.installer.platform === platform));
}
export function downloadRelease(releases, channel) {
  return releases.find(release => (!channel || release.channel === channel) && installersFor(release).length) || null;
}
/** A partial API response can add history without removing verified files or channels. */
export function mergeReleaseFeeds(baseline, incoming) {
  const releases = new Map(baseline.map(release => [release.tag_name, release]));
  for (const release of incoming) {
    const previous = releases.get(release.tag_name);
    const assets = new Map((previous?.assets || []).map(asset => [asset.name, asset]));
    for (const asset of release.assets) assets.set(asset.name, asset);
    releases.set(release.tag_name, {
      ...previous, ...release,
      body: release.body || previous?.body || '',
      published_at: release.published_at || previous?.published_at || null,
      assets: [...assets.values()],
    });
  }
  return [...releases.values()].sort((a, b) => (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0));
}
export function platformDescription(release, platform) {
  const builds = installersFor(release, platform);
  return [...new Set(builds.map(asset => platform === 'linux' ? asset.installer.formatLabel : asset.installer.architecture))].join(' and ');
}
export function formatSize(size) {
  if (!Number.isSafeInteger(size)) return 'Size not published';
  return size >= 1000000 ? `${(size / 1000000).toFixed(1)} MB` : `${(size / 1000).toFixed(1)} kB`;
}
export function formatDate(date) {
  return date ? new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date)) : 'Publication date not available';
}
export function detectDesktopPlatform(navigatorValue = navigator) {
  const agent = `${navigatorValue.userAgent || ''} ${navigatorValue.platform || ''}`;
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(agent)) return null;
  if (/Windows|Win32|Win64/i.test(agent)) return 'windows';
  if (/Macintosh|MacIntel|MacPPC|Mac OS X/i.test(agent)) return 'mac';
  if (/Linux|X11/i.test(agent)) return 'linux';
  return null;
}
async function readFeed(url, timeout) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error('Release metadata unavailable');
  return normalizeReleases(await response.json());
}
export async function loadReleaseData(onUpdate) {
  let current = [];
  try {
    current = await readFeed('/releases.json', 3000);
    onUpdate(current, 'manifest');
  } catch { onUpdate([], 'unavailable'); }
  try {
    const remote = await readFeed('https://api.github.com/repos/1kentom/span/releases?per_page=10', 6000);
    if (remote.length) onUpdate(mergeReleaseFeeds(current, remote), 'github');
  } catch {
    // The local release manifest and permanent GitHub links remain available.
  }
}
