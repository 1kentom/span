import { expect, test, type Locator } from "@playwright/test";
import { modifier, openSettings, ready } from "./helpers";

async function settingsSource(page: import("@playwright/test").Page) {
  await ready(page); await openSettings(page);
  await page.getByRole("button", { name: "Open settings JSONC", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Edit Workspace settings (JSONC)", exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

async function prepare(editor: Locator, marked: string) {
  const text = marked.replace("|", "");
  await editor.click(); await editor.press(`${modifier}+a`); await editor.press("Backspace");
  await editor.page().keyboard.insertText(text); await editor.press(`${modifier}+End`);
  for (let index = 0; index < text.length - marked.indexOf("|"); index++) await editor.press("ArrowLeft");
  await editor.press("Control+Space");
  return text;
}

test("Tab accepts the visible Inter settings value and undo restores the exact quoted token", async ({ page }, testInfo) => {
  const editor = await settingsSource(page);
  const original = await prepare(editor, '{\n  // Keep this comment\n  "uiFontFamily": "In|",\n  "fontSize": 13,\n}\n');
  await expect(page.getByRole("option").filter({ hasText: /"Inter"/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("inter-completion-before-tab.png") });
  await editor.press("Tab");
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await expect.poll(() => editor.locator(".cm-line").allTextContents()).toEqual(original.replace('"In"', '"Inter"').split("\n"));
  await page.screenshot({ path: testInfo.outputPath("inter-completion-after-tab.png") });
  await editor.press(`${modifier}+z`);
  await expect.poll(() => editor.locator(".cm-line").allTextContents()).toEqual(original.split("\n"));
});

test("Tab accepts schema enum and property replacements without duplicate quotes or losing commas", async ({ page }) => {
  const editor = await settingsSource(page);
  for (const fixture of [
    { marked: '{"theme": "Pu|",}', label: /"Purple"/, expected: '{"theme": "Purple",}' },
    { marked: '{"uiFontSi|": 14,}', label: /uiFontSize/, expected: '{"uiFontSize": 14,}' },
  ]) {
    await prepare(editor, fixture.marked);
    await expect(page.getByRole("option").filter({ hasText: fixture.label })).toBeVisible();
    await editor.press("Tab");
    await expect.poll(() => editor.locator(".cm-line").allTextContents()).toEqual([fixture.expected]);
  }
});

test("ordinary Tab and Shift+Tab indentation and Escape-Tab keyboard escape remain available", async ({ page }) => {
  await ready(page);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await editor.click(); await editor.press(`${modifier}+a`); await page.keyboard.insertText("  plain");
  await editor.press("Escape"); await editor.press("ArrowRight");
  await editor.press("Tab"); await expect(editor).toHaveText("    plain");
  await editor.press("Shift+Tab"); await expect(editor).toHaveText("  plain");
  await editor.press("Escape"); await editor.press("Tab");
  await expect(editor).not.toBeFocused(); await expect(editor).toHaveText("  plain");
});
