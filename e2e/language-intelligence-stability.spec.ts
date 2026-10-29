import { expect, test, type Page } from "@playwright/test";
import { openFile, openSettings, ready } from "./helpers";

// Browser preview only: the hub is driven by the scripted fixture in ui/src/lib/hub-preview.ts. These tests prove the
// layout is stable, not that a real language server works. Set HUB_SHOTS to a folder to save screenshots of every state,
// and HUB_SIZES to a file to save the measured sizes.
const SHOTS = process.env.HUB_SHOTS;
const SIZES = process.env.HUB_SIZES;
const FILE = "src/hover-sample/Controller.java";
type Rect = { x: number; y: number; width: number; height: number };

const scenarios: { name: string; kind: string; status?: RegExp; pill: string; percent?: string }[] = [
  { name: "needs-install", kind: "needs-install", status: /^Install for completions and errors \(about 120 MB\)$/, pill: "Not installed" },
  { name: "installing-0", kind: "installing", status: /^Downloading 0 of 320 MB$/, pill: "Installing", percent: "0%" },
  { name: "installing", kind: "installing", status: /^Downloading 128 of 320 MB$/, pill: "Installing", percent: "40%" },
  { name: "installing-100", kind: "installing", status: /^Downloading 320 MB of 320 MB$|^Downloading 320 of 320 MB$/, pill: "Installing", percent: "100%" },
  { name: "verifying", kind: "installing", status: /^Checking the download$/, pill: "Installing", percent: "100%" },
  { name: "extracting", kind: "installing", status: /^Unpacking$/, pill: "Installing", percent: "100%" },
  { name: "starting", kind: "starting", status: /^The first start can take a minute$/, pill: "Starting" },
  { name: "indexing", kind: "working", status: /^Reading classes and dependencies$/, pill: "Indexing", percent: "35%" },
  { name: "ready", kind: "ready", pill: "Ready" },
  { name: "runtime-missing", kind: "runtime-missing", status: /^Needs JDK 25 or newer\. Found JDK 21$/, pill: "Needs runtime" },
  { name: "install-failed", kind: "install-failed", status: /^Couldn't install\. Check your connection$/, pill: "Install failed" },
  { name: "crashed", kind: "crashed", status: /^Stopped unexpectedly$/, pill: "Stopped" },
  { name: "disabled", kind: "disabled", status: /^Turn on for completions and errors$/, pill: "Off" },
  { name: "needs-trust", kind: "ready", pill: "Needs trust" },
  { name: "trusted", kind: "ready", pill: "Ready" },
];

const topButton = (page: Page) => page.locator(".top-right .hub-button");
const statusButton = (page: Page) => page.locator(".statusbar .lsp-status-button");
const panel = (page: Page) => page.getByRole("dialog", { name: "Language intelligence", exact: true });
const box = async (locator: ReturnType<Page["locator"]>): Promise<Rect> => (await locator.boundingBox())!;

async function setup(page: Page, scenario: string) {
  await ready(page);
  await openFile(page, FILE);
  await expect(page.getByRole("textbox", { name: "Edit Controller.java", exact: true })).toBeVisible();
  await page.evaluate(name => (window as any).__spanHubPreview.set(name), scenario);
  await expect(topButton(page)).toHaveAttribute("data-tone", /.+/);
}
async function useLightTheme(page: Page) {
  await openSettings(page);
  await page.getByRole("radio", { name: "Light theme", exact: true }).click();
  await expect(page.locator("main.ide")).toHaveClass(/theme-light/);
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await openFile(page, FILE);
}
const shot = async (page: Page, name: string, theme: string, clip?: Rect) => {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/hub2-${name}-${theme}.png`, clip });
};
/** Text zones must not overflow sideways. */
const overflowing = (page: Page) => page.evaluate(() => {
  const bad: string[] = [];
  const check = (el: Element, label: string) => { const node = el as HTMLElement; if (node.scrollWidth > node.clientWidth) bad.push(`${label}: ${node.scrollWidth} > ${node.clientWidth}`); };
  const panel = document.querySelector(".hub-panel")!;
  check(panel, "panel");
  for (const selector of [".hub-head", ".hub-name strong", ".hub-name small", ".hub-status-text", ".hub-pill", ".hub-percent", ".hub-chips", ".hub-trust-row", ".hub-list-head", ".hub-actions", ".hub-row"]) panel.querySelectorAll(selector).forEach(el => check(el, selector));
  return bad;
});

for (const theme of ["dark", "light"] as const) {
  test(`the panel keeps its width and place, and the bolt and the status bar item keep their box, across every state (${theme})`, async ({ page }, testInfo) => {
    test.slow(); // fifteen states, each measured several times
    await setup(page, "ready");
    if (theme === "light") await useLightTheme(page);
    await page.evaluate(() => (window as any).__spanHubPreview.set("ready"));
    await topButton(page).click();
    await expect(panel(page)).toBeVisible();
    // The language list is always there; the old "All languages" disclosure is gone.
    await expect(panel(page).getByRole("button", { name: "All languages", exact: true })).toHaveCount(0);
    await expect(panel(page).locator(".hub-row")).toHaveCount(7);
    const bolt0 = await box(topButton(page));
    const status0 = await box(statusButton(page));
    const sizes: { name: string; width: number; height: number }[] = [];
    let first: Rect | undefined;
    for (const item of scenarios) {
      await page.evaluate(name => (window as any).__spanHubPreview.set(name), item.name);
      await expect(panel(page)).toHaveAttribute("data-kind", item.kind);
      await expect(panel(page).locator(".hub-pill")).toHaveText(item.pill);
      if (item.status) await expect(panel(page).locator(".hub-status-text")).toHaveText(item.status);
      else await expect(panel(page).locator(".hub-status-text")).toHaveCount(0);
      if (item.percent) await expect(panel(page).locator("[data-testid=hub-percent]")).toHaveText(item.percent);
      else await expect(panel(page).locator("[data-testid=hub-percent]")).toHaveCount(0);
      const now = await box(panel(page));
      first ??= now;
      // Height follows the content (no dead space); width and the anchored corner never move.
      expect(now.width, `${item.name} width`).toBe(first.width);
      expect(now.x, `${item.name} x`).toBe(first.x);
      expect(now.y, `${item.name} y`).toBe(first.y);
      expect(await box(topButton(page)), `${item.name} bolt`).toEqual(bolt0);
      expect(await box(statusButton(page)), `${item.name} status bar item`).toEqual(status0);
      expect(await overflowing(page), `${item.name} overflow`).toEqual([]);
      sizes.push({ name: item.name, width: now.width, height: now.height });
      await shot(page, item.name, theme, { x: 1040, y: 0, width: 400, height: 640 });
    }
    if (SIZES && theme === "dark") await import("node:fs").then(fs => fs.writeFileSync(SIZES, JSON.stringify({ bolt: bolt0, status: status0, sizes }, null, 2)));
    await testInfo.attach("sizes", { body: JSON.stringify(sizes), contentType: "application/json" });
  });
}

test("the bolt and the status bar item keep their box with the panel closed, whatever the state", async ({ page }) => {
  await setup(page, "ready");
  const bolt0 = await box(topButton(page));
  const status0 = await box(statusButton(page));
  for (const item of scenarios) {
    await page.evaluate(name => (window as any).__spanHubPreview.set(name), item.name);
    await expect(topButton(page)).toHaveAttribute("aria-label", /.+/);
    await page.waitForTimeout(40);
    expect(await box(topButton(page)), `${item.name} bolt`).toEqual(bolt0);
    expect(await box(statusButton(page)), `${item.name} status bar item`).toEqual(status0);
    const check = await page.evaluate(() => document.querySelector(".top-right .hub-button .hub-badge.check") === null);
    expect(check).toBe(true);
  }
});

test("the bolt is blue by default, rings only while work runs and has a dot only when attention is needed", async ({ page }) => {
  await setup(page, "ready");
  const colour = () => topButton(page).evaluate(node => getComputedStyle(node).color);
  const blue = await page.evaluate(() => { const probe = document.createElement("i"); probe.className = "blue"; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; });
  for (const [name, ring, badge] of [["ready", "none", ""], ["installing", "determinate", ""], ["starting", "indeterminate", ""], ["indexing", "determinate", ""], ["needs-install", "none", "attention"], ["crashed", "none", "attention"], ["needs-trust", "none", "restricted"], ["disabled", "none", ""]] as const) {
    await page.evaluate(scenario => (window as any).__spanHubPreview.set(scenario), name);
    await expect(topButton(page)).toHaveAttribute("data-ring", ring);
    await expect(topButton(page)).toHaveAttribute("data-badge", badge);
    expect(await colour(), name).toBe(blue);
  }
});

test("percent digits do not change the width of the percent text", async ({ page }) => {
  await setup(page, "installing");
  await topButton(page).click();
  const widths = await page.evaluate(() => {
    const host = document.querySelector(".hub-status")!;
    const probe = document.createElement("span"); probe.className = "hub-percent"; probe.style.cssText = "position:absolute;visibility:hidden;width:auto";
    host.append(probe);
    const text = (value: string) => { probe.textContent = value; const range = document.createRange(); range.selectNodeContents(probe); return range.getBoundingClientRect().width; };
    const result = { a: text("11%"), b: text("88%"), c: text("40%"), d: text("0%") === text("0%"), fixed: getComputedStyle(document.querySelector("[data-testid=hub-percent]")!).fontVariantNumeric };
    probe.remove();
    return result;
  });
  expect(widths.a).toBe(widths.b);
  expect(widths.a).toBe(widths.c);
  expect(widths.fixed).toContain("tabular-nums");
});

for (const theme of ["dark", "light"] as const) {
  test(`the trust prompt floats over the editor and moves nothing (${theme})`, async ({ page }) => {
    await setup(page, "ready");
    if (theme === "light") await useLightTheme(page);
    await page.evaluate(() => (window as any).__spanHubPreview.set("ready"));
    const editor = page.getByRole("textbox", { name: "Edit Controller.java", exact: true });
    const areas = () => page.evaluate(() => ({ center: document.querySelector(".center-area")!.getBoundingClientRect().toJSON(), groups: document.querySelector(".editor-groups")!.getBoundingClientRect().toJSON(), tabs: [...document.querySelectorAll(".editor-tabs")].map(el => el.getBoundingClientRect().toJSON()) }));
    const before = { editor: await box(editor), areas: await areas() };
    await expect(page.getByRole("region", { name: "Folder trust", exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).__spanHubPreview.set("needs-trust"));
    const prompt = page.getByRole("region", { name: "Folder trust", exact: true });
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText("Trust this folder to load its dependencies?");
    await page.waitForTimeout(300);
    expect({ editor: await box(editor), areas: await areas() }).toEqual(before);
    // It sits in the top right corner of the editor area, over it.
    const center = before.areas.center;
    const card = await box(prompt);
    expect(card.x + card.width).toBeLessThanOrEqual(center.x + center.width);
    expect(card.y).toBeGreaterThanOrEqual(center.y);
    expect(card.x + card.width).toBeGreaterThan(center.x + center.width - 40);
    expect(await overflowing2(page)).toEqual([]);
    await shot(page, "trust-overlay", theme);
    // Opening the panel hides it for good (this session), and the panel footer says what it said.
    await topButton(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(prompt).toHaveCount(0);
    await expect(panel(page).locator(".hub-trust")).toHaveText("Untrusted folder");
    expect({ editor: await box(editor), areas: await areas() }).toEqual(before);
    await page.keyboard.press("Escape");
    await expect(prompt).toHaveCount(0);
  });
}
const overflowing2 = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".trust-banner, .trust-banner *")].filter(el => (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth).map(el => el.className));
