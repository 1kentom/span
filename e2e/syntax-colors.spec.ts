import { expect, test, type Page } from "@playwright/test";
import { openSettings, ready } from "./helpers";

// Browser preview only: the preview settings fixture stands in for the native settings store.
const editorToken = (page: Page) => page.locator(".span-editor:not(.syn-preview) .cm-line", { hasText: "from './rpc'" }).locator("span").filter({ hasText: /^'\.\/rpc'$/ }).last();
const color = (locator: ReturnType<Page["locator"]>) => locator.evaluate(element => getComputedStyle(element).color);

test("changing the import path color recolors the editor immediately and reset restores it", async ({ page }) => {
  await ready(page);
  await expect(editorToken(page)).toBeVisible();
  const original = await color(editorToken(page));
  expect(original).not.toBe("rgb(255, 0, 0)");

  await openSettings(page);
  await page.getByRole("button", { name: "Syntax colors", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Syntax colors", exact: true })).toBeVisible();
  const hex = page.getByRole("textbox", { name: "Hex color for Import path", exact: true });
  await hex.fill("#ff0000");

  // The live preview updates before anything is saved, through the editor's own highlight classes.
  const previewToken = page.locator(".syn-preview .cm-line", { hasText: "import javafx.fxml.FXML;" }).locator("span").filter({ hasText: /^javafx\.fxml$/ }).last();
  await expect(previewToken).toBeVisible();
  await expect.poll(() => color(previewToken)).toBe("rgb(255, 0, 0)");

  await hex.press("Enter");
  await expect(page.locator('[data-token="importPath"] .syn-marker', { hasText: "Customized" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--syn-importPath"))).toBe("#ff0000");

  // An invalid value shows an inline error and is not saved.
  await hex.fill("red");
  await expect(page.locator('[data-token="importPath"] [role="alert"]')).toContainText("#rgb, #rrggbb or #rrggbbaa");
  await hex.press("Enter");
  await expect(page.locator('[data-token="importPath"] .syn-marker', { hasText: "Customized" })).toBeVisible();
  await hex.press("Escape");
  await expect(hex).toHaveValue("#ff0000");

  await page.getByRole("tab", { name: "rpc-node.ts", exact: true }).click();
  await expect(editorToken(page)).toBeVisible();
  await expect.poll(() => color(editorToken(page))).toBe("rgb(255, 0, 0)");

  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Reset import path color", exact: true }).click();
  await expect(page.locator('[data-token="importPath"] .syn-marker')).toHaveCount(0);
  await page.getByRole("tab", { name: "rpc-node.ts", exact: true }).click();
  await expect.poll(() => color(editorToken(page))).toBe(original);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--syn-importPath"))).toBe("");
});
