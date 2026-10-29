import { expect, test } from "@playwright/test";
import { modifier, openSettings, ready } from "./helpers";

test("window zoom scales the whole workbench and persists independently of font preferences", async ({ page }) => {
  await ready(page);
  const project = page.getByRole("complementary", { name: "Project", exact: true });
  const editorLine = page.locator(".editor-document").filter({ visible: true }).locator(".cm-line").first();
  const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
  const initial = { panel: (await project.boundingBox())!.width, line: (await editorLine.boundingBox())!.height, button: (await settingsButton.boundingBox())!.height };
  await page.keyboard.press(`${modifier}+=`);
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.style.zoom))).toBeCloseTo(1.2, 5);
  await expect.poll(async () => (await project.boundingBox())!.width / initial.panel).toBeCloseTo(1.2, 2);
  await expect.poll(async () => (await editorLine.boundingBox())!.height / initial.line).toBeCloseTo(1.2, 2);
  await expect.poll(async () => (await settingsButton.boundingBox())!.height / initial.button).toBeCloseTo(1.2, 2);
  await expect.poll(async () => (await page.locator(".ide").boundingBox())!.height).toBeCloseTo(900, 0);
  expect(await page.locator(".span-editor").first().evaluate(element => getComputedStyle(element).getPropertyValue("--editor-font-size").trim())).toBe("13px");
  expect(await page.evaluate(() => localStorage.getItem("span:window.zoomLevel"))).toBe("1");

  await openSettings(page);
  const search = page.getByRole("searchbox", { name: "Search settings", exact: true });
  const scaledSearchHeight = (await search.boundingBox())!.height;
  await page.keyboard.press(`${modifier}+0`);
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.style.zoom))).toBe(1);
  expect(scaledSearchHeight / (await search.boundingBox())!.height).toBeCloseTo(1.2, 2);
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Editor font size", exact: true })).toHaveValue("13");

  await page.keyboard.press(`${modifier}+=`);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.style.zoom))).toBeCloseTo(1.2, 5);
  await page.keyboard.press(`${modifier}+0`);
  await expect.poll(async () => (await project.boundingBox())!.width).toBeCloseTo(initial.panel, 1);
  await page.keyboard.press(`${modifier}+-`);
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.style.zoom))).toBeCloseTo(1 / 1.2, 5);
  await expect.poll(async () => (await project.boundingBox())!.width / initial.panel).toBeCloseTo(1 / 1.2, 2);
  await expect.poll(async () => (await page.locator(".ide").boundingBox())!.height).toBeCloseTo(900, 0);
  await page.keyboard.press(`${modifier}+0`);
});


for (const factor of [1.728, 2, 1.2 ** 5]) {
  test(`keeps editor and terminal inside the viewport at ${factor} CSS zoom and resizes panels in logical pixels`, async ({ page }, testInfo) => {
    await ready(page);
    await page.evaluate(async factor => { const zoom = await import("/src/lib/zoom.ts"); await zoom.applyWindowZoom(factor); }, factor);
    const center = page.locator(".center-area");
    await expect.poll(async () => (await center.boundingBox())!.width).toBeGreaterThan(100);
    const viewport = page.viewportSize()!;
    for (const selector of [".ide", ".workbench-main", ".center-area", ".run-bottom-panel", ".statusbar"]) {
      const bounds = (await page.locator(selector).boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
    }
    const mainBounds = (await page.locator(".workbench-main").boundingBox())!;
    const terminalBounds = (await page.locator(".run-bottom-panel").boundingBox())!;
    expect(terminalBounds.y + terminalBounds.height).toBeLessThanOrEqual(mainBounds.y + mainBounds.height + 1);
    const handle = page.getByRole("separator", { name: "Resize project panel", exact: true });
    const logicalWidth = await page.locator(".workbench-main").evaluate(node => node.clientWidth);
    expect(Number(await handle.getAttribute("aria-valuemax"))).toBeCloseTo(logicalWidth * .42, 1);
    // Drag inward to stay below the responsive width cap.
    const before = Number(await handle.getAttribute("aria-valuenow"));
    const grip = handle.locator(".panel-rail-grip"); await grip.hover();
    const box = (await grip.boundingBox())!; const x = box.x + box.width / 2; const y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 40, y, { steps: 5 }); await page.mouse.up();
    await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeCloseTo(before - 40 / factor, 0);
    await page.screenshot({ path: testInfo.outputPath(`workbench-zoom${factor}.png`) });
  });
}


test("keeps an expanded terminal above the status bar in a small window at maximum zoom", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 600 }); await ready(page);
  const divider = page.getByRole("separator", { name: "Resize terminal panel", exact: true });
  for (let index = 0; index < 8; index++) await divider.press("Shift+ArrowUp");
  await page.evaluate(async () => { const zoom = await import("/src/lib/zoom.ts"); await zoom.applyWindowZoom(1.2 ** 5); });
  await expect.poll(async () => (await page.locator(".ide").boundingBox())!.height).toBeCloseTo(600, 0);
  const main = (await page.locator(".workbench-main").boundingBox())!;
  const terminal = (await page.locator(".run-bottom-panel").boundingBox())!;
  const editor = (await page.locator(".editor-groups").boundingBox())!;
  expect(terminal.y + terminal.height).toBeLessThanOrEqual(main.y + main.height + 1);
  expect(editor.height / (1.2 ** 5)).toBeGreaterThanOrEqual(99.5);
  expect((await page.locator(".statusbar").boundingBox())!.y).toBeGreaterThanOrEqual(terminal.y + terminal.height - 1);
  await page.screenshot({ path: testInfo.outputPath("small-workbench-max-zoom.png") });
});
