import { expect, test, type Page } from "@playwright/test";
import { modifier, openFile, ready, screenshot } from "./helpers";

/**
 * Browser preview only. The definition answer is the labelled jdt: fixture in navigation-preview.ts, shaped like
 * the JDT LS class file URI of the bug report. It proves the click routing and the viewer, not a real server.
 */
async function openController(page: Page) {
  await ready(page);
  await openFile(page, "src/hover-sample/Controller.java");
  await expect(page.getByRole("textbox", { name: "Edit Controller.java", exact: true })).toBeVisible();
}

/** Centre of the first occurrence of `word` in the visible editor, found with a DOM range so it follows real layout. */
async function wordPoint(page: Page, word: string) {
  const point = await page.evaluate(word => {
    const content = [...document.querySelectorAll(".cm-content")].find(item => (item as HTMLElement).offsetParent !== null)!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf(word);
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + word.length);
      const box = range.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  }, word);
  expect(point, `"${word}" is visible`).not.toBeNull();
  return point!;
}

async function clickWith(page: Page, word: string, keys: string[]) {
  const point = await wordPoint(page, word);
  await page.mouse.move(point.x, point.y);
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.click(point.x, point.y);
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
}

test("Cmd/Ctrl+click on a library class opens the read-only viewer and shows no error", async ({ page }, testInfo) => {
  await openController(page);
  await clickWith(page, "ComboBox", [modifier]);
  const viewer = page.getByRole("region", { name: "Read-only library source" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByText("Read-only library source", { exact: true })).toBeVisible();
  await expect(viewer.locator(".nav-library-name")).toHaveText("javafx.scene.control/ComboBox.java");
  await expect(viewer.locator(".nav-library-name")).toHaveAttribute("title", /^jdt:\/\/contents\/javafx-controls-21\.0\.2-mac-aarch64\.jar\//);
  await expect(viewer.locator(".nav-library-origin")).toHaveText("javafx-controls-21.0.2-mac-aarch64.jar");
  await expect(viewer.locator(".cm-content")).toContainText("public class ComboBox<T>");
  await expect(viewer.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".error-toast")).toHaveCount(0);
  await screenshot(page, testInfo, "library-viewer");
  if (process.env.LIB_VIEWER_SHOT) await page.screenshot({ path: process.env.LIB_VIEWER_SHOT });
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(page.locator(".error-toast")).toHaveCount(0);
});

test("Cmd/Ctrl+Alt+click opens the library source to the side", async ({ page }) => {
  await openController(page);
  await clickWith(page, "ComboBox", [modifier, "Alt"]);
  const viewer = page.getByRole("region", { name: "Read-only library source" });
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute("data-side", "true");
  expect((await viewer.boundingBox())!.x).toBeGreaterThan(400);
  await expect(page.locator(".error-toast")).toHaveCount(0);
});
