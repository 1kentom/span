import { expect, test } from "@playwright/test";
import { modifier, ready, screenshot } from "./helpers";

async function document(page: import("@playwright/test").Page, text: string) {
  await ready(page);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await editor.click(); await editor.press(`${modifier}+a`); await page.keyboard.insertText(text);
  await editor.press(`${modifier}+f`);
  const panel = page.getByRole("search", { name: "Find and replace", exact: true });
  await expect(panel.getByRole("textbox", { name: "Find", exact: true })).toBeFocused();
  return { editor, panel, find: panel.getByRole("textbox", { name: "Find", exact: true }) };
}

test("compact find uses real matches, word/case toggles and keyboard navigation", async ({ page }, testInfo) => {
  const { editor, panel, find } = await document(page, "1kentom 1kentom\n1KENTOM x1kentom");
  await expect(panel.getByRole("textbox", { name: "Replace", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Toggle replace", exact: true })).toHaveAttribute("aria-expanded", "false");
  await find.fill("1kentom"); await expect(panel.getByRole("status")).toHaveText("4 matches");
  await panel.getByRole("button", { name: "Match case", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("3 matches");
  await panel.getByRole("button", { name: "Match whole word", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("2 matches");
  await find.press("Enter"); await expect(panel.getByRole("status")).toHaveText("1 of 2");
  await find.press("Shift+Enter"); await expect(panel.getByRole("status")).toHaveText("2 of 2");
  await expect(panel.locator('input[type="checkbox"]')).toHaveCount(0);
  expect((await panel.boundingBox())!.height).toBeLessThan(48);
  await screenshot(page, testInfo, "find-compact-1440");
  await find.press("Escape"); await expect(panel).toHaveCount(0); await expect(editor).toBeFocused();
});

test("replace current and all edit the shared document", async ({ page }, testInfo) => {
  const { editor, panel, find } = await document(page, "1kentom alpha\n1kentom beta");
  await find.fill("1kentom"); await find.press("Enter");
  await panel.getByRole("button", { name: "Toggle replace", exact: true }).click();
  const replacement = panel.getByRole("textbox", { name: "Replace", exact: true });
  await expect(replacement).toBeVisible();
  await replacement.fill("span");
  await screenshot(page, testInfo, "find-replace-compact-1440");
  await panel.getByRole("button", { name: "Replace current match", exact: true }).click();
  await expect(editor).toContainText("span alpha"); await expect(editor).toContainText("1kentom beta");
  await panel.getByRole("button", { name: "Replace all matches", exact: true }).click();
  await expect(editor).toContainText("span beta"); await expect(editor).not.toContainText("1kentom");
  await expect(panel.getByRole("status")).toHaveText("No results");
  await expect(panel.getByRole("button", { name: "Replace all matches", exact: true })).toBeDisabled();
  await replacement.press("Escape"); await expect(editor).toBeFocused();
});

test("regex errors and zero results are clear, capture replacements use CM semantics", async ({ page }) => {
  const { editor, panel, find } = await document(page, "1kentom 2kentom 3kentom");
  await panel.getByRole("button", { name: "Use regular expression", exact: true }).click();
  await find.fill("("); await expect(panel.getByRole("alert")).toHaveText("Invalid regular expression");
  await expect(find).toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByRole("button", { name: "Next match (Enter)", exact: true })).toBeDisabled();
  await find.fill("(\\d)kentom"); await expect(panel.getByRole("alert")).toBeHidden();
  await panel.getByRole("button", { name: "Toggle replace", exact: true }).click();
  await panel.getByRole("textbox", { name: "Replace", exact: true }).fill("span$1");
  await panel.getByRole("button", { name: "Replace all matches", exact: true }).click();
  await expect(editor).toContainText("span1 span2 span3");
  await find.fill("not-present"); await expect(panel.getByRole("status")).toHaveText("No results");
  await expect(panel.getByRole("button", { name: "Select all matches", exact: true })).toBeDisabled();
  await find.focus(); await page.keyboard.press("Tab");
  await expect(panel.getByRole("button", { name: "Match case", exact: true })).toBeFocused();
});

test("find remains usable without clipping in a narrow split editor", async ({ page }, testInfo) => {
  await ready(page);
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const group = page.getByRole("region", { name: "Editor group 2", exact: true });
  await group.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true }).click();
  await page.keyboard.press(`${modifier}+f`);
  const panel = group.getByRole("search", { name: "Find and replace", exact: true });
  const find = panel.getByRole("textbox", { name: "Find", exact: true });
  await find.fill("private");
  expect((await find.boundingBox())!.width).toBeGreaterThanOrEqual(64);
  const bounds = (await panel.boundingBox())!;
  for (const control of await panel.locator("input,button").all()) {
    if (!await control.isVisible()) continue;
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(panel.getByRole("status")).not.toHaveText("No results");
  await screenshot(page, testInfo, "find-narrow-split-1440");
  await find.press("Escape");
  await expect(group.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true })).toBeFocused();
});
