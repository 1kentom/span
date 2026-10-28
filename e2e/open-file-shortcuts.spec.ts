import { expect, test, type Page } from "@playwright/test";
import { modifier, ready } from "./helpers";

type PickerFixture = { selected: string | null; error: string | null; calls: number; enqueued: string[][]; roots: (string | null)[]; hold: boolean; release?: () => void; request?: (request: { workspaceRoot: string; files: [] }) => Promise<void> };
type PickerWindow = Window & { pickerFixture: PickerFixture };

async function fixture(page: Page) {
  // A browser transport fixture replaces the picker and typed startup event stream.
  // It does not exercise a physical native dialog or operating-system file access.
  await page.route(/\/src\/lib\/client\.ts(?:\?.*)?$/, async route => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({ response, body: source + `
const pickerFixture = window.pickerFixture = { selected: null, error: null, calls: 0, enqueued: [], roots: [], hold: false };
let openListener;
api.pickFile = async () => {
  pickerFixture.calls++;
  if (pickerFixture.hold) await new Promise(resolve => pickerFixture.release = resolve);
  if (pickerFixture.error) throw new Error(pickerFixture.error);
  return pickerFixture.selected;
};
api.onOpenWorkspaceRequested = async listener => { openListener = listener; pickerFixture.request = listener; return () => { openListener = undefined; }; };
api.enqueueDroppedPaths = async paths => {
  pickerFixture.enqueued.push(paths);
  if (!openListener) throw new Error('Open request subscription missing');
  void openListener({ workspaceRoot: '/outside', files: paths.map(path => ({ path, line: null, column: null })) });
};
const originalOpenWorkspace = api.openWorkspace;
api.openWorkspace = async path => {
  pickerFixture.roots.push(path || null);
  return path === '/outside' ? { name: 'outside', root: path } : originalOpenWorkspace(path);
};
` });
  });
  await ready(page);
  await page.evaluate(() => { (window as PickerWindow).pickerFixture.roots = []; });
}

async function pickFile(page: Page) {
  await page.keyboard.press(`${modifier}+Shift+p`);
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await palette.getByRole("combobox", { name: "Search commands", exact: true }).fill("Open File");
  await palette.locator("#command-openFile").click();
  await expect(palette).toBeHidden();
}

test("Cmd+E toggles Files, while Cmd+Shift+E always focuses it without picking", async ({ page }) => {
  await fixture(page);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await editor.focus(); await page.keyboard.insertText("// preserved sidebar draft\n");
  const project = page.getByRole("complementary", { name: "Project", exact: true });
  await project.getByRole("button", { name: "Search", exact: true }).click();
  await page.keyboard.press(`${modifier}+e`);
  await expect(project.getByRole("button", { name: "Files", exact: true })).toHaveAttribute("aria-pressed", "true", { timeout: 2000 });
  await expect(project.getByRole("tree", { name: "Workspace files" })).toBeVisible();
  expect(await project.getByRole("tree").evaluate(tree => tree.contains(document.activeElement))).toBe(true);
  await page.keyboard.press(`${modifier}+e`);
  await expect(project).toBeHidden();
  await page.keyboard.press(`${modifier}+e`);
  await expect(project).toBeVisible();
  await expect(project.getByRole("button", { name: "Files", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await project.getByRole("tree").evaluate(tree => tree.contains(document.activeElement))).toBe(true);
  await page.keyboard.press(`${modifier}+e`);
  await expect(project).toBeHidden();
  await page.keyboard.press(`${modifier}+Shift+e`);
  await expect(project).toBeVisible();
  expect(await project.getByRole("tree").evaluate(tree => tree.contains(document.activeElement))).toBe(true);
  await expect(editor).toContainText("preserved sidebar draft");
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.calls)).toBe(0);
  await page.keyboard.press(`${modifier}+p`);
  await expect(page.getByRole("dialog", { name: "Goto", exact: true })).toBeVisible();
});

test("Open File command picks an inside file while Cmd+P opens Go to", async ({ page }) => {
  await fixture(page);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await editor.focus(); await page.keyboard.insertText("// retained picker draft\n");
  await page.evaluate(() => { (window as PickerWindow).pickerFixture.selected = "/preview/intellij/README.md"; });
  await pickFile(page);
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog", { name: "Goto", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.enqueued)).toEqual([]);
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.roots)).toEqual([]);
  await page.getByRole("tab", { name: "rpc-node.ts", exact: true }).click();
  await expect(editor).toContainText("retained picker draft");
  await page.keyboard.press(`${modifier}+p`);
  await expect(page.getByRole("dialog", { name: "Goto", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.calls)).toBe(1);
});

test("picker cancellation is a no-op and picker errors stay visible", async ({ page }) => {
  await fixture(page);
  await pickFile(page);
  await expect.poll(() => page.evaluate(() => (window as PickerWindow).pickerFixture.calls)).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.enqueued)).toEqual([]);
  await page.evaluate(() => { (window as PickerWindow).pickerFixture.error = "File picker failed"; });
  await pickFile(page);
  await expect(page.getByRole("alert")).toContainText("Could not open file: Error: File picker failed");
  await expect(page.getByRole("dialog", { name: "Goto", exact: true })).toHaveCount(0);
});

test("outside selection uses the existing startup dirty guard and Cancel retains the draft", async ({ page }) => {
  await fixture(page);
  const editor = page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true });
  await editor.focus(); await page.keyboard.insertText("// keep outside picker draft\n");
  await page.evaluate(() => { (window as PickerWindow).pickerFixture.selected = "/outside/README.md"; });
  await pickFile(page);
  const dialog = page.getByRole("dialog", { name: "Open requested project", exact: true });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.enqueued)).toEqual([["/outside/README.md"]]);
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.roots)).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toContainText("keep outside picker draft");
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.roots)).toEqual([]);
});

test("only one file picker runs while a selection is pending", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as PickerWindow).pickerFixture.hold = true; });
  await pickFile(page); await pickFile(page);
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.calls)).toBe(1);
  await page.evaluate(() => (window as PickerWindow).pickerFixture.release?.());
  await page.keyboard.press(`${modifier}+p`);
  await expect(page.getByRole("dialog", { name: "Goto", exact: true })).toBeVisible();
});

test("a picker returning after a workspace change uses the current root", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const state = (window as PickerWindow).pickerFixture; state.hold = true; state.selected = "/outside/README.md"; });
  await pickFile(page);
  await page.evaluate(() => (window as PickerWindow).pickerFixture.request?.({ workspaceRoot: "/outside", files: [] }));
  await expect(page.getByRole("button", { name: "Recent projects", exact: true })).toHaveText("outside");
  await page.evaluate(() => (window as PickerWindow).pickerFixture.release?.());
  await expect(page.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.enqueued)).toEqual([]);
  expect(await page.evaluate(() => (window as PickerWindow).pickerFixture.roots)).toEqual(["/outside"]);
});

test("the split action uses the supplied artwork at the far right and in its submenu", async ({ page }) => {
  await ready(page);
  const header = page.locator(".editor-header").first();
  const split = header.getByRole("button", { name: "Split editor", exact: true });
  await expect(split.locator(".icon")).toHaveCSS("mask-image", /split-editor\.svg/);
  expect(await split.evaluate(element => element.nextElementSibling)).toBeNull();
  expect(await split.evaluate(element => element.previousElementSibling?.getAttribute("aria-label"))).toBe("Save file");
  await page.getByRole("tab", { name: "rpc-node.ts", exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu").first();
  const splitMenu = menu.getByRole("menuitem", { name: "Split editor", exact: true });
  await expect(splitMenu.locator(".icon").first()).toHaveCSS("mask-image", /split-editor\.svg/);
  await splitMenu.hover();
  await expect(page.getByRole("menuitem", { name: "Open in split to the right", exact: true }).locator(".icon")).toHaveCSS("mask-image", /split-editor\.svg/);
});
