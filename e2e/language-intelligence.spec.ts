import { expect, test, type Page } from "@playwright/test";
import { openFile, openSettings, ready } from "./helpers";

// Browser preview only: the hub is driven by the scripted fixture in ui/src/lib/hub-preview.ts. It proves the UI,
// not real language servers. Set HUB_SHOTS to a folder to save screenshots of every state.
const SHOTS = process.env.HUB_SHOTS;
const FILE = "src/hover-sample/Controller.java";
type Scenario = "needs-install" | "installing" | "runtime-missing" | "install-failed" | "crashed" | "needs-trust" | "ready" | "disabled" | "starting";

const topButton = (page: Page) => page.locator(".top-right .hub-button");
const statusButton = (page: Page) => page.locator(".statusbar .lsp-status-button");
const panel = (page: Page) => page.getByRole("dialog", { name: "Language intelligence", exact: true });
const card = (page: Page) => panel(page).locator(".hub-card");

async function setup(page: Page, scenario: Scenario) {
  await ready(page);
  await openFile(page, FILE);
  await expect(page.getByRole("textbox", { name: "Edit Controller.java", exact: true })).toBeVisible();
  await page.evaluate(name => (window as any).__spanHubPreview.set(name), scenario);
  await expect(topButton(page)).toHaveAttribute("data-tone", /.+/);
}
const shot = async (page: Page, name: string, theme: "dark" | "light") => { if (SHOTS) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${SHOTS}/hub-${name}-${theme}.png` }); } };
async function openPanel(page: Page) { await topButton(page).click(); await expect(panel(page)).toBeVisible(); }
async function useLightTheme(page: Page) {
  await openSettings(page);
  await page.getByRole("radio", { name: "Light theme", exact: true }).click();
  await expect(page.locator("main.ide")).toHaveClass(/theme-light/);
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await openFile(page, FILE);
}

/** What the four surfaces say about the install percent right now. They must always agree. */
async function surfaces(page: Page) {
  return page.evaluate(() => {
    const text = (selector: string) => document.querySelector(selector)?.textContent ?? null;
    const attr = (selector: string, name: string) => document.querySelector(selector)?.getAttribute(name) ?? null;
    return {
      label: attr(".top-right .hub-button", "aria-label"), ring: attr(".top-right .hub-button", "data-percent"), status: text(".statusbar .lsp-status-text"),
      bar: attr(".hub-panel [role=progressbar]", "aria-valuenow"), percentText: text("[data-testid=hub-percent]"), headline: text(".hub-card .hub-headline"),
      titles: document.querySelectorAll(".top-right .hub-button[title], .statusbar .lsp-status-button[title], .hub-panel [title]").length,
    };
  });
}

test("a needs-install file walks through download, checks, start, indexing and ready with one steady percent", async ({ page }) => {
  await setup(page, "needs-install");
  await expect(topButton(page)).toHaveAttribute("aria-label", "Language intelligence. Java support is not installed.");
  await expect(topButton(page)).toHaveAttribute("data-badge", "attention");
  await expect(statusButton(page)).toHaveText("Java: not installed");
  await openPanel(page);
  await expect(panel(page).locator(".hub-header p")).toHaveText("Completions, error checking, hover info and go to definition for your code.");
  await expect(card(page)).toContainText("Java support is not installed. Install it to get completions, error checking and go to definition. About 120 MB. You can keep editing while it downloads.");
  await shot(page, "needs-install", "dark");
  await page.evaluate(() => {
    const w = window as any; w.__hubSamples = [];
    const read = () => {
      const q = (s: string) => document.querySelector(s);
      w.__hubSamples.push({ bar: q(".hub-panel [role=progressbar]")?.getAttribute("aria-valuenow") ?? null, label: q(".top-right .hub-button")?.getAttribute("aria-label"), status: q(".statusbar .lsp-status-text")?.textContent, headline: q(".hub-card .hub-headline")?.textContent, pct: q("[data-testid=hub-percent]")?.textContent, ring: q(".top-right .hub-button")?.getAttribute("data-percent") });
    };
    w.__hubTimer = setInterval(read, 8);
  });
  await panel(page).getByRole("button", { name: "Install Java support", exact: true }).click();
  await expect(card(page).locator(".hub-state")).toContainText("Installing");
  await expect(card(page).locator("[role=progressbar]")).toHaveCount(1);
  await expect(card(page).locator(".hub-detail")).toHaveText("You can keep editing. Java features switch on by themselves when it is ready.");
  await expect(card(page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect.poll(async () => { const now = await surfaces(page); return /Installing Java support \(/.test(now.label ?? "") ? now.percentText : null; }, { timeout: 8000 }).toMatch(/^([1-9]|[1-9]\d)%$/);
  const mid = await surfaces(page);
  const percent = Number(mid.bar);
  expect(mid.label).toBe(`Language intelligence. Installing Java support (${percent}%).`);
  expect(mid.status).toBe(`Java: installing ${percent}%`);
  expect(mid.ring).toBe(String(percent));
  expect(mid.percentText).toBe(`${percent}%`);
  expect(mid.titles).toBe(0);
  await expect(card(page).locator(".hub-state")).toHaveText("Ready", { timeout: 20_000 });
  await expect(topButton(page)).toHaveAttribute("data-check", "true");
  await expect(card(page).locator(".hub-detail")).toHaveText("Ready. Completions, errors, hover and go to definition are on for this file.");
  await expect(statusButton(page)).toHaveText("Java: ready");
  await shot(page, "ready-after-install", "dark");
  const samples = await page.evaluate(() => { const w = window as any; clearInterval(w.__hubTimer); return w.__hubSamples as { bar: string | null; label: string; status: string; headline: string; pct: string; ring: string | null }[]; });
  const headlines = new Set(samples.map(sample => sample.headline));
  for (const phase of ["Checking the download…", "Unpacking…", "Finishing…", "Starting…", "Indexing your project… 35%"]) expect([...headlines], `saw "${phase}"`).toContain(phase);
  expect([...headlines].some(line => /^Downloading… \d+ MB of 320 MB$/.test(line ?? ""))).toBe(true);
  const bytes = samples.filter(sample => /^Downloading/.test(sample.headline ?? "")).map(sample => Number(/(\d+) MB of/.exec(sample.headline)![1]));
  for (let index = 1; index < bytes.length; index++) expect(bytes[index]).toBeGreaterThanOrEqual(bytes[index - 1]);
  const bars = samples.filter(sample => sample.bar !== null && /Installing/.test(sample.label)).map(sample => Number(sample.bar));
  expect(bars.length).toBeGreaterThan(8);
  for (let index = 1; index < bars.length; index++) expect(bars[index], "percent never goes backwards").toBeGreaterThanOrEqual(bars[index - 1]);
  expect(Math.max(...bars)).toBe(100);
  let checked = 0;
  for (const sample of samples) {
    const match = /Installing Java support \((\d+)%\)/.exec(sample.label ?? "");
    if (!match) continue;
    checked++;
    expect(sample.bar, "button and panel agree").toBe(match[1]);
    expect(sample.status).toBe(`Java: installing ${match[1]}%`);
    expect(sample.ring).toBe(match[1]);
    expect(sample.pct).toBe(`${match[1]}%`);
  }
  expect(checked).toBeGreaterThan(8);
  const indexing = samples.filter(sample => sample.headline === "Indexing your project… 35%");
  expect(indexing.length).toBeGreaterThan(0);
  for (const sample of indexing) { expect(sample.label).toContain("(35%)"); expect(sample.status).toBe("Java: indexing 35%"); expect(sample.bar).toBe("35"); }
});

test("cancelling an install returns to needs install without an error", async ({ page }) => {
  await setup(page, "needs-install");
  await openPanel(page);
  await panel(page).getByRole("button", { name: "Install Java support", exact: true }).click();
  await expect(card(page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(card(page).locator(".hub-state")).toHaveText("Not installed");
  await expect(card(page).getByRole("button", { name: "Install Java support", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(card(page).locator("[role=progressbar]")).toHaveCount(0);
});

for (const theme of ["dark", "light"] as const) {
  test(`every state reads the same everywhere (${theme})`, async ({ page }) => {
    await setup(page, "ready");
    if (theme === "light") await useLightTheme(page);
    await page.evaluate(() => (window as any).__spanHubPreview.set("ready"));
    await openPanel(page);
    const cases: { scenario: Scenario; label: string; status: string; text: string; badge?: string; button?: string }[] = [
      { scenario: "needs-install", label: "Language intelligence. Java support is not installed.", status: "Java: not installed", text: "Java support is not installed", badge: "attention", button: "Install Java support" },
      { scenario: "installing", label: "Language intelligence. Installing Java support (40%).", status: "Java: installing 40%", text: "Downloading… 128 MB of 320 MB", button: "Cancel" },
      { scenario: "starting", label: "Language intelligence. Starting Java support.", status: "Java: starting", text: "Starting Java support. The first start can take a minute while it reads your project." },
      { scenario: "runtime-missing", label: "Language intelligence. Java support needs JDK.", status: "Java: needs JDK", text: "Java support needs JDK 25 or newer. Found: JDK 21 at /Library/Java/JavaVirtualMachines/jdk-21.jdk. Install a newer JDK, or choose one.", badge: "attention", button: "Choose JDK folder…" },
      { scenario: "install-failed", label: "Language intelligence. Java support needs attention.", status: "Java: needs attention", text: "Java support could not be downloaded. Check your internet connection and try again.", badge: "attention", button: "Retry" },
      { scenario: "crashed", label: "Language intelligence. Java support stopped unexpectedly.", status: "Java: stopped", text: "Java support stopped unexpectedly.", badge: "attention", button: "Restart" },
      { scenario: "needs-trust", label: "Language intelligence. Java support is ready, with this folder restricted.", status: "Java: ready (restricted)", text: "Only trust projects you got from a source you trust.", badge: "restricted", button: "Trust this folder" },
      { scenario: "ready", label: "Language intelligence. Java support is ready.", status: "Java: ready", text: "Ready. Completions, errors, hover and go to definition are on for this file.", button: "Restart" },
      { scenario: "disabled", label: "Language intelligence. Java support is turned off.", status: "Java: off", text: "Java support is turned off.", button: "Turn on" },
    ];
    for (const item of cases) {
      await page.evaluate(name => (window as any).__spanHubPreview.set(name), item.scenario);
      await expect(topButton(page)).toHaveAttribute("aria-label", item.label);
      await expect(statusButton(page)).toHaveText(item.status);
      await expect(statusButton(page)).toHaveAttribute("aria-label", item.label);
      await expect(card(page)).toContainText(item.text);
      if (item.button) await expect(card(page).getByRole("button", { name: item.button, exact: true })).toBeVisible();
      await expect(topButton(page)).toHaveAttribute("data-badge", item.badge ?? "");
      if (item.scenario === "installing") {
        const now = await surfaces(page);
        expect([now.bar, now.ring, now.percentText?.replace("%", "")]).toEqual(["40", "40", "40"]);
        expect(now.label).toContain("(40%)");
        expect(now.status).toBe("Java: installing 40%");
      }
      expect((await surfaces(page)).titles).toBe(0);
      await shot(page, item.scenario, theme);
    }
    // Hovering the button shows a tooltip made from the same summary, only while the panel is closed.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    await page.evaluate(() => (window as any).__spanHubPreview.set("installing"));
    await topButton(page).hover();
    await expect(page.locator(".hub-tooltip")).toHaveText("Installing Java support (40%)");
    await shot(page, "button-tooltip", theme);
  });
}

test("a missing JDK can be chosen and checked again", async ({ page }) => {
  await setup(page, "runtime-missing");
  await openPanel(page);
  await expect(card(page)).toContainText("Found: JDK 21 at /Library/Java/JavaVirtualMachines/jdk-21.jdk");
  await card(page).getByRole("button", { name: "Check again", exact: true }).click();
  await expect(card(page)).toContainText("Java support needs JDK 25 or newer");
  await card(page).getByRole("button", { name: "Choose JDK folder…", exact: true }).click();
  await expect(card(page).locator(".hub-state")).toHaveText("Ready", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await openSettings(page);
  await page.getByRole("button", { name: "Language servers", exact: true }).click();
  await expect(page.locator("#sp-lsp-java")).toHaveValue("/preview/jdks/jdk-25");
});

test("a failed install shows a plain reason, hides the details until asked, and retries", async ({ page }) => {
  await setup(page, "install-failed");
  await openPanel(page);
  await expect(card(page).locator(".hub-detail")).toHaveText("Java support could not be downloaded. Check your internet connection and try again.");
  const details = card(page).locator("details");
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText("connection reset by peer");
  await expect(details.getByRole("button", { name: "Copy details", exact: true })).toBeVisible();
  await shot(page, "install-failed-details", "dark");
  await card(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(card(page).locator("[role=progressbar]")).toHaveCount(1);
  await expect(card(page).locator(".hub-state")).toHaveText("Ready", { timeout: 20_000 });
});

test("folder trust: banner, learn more, not now, hover hint and trusting restarts with project dependencies", async ({ page }) => {
  await setup(page, "needs-trust");
  const banner = page.getByRole("region", { name: "Folder trust", exact: true });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Trust this folder to load project dependencies?");
  await expect(banner).toContainText("Only trust projects you got from a source you trust.");
  await expect(topButton(page)).toHaveAttribute("data-badge", "restricted");
  await shot(page, "trust-banner", "dark");
  await banner.getByRole("button", { name: "Learn more", exact: true }).click();
  await expect(banner.locator(".trust-banner-more")).toContainText("restricted mode");
  await banner.getByRole("button", { name: "Hide details", exact: true }).click();
  await expect(banner.locator(".trust-banner-more")).toHaveCount(0);
  // Hovering a name the server could not answer offers the same choice.
  const point = await page.evaluate(() => {
    const walker = document.createTreeWalker([...document.querySelectorAll(".cm-content")].find(item => (item as HTMLElement).offsetParent !== null)!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").indexOf("Override");
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 8);
      const box = range.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.move(point!.x, point!.y);
  const hover = page.locator(".cm-lsp-hover");
  await expect(hover).toContainText("Library types are not loaded until this folder is trusted.");
  await shot(page, "trust-hover-hint", "dark");
  await page.keyboard.press("Escape");
  // Not now hides the banner, the card keeps the choice.
  await banner.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(banner).toHaveCount(0);
  await openPanel(page);
  await expect(card(page)).toContainText("Restricted.");
  await expect(card(page).getByRole("button", { name: "Trust this folder", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // Only until the next app start.
  await page.reload();
  await ready(page);
  await openFile(page, FILE);
  await page.evaluate(() => (window as any).__spanHubPreview.set("needs-trust"));
  await expect(page.getByRole("region", { name: "Folder trust", exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Folder trust", exact: true }).getByRole("button", { name: "Trust folder", exact: true }).click();
  await expect(page.getByRole("region", { name: "Folder trust", exact: true })).toContainText("Restarting Java support with project dependencies…");
  await shot(page, "trust-restarting", "dark");
  await expect(page.getByRole("region", { name: "Folder trust", exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(topButton(page)).toHaveAttribute("data-check", "true");
  await openPanel(page);
  await expect(card(page)).toContainText("This folder is trusted");
  await card(page).getByRole("button", { name: "Stop trusting", exact: true }).click();
  await expect(page.getByRole("region", { name: "Folder trust", exact: true })).toBeVisible({ timeout: 15_000 });
});

test("keyboard: open with Enter, Escape closes and returns focus to the button", async ({ page }) => {
  await setup(page, "needs-install");
  await topButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeVisible();
  await expect(topButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest(".hub-panel") !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(topButton(page)).toBeFocused();
  await statusButton(page).click();
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(statusButton(page)).toBeFocused();
});

test("the panel is reused in Settings, and a file without a language server is neutral", async ({ page }) => {
  await setup(page, "ready");
  await openSettings(page);
  await page.getByRole("button", { name: "Language servers", exact: true }).click();
  const region = page.getByRole("region", { name: "Language intelligence", exact: true });
  await expect(region).toBeVisible();
  await expect(region.getByRole("switch", { name: "Java support on or off" })).toHaveAttribute("aria-checked", "true");
  await shot(page, "settings", "dark");
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await openFile(page, "README.md");
  await expect(topButton(page)).toHaveAttribute("data-tone", "off");
  await expect(topButton(page)).toHaveAttribute("aria-label", "Language intelligence. No language support for this file.");
  await expect(statusButton(page)).toHaveCount(0);
  await openPanel(page);
  await expect(panel(page)).toContainText("No language support is available for this file type");
});

test("the Go to group of the editor menu uses code and layer icons", async ({ page }) => {
  await ready(page);
  await openFile(page, FILE);
  const editor = page.getByRole("textbox", { name: "Edit Controller.java", exact: true });
  await editor.click({ button: "right", position: { x: 120, y: 60 } });
  const menu = page.getByRole("menu").last();
  const mask = (name: string) => menu.getByRole("menuitem", { name: new RegExp(`^${name}`) }).locator(".icon").first().evaluate(node => getComputedStyle(node).maskImage || getComputedStyle(node).webkitMaskImage);
  expect(await mask("Go to Definition")).toContain("/icons/goto-definition.svg");
  expect(await mask("Go to Type Definition")).toContain("/icons/goto-type-definition.svg");
  expect(await mask("Go to Implementations")).toContain("/icons/goto-implementations.svg");
  await shot(page, "context-menu-icons", "dark");
});
