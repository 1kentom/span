import { initializeNavigation } from './navigation.js';
import { CustomSelect } from './custom-select.js';
import { loadReleaseData, channelLabels, formatDate } from './release-data.js';
import { releaseId, releaseSummary, renderReleaseNotes } from './release-notes.js';

initializeNavigation();
const byId = id => document.getElementById(id);
let releases = [];
let selectedChannel = 'all';
let observer;
let locatedHash = '';
function element(tag, className, text) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
new CustomSelect(byId('history-channel'), {
  label: 'Release channel', value: 'all',
  options: [{ value: 'all', label: 'All releases' }, ...Object.entries(channelLabels).map(([value, label]) => ({ value, label }))],
  onChange(value) { selectedChannel = value; render(); },
});
function focusRelease(id) {
  const article = document.getElementById(id);
  if (!article) return;
  const details = article.querySelector('details');
  if (details) details.open = true;
  article.focus({ preventScroll: true }); article.scrollIntoView({ block: 'start' });
}
function render() {
  const openNotes = new Map([...document.querySelectorAll('.release-full-notes')].map(node => [node.dataset.tag, node.open]));
  observer?.disconnect();
  const timeline = byId('release-timeline'); const index = byId('release-index');
  timeline.replaceChildren(); index.replaceChildren();
  const visible = releases.filter(release => selectedChannel === 'all' || release.channel === selectedChannel);
  byId('history-loading').hidden = true;
  byId('history-empty').hidden = visible.length > 0;
  byId('history-footer').hidden = visible.length === 0;
  byId('history-empty-description').textContent = releases.length
    ? `${channelLabels[selectedChannel] || 'These'} release notes are not published in this feed. Choose another channel or check GitHub Releases.`
    : 'The release feed could not be loaded. You can still read the published notes on GitHub.';
  byId('history-announcement').textContent = `${visible.length} ${visible.length === 1 ? 'release' : 'releases'} shown.`;
  for (const [position, release] of visible.entries()) {
    const id = releaseId(release.tag_name);
    const nav = element('a', 'release-index-link'); nav.href = `#${id}`;
    nav.append(element('span', '', release.tag_name.replace(/^v/, '')), element('small', '', channelLabels[release.channel]));
    nav.addEventListener('click', () => focusRelease(id)); index.append(nav);
    const article = element('article', 'release-entry'); article.id = id; article.tabIndex = -1;
    const meta = element('div', 'release-entry-meta');
    const date = element('time', '', formatDate(release.published_at));
    if (release.published_at) date.dateTime = release.published_at;
    meta.append(date, element('span', `release-channel release-channel-${release.channel}`, channelLabels[release.channel]));
    if (position === 0) meta.append(element('span', 'release-latest', 'Latest in this view'));
    const heading = element('h2', 'release-entry-title', release.name);
    const summary = element('p', 'release-entry-summary', releaseSummary(release.body));
    const actions = element('div', 'release-entry-actions');
    const source = element('a', 'text-link', 'Release and checksums on GitHub'); source.href = release.html_url;
    actions.append(source);
    const details = element('details', 'release-full-notes'); details.dataset.tag = release.tag_name;
    details.open = openNotes.has(release.tag_name) ? openNotes.get(release.tag_name) : position === 0;
    const disclosure = element('summary', '', 'Full release notes');
    const chevron = document.createElement('img');
    Object.assign(chevron, { src: '/assets/icons/arrow-down4.svg', alt: '', width: 17, height: 17, className: 'chevron' });
    disclosure.append(chevron);
    const notes = element('div', 'release-note-content');
    notes.append(renderReleaseNotes(release.body || 'Release notes were not included. Read the published release on GitHub.'));
    details.append(disclosure, notes);
    article.append(meta, heading, summary, actions, details); timeline.append(article);
  }
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      const active = entries.find(entry => entry.isIntersecting);
      if (!active) return;
      for (const link of index.children) {
        if (link.hash === `#${active.target.id}`) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    }, { rootMargin: '-5% 0px -65% 0px' });
    for (const article of timeline.children) observer.observe(article);
  }
  let hash;
  try { hash = decodeURIComponent(location.hash.slice(1)); } catch { hash = ''; }
  if (hash && hash !== locatedHash && document.getElementById(hash)) {
    // Revisit the requested version once the asynchronous feed creates its anchor.
    requestAnimationFrame(() => focusRelease(hash));
    locatedHash = hash;
  }
}
loadReleaseData(data => { releases = data; render(); });
window.addEventListener('hashchange', () => {
  try { locatedHash = decodeURIComponent(location.hash.slice(1)); focusRelease(locatedHash); } catch { /* Invalid fragments do not change the release selection. */ }
});
