const { test, expect } = require('@playwright/test');
const manifest = require('../releases.json');
const release = manifest[0];
const installers = release.assets.filter(asset => /\.(dmg|exe|deb|AppImage)$/i.test(asset.name));
const clone = value => JSON.parse(JSON.stringify(value));
async function api(page, response = null) {
  await page.route('https://api.github.com/**', route => route.fulfill({ status: response === null ? 403 : 200, contentType: 'application/json', body: JSON.stringify(response || { message: 'rate limited' }) }));
}
async function localFeed(page, releases) {
  await page.route('**/releases.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(releases) }));
}

test('changelog renders the current verified manifest as readable notes during API failure', async ({ page }) => {
  await api(page); await page.goto('/changelog/');
  await expect(page.locator('h1')).toHaveText('Taking shape.');
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://span.kentom.co.ke/changelog/');
  await expect(page.locator('meta[name=description]')).toHaveAttribute('content', /changes, known limitations/);
  await expect(page.locator('.release-entry')).toHaveCount(manifest.length);
  const latest = page.locator('.release-entry').first();
  await expect(latest.locator('h2')).toHaveText(release.name);
  await expect(latest.locator('time')).toHaveAttribute('datetime', release.published_at);
  await expect(latest.locator('.release-channel')).toHaveText('Nightly');
  await expect(latest.locator('.release-full-notes')).toHaveAttribute('open', '');
  await expect(latest.locator('.release-note-content h4')).toContainText(['Added', 'Changed', 'Fixed', 'Known limitations']);
  expect(await latest.locator('.release-note-content li').count()).toBeGreaterThan(5);
  await expect(latest.getByRole('link', { name: 'Release and checksums on GitHub' })).toHaveAttribute('href', release.html_url);
  expect(await latest.locator('.release-entry-summary').innerText()).not.toMatch(/^#|Channel:|`/);
  await latest.locator('summary').click(); await expect(latest.locator('.release-full-notes')).not.toHaveAttribute('open');
  await page.locator('#release-index a').first().click();
  await expect(latest).toBeFocused(); await expect(latest.locator('.release-full-notes')).toHaveAttribute('open', '');
});

test('release Markdown keeps code and formatting while rejecting active HTML, images and unsafe URLs', async ({ page }) => {
  const fixture = clone(release);
  fixture.body = '# Release\n\n### Added\n\n- **Real bold** and `inline code`\n- [Safe documentation](https://github.com/1kentom/span)\n- [Unsafe JS](javascript:alert(1))\n- [Unsafe data](data:text/html,hello)\n- [Unsafe HTTP](http://example.invalid)\n- ![Tracking image](https://example.invalid/pixel.png)\n\n> A *quoted* note.\n\n```sh\nprintf "日本語🌱"\n<script>window.injected = true</script>\n<!-- keep this code comment -->\n```\n\n<img src=x onerror="window.injected=true"><iframe src="https://example.invalid"></iframe>\n\n<!-- private editorial comment -->';
  await localFeed(page, [fixture]); await api(page); await page.goto('/changelog/');
  const notes = page.locator('.release-note-content');
  await expect(notes.locator('strong')).toHaveText('Real bold');
  await expect(notes.locator('blockquote em')).toHaveText('quoted');
  await expect(notes.locator('pre code')).toContainText('printf "日本語🌱"');
  await expect(notes.locator('pre code')).toContainText('<script>');
  await expect(notes.locator('pre code')).toContainText('<!-- keep this code comment -->');
  await expect(notes.locator('a')).toHaveCount(1);
  await expect(notes.locator('a')).toHaveAttribute('href', 'https://github.com/1kentom/span');
  await expect(notes.locator('img,script,iframe')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await expect(notes).not.toContainText('private editorial comment');
});

test('partial and older API metadata cannot delete verified installers, hashes or channel heads', async ({ page }) => {
  const partial = clone(release); partial.assets = [partial.assets.find(asset => /\.dmg$/.test(asset.name))]; partial.body = '';
  const older = clone(release); older.tag_name = 'v0.1.0-nightly.test-older'; older.html_url = `https://github.com/1kentom/span/releases/tag/${older.tag_name}`; older.published_at = '2025-01-01T00:00:00Z'; older.assets = [];
  await api(page, [partial, older]); await page.goto('/download/');
  await expect(page.locator('.build-download')).toHaveCount(5);
  expect(new Set(await page.locator('.build-download').evaluateAll(nodes => nodes.map(node => node.href)))).toEqual(new Set(installers.map(asset => asset.browser_download_url)));
  for (const asset of installers) {
    const row = page.locator('.build-row').filter({ has: page.locator('.file-name', { hasText: asset.name }) });
    await row.locator('summary').click(); await expect(row.locator('.build-checksum')).toHaveText(asset.digest.slice(7));
  }
  await page.goto('/changelog/');
  await expect(page.locator('.release-entry')).toHaveCount(2);
  await expect(page.locator('.release-note-content').first()).toContainText('Known limitations');
});

test('a newer notes-only release does not replace the verified download', async ({ page }) => {
  const preview = clone(release); preview.tag_name = 'v0.1.0-preview.test'; preview.name = 'Preview notes fixture'; preview.html_url = `https://github.com/1kentom/span/releases/tag/${preview.tag_name}`; preview.published_at = '2030-01-01T00:00:00Z'; preview.assets = [];
  await api(page, [preview]); await page.goto('/download/');
  await expect(page.locator('#release-version')).toContainText(release.tag_name);
  await expect(page.locator('.build-download')).toHaveCount(5);
  await page.goto('/'); await expect(page.locator('.home-release-line')).toContainText(release.tag_name);
});

test('homepage summaries and platform descriptions reflect the actual available assets', async ({ page }) => {
  const partial = clone(release); partial.assets = [partial.assets.find(asset => /aarch64.*\.dmg$/.test(asset.name))];
  await localFeed(page, [partial]); await api(page); await page.goto('/');
  await expect(page.locator('.home-platform')).toHaveCount(1);
  await expect(page.locator('.home-platform small')).toHaveText('Apple silicon (ARM64)');
  await expect(page.locator('.release-preview p')).not.toContainText('##');
  await page.locator('.release-preview .text-link').click();
  await expect(page).toHaveURL(new RegExp(`/changelog/#release-${release.tag_name.replaceAll('.', '\\.')}$`));
  await expect(page.locator('.release-entry').first()).toBeFocused();
});

for (const width of [320, 390, 1440]) {
  test(`changelog wraps long versions and code at ${width}px with keyboard channel filtering`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = clone(release); fixture.body += '\n\n```text\n' + 'long-value-'.repeat(80) + '\n```';
    await localFeed(page, [fixture]); await api(page); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/changelog/'); await expect(page.locator('.release-entry')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const channel = page.getByRole('combobox', { name: 'Release channel', exact: true });
    await channel.focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await expect(page.locator('#history-empty')).toBeVisible(); await expect(page.locator('.release-entry')).toHaveCount(0);
    await expect(page.locator('#history-empty-description')).toContainText('Stable release notes are not published');
    await expect(channel).toBeFocused(); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    await expect(page.locator('.release-entry')).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

test('empty, malformed and unavailable history retains GitHub links, including without JavaScript', async ({ page, browser }) => {
  await localFeed(page, [{ ...release, html_url: 'javascript:alert(1)' }, { ...release, tag_name: 123, html_url: 'https://github.com/1kentom/span/releases/tag/123' }]); await api(page); await page.goto('/changelog/');
  await expect(page.locator('#history-empty')).toBeVisible(); await expect(page.locator('.release-entry')).toHaveCount(0);
  await expect(page.locator('#history-empty a')).toHaveAttribute('href', 'https://github.com/1kentom/span/releases');
  const context = await browser.newContext({ javaScriptEnabled: false }); const fallback = await context.newPage();
  await fallback.goto('http://127.0.0.1:1431/changelog/');
  await expect(fallback.locator('noscript a')).toHaveAttribute('href', 'https://github.com/1kentom/span/releases');
  await expect(fallback.locator('#history-loading')).toBeHidden(); await context.close();
});
