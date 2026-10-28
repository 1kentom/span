import { initializeNavigation } from './navigation.js';
import { loadReleaseData, installersFor, downloadRelease, platformDescription, formatDate, platformLabels, channelLabels } from './release-data.js';
import { releaseSummary, releaseId } from './release-notes.js';

initializeNavigation();
const sectionLinks = [...document.querySelectorAll('.section-nav a')];
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        sectionLinks.forEach((link) => {
          const active = link.hash === `#${entry.target.id}`;
          link.classList.toggle('active', active);
          if (active) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        });
      }
    }
  }, { rootMargin: '-15% 0px -45% 0px' });
  sectionLinks.forEach((link) => {
    const section = link.hash && document.getElementById(link.hash.slice(1));
    if (section) observer.observe(section);
  });
}


function renderPublishedReleases(releases) {
  if (!releases.length) return;
  const changelog = document.querySelector('#published-changelog');
  changelog.replaceChildren();
  for (const release of releases.slice(0, 3)) {
    const article = document.createElement('article');
    article.className = 'release-preview';
    const date = document.createElement('time');
    if (release.published_at) date.dateTime = release.published_at;
    date.textContent = formatDate(release.published_at);
    const content = document.createElement('div');
    const badge = document.createElement('span');
    badge.className = 'status';
    badge.textContent = release.prerelease ? 'Development prerelease' : 'Published release';
    const heading = document.createElement('h3');
    heading.textContent = release.name;
    const description = document.createElement('p');
    description.textContent = releaseSummary(release.body);
    const link = document.createElement('a');
    link.className = 'text-link';
    link.href = `/changelog/#${releaseId(release.tag_name)}`;
    link.textContent = 'Read release notes';
    content.append(badge, heading, description, link);
    article.append(date, content);
    changelog.append(article);
  }
  const latest = downloadRelease(releases);
  if (!latest) return;
  const container = document.querySelector('#published-downloads');
  container.replaceChildren();
  const line = document.createElement('div');
  line.className = 'home-release-line';
  const badge = document.createElement('span');
  badge.className = 'status';
  badge.textContent = `${channelLabels[latest.channel]}${latest.prerelease ? ' prerelease' : ''}`;
  const version = document.createElement('span');
  version.textContent = latest.tag_name;
  const date = document.createElement('span');
  date.textContent = `Published ${formatDate(latest.published_at)}`;
  line.append(badge, version, date);
  const summary = document.createElement('div');
  summary.className = 'home-download-summary';
  for (const platform of ['mac', 'windows', 'linux']) {
    if (!installersFor(latest, platform).length) continue;
    const link = document.createElement('a');
    link.className = 'home-platform';
    link.href = `/download/?platform=${platform}&channel=${latest.channel}`;
    const logo = document.createElement('img');
    Object.assign(logo, { src: `/assets/icons/${platform === 'mac' ? 'macos' : platform}.svg`, alt: '', className: 'platform-symbol', width: 25, height: 25 });
    const labels = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = platformLabels[platform];
    const detail = document.createElement('small');
    detail.textContent = platformDescription(latest, platform);
    labels.append(name, detail);
    const chevron = document.createElement('img');
    Object.assign(chevron, { src: '/assets/icons/arrow-right4.svg', alt: '', className: 'chevron', width: 16, height: 16 });
    link.append(logo, labels, chevron);
    summary.append(link);
  }
  if (summary.children.length) container.append(line, summary);
}
loadReleaseData(renderPublishedReleases);
