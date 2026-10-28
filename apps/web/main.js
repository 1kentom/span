const menu = document.querySelector('.menu');
const navigation = document.querySelector('#main-nav');
const closeMenu = () => {
  navigation.classList.remove('open');
  menu.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-label', 'Open navigation');
};
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  navigation.classList.toggle('open', open);
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
});
navigation.addEventListener('click', (event) => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && navigation.classList.contains('open')) {
    closeMenu();
    menu.focus();
  }
});
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
  sectionLinks.forEach((link) => observer.observe(document.querySelector(link.hash)));
}

// Published GitHub releases progressively enhance the source-build baseline.
// Missing releases, network failures, and rate limits leave that baseline intact.
async function loadPublishedReleases() {
  try {
    const response = await fetch('https://api.github.com/repos/1kentom/span/releases?per_page=3', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return;
    const releases = await response.json();
    if (!Array.isArray(releases)) return;
    const officialUrl = (value, asset = false) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'github.com' &&
          url.pathname.startsWith('/1kentom/span/releases/') &&
          (!asset || url.pathname.startsWith('/1kentom/span/releases/download/'));
      } catch { return false; }
    };
    const published = releases.filter(release => !release.draft && officialUrl(release.html_url));
    const changelog = document.querySelector('#published-changelog');
    for (const release of published) {
      const article = document.createElement('article');
      article.className = 'published-release';
      const badge = document.createElement('span');
      badge.className = 'status';
      badge.textContent = release.prerelease ? 'Prerelease' : 'Published release';
      const heading = document.createElement('h3');
      heading.textContent = release.name || release.tag_name;
      const description = document.createElement('p');
      description.textContent = (release.body || 'See the release notes on GitHub.').slice(0, 500);
      const link = document.createElement('a');
      link.className = 'text-link';
      link.href = release.html_url;
      link.textContent = 'Read release notes on GitHub';
      article.append(badge, heading, description, link);
      changelog.append(article);
    }
    const latest = published[0];
    const assets = latest?.assets?.filter(asset => officialUrl(asset.browser_download_url, true) &&
      /\.(dmg|exe|msi|deb|rpm|appimage|tar\.gz|zip)$/i.test(asset.name));
    if (!assets?.length) return;
    document.querySelector('.download > div > p').textContent = 'Prefer to build it yourself? The current source and build instructions are available on GitHub. Read each published release for platform support, signing status, and known limitations.';
    const card = document.createElement('article');
    card.className = 'published-release';
    const heading = document.createElement('h3');
    heading.textContent = `${latest.name || latest.tag_name} on GitHub Releases`;
    const description = document.createElement('p');
    description.textContent = 'These files are published by the project. Read their release notes for platform support, signing status, and known limitations.';
    const links = document.createElement('div');
    links.className = 'actions';
    for (const asset of assets) {
      const link = document.createElement('a');
      link.className = 'button outline';
      link.href = asset.browser_download_url;
      link.textContent = asset.name;
      links.append(link);
    }
    card.append(heading, description, links);
    document.querySelector('#published-downloads').append(card);
  } catch {
    // The source-build instructions remain available without the GitHub API.
  }
}
loadPublishedReleases();
