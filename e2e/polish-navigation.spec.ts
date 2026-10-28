import { expect, test } from "@playwright/test";
import { modifier, openFile, ready } from "./helpers";

test("Control P and the primary P shortcut open Goto with previews and separate text search", async ({ page }) => {
  await ready(page);
  for (const shortcut of ["Control+p", `${modifier}+p`]) {
    await page.keyboard.press(shortcut);
    const dialog = page.getByRole("dialog", { name: "Goto", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Recent files", { exact: true })).toBeVisible();
    await dialog.getByRole("combobox", { name: "Find a file", exact: true }).fill("rpc-node.ts");
    await expect(dialog.locator(".goto-preview")).toContainText("SocketTransport");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await dialog.getByRole("tab", { name: "Text Search", exact: true }).click();
    await dialog.getByRole("combobox", { name: "Search workspace text", exact: true }).fill("SocketTransport");
    await expect(dialog.getByRole("option").first()).toContainText("rpc-node.ts:");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
});

test("find and go to line commands route to the active split", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  await openFile(page, "community/platform/node-rpc-client/package.json");
  const first = page.getByRole("region", { name: "Editor group 1", exact: true });
  const second = page.getByRole("region", { name: "Editor group 2", exact: true });
  await second.getByRole("textbox", { name: "Edit package.json", exact: true }).click();
  await page.keyboard.press(`${modifier}+f`);
  await expect(second.locator(".cm-search")).toBeVisible();
  await expect(first.locator(".cm-search")).toHaveCount(0);
  await second.locator(".cm-search").getByRole("textbox", { name: "Find", exact: true }).fill("private");
  await second.locator(".cm-search").getByRole("button", { name: "Close find (Escape)", exact: true }).click();
  await first.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true }).click();
  await page.keyboard.press("Control+g");
  const input = first.getByRole("textbox", { name: "Go to line:", exact: true });
  await expect(input).toBeVisible();
  await expect(second.locator(".cm-gotoLine")).toHaveCount(0);
  await input.fill("12");
  await input.press("Enter");
  await expect(page.locator(".status-right")).toContainText("12:1");
});

test("panel dividers collapse at the edge and rail clicks restore remembered size", async ({ page }) => {
  await ready(page);
  const panels = [
    { name: "project", region: page.getByRole("complementary", { name: "Project", exact: true }), x: 8, y: undefined },
    { name: "AI Assistant", region: page.getByRole("complementary", { name: "AI Assistant panel", exact: true }), x: 1432, y: undefined },
    { name: "terminal", region: page.getByRole("region", { name: "Terminal", exact: true }), x: undefined, y: 868 },
  ];
  for (const panel of panels) {
    const initial = await panel.region.boundingBox();
    const divider = page.getByRole("separator", { name: `Resize ${panel.name} panel`, exact: true });
    const box = await divider.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(panel.x ?? box!.x + box!.width / 2, panel.y ?? box!.y + box!.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(panel.region).toBeHidden();
    const rail = page.getByRole("separator", { name: `Restore ${panel.name} panel`, exact: true });
    await expect(rail).toHaveAttribute("aria-valuenow", "0");
    await rail.click();
    await expect(panel.region).toBeVisible();
    const restored = await panel.region.boundingBox();
    expect(Math.abs((panel.y === undefined ? restored!.width : restored!.height) - (panel.y === undefined ? initial!.width : initial!.height))).toBeLessThan(3);
  }
});

test("breadcrumbs browse siblings and file context menus copy the actual preview path", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(test.info().project.use.baseURL || "http://127.0.0.1:1420").origin });
  await ready(page);
  const crumbs = page.getByRole("navigation", { name: "Active file path", exact: true });
  await crumbs.getByRole("button", { name: "rpc-node.ts", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy path", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Copy relative path", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("community/platform/node-rpc-client/src/rpc-node.ts");
  await crumbs.getByRole("button", { name: "src", exact: true }).click();
  await page.getByRole("menu", { name: "Browse folder", exact: true }).getByRole("menuitem", { name: "rpc.ts", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Edit rpc.ts", exact: true })).toBeVisible();
});


test("Linux platform key selection accepts uppercase Control Shift Z events across splits", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" }));
  await ready(page);
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const editors = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await editors.first().focus();
  await editors.first().press("Control+End");
  await page.keyboard.insertText("\n// Linux redo through actual keyboard events");
  await expect(editors.nth(1)).toContainText("Linux redo through actual keyboard events");
  await editors.nth(1).focus();
  await editors.nth(1).press("Control+z");
  await expect(editors.first()).not.toContainText("Linux redo through actual keyboard events");
  await editors.first().focus();
  await editors.first().press("Control+Shift+z");
  await expect(editors.first()).toContainText("Linux redo through actual keyboard events");
  await expect(editors.nth(1)).toContainText("Linux redo through actual keyboard events");
  await editors.nth(1).focus();
  await editors.nth(1).press("Control+z");
  await expect(editors.first()).not.toContainText("Linux redo through actual keyboard events");
  await editors.first().focus();
  await editors.first().press("Control+Shift+Z");
  await expect(editors.first()).toContainText("Linux redo through actual keyboard events");
  await expect(editors.nth(1)).toContainText("Linux redo through actual keyboard events");
});

test("editor context Copy Cut Paste uses the browser clipboard and undo restores each edit", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(test.info().project.use.baseURL || "http://127.0.0.1:1420").origin });
  await ready(page);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  const initial = await editor.textContent();
  const menu = page.getByRole("menu", { name: "Editor actions", exact: true });
  await editor.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Select all", exact: true }).click();
  await editor.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("SocketTransport");
  await expect.poll(() => editor.textContent()).toBe(initial);
  await editor.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Cut", exact: true }).click();
  await expect.poll(() => editor.textContent()).toBe("");
  await editor.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Paste", exact: true }).click();
  await expect.poll(() => editor.textContent()).toBe(initial);
  await editor.focus();
  await editor.press(`${modifier}+z`);
  await expect.poll(() => editor.textContent()).toBe("");
  await editor.press(`${modifier}+Shift+z`);
  await expect.poll(() => editor.textContent()).toBe(initial);
});
