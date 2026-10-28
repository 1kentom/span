import { expect, test, type Page } from "@playwright/test";
import { modifier, openFile, ready } from "./helpers";

const SHOTS = process.env.HOVER_SHOTS;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/hover-${name}.png` }); };

/** Centre of the first occurrence of `word` in the editor text, found with a DOM range so it follows real layout. */
async function wordPoint(page: Page, word: string, nth = 0) {
  const point = await page.evaluate(({ word, nth }) => {
    const walker = document.createTreeWalker([...document.querySelectorAll(".cm-content")].find(item => (item as HTMLElement).offsetParent !== null)!, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
        if (seen++ !== nth) continue;
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + word.length);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
    }
    return null;
  }, { word, nth });
  expect(point, `"${word}" is visible`).not.toBeNull();
  return point!;
}

async function openSample(page: Page, file: string) {
  await ready(page);
  await openFile(page, file);
  await expect(page.getByRole("textbox", { name: `Edit ${file.split("/").pop()}`, exact: true })).toBeVisible();
}

test("Java hover renders markdown, hides the synthetic project and offers the footer actions", async ({ page }) => {
  await openSample(page, "src/hover-sample/Controller.java");
  const initialize = await wordPoint(page, "initialize");
  await page.mouse.move(initialize.x, initialize.y);
  const hover = page.locator(".cm-lsp-hover");
  await expect(hover).toBeVisible();
  await expect(hover.locator(".cm-lsp-signature")).toHaveText("void com.kentom.todo.Controller.initialize()");
  await expect(hover).not.toContainText("jdt.ls-java-project");
  await expect(hover).not.toContainText("*");
  await expect(hover.locator(".cm-lsp-signature span[class*='syn-']").first()).toBeVisible();
  await expect(hover.getByRole("button", { name: /Go to Definition/ })).toContainText(modifier === "Meta" ? "Cmd+click" : "Ctrl+click");
  await expect(hover.getByRole("button", { name: /Peek Definition/ })).toContainText(/Alt\+F12|⌥F12/);
  await shot(page, "java-jdt");
  // The pointer may travel into the popup without it closing.
  const box = (await hover.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8, { steps: 8 });
  await page.waitForTimeout(700);
  await expect(hover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(hover).toBeHidden();
});

test("hovering a class with generics converts the HTML docs", async ({ page }) => {
  await openSample(page, "src/hover-sample/Controller.java");
  const point = await wordPoint(page, "ComboBox", 1);
  await page.mouse.move(point.x, point.y);
  const hover = page.locator(".cm-lsp-hover");
  await expect(hover.locator(".cm-lsp-signature")).toContainText("class javafx.scene.control.ComboBox<T>");
  await expect(hover.locator("strong")).toHaveText("ComboBox");
  await expect(hover.locator("li")).toHaveCount(2);
  await expect(hover.locator("a")).toHaveAttribute("href", "https://openjfx.io/");
  await expect(hover.locator("script, img")).toHaveCount(0);
  await shot(page, "java-combobox");
});

test("TypeScript hover shows docs and the problem at that position", async ({ page }) => {
  await openSample(page, "src/hover-sample/api.ts");
  const add = await wordPoint(page, "add", 1);
  await page.mouse.move(add.x, add.y);
  const hover = page.locator(".cm-lsp-hover");
  await expect(hover.locator(".cm-lsp-signature")).toContainText("function add(a: number, b: number): number");
  await expect(hover).toContainText("Adds two numbers.");
  await shot(page, "ts-function");
  await page.mouse.move(5, 5);
  await expect(hover).toBeHidden();
  const argument = await wordPoint(page, '"2"');
  await page.mouse.move(argument.x, argument.y);
  const problem = page.locator(".cm-lsp-diagnostic-error");
  await expect(problem).toContainText("not assignable to parameter of type 'number'");
  await expect(problem.locator(".cm-lsp-diagnostic-source")).toHaveText("ts (2345)");
  await shot(page, "ts-diagnostic");
});

test("the editor context menu leads with code intelligence and disables what the server lacks", async ({ page }) => {
  await openSample(page, "src/hover-sample/api.ts");
  const add = await wordPoint(page, "add", 1);
  await page.mouse.click(add.x, add.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Editor actions" });
  await expect(menu).toBeVisible();
  const labels = await menu.getByRole("menuitem").allTextContents();
  expect(labels.slice(0, 8).map(text => text.replace(/\s.*?(?=Peek|$)/, "").slice(0, 14))).toBeTruthy();
  const names = await menu.locator(":scope > button .context-menu-label").allTextContents();
  expect(names.slice(0, 9)).toEqual(["Go to Definition", "Go to Type Definition", "Go to Implementations", "Go to References", "Peek", "Find All References", "Rename Symbol", "Show Call Hierarchy", "Show Type Hierarchy"]);
  expect(names).toContain("Split editor");
  await expect(menu.getByRole("menuitem", { name: /Show Type Hierarchy/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /Show Type Hierarchy/ })).toHaveAttribute("title", "Not supported by preview fixture");
  await expect(menu.getByRole("menuitem", { name: /Go to Definition/ })).toContainText("F12");
  await menu.getByRole("menuitem", { name: "Peek", exact: true }).hover();
  await expect(page.getByRole("menu", { name: "Peek" })).toBeVisible();
  await shot(page, "context-menu");
  await page.keyboard.press("Escape");
});

test("a file without a language server gets no code intelligence group", async ({ page }) => {
  await ready(page);
  await openFile(page, ".env.local");
  const point = await wordPoint(page, "SPAN_ENV");
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Editor actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Go to Definition/ })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: /Split editor/ })).toBeVisible();
});

test("holding the modifier underlines a symbol with a definition and previews its declaration", async ({ page }) => {
  await openSample(page, "src/hover-sample/api.ts");
  const add = await wordPoint(page, "add", 1);
  await page.mouse.move(add.x, add.y);
  await page.keyboard.down(modifier);
  await expect(page.locator(".cm-lsp-link")).toHaveText("add");
  await expect(page.locator(".cm-lsp-preview")).toContainText("export function add");
  await shot(page, "link-underline");
  await page.keyboard.up(modifier);
  await expect(page.locator(".cm-lsp-link")).toHaveCount(0);
  await expect(page.locator(".cm-lsp-preview")).toHaveCount(0);
});

test("modifier click goes to the definition without a context menu or a second cursor", async ({ page }) => {
  await openSample(page, "src/hover-sample/api.ts");
  const add = await wordPoint(page, "add", 1);
  await page.keyboard.down(modifier);
  await page.mouse.click(add.x, add.y);
  await page.keyboard.up(modifier);
  await expect(page.locator(".context-menu")).toHaveCount(0);
  await expect(page.locator(".cm-editor:visible .cm-cursor")).toHaveCount(1);
  await expect.poll(() => page.locator(".cm-editor:visible .cm-activeLine").first().textContent()).toContain("export function add");
});

test("a token without a definition says so", async ({ page }) => {
  await openSample(page, "src/hover-sample/Controller.java");
  const point = await wordPoint(page, "getItems");
  await page.keyboard.down(modifier);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up(modifier);
  await expect(page.locator(".cm-lsp-notice")).toHaveText("No definition found");
  await expect(page.locator(".context-menu")).toHaveCount(0);
  await expect(page.locator(".cm-editor:visible .cm-cursor")).toHaveCount(1);
  await shot(page, "no-definition");
});

test("quick info opens the hover at the caret and focuses it", async ({ page }) => {
  await openSample(page, "src/hover-sample/api.ts");
  const add = await wordPoint(page, "add", 1);
  await page.mouse.click(add.x, add.y);
  await page.keyboard.press(`${modifier}+Shift+i`);
  const hover = page.locator(".cm-lsp-hover");
  await expect(hover).toBeVisible();
  await expect(hover).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(hover).toBeHidden();
});
