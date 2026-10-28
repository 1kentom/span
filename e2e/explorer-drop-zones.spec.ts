import { expect, test, type Page } from "@playwright/test";
import { modifier } from "./helpers";

const shots = process.env.EXPLORER_SHOTS;
async function shot(page: Page, name: string) {
  if (!shots) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${shots}/explorer-${name}.png` });
}
async function ready(page: Page, theme: "dark" | "light" = "dark") {
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "package.json", exact: true })).toBeVisible();
  await page.evaluate(value => { document.documentElement.dataset.theme = value; const ide = document.querySelector(".ide"); ide?.classList.remove("theme-dark", "theme-light", "theme-purple"); ide?.classList.add(`theme-${value}`); }, theme);
}
const envRow = (page: Page) => page.getByRole("treeitem").filter({ hasText: /^\.env\.local$/ });
async function pointAt(page: Page, group: number, fx: number, fy: number) {
  const box = await page.getByRole("region", { name: `Editor group ${group}`, exact: true }).boundingBox();
  if (!box) throw new Error("group not visible");
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}
async function startDrag(page: Page, to: { x: number; y: number }) {
  const row = await envRow(page).boundingBox();
  if (!row) throw new Error("row not visible");
  await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 });
}

for (const theme of ["dark", "light"] as const) {
  for (const [zone, fx, fy] of [["right", .9, .5], ["bottom", .5, .9], ["left", .1, .5], ["top", .5, .1], ["center", .5, .5]] as const) {
    test(`dropping an Explorer file on the ${zone} zone opens it there (${theme})`, async ({ page }) => {
      await ready(page, theme);
      await startDrag(page, await pointAt(page, 1, fx, fy));
      const overlay = page.locator(".drop-zone");
      await expect(overlay).toHaveAttribute("data-zone", zone);
      await shot(page, `zone-${zone}-${theme}`);
      await page.mouse.up();
      await expect(overlay).toHaveCount(0);
      if (zone === "center") { await expect(page.locator("[data-editor-group]")).toHaveCount(1); await expect(page.getByRole("tab", { name: ".env.local", exact: true })).toBeVisible(); return; }
      await expect(page.locator("[data-editor-group]")).toHaveCount(2);
      const stacked = zone === "top" || zone === "bottom";
      await expect(page.locator(".editor-groups")).toHaveClass(stacked ? /stacked/ : /^(?!.*stacked)/);
      const created = page.getByRole("tab", { name: ".env.local", exact: true });
      await expect(created).toHaveCount(1);
      const groups = await page.locator("[data-editor-group]").evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute("data-editor-group"), tab: !!node.querySelector('[role="tab"][title=".env.local"]') })));
      expect(groups[zone === "left" || zone === "top" ? 0 : 1].tab).toBe(true);
      await expect(page.getByRole("separator", { name: "Resize editor groups", exact: true })).toHaveAttribute("aria-orientation", stacked ? "horizontal" : "vertical");
      if (theme === "dark") await shot(page, `layout-${zone}-${theme}`);
    });
  }
}

test("a tab dragged to the bottom edge splits the editor below and the divider resizes it", async ({ page }) => {
  await ready(page);
  const first = page.getByRole("region", { name: "Editor group 1", exact: true });
  const tab = first.getByRole("tab", { name: "package.json", exact: true });
  const from = await tab.boundingBox(); if (!from) throw new Error("tab");
  const to = await pointAt(page, 1, .5, .9);
  await page.mouse.move(from.x + 10, from.y + from.height / 2); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(page.locator(".drop-zone")).toHaveAttribute("data-zone", "bottom");
  await page.mouse.up();
  await expect(page.locator("[data-editor-group]")).toHaveCount(2);
  const handle = page.getByRole("separator", { name: "Resize editor groups", exact: true });
  const before = await first.boundingBox();
  await handle.focus(); await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await first.boundingBox())?.height ?? 0).toBeGreaterThan(before?.height ?? 0);
});

test("dragging over the terminal panel shows no drop zone and a not-allowed cursor", async ({ page }) => {
  await ready(page);
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  if (!(await terminal.isVisible())) await page.getByRole("button", { name: "Toggle terminal panel", exact: true }).click();
  const box = await terminal.boundingBox(); if (!box) throw new Error("terminal");
  await startDrag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await expect(page.locator(".drop-zone")).toHaveCount(0);
  expect(await terminal.evaluate(node => getComputedStyle(node).cursor)).toBe("not-allowed");
  await page.mouse.up();
  await expect(page.locator("[data-editor-group]")).toHaveCount(1);
});

test("Escape cancels an Explorer drag without opening anything", async ({ page }) => {
  await ready(page);
  await startDrag(page, await pointAt(page, 1, .9, .5));
  await expect(page.locator(".drop-zone")).toHaveCount(1);
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(page.locator("[data-editor-group]")).toHaveCount(1);
  await expect(page.getByRole("tab", { name: ".env.local", exact: true })).toHaveCount(0);
});

test("dragging a row over a folder highlights it, shows the pill and expands it after a pause", async ({ page }) => {
  await ready(page);
  const folder = page.locator('[role="treeitem"][data-path="src"]');
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  const to = await folder.boundingBox(); if (!to) throw new Error("folder");
  await startDrag(page, { x: to.x + to.width / 2, y: to.y + to.height / 2 });
  await expect(folder).toHaveClass(/droptgt/);
  await expect(page.locator(".explorer-drag-pill")).toContainText(".env.local");
  await shot(page, "drag-over-folder");
  await expect(folder).toHaveAttribute("aria-expanded", "true", { timeout: 3000 });
  await page.keyboard.press("Escape"); await page.mouse.up();
});

test(`${modifier}+N opens an inline new file row, validates and cancels`, async ({ page }) => {
  await ready(page);
  await page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true }).click();
  await page.keyboard.press(`${modifier}+n`);
  const input = page.getByRole("textbox", { name: "New file name", exact: true });
  await expect(input).toBeFocused();
  await shot(page, "new-file-row");
  await input.fill("rpc.ts");
  await expect(page.getByRole("alert")).toContainText("already exists at this location");
  await input.fill("a//b");
  await expect(page.getByRole("alert")).toContainText("two slashes");
  await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Shift+n`);
  await expect(page.getByRole("textbox", { name: "New folder name", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
});

test("Alt+Insert opens the New in popup with a filter", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("Alt+Insert");
  const popup = page.getByRole("dialog", { name: /^New in / });
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("option")).toHaveCount(10);
  await page.waitForTimeout(300);
  await shot(page, "new-popup");
  await popup.getByRole("combobox", { name: "Filter templates" }).fill("react");
  await expect(popup.getByRole("option")).toHaveCount(1);
  await popup.getByRole("combobox", { name: "Filter templates" }).fill("zzz");
  await expect(popup.getByText('No template matches "zzz"')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});
