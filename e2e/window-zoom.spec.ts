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
