import { CustomSelect } from './custom-select.js';
import { initializeNavigation } from './navigation.js';
import { loadReleaseData, installersFor, downloadRelease, platformLabels, channelLabels, formatDate, formatSize, detectDesktopPlatform } from './release-data.js';

initializeNavigation();
const $ = id => document.getElementById(id);
const icons = { mac: '/assets/icons/macos.svg', windows: '/assets/icons/windows.svg', linux: '/assets/icons/linux.svg' };
const parameters = new URLSearchParams(location.search);
const detected = detectDesktopPlatform();
const state = {
  releases: [],
  channel: ['nightly', 'preview', 'stable'].includes(parameters.get('channel')) ? parameters.get('channel') : 'nightly',
  platform: ['mac', 'windows', 'linux'].includes(parameters.get('platform')) ? parameters.get('platform') : detected || 'mac',
  arch: ['arm64', 'x64'].includes(parameters.get('arch')) ? parameters.get('arch') : '',
  format: ['dmg', 'exe', 'msi', 'deb', 'appimage'].includes(parameters.get('format')) ? parameters.get('format') : '',
};
let selectedAsset = null;
let currentRelease = null;
let copyFeedbackTimer;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function image(src, className, size = 17) {
  const node = document.createElement('img');
  Object.assign(node, { src, className, alt: '', width: size, height: size });
  return node;
}
function announce(message) { $('download-announcement').textContent = message; }
function updateUrl() {
  const url = new URL(location.href);
  for (const key of ['channel', 'platform', 'arch', 'format']) {
    if (state[key]) url.searchParams.set(key, state[key]);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, '', url);
}
const channelSelect = new CustomSelect($('channel'), { label: 'Release channel', value: state.channel, options: [], onChange: value => {
  state.channel = value;
  render();
  updateUrl();
  announce(`${channelLabels[value]} channel selected.`);
} });
const platformSelect = new CustomSelect($('platform'), { label: 'Operating system', value: state.platform, options: [], onChange: value => {
  state.platform = value;
  state.arch = '';
  state.format = '';
  renderSelection();
  renderCards();
  updateUrl();
  announce(`${platformLabels[value]} selected. Check the architecture before downloading.`);
} });
const architectureSelect = new CustomSelect($('architecture'), { label: 'Architecture', value: state.arch, options: [], onChange: value => {
  state.arch = value;
  state.format = '';
  renderSelection();
  updateUrl();
  announce(`Architecture selected: ${architectureSelect.valueNode.textContent}.`);
} });
const formatSelect = new CustomSelect($('format'), { label: 'Package format', value: state.format, options: [], onChange: value => {
  state.format = value;
  renderSelection();
  updateUrl();
  announce(`Package selected: ${formatSelect.valueNode.textContent}.`);
} });
function render() {
  channelSelect.setOptions(['nightly', 'preview', 'stable'].map(value => ({ value, label: channelLabels[value], detail: downloadRelease(state.releases, value) ? 'Published builds' : 'Not published' })), state.channel);
  $('release-loading').hidden = true;
  $('release-unavailable').hidden = state.releases.length > 0;
  currentRelease = downloadRelease(state.releases, state.channel);
  const contentVisible = !!currentRelease;
  $('download-content').hidden = !contentVisible;
  $('all-builds').hidden = !contentVisible;
  $('install-guide').hidden = !contentVisible;
  $('channel-empty').hidden = contentVisible || state.releases.length === 0;
  if (!currentRelease) {
    $('release-version').textContent = `${channelLabels[state.channel]} channel`;
    $('release-date').textContent = 'No installer has been selected.';
    $('channel-empty-title').textContent = `${channelLabels[state.channel]} is not published yet`;
    $('channel-empty-description').textContent = `${channelLabels[state.channel]} installers are not available. ${state.releases.some(release => release.channel === 'nightly') ? 'A development Nightly is available if you want to try the current foundation.' : 'Check GitHub Releases for the available development builds.'}`;
    $('use-nightly').hidden = !state.releases.some(release => release.channel === 'nightly');
    return;
  }
  $('release-version').textContent = `${channelLabels[state.channel]} ${currentRelease.tag_name}`;
  $('release-date').textContent = `Published ${formatDate(currentRelease.published_at)} (UTC). Manual installation.`;
  $('all-builds-version').textContent = currentRelease.tag_name;
  $('release-notes').href = currentRelease.html_url;
  $('release-status').textContent = currentRelease.prerelease
    ? 'Development prerelease with known limitations. Signing and all-platform installation are not fully verified.'
    : 'Read the release notes for platform support, signing status and known limitations.';
  $('platform-detection').textContent = detected
    ? `${platformLabels[detected]} detected. Choose the architecture for your machine.`
    : 'Choose a desktop platform. No processor architecture was detected.';
  const checksumFile = currentRelease.assets.find(asset => asset.name === 'SHA256SUMS');
  $('checksum-file').href = checksumFile?.browser_download_url || currentRelease.html_url;
  $('checksum-file').firstChild.textContent = checksumFile ? 'Download SHA256SUMS' : 'Check release checksums';
  renderSelection();
  renderCards();
}
function renderSelection() {
  if (!currentRelease) return;
  $('copy-feedback').hidden = true;
  clearTimeout(copyFeedbackTimer);
  const builds = installersFor(currentRelease, state.platform);
  platformSelect.setOptions(['mac', 'windows', 'linux'].map(value => ({ value, label: platformLabels[value], detail: installersFor(currentRelease, value).length ? '' : 'No published installer' })), state.platform);
  const architectures = [...new Map(builds.map(asset => [asset.installer.arch, asset.installer.architecture])).entries()].map(([value, label]) => ({ value, label }));
  if (state.platform === 'mac') {
    if (!architectures.some(option => option.value === state.arch)) state.arch = '';
    architectureSelect.setOptions([{ value: '', label: 'Choose your Mac chip' }, ...architectures], state.arch);
  } else {
    if (!state.arch) state.arch = architectures[0]?.value || '';
    const choices = [...architectures];
    if (!choices.some(option => option.value === 'arm64')) choices.push({ value: 'arm64', label: 'ARM64', detail: 'Not published for this release' });
    architectureSelect.setOptions(choices, state.arch);
  }
  const available = builds.filter(asset => !state.arch || asset.installer.arch === state.arch);
  const formats = [...new Map(available.map(asset => [asset.installer.format, asset.installer.formatLabel])).entries()].map(([value, label]) => ({ value, label }));
  if (!formats.some(option => option.value === state.format)) state.format = formats.some(option => option.value === 'deb') ? 'deb' : formats[0]?.value || '';
  formatSelect.setOptions(formats, state.format);
  selectedAsset = state.arch ? builds.find(asset => asset.installer.arch === state.arch && asset.installer.format === state.format) || null : null;
  $('recommended-logo').src = icons[state.platform];
  $('recommendation-title').textContent = `span for ${platformLabels[state.platform]}`;
  $('architecture-note').textContent = state.platform === 'mac'
    ? 'Choose your chip explicitly. A Mac browser may report Intel on an Apple silicon machine.'
    : `Published ${platformLabels[state.platform]} builds use x64. Your processor was not detected.`;
  $('primary-download').hidden = !selectedAsset;
  $('selected-verification').hidden = !selectedAsset;
  $('verify-placeholder').hidden = !!selectedAsset;
  if (!selectedAsset) {
    $('primary-download').removeAttribute('href');
    $('selected-file').textContent = state.arch ? `No ${platformLabels[state.platform]} ${state.arch.toUpperCase()} installer is published for this release.` : builds.length ? 'Choose your architecture to select an installer.' : `No ${platformLabels[state.platform]} installer is published for this release.`;
    $('selected-meta').textContent = '';
    $('selected-help').textContent = state.platform === 'mac' ? 'Find your chip in Apple menu, About This Mac. Apple silicon uses ARM64; an Intel processor uses x64.' : 'Select a compatible published architecture, choose another platform, or check the source-build instructions.';
  } else {
    $('primary-download').href = selectedAsset.browser_download_url;
    $('primary-download').setAttribute('aria-label', `Download span for ${platformLabels[state.platform]}, ${selectedAsset.installer.architecture}, ${selectedAsset.installer.formatLabel}`);
    $('selected-file').textContent = selectedAsset.name;
    $('selected-meta').textContent = `${formatSize(selectedAsset.size)}, ${selectedAsset.installer.formatLabel}, ${selectedAsset.installer.architecture}`;
    $('selected-meta').title = selectedAsset.size === null ? '' : `${selectedAsset.size.toLocaleString('en')} bytes`;
    $('selected-help').textContent = 'Downloads directly from this project’s GitHub release. Compare the checksum before opening the file.';
    $('verify-file-label').textContent = selectedAsset.name;
    $('selected-sha').textContent = selectedAsset.digest ? selectedAsset.digest.slice(7) : 'No SHA-256 digest is published for this file.';
    $('copy-sha').disabled = !selectedAsset.digest;
    $('verify-command').textContent = verificationCommand(selectedAsset);
  }
  renderInstructions();
}
function verificationCommand(asset) {
  if (state.platform === 'windows') return `Get-FileHash -Algorithm SHA256 ".\\${asset.name}"`;
  return `${state.platform === 'mac' ? 'shasum -a 256' : 'sha256sum'} "${asset.name}"`;
}
function renderCards() {
  const container = $('platform-builds');
  container.replaceChildren();
  for (const platform of ['mac', 'windows', 'linux']) {
    const card = element('article', `platform-card${platform === detected ? ' detected' : ''}`);
    const heading = element('div', 'platform-card-heading');
    heading.append(image(icons[platform], 'platform-symbol', 24), element('h3', '', platformLabels[platform]));
    if (platform === detected) heading.append(element('span', 'detected-label', 'Detected OS'));
    card.append(heading);
    const builds = installersFor(currentRelease, platform).sort((a, b) => (a.installer.format === 'deb' ? -1 : b.installer.format === 'deb' ? 1 : 0));
    if (!builds.length) card.append(element('p', 'build-row', 'No installer published for this release.'));
    for (const asset of builds) {
      const row = element('div', 'build-row');
      const top = element('div', 'build-row-header');
      const info = element('div');
      info.append(element('strong', '', asset.installer.architecture), element('small', '', asset.installer.formatLabel));
      const size = element('span', 'build-size', formatSize(asset.size));
      if (asset.size !== null) size.title = `${asset.size.toLocaleString('en')} bytes`;
      top.append(info, size);
      const link = element('a', 'build-download', `Download ${asset.installer.format === 'appimage' ? 'AppImage' : `.${asset.installer.format}`}`);
      link.href = asset.browser_download_url;
      link.setAttribute('aria-label', `Download ${platformLabels[platform]} ${asset.installer.architecture} ${asset.installer.formatLabel}`);
      link.append(image('/assets/icons/arrow-down4.svg', 'chevron', 14));
      const details = element('details', 'build-details');
      const summary = element('summary', '', 'File and SHA-256');
      summary.append(image('/assets/icons/arrow-down4.svg', 'chevron', 11));
      details.append(summary, element('span', 'file-name', asset.name), element('code', 'build-checksum', asset.digest ? asset.digest.slice(7) : 'Checksum not published'));
      const choose = element('button', 'build-choose', 'Use in installation guide');
      choose.type = 'button';
      choose.addEventListener('click', () => {
        Object.assign(state, { platform, arch: asset.installer.arch, format: asset.installer.format });
        renderSelection();
        updateUrl();
        $('install-guide').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        announce(`Installation guide selected for ${platformLabels[platform]}, ${asset.installer.architecture}, ${asset.installer.formatLabel}.`);
      });
      row.append(top, link, details, choose);
      card.append(row);
    }
    container.append(card);
  }
}
function renderInstructions() {
  const steps = $('install-steps');
  steps.replaceChildren();
  let introduction = '';
  let instructions = [];
  if (state.platform === 'mac') {
    introduction = 'Use the disk image that matches your Mac. These development installers are provided for manual installation.';
    instructions = ['In Apple menu, About This Mac, check whether the machine has an Apple chip or an Intel processor.', 'Download the matching .dmg and compare its SHA-256 checksum. Open the disk image and drag span into Applications.', 'Open span from Applications. Review the release notes and any macOS security prompts before deciding whether to run this development build.'];
  } else if (state.platform === 'windows') {
    introduction = 'The current Windows installer targets Intel and AMD x64 systems. A Windows ARM64 installer is not published.';
    instructions = ['Check your system type in Settings, System, About. Select the x64 installer for a compatible machine.', 'Download the .exe and compare its SHA-256 checksum in PowerShell.', 'Run the installer, review its prompts, and open span from the Start menu. Signing and native installation on every target remain under verification.'];
  } else if (state.format === 'appimage') {
    introduction = 'The AppImage targets Linux x64 systems. Check the release notes for distribution requirements and known limitations.';
    instructions = ['Download the AppImage and compare its SHA-256 checksum.', 'In the download folder, make the file executable:', 'Launch the AppImage from the same folder. If it does not start, check the release notes and your distribution requirements.'];
  } else {
    introduction = 'Use the Debian package on a compatible Debian or Ubuntu x64 system. Other distributions can try the AppImage.';
    instructions = ['Download the .deb and compare its SHA-256 checksum.', 'Install the local package from your download folder:', 'Open span from your application menu. Review any dependency or platform limitations in the release notes.'];
  }
  $('install-introduction').textContent = introduction;
  for (const [index, text] of instructions.entries()) {
    const item = element('li', '', text);
    if (state.platform === 'linux' && selectedAsset && index === 1) {
      item.append(document.createElement('br'), element('code', '', state.format === 'appimage' ? `chmod +x "${selectedAsset.name}"` : `sudo apt install "./${selectedAsset.name}"`));
    }
    if (state.platform === 'linux' && selectedAsset && state.format === 'appimage' && index === 2) item.append(document.createElement('br'), element('code', '', `./"${selectedAsset.name}"`));
    steps.append(item);
  }
}
$('use-nightly').addEventListener('click', () => {
  state.channel = 'nightly';
  render();
  updateUrl();
  channelSelect.trigger.focus();
  announce('Nightly downloads selected.');
});
async function copyValue(value, label) {
  if (!value) return;
  let message;
  let failed = false;
  try { await navigator.clipboard.writeText(value); message = `${label} copied.`; }
  catch { failed = true; message = `Copy failed. Select the ${label.toLowerCase()} text and copy it manually.`; }
  announce(message);
  $('copy-feedback').textContent = message;
  $('copy-feedback').classList.toggle('failed', failed);
  $('copy-feedback').hidden = false;
  clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = setTimeout(() => { $('copy-feedback').hidden = true; }, 3500);
}
$('copy-sha').addEventListener('click', () => copyValue(selectedAsset?.digest?.slice(7), 'SHA-256 checksum'));
$('copy-command').addEventListener('click', () => copyValue(selectedAsset && verificationCommand(selectedAsset), 'Verification command'));
loadReleaseData(releases => {
  state.releases = releases;
  render();
});
