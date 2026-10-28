const { test, expect } = require('@playwright/test');
const manifest = require('../releases.json');
const release = manifest.find(entry => /nightly/i.test(entry.tag_name));
const installers = release.assets.filter(asset => /\.(dmg|exe|deb|AppImage)$/i.test(asset.name));
const assetFor = suffix => installers.find(asset => asset.name.includes(suffix));
const macAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
async function apiLimited(page) {
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"rate limit exceeded"}' }));
}
async function choose(page, label, option) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('verified manifest survives API 403 with all five exact installers and hashes', async ({ page }) => {
  await apiLimited(page);
  await page.goto('/download/');
  await expect(page.locator('.build-download')).toHaveCount(5);
  expect(new Set(await page.locator('.build-download').evaluateAll(links => links.map(link => link.href)))).toEqual(new Set(installers.map(asset => asset.browser_download_url)));
  for (const asset of installers) {
    const row = page.locator('.build-row').filter({ has: page.locator('.file-name', { hasText: asset.name }) });
    await row.locator('summary').click();
    await expect(row.locator('.build-checksum')).toHaveText(asset.digest.slice(7));
  }
  await expect(page.locator('#checksum-file')).toHaveAttribute('href', release.assets.find(asset => asset.name === 'SHA256SUMS').browser_download_url);
  await expect(page.locator('#release-version')).toContainText(release.tag_name);
  await expect(page.locator('#release-date')).toContainText('2026');
  await expect(page.locator('#release-status')).toContainText('Development prerelease');
});

test('Mac Intel UA never selects a Mac chip and both explicit choices map exactly', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: macAgent });
  const page = await context.newPage();
  await apiLimited(page);
  await page.goto('/download/?platform=mac');
  await expect(page.getByRole('combobox', { name: 'Architecture', exact: true })).toHaveText('Choose your Mac chip');
  await expect(page.locator('#primary-download')).toBeHidden();
  await choose(page, 'Architecture', 'Apple silicon (ARM64)');
  await expect(page.locator('#primary-download')).toHaveAttribute('href', assetFor('aarch64-apple-darwin').browser_download_url);
  await expect(page.locator('#selected-sha')).toHaveText(assetFor('aarch64-apple-darwin').digest.slice(7));
  await choose(page, 'Architecture', 'Intel (x64)');
  await expect(page.locator('#primary-download')).toHaveAttribute('href', assetFor('x86_64-apple-darwin').browser_download_url);
  await expect(page.locator('#selected-meta')).toContainText(`${(assetFor('x86_64-apple-darwin').size / 1000000).toFixed(1)} MB`);
  await context.close();
});

test('shared selectors support keyboard, unpublished channels, Escape, Tab and outside click', async ({ page }) => {
  await apiLimited(page);
  await page.goto('/download/');
  const channel = page.getByRole('combobox', { name: 'Release channel', exact: true });
  await channel.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const preview = manifest.find(entry => !/nightly/i.test(entry.tag_name) && entry.prerelease);
  if (preview) {
    await expect(page.locator('#release-version')).toContainText(preview.tag_name);
    await expect(page.locator('#download-content')).toBeVisible();
  } else {
    await expect(page.locator('#channel-empty-title')).toHaveText('Preview is not published yet');
    await expect(page.locator('#download-content')).toBeHidden();
  }
  await expect(channel).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.locator('#channel-empty-title')).toHaveText('Stable is not published yet');
  await page.getByRole('button', { name: 'Show Nightly downloads' }).click();
  await expect(page.locator('#download-content')).toBeVisible();
  await channel.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(channel).toHaveText('Nightly');
  await expect(channel).toBeFocused();
  await channel.click();
  await page.keyboard.press('Tab');
  await expect(channel).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('combobox', { name: 'Operating system', exact: true })).toBeFocused();
  await channel.click();
  await page.locator('h1').click();
  await expect(channel).toHaveAttribute('aria-expanded', 'false');
  await channel.focus();
  await page.keyboard.press('s');
  await page.keyboard.press('Enter');
  await expect(page.locator('#channel-empty-title')).toHaveText('Stable is not published yet');
});

test('Windows and Linux selectors choose exact packages and matching verification commands', async ({ page }) => {
  await apiLimited(page);
  await page.goto('/download/?platform=windows');
  await expect(page.locator('#primary-download')).toHaveAttribute('href', assetFor('windows').browser_download_url);
  await expect(page.locator('#verify-command')).toContainText('Get-FileHash -Algorithm SHA256');
  await choose(page, 'Architecture', 'ARM64 Not published for this release');
  await expect(page.locator('#primary-download')).toBeHidden();
  await expect(page.locator('#selected-file')).toContainText('ARM64 installer is published');
  await choose(page, 'Operating system', 'Linux');
  await expect(page.locator('#primary-download')).toHaveAttribute('href', assetFor('.deb').browser_download_url);
  await expect(page.locator('#install-steps')).toContainText('sudo apt install');
  await choose(page, 'Package format', 'AppImage');
  await expect(page.locator('#primary-download')).toHaveAttribute('href', assetFor('.AppImage').browser_download_url);
  await expect(page.locator('#verify-command')).toContainText('sha256sum');
  await expect(page.locator('#install-steps')).toContainText('chmod +x');
});

test('copy controls report actual success and failure, and row guide selects its checksum', async ({ page }) => {
  await apiLimited(page);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copiedValue = value; } } }));
  await page.goto('/download/?platform=mac');
  const intel = assetFor('x86_64-apple-darwin');
  await page.locator('.build-row').filter({ has: page.locator('.file-name', { hasText: intel.name }) }).getByRole('button', { name: 'Use in installation guide' }).click();
  await expect(page.locator('#selected-sha')).toHaveText(intel.digest.slice(7));
  await page.getByRole('button', { name: 'Copy selected SHA-256 checksum' }).click();
  expect(await page.evaluate(() => window.copiedValue)).toBe(intel.digest.slice(7));
  await expect(page.locator('#download-announcement')).toHaveText('SHA-256 checksum copied.');
  await expect(page.locator('#copy-feedback')).toBeVisible();
  await expect(page.locator('#copy-feedback')).toHaveText('SHA-256 checksum copied.');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); }; });
  await page.getByRole('button', { name: 'Copy checksum verification command' }).click();
  await expect(page.locator('#download-announcement')).toContainText('Copy failed');
});

for (const width of [320, 390, 1440]) {
  test(`responsive download cards, expanded filenames and selectors at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await apiLimited(page);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/download/?platform=mac&arch=arm64');
    await expect(page.locator('.build-download')).toHaveCount(5);
    for (const summary of await page.locator('.build-details summary').all()) await summary.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    expect(errors).toEqual([]);
    if (width < 760) {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.locator('#main-nav')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.menu')).toHaveAttribute('aria-expanded', 'false');
    }
  });
}

test('empty metadata and API failure show safe source/release fallback', async ({ page }) => {
  await apiLimited(page);
  await page.route('**/releases.json', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.goto('/download/');
  await expect(page.locator('#release-unavailable')).toBeVisible();
  await expect(page.locator('#download-content')).toBeHidden();
  await expect(page.locator('.build-download')).toHaveCount(0);
  await expect(page.locator('#release-unavailable a').first()).toHaveAttribute('href', 'https://github.com/1kentom/span/releases');
});

test('external, mismatched and script asset URLs never become download links', async ({ page }) => {
  await apiLimited(page);
  const unsafe = JSON.parse(JSON.stringify(release));
  const original = installers[0];
  unsafe.assets.push({ ...original, browser_download_url: 'https://malicious.invalid/app.dmg' });
  unsafe.assets.push({ ...original, browser_download_url: 'javascript:alert(1)' });
  unsafe.assets.push({ ...original, browser_download_url: original.browser_download_url.replace(release.tag_name, 'some-other-tag') });
  unsafe.name = '<img src=x onerror=alert(1)>';
  await page.route('**/releases.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([unsafe]) }));
  await page.goto('/download/');
  await expect(page.locator('.build-download')).toHaveCount(5);
  expect(await page.locator('a').evaluateAll(links => links.some(link => /malicious.invalid|javascript:/.test(link.href)))).toBe(false);
  expect(await page.locator('img[onerror],script:not([src])').count()).toBe(0);
});

test('homepage links lead to the dedicated route and JavaScript-free fallback remains useful', async ({ page, browser }) => {
  await apiLimited(page);
  await page.goto('/');
  await expect(page.locator('.home-platform')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Download span', exact: true })).toHaveAttribute('href', '/download/');
  await page.getByRole('link', { name: 'Download span', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('Download span');
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', 'https://span.kentom.co.ke/download/');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const fallback = await context.newPage();
  await fallback.goto('http://127.0.0.1:1431/download/');
  await expect(fallback.locator('noscript .download-message')).toContainText('development builds');
  await expect(fallback.locator('noscript a')).toHaveAttribute('href', 'https://github.com/1kentom/span/releases');
  await context.close();
});
