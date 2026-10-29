import { expect, test, type Page } from '@playwright/test';
import { modifier, openFile, ready } from './helpers';

async function setSidebarWidth(page: Page, name: string, width: number, reverse = false) {
  const handle = page.getByRole('separator', { name, exact: true });
  const current = Number(await handle.getAttribute('aria-valuenow'));
  const grip = handle.locator('.panel-rail-grip');
  const box = (await grip.boundingBox())!;
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + (width - current) * (reverse ? -1 : 1), y);
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', String(width));
}
async function prepared(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 }); await ready(page);
  await setSidebarWidth(page, 'Resize project panel', 328);
  await setSidebarWidth(page, 'Resize AI Assistant panel', 328, true);
}
async function centerWidth(page: Page, factor = 1) {
  return (await page.locator('.center-area').boundingBox())!.width / factor;
}

for (const width of [1280, 1352]) {
  test(`keeps a usable editor and terminal with both remembered sidebars at ${width}px and zoom three`, async ({ page }, info) => {
    await prepared(page, width);
    await openFile(page, 'README.md');
    const terminal = page.getByRole('separator', { name: 'Resize terminal panel', exact: true });
    for (let index = 0; index < 8; index++) await terminal.press('Shift+ArrowUp');
    await page.evaluate(async () => { const zoom = await import('/src/lib/zoom.ts'); await zoom.applyWindowZoom(1.728); });
    await expect.poll(() => centerWidth(page, 1.728)).toBeGreaterThanOrEqual(319.5);
    await expect(page.getByRole('button', { name: 'Toggle AI Assistant panel', exact: true })).toHaveAttribute('aria-pressed', 'false');
    const restore = page.getByRole('separator', { name: 'Restore AI Assistant panel', exact: true });
    await expect(restore).toBeVisible();
    expect(await page.locator('#panel-handle-tooltip-right').textContent()).toContain('Hidden to keep the editor usable');
    const groups = (await page.locator('.editor-groups').boundingBox())!;
    expect(groups.height / 1.728).toBeGreaterThanOrEqual(199);
    const bottom = (await page.locator('.run-bottom-panel').boundingBox())!;
    const main = (await page.locator('.workbench-main').boundingBox())!;
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(main.y + main.height + 1);
    expect(bottom.y + bottom.height).toBeLessThanOrEqual((await page.locator('.statusbar').boundingBox())!.y + 1);
    await page.getByRole('radio', { name: 'Source and preview', exact: true }).click();
    const source = page.locator('.editor-document').filter({ visible: true }).locator('.source-view .cm-scroller').first();
    expect((await source.boundingBox())!.height / 1.728).toBeGreaterThanOrEqual(100);
    await page.getByRole('textbox', { name: 'Edit README.md', exact: true }).focus();
    await page.mouse.move(5, 5);
    await page.screenshot({ path: info.outputPath(`usable-center-${width}-zoom3.png`) });
  });
}

test('one restore click changes narrow-panel priority and widening restores both stored widths', async ({ page }, info) => {
  await prepared(page, 1352);
  await page.evaluate(async () => { const zoom = await import('/src/lib/zoom.ts'); await zoom.applyWindowZoom(1.728); });
  await page.getByRole('separator', { name: 'Restore AI Assistant panel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Toggle AI Assistant panel', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Toggle project panel', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(await centerWidth(page, 1.728)).toBeGreaterThanOrEqual(319.5);
  await page.screenshot({ path: info.outputPath('assistant-priority-zoom3.png') });
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect(page.getByRole('separator', { name: 'Resize project panel', exact: true })).toHaveAttribute('aria-valuenow', '328');
  await expect(page.getByRole('separator', { name: 'Resize AI Assistant panel', exact: true })).toHaveAttribute('aria-valuenow', '328');
  await page.setViewportSize({ width: 1352, height: 900 });
  await expect(page.getByRole('separator', { name: 'Restore project panel', exact: true })).toBeVisible();
  await page.keyboard.press(`${modifier}+0`);
  await expect(page.getByRole('separator', { name: 'Resize project panel', exact: true })).toHaveAttribute('aria-valuenow', '328');
  await expect(page.getByRole('separator', { name: 'Resize AI Assistant panel', exact: true })).toHaveAttribute('aria-valuenow', '328');
});

test('uses the same budgets with a reduced native-shaped layout viewport', async ({ page }, info) => {
  await prepared(page, 1352);
  await page.setViewportSize({ width: 782, height: 521 });
  await expect.poll(() => centerWidth(page)).toBeGreaterThanOrEqual(319.5);
  expect((await page.locator('.explorer-panel').boundingBox())!.width).toBeCloseTo(328, 0);
  await expect(page.getByRole('separator', { name: 'Restore AI Assistant panel', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('native-shaped-viewport.png') });
});

test('restores tools as dismissible overlays only when even one docked panel cannot fit', async ({ page }, info) => {
  await prepared(page, 1280);
  await page.evaluate(async () => { const zoom = await import('/src/lib/zoom.ts'); await zoom.applyWindowZoom(1.2 ** 5); });
  await expect(page.getByRole('separator', { name: 'Restore project panel', exact: true })).toBeVisible();
  await page.getByRole('separator', { name: 'Restore AI Assistant panel', exact: true }).click();
  await expect(page.locator('.assistant-panel')).toHaveClass(/sidebar-overlay/);
  expect(await centerWidth(page, 1.2 ** 5)).toBeGreaterThanOrEqual(319.5);
  await page.screenshot({ path: info.outputPath('maximum-zoom-tool-overlay.png') });
  await page.getByRole('button', { name: 'Toggle AI Assistant panel', exact: true }).click();
  await expect(page.locator('.assistant-panel')).toBeHidden();
  await page.keyboard.press(`${modifier}+0`);
  await expect(page.locator('.assistant-panel')).toBeHidden();
});


test('keeps the focused sidebar visible when zooming and opens Explorer from Uploads with one click', async ({ page }) => {
  await prepared(page, 1352);
  await page.locator('.assistant-panel button:not([disabled])').first().focus();
  await page.getByRole('button', { name: 'Uploads', exact: true }).click();
  // Uploads uses the center, so focusing the assistant still leaves its Explorer action available.
  await page.locator('.assistant-panel button:not([disabled])').first().focus();
  await page.evaluate(async () => { const zoom = await import('/src/lib/zoom.ts'); await zoom.applyWindowZoom(1.728); });
  await expect(page.getByRole('button', { name: 'Toggle AI Assistant panel', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Explorer', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Project', exact: true })).toBeVisible();
  await expect(page.locator('.uploads-view-layer')).toHaveCount(0);
  expect(await centerWidth(page, 1.728)).toBeGreaterThanOrEqual(319.5);
});
