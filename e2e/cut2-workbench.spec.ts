import { expect, test } from "@playwright/test";
import { modifier, openFile, openSettings, ready } from "./helpers";

test("empty and last-tab split groups close without closing the app", async ({ page }) => {
  await ready(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  await expect(page.getByRole("region", { name: "Editor group 2", exact: true })).toContainText("No file open");
  await expect(page.locator(".animated-logo")).toHaveCount(0);
  await page.keyboard.press(`${modifier}+w`);
  await expect(page.getByRole("region", { name: "Editor group 2", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "rpc-node.ts", exact: true }).click();
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const second = page.getByRole("region", { name: "Editor group 3", exact: true });
  await second.getByRole("button", { name: "Close rpc-node.ts", exact: true }).click();
  await expect(second).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true })).toBeVisible();
});

test("closing a duplicate dirty split preserves edits and shared undo", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const editors = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await editors.nth(1).click(); await editors.nth(1).press(`${modifier}+End`);
  await page.keyboard.insertText("\n// group close keeps shared draft");
  await page.getByRole("button", { name: "Close editor group 2", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Unsaved changes", exact: true })).toHaveCount(0);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await expect(editor).toContainText("group close keeps shared draft");
  await editor.focus(); await editor.press(`${modifier}+z`);
  await expect(editor).not.toContainText("group close keeps shared draft");
});

test("the dirty dot clears when manual deletion returns a file to its saved content", async ({ page }) => {
  await ready(page);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  const close = page.getByRole("button", { name: "Close rpc-node.ts", exact: true });
  await editor.focus(); await editor.press(`${modifier}+End`); await page.keyboard.insertText("x");
  await expect(close).toHaveAttribute("title", "Unsaved changes, close file");
  await editor.press("Backspace");
  await expect(close).toHaveAttribute("title", "Close file");
  await close.click(); await expect(page.getByRole("dialog", { name: "Unsaved changes", exact: true })).toHaveCount(0);
});

test("closing a unique dirty group keeps its draft after Cancel or failed Save", async ({ page }) => {
  await ready(page); await page.getByRole("button", { name: "Split editor", exact: true }).click();
  await openFile(page, ".env.local");
  const editor = page.getByRole("textbox", { name: "Edit .env.local", exact: true });
  await editor.click(); await editor.press(`${modifier}+End`); await page.keyboard.insertText("\nCUT2_DRAFT=kept");
  await page.getByRole("button", { name: "Close editor group 2", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Saving files requires the span desktop app");
  await expect(dialog).toBeVisible(); await page.keyboard.press("Escape");
  await expect(editor).toContainText("CUT2_DRAFT=kept");
  await expect(page.getByRole("region", { name: "Editor group 2", exact: true })).toBeVisible();
});

test("tabs move between groups and Explorer files drop into the target group", async ({ page }) => {
  await ready(page); await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const first = page.getByRole("region", { name: "Editor group 1", exact: true });
  const second = page.getByRole("region", { name: "Editor group 2", exact: true });
  await first.getByRole("tab", { name: "package.json", exact: true }).locator("..").dragTo(second.locator(".editor-documents"));
  await expect(first.getByRole("tab", { name: "package.json", exact: true })).toHaveCount(0);
  await expect(second.getByRole("textbox", { name: "Edit package.json", exact: true })).toBeVisible();
  const entry = page.getByRole("treeitem").filter({ hasText: /^\.env\.local$/ });
  await expect(entry).toHaveAttribute("draggable", "true");
  await entry.dragTo(second.locator(".editor-documents"));
  await expect(second.getByRole("textbox", { name: "Edit .env.local", exact: true })).toBeVisible();
});

test("file context menus expose working path submenus and disable native mutations in preview", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(test.info().project.use.baseURL || "http://127.0.0.1:1420").origin });
  await ready(page);
  await page.getByRole("tab", { name: "rpc-node.ts", exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "File actions", exact: true });
  await expect(menu.getByRole("menuitem", { name: "Rename…", exact: true })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Move to Trash…", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Copy path", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Copy relative path", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("community/platform/node-rpc-client/src/rpc-node.ts");
});
