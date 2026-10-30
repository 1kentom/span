import { expect, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const modifier = process.platform === "darwin" ? "Meta" : "Control";
/** Hover scale of the panel resize grip (`""`) or of its dots (`" i"`), read from panel-handle.css so the specs follow the grip geometry instead of repeating it. */
export function gripHoverScale(part: "" | " i"): number {
  const css = readFileSync(resolve(__dirname, "../ui/src/styles/panel-handle.css"), "utf8");
  const start = css.indexOf(`.panel-handle:hover .panel-rail-grip${part},`);
  const scale = css.slice(start, css.indexOf("}", start)).match(/transform:\s*scale\(([\d.]+)\)/)?.[1];
  if (start < 0 || !scale) throw new Error(`no hover scale for .panel-rail-grip${part} in panel-handle.css`);
  return Number(scale);
}
/** The computed `transform` of a uniform scale. */
export const scaleMatrix = (scale: number) => `matrix(${scale}, 0, 0, ${scale}, 0, 0)`;
export async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true })).toBeVisible();
  await expect(page.getByText("Browser preview", { exact: true })).toBeVisible();
}
export async function openFile(page: Page, path: string) {
  await page.getByRole("button", { name: "Open quick open", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Goto", exact: true });
  await dialog.getByRole("combobox", { name: "Find a file", exact: true }).fill(path);
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await dialog.getByRole("option").click();
  await expect(dialog).toBeHidden();
}
export async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator(".settings-page")).toBeVisible();
}
export async function closeAllTabs(page: Page) {
  const tabs = page.locator(".editor-tabs").getByRole("button", { name: /^Close / });
  while (await tabs.count()) await tabs.first().click();
  await expect(page.locator(".editor-empty").first()).toBeVisible();
}
export async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, { path, contentType: "image/png" });
}
