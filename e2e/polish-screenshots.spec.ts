import { expect, test } from "@playwright/test";
import { closeAllTabs, openFile, openSettings, ready, screenshot } from "./helpers";

test("the empty editor welcome is left aligned and honors reduced motion", async ({ page }) => {
  await ready(page);
  await closeAllTabs(page);
  const welcome = page.locator(".editor-empty").first();
  const logo = welcome.locator(".animated-logo");
  await expect(logo).toBeVisible();
  const artwork = logo.locator("img");
  await expect.poll(() => artwork.evaluate(img => getComputedStyle(img).animationName)).toBe("span-logo-drift");
  const logoBox = await logo.boundingBox();
  const actionBox = await welcome.getByRole("button", { name: /Open a file/ }).boundingBox();
  expect(Math.abs(logoBox!.x - actionBox!.x)).toBeLessThan(4);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => artwork.evaluate(img => getComputedStyle(img).animationName)).toBe("none");
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 2048, height: 1222 }]) {
  test(`polish screenshots ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await ready(page);
    await openSettings(page);
    await expect(page.getByRole("radio", { name: "Dark theme", exact: true })).toBeVisible();
    await screenshot(page, testInfo, `settings-${viewport.width}x${viewport.height}`);
    await page.getByRole("button", { name: "Close Settings", exact: true }).click();
    await openFile(page, "README.md");
    await expect(page.getByRole("region", { name: "Markdown preview", exact: true })).toBeVisible();
    await screenshot(page, testInfo, `markdown-${viewport.width}x${viewport.height}`);
    await openFile(page, "assets/span-sample.png");
    const image = page.getByRole("region", { name: "Preview of span-sample.png", exact: true }).getByRole("img", { name: "span-sample.png", exact: true });
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
    await screenshot(page, testInfo, `image-${viewport.width}x${viewport.height}`);
    await openFile(page, "assets/span-sample.svg");
    const svg = page.getByRole("region", { name: "Preview of span-sample.svg", exact: true }).getByRole("img", { name: "span-sample.svg", exact: true });
    await expect.poll(() => svg.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(128);
    await screenshot(page, testInfo, `svg-${viewport.width}x${viewport.height}`);
    await closeAllTabs(page);
    await expect(page.locator(".editor-empty .animated-logo")).toBeVisible();
    await screenshot(page, testInfo, `welcome-${viewport.width}x${viewport.height}`);
  });
}
