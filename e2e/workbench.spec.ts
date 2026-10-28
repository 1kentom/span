import { expect, test } from "@playwright/test";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

async function ready(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true })).toBeVisible();
}

test("quick open switches files while retaining existing tabs", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Open quick open", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Goto", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Find a file" }).fill("README.md");
  await dialog.getByRole("option", { name: /README\.md/ }).click();
  await expect(page.getByRole("region", { name: "Markdown preview", exact: true })).toContainText("browser preview workspace");
  await expect(page.getByRole("tab", { name: /rpc-node\.ts/ })).toBeVisible();
  await page.getByRole("tab", { name: /rpc-node\.ts/ }).click();
  await expect(page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true })).toContainText("SocketTransport");
});

test("edits survive a rejected browser save and undo restores the document", async ({ page }) => {
  await ready(page);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  const initial = await editor.textContent();
  await editor.click();
  await editor.press(`${modifier}+End`);
  await page.keyboard.insertText("\n// unsaved browser edit");
  await expect(editor).toContainText("unsaved browser edit");
  await editor.press(`${modifier}+s`);
  await expect(page.getByText(/Saving files requires the span desktop app/)).toBeVisible();
  await expect(editor).toContainText("unsaved browser edit");
  await editor.click();
  await editor.press(`${modifier}+z`);
  await expect.poll(() => editor.textContent()).toBe(initial);
});


test("switching tabs preserves the file selection and undo history", async ({ page }) => {
  await ready(page);
  let editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  const initial = await editor.textContent();
  await editor.click();
  await editor.press(`${modifier}+End`);
  await page.keyboard.insertText("\n// history stays with this file");
  for (let index = 0; index < 4; index += 1) await editor.press("Shift+ArrowLeft");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("file");
  await page.getByRole("tab", { name: "package.json", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Edit package.json", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "rpc-node.ts", exact: true }).click();
  editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await editor.focus();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("file");
  await editor.press(`${modifier}+z`);
  await expect.poll(() => editor.textContent()).toBe(initial);
});

test("split views share live buffer edits", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const editors = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await expect(editors).toHaveCount(2);
  await editors.first().click();
  await editors.first().press(`${modifier}+End`);
  await page.keyboard.insertText("\n// shared split revision");
  await expect(editors.first()).toContainText("shared split revision");
  await expect(editors.nth(1)).toContainText("shared split revision");
  await editors.nth(1).focus();
  await editors.nth(1).press(`${modifier}+z`);
  await expect(editors.first()).not.toContainText("shared split revision");
  await expect(editors.nth(1)).not.toContainText("shared split revision");
  await editors.first().focus();
  await editors.first().press(`${modifier}+Shift+z`);
  await expect(editors.first()).toContainText("shared split revision");
  await expect(editors.nth(1)).toContainText("shared split revision");
  await editors.nth(1).focus();
  await editors.nth(1).press(`${modifier}+End`);
  await page.keyboard.insertText("\n// second split edit");
  await expect(editors.first()).toContainText("second split edit");
  await expect(editors.nth(1)).toContainText("second split edit");
  await editors.first().focus();
  await editors.first().press(`${modifier}+z`);
  await expect(editors.first()).not.toContainText("second split edit");
  await expect(editors.nth(1)).not.toContainText("second split edit");
  await expect(editors.first()).toContainText("shared split revision");
  await editors.nth(1).focus();
  await editors.nth(1).press(`${modifier}+z`);
  await expect(editors.first()).not.toContainText("shared split revision");
  await expect(editors.nth(1)).not.toContainText("shared split revision");
  await editors.first().focus();
  await editors.first().press(`${modifier}+Shift+z`);
  await expect(editors.first()).toContainText("shared split revision");
  await expect(editors.nth(1)).toContainText("shared split revision");
  await editors.nth(1).focus();
  await editors.nth(1).press(`${modifier}+Shift+z`);
  await expect(editors.first()).toContainText("second split edit");
  await expect(editors.nth(1)).toContainText("second split edit");
  await expect(page.getByRole("button", { name: "Close rpc-node.ts", exact: true }).first()).toHaveAttribute("title", "Unsaved changes, close file");
  await editors.nth(1).press(`${modifier}+s`);
  await expect(page.getByText(/Saving files requires the span desktop app/)).toBeVisible();
  await expect(editors.first()).toContainText("second split edit");
  await expect(editors.nth(1)).toContainText("second split edit");
});

test("theme choices apply through the accessible settings menu", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Light theme", exact: true }).click();
  await expect(page.locator("main.ide")).toHaveClass(/theme-light/);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 2048, height: 1222 }]) {
  test(`reference screenshot ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByText("Browser preview", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`span-${viewport.width}x${viewport.height}.png`), fullPage: false });
    await testInfo.attach(`span-${viewport.width}x${viewport.height}`, { path: testInfo.outputPath(`span-${viewport.width}x${viewport.height}.png`), contentType: "image/png" });
  });
}
