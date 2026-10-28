import { expect, test, type Page } from "@playwright/test";
import { modifier, openFile, ready, screenshot } from "./helpers";

/** Browser preview only: navigation answers come from the labelled text-scanning fixture in navigation-preview.ts. */
async function openSample(page: Page, name: "main.ts" | "shapes.ts") {
  await ready(page);
  await openFile(page, `navigation-sample/${name}`);
  await expect(page.getByRole("textbox", { name: `Edit ${name}`, exact: true })).toBeVisible();
}

/** Puts the caret inside `word` on the first line that contains `lineText`. */
async function caretOn(page: Page, lineText: string, word: string) {
  const line = page.locator(".cm-line").filter({ hasText: lineText }).first();
  await line.click();
  await page.keyboard.press("End");
  const text = (await line.textContent()) ?? "";
  const back = text.length - (text.indexOf(word, text.indexOf(lineText)) + 1);
  for (let index = 0; index < back; index++) await page.keyboard.press("ArrowLeft");
}

test("peek definition shows the target inline, steps through results and closes with Escape", async ({ page }, testInfo) => {
  await openSample(page, "main.ts");
  await caretOn(page, "export function describe", "Shape");
  await page.keyboard.press("Alt+F12");
  const peek = page.getByRole("dialog", { name: /^Peek definition/ });
  await expect(peek).toBeVisible();
  await expect(peek.locator(".cm-peek-count")).toHaveText("1 of 1");
  await expect(peek.locator(".cm-peek-source")).toContainText("interface Shape");
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);

  await caretOn(page, "export function describe", "Shape");
  await page.keyboard.press("Shift+Alt+F12");
  const refs = page.getByRole("dialog", { name: /^Peek references/ });
  await expect(refs).toBeVisible();
  await expect(refs.getByRole("listbox", { name: "Peek results" })).toBeVisible();
  await expect(refs.locator(".cm-peek-source")).toContainText("Shape");
  const first = await refs.locator(".cm-peek-count").textContent();
  await page.keyboard.press("F4");
  await expect(refs.locator(".cm-peek-count")).not.toHaveText(first ?? "");
  await page.keyboard.press("Shift+F4");
  await expect(refs.locator(".cm-peek-count")).toHaveText(first ?? "");
  await screenshot(page, testInfo, "nav-peek");
  await page.keyboard.press("Enter");
  await expect(refs).toHaveCount(0);
});

test("a double click closes a peek unless it is kept open", async ({ page }) => {
  await openSample(page, "main.ts");
  await caretOn(page, "export function describe", "Shape");
  await page.keyboard.press("Alt+F12");
  const peek = page.getByRole("dialog", { name: /^Peek definition/ });
  await expect(peek.locator(".cm-peek-source")).toContainText("interface Shape");
  await peek.getByRole("button", { name: "Keep peek open on double click" }).click();
  await peek.locator(".cm-peek-source").dblclick();
  await expect(peek).toBeVisible();
  await peek.getByRole("button", { name: "Keep peek open on double click" }).click();
  await peek.locator(".cm-peek-source").dblclick();
  await expect(peek).toHaveCount(0);
});

test("find all references fills the bottom References tab and navigates from a row", async ({ page }, testInfo) => {
  await openSample(page, "main.ts");
  await caretOn(page, "export function describe", "Shape");
  await page.keyboard.press("Shift+F12");
  const panel = page.getByRole("region", { name: "References", exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("status").first()).toHaveText(/^\d+ references to `Shape`$/);
  await expect(page.getByRole("tab", { name: "References" })).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("treeitem", { name: /shapes\.ts/ }).first()).toBeVisible();
  await expect(panel.locator(".nav-line-text mark").first()).toHaveText("Shape");
  await screenshot(page, testInfo, "nav-references");
  await panel.getByRole("button", { name: "Collapse all" }).click();
  await expect(panel.locator(".nav-item")).toHaveCount(0);
  await panel.getByRole("button", { name: "Expand all" }).click();
  const group = panel.locator(".nav-group").first();
  await group.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: /^Edit (main|shapes)\.ts$/ }).first()).toBeVisible();
  await panel.locator(".nav-group").first().focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-content:focus").first()).toBeVisible();
});

test("go to symbol in file and in workspace use the Goto dialog", async ({ page }, testInfo) => {
  await openSample(page, "shapes.ts");
  await page.keyboard.press(`${modifier}+Shift+o`);
  const dialog = page.getByRole("dialog", { name: "Goto", exact: true });
  const input = dialog.getByRole("combobox");
  await expect(input).toHaveValue("@");
  await expect(dialog.getByRole("option", { name: "Circle", exact: true })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /^area/ })).toHaveCount(3);
  await screenshot(page, testInfo, "nav-symbols");
  await input.fill("@:");
  await expect(dialog.locator(".goto-section", { hasText: "methods" })).toBeVisible();
  await input.fill("@sqar");
  await expect(dialog.getByRole("option").first()).toContainText("Square");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await page.keyboard.press(`${modifier}+t`);
  await expect(input).toHaveValue("#");
  await input.fill("#describe");
  await expect(dialog.getByRole("option", { name: /describe/ })).toBeVisible();
  await input.press("Enter");
  await expect(page.getByRole("textbox", { name: "Edit main.ts", exact: true })).toBeVisible();
});

test("call and type hierarchy panels expand lazily and navigate", async ({ page }, testInfo) => {
  await openSample(page, "main.ts");
  await caretOn(page, "export function describe", "describe");
  await page.keyboard.press("Shift+Alt+H");
  const panel = page.getByRole("region", { name: "Call hierarchy", exact: true });
  await expect(panel.getByRole("treeitem", { name: /describe/ }).first()).toBeVisible();
  await expect(panel.getByRole("treeitem", { name: /report/ })).toBeVisible();
  await screenshot(page, testInfo, "nav-hierarchy");
  await panel.getByRole("button", { name: "Outgoing calls" }).click();
  await expect(panel.getByRole("treeitem", { name: /area/ }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Hierarchy" }).click();
  await openFile(page, "navigation-sample/shapes.ts");
  await caretOn(page, "export class Circle", "Circle");
  await page.keyboard.press(`${modifier}+Alt+h`);
  const types = page.getByRole("region", { name: "Type hierarchy", exact: true });
  await expect(types.getByRole("treeitem", { name: /Shape/ })).toBeVisible();
  await types.getByRole("button", { name: "Subtypes" }).click();
  await expect(types.getByRole("status").filter({ hasText: "No subtypes" })).toBeVisible();
});

test("the breadcrumb bar shows the symbol path with a sibling dropdown", async ({ page }) => {
  await openSample(page, "shapes.ts");
  await caretOn(page, "return Math.PI", "PI");
  const bar = page.getByRole("navigation", { name: "Active file path" });
  await expect(bar.getByRole("button", { name: /Circle/ })).toBeVisible();
  await expect(bar.getByRole("button", { name: /area/ })).toBeVisible();
  await bar.getByRole("button", { name: /area/ }).click();
  const menu = page.getByRole("menu", { name: /Symbols next to area/ });
  await expect(menu.getByRole("menuitem", { name: "constructor" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "constructor" }).click();
  await page.keyboard.press(`${modifier}+Shift+.`);
  await expect(bar.getByRole("button").last()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: /Symbols next to/ })).toBeVisible();
});

test("rename applies one undoable edit across files and reports a summary", async ({ page }, testInfo) => {
  await openSample(page, "main.ts");
  await caretOn(page, "export function describe", "describe");
  await page.keyboard.press("F2");
  const box = page.getByRole("textbox", { name: "Rename symbol" });
  await expect(box).toHaveValue("describe");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await page.keyboard.press("F2");
  await box.fill("summarize");
  await screenshot(page, testInfo, "nav-rename");
  await box.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Renamed 2 occurrences in 1 file" })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Edit main.ts", exact: true });
  await expect(editor).toContainText("export function summarize(shape: Shape)");
  await expect(editor).toContainText("shapes.map(summarize)");
  await editor.press(`${modifier}+z`);
  await expect(editor).toContainText("export function describe(shape: Shape)");
});

test("library definitions open in a read-only viewer, never as a buffer", async ({ page }, testInfo) => {
  await openSample(page, "main.ts");
  await caretOn(page, "export async function load", "Promise");
  await page.keyboard.press("F12");
  const viewer = page.getByRole("region", { name: "Read-only library source" });
  await expect(viewer.getByText("Read-only library source", { exact: true })).toBeVisible();
  await expect(viewer.getByRole("tab", { name: /lib\.es5\.d\.ts/ })).toBeVisible();
  await expect(viewer.locator(".cm-content")).toContainText("interface Promise");
  await expect(viewer.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await screenshot(page, testInfo, "nav-library");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("commands that a file's server cannot answer show the not-available message", async ({ page }) => {
  await ready(page);
  await openFile(page, "tsconfig.json");
  await page.getByRole("textbox", { name: "Edit tsconfig.json", exact: true }).click();
  await page.keyboard.press("F12");
  await expect(page.getByRole("alert").filter({ hasText: "Not available for this file" })).toBeVisible();
});
