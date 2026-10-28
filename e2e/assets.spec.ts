import { expect, test, type Page } from '@playwright/test';

async function openSample(page: Page, filename: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open quick open', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Goto', exact: true });
  await dialog.getByRole('combobox', { name: 'Find a file' }).fill(filename);
  await dialog.getByRole('option', { name: new RegExp(filename.replaceAll('.', '\\.')) }).click();
}

test('sample PNG decodes through the image bridge with dimensions, zoom and transparency controls', async ({ page }) => {
  await openSample(page, 'span-sample.png');
  const preview = page.getByRole('region', { name: 'Preview of span-sample.png', exact: true });
  const image = preview.getByRole('img', { name: 'span-sample.png', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => [element instanceof HTMLImageElement && element.complete, (element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([true, 64, 48]);
  await expect(preview).toContainText('64 × 48 px');
  await expect(page.getByRole('tab', { name: 'span-sample.png', exact: true }).locator('.material-file-icon-dark')).toHaveAttribute('src', /image/);
  await expect(page.getByRole('textbox', { name: 'Edit span-sample.png', exact: true })).toHaveCount(0);
  await preview.getByRole('button', { name: 'Actual size', exact: true }).click();
  await expect(image).toHaveCSS('width', '64px');
  await preview.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(image).toHaveCSS('width', '80px');
  await preview.getByRole('combobox', { name: 'Image preview background', exact: true }).selectOption('light');
  await expect(preview.locator('.asset-preview-stage')).toHaveAttribute('data-background', 'light');
});

test('SVG remains editable in both view while its isolated preview blocks executable and external content', async ({ page }) => {
  const unexpectedRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('span-test-tracker.invalid')) unexpectedRequests.push(request.url()); });
  await openSample(page, 'span-sample.svg');
  const preview = page.getByRole('region', { name: 'Preview of span-sample.svg', exact: true });
  const image = preview.getByRole('img', { name: 'span-sample.svg', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([128, 96]);
  await page.getByRole('button', { name: 'Both', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit span-sample.svg', exact: true });
  await expect(editor).toBeVisible();
  await editor.focus();
  await editor.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.insertText('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><script>window.spanSvgExecuted=true</script><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject><image href="https://span-test-tracker.invalid/pixel"/><rect width="40" height="30" fill="red" onload="window.spanSvgExecuted=true"/></svg>');
  await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([40, 30]);
  await expect(preview.locator('svg,script,foreignObject')).toHaveCount(0);
  const isolated = await image.getAttribute('src');
  expect(decodeURIComponent(isolated || '')).not.toMatch(/<script|foreignObject|onload|span-test-tracker/);
  expect(await page.evaluate(() => 'spanSvgExecuted' in window)).toBe(false);
  expect(unexpectedRequests).toEqual([]);
});
