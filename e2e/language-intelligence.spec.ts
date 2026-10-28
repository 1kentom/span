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
const card = (page: Page) => panel(page);
const statusLine = (page: Page) => panel(page).locator(".hub-status-text");

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
      bar: attr(".hub-panel [role=progressbar]", "aria-valuenow"), percentText: text("[data-testid=hub-percent]"), headline: text(".hub-panel .hub-status-text"),
      titles: document.querySelectorAll(".top-right .hub-button[title], .statusbar .lsp-status-button[title], .hub-panel [title]").length,
    };
  });
}

test("a needs-install file walks through download, checks, start, indexing and ready with one steady percent", async ({ page }) => {
  await setup(page, "needs-install");
  await expect(topButton(page)).toHaveAttribute("aria-label", "Language intelligence. Java is not installed.");
  await expect(topButton(page)).toHaveAttribute("data-badge", "attention");
  await expect(statusButton(page)).toHaveText("Java · Install");
  await openPanel(page);
  await expect(panel(page).locator(".hub-name small")).toHaveText("Eclipse JDT LS 1.62 · preview");
  await expect(statusLine(page)).toHaveText("Install for completions and errors (about 120 MB)");
  await shot(page, "needs-install", "dark");
  await page.evaluate(() => {
    const w = window as any; w.__hubSamples = [];
    const read = () => {
      const q = (s: string) => document.querySelector(s);
      w.__hubSamples.push({ bar: q(".hub-panel [role=progressbar]")?.getAttribute("aria-valuenow") ?? null, label: q(".top-right .hub-button")?.getAttribute("aria-label"), status: q(".statusbar .lsp-status-text")?.textContent, headline: q(".hub-panel .hub-status-text")?.textContent, pct: q("[data-testid=hub-percent]")?.textContent, ring: q(".top-right .hub-button")?.getAttribute("data-percent"), size: (() => { const r = q(".hub-panel")?.getBoundingClientRect(); return r ? `${r.width}x${r.height}` : null; })() });
    };
    w.__hubTimer = setInterval(read, 8);
  });
  await panel(page).getByRole("button", { name: "Install", exact: true }).click();
  await expect(card(page).locator(".hub-state-word")).toHaveText("Installing");
  await expect(card(page).locator("[role=progressbar]")).toHaveCount(1);
  await expect(card(page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect.poll(async () => { const now = await surfaces(page); return /Installing Java \(/.test(now.label ?? "") ? now.percentText : null; }, { timeout: 8000 }).toMatch(/^([1-9]|[1-9]\d)%$/);
  const mid = await surfaces(page);
  const percent = Number(mid.bar);
  expect(mid.label).toBe(`Language intelligence. Installing Java (${percent}%).`);
  expect(mid.status).toBe(`Java ${percent}%`);
  expect(mid.ring).toBe(String(percent));
  expect(mid.percentText).toBe(`${percent}%`);
  expect(mid.titles).toBe(0);
  await expect(panel(page)).toHaveAttribute("data-kind", "ready", { timeout: 20_000 });
  await expect(topButton(page)).toHaveAttribute("data-badge", "");
  await expect(topButton(page)).toHaveAttribute("data-ring", "none");
  await expect(statusLine(page)).toHaveText("Completions, errors, hover, go to definition, references, rename, format");
  await expect(statusButton(page)).toHaveText("Java");
  await shot(page, "ready-after-install", "dark");
  const samples = await page.evaluate(() => { const w = window as any; clearInterval(w.__hubTimer); return w.__hubSamples as { bar: string | null; label: string; status: string; headline: string; pct: string; ring: string | null; size: string | null }[]; });
  // The whole walk, from needs install to ready, never changes the panel size.
  expect([...new Set(samples.map(sample => sample.size))]).toHaveLength(1);
  const headlines = new Set(samples.map(sample => sample.headline));
  for (const phase of ["Checking the download", "Unpacking", "Finishing", "The first start can take a minute", "Reading classes and dependencies"]) expect([...headlines], `saw "${phase}"`).toContain(phase);
  expect([...headlines].some(line => /^Downloading \d+ of 320 MB$/.test(line ?? ""))).toBe(true);
  const bytes = samples.filter(sample => /^Downloading/.test(sample.headline ?? "")).map(sample => Number(/Downloading (\d+)/.exec(sample.headline)![1]));
  for (let index = 1; index < bytes.length; index++) expect(bytes[index]).toBeGreaterThanOrEqual(bytes[index - 1]);
  const bars = samples.filter(sample => sample.bar !== null && /Installing/.test(sample.label)).map(sample => Number(sample.bar));
  expect(bars.length).toBeGreaterThan(8);
  for (let index = 1; index < bars.length; index++) expect(bars[index], "percent never goes backwards").toBeGreaterThanOrEqual(bars[index - 1]);
  expect(Math.max(...bars)).toBe(100);
  let checked = 0;
  for (const sample of samples) {
    const match = /Installing Java \((\d+)%\)/.exec(sample.label ?? "");
    if (!match) continue;
    checked++;
    expect(sample.bar, "button and panel agree").toBe(match[1]);
    expect(sample.status).toBe(`Java ${match[1]}%`);
    expect(sample.ring).toBe(match[1]);
    expect(sample.pct).toBe(`${match[1]}%`);
  }
  expect(checked).toBeGreaterThan(8);
  const indexing = samples.filter(sample => sample.headline === "Reading classes and dependencies" && sample.bar === "35");
  expect(indexing.length).toBeGreaterThan(0);
  for (const sample of indexing) { expect(sample.label).toContain("(35%)"); expect(sample.status).toBe("Java 35%"); expect(sample.pct).toBe("35%"); }
});

test("cancelling an install returns to needs install without an error", async ({ page }) => {
  await setup(page, "needs-install");
  await openPanel(page);
  await panel(page).getByRole("button", { name: "Install", exact: true }).click();
  await expect(card(page).getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-kind", "needs-install");
  await expect(statusLine(page)).toHaveText("Install for completions and errors (about 120 MB)");
  await expect(card(page).getByRole("button", { name: "Install", exact: true })).toBeVisible();
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
      { scenario: "needs-install", label: "Language intelligence. Java is not installed.", status: "Java · Install", text: "Install for completions and errors (about 120 MB)", badge: "attention", button: "Install" },
      { scenario: "installing", label: "Language intelligence. Installing Java (40%).", status: "Java 40%", text: "Downloading 128 of 320 MB", button: "Cancel" },
      { scenario: "starting", label: "Language intelligence. Starting Java.", status: "Java · Starting", text: "The first start can take a minute" },
      { scenario: "runtime-missing", label: "Language intelligence. Java needs JDK.", status: "Java · JDK", text: "Needs JDK 25 or newer. Found JDK 21", badge: "attention", button: "Choose JDK" },
      { scenario: "install-failed", label: "Language intelligence. Java did not install.", status: "Java · Failed", text: "Couldn't install. Check your connection", badge: "attention", button: "Retry" },
      { scenario: "crashed", label: "Language intelligence. Java stopped unexpectedly.", status: "Java · Stopped", text: "Stopped unexpectedly", badge: "attention", button: "Restart" },
      { scenario: "needs-trust", label: "Language intelligence. Java is ready, folder not trusted.", status: "Java · Trust", text: "Completions, errors, hover", badge: "restricted", button: "Trust folder" },
      { scenario: "ready", label: "Language intelligence. Java is ready.", status: "Java", text: "Completions, errors, hover, go to definition, references, rename, format", button: "Restart" },
      { scenario: "disabled", label: "Language intelligence. Java is off.", status: "Java · Off", text: "Turn on for completions and errors", button: "Turn on" },
    ];
    for (const item of cases) {
      await page.evaluate(name => (window as any).__spanHubPreview.set(name), item.scenario);
      await expect(topButton(page)).toHaveAttribute("aria-label", item.label);
      await expect(statusButton(page)).toHaveText(item.status);
      await expect(statusButton(page)).toHaveAttribute("aria-label", item.label);
      await expect(statusLine(page)).toContainText(item.text);
      if (item.button) await expect(card(page).getByRole("button", { name: item.button, exact: true })).toBeVisible();
      await expect(topButton(page)).toHaveAttribute("data-badge", item.badge ?? "");
      if (item.scenario === "installing") {
        const now = await surfaces(page);
        expect([now.bar, now.ring, now.percentText?.replace("%", "")]).toEqual(["40", "40", "40"]);
        expect(now.label).toContain("(40%)");
        expect(now.status).toBe("Java 40%");
      }
      expect((await surfaces(page)).titles).toBe(0);
      await shot(page, item.scenario, theme);
    }
    // Hovering the button shows a tooltip made from the same summary, only while the panel is closed.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
    await page.evaluate(() => (window as any).__spanHubPreview.set("installing"));
    await topButton(page).hover();
    await expect(page.locator(".hub-tooltip")).toHaveText("Installing Java (40%)");
    await shot(page, "button-tooltip", theme);
  });
}

test("a missing JDK can be chosen and checked again", async ({ page }) => {
  await setup(page, "runtime-missing");
  await openPanel(page);
  await expect(statusLine(page)).toHaveText("Needs JDK 25 or newer. Found JDK 21");
  await expect(card(page).locator(".hub-status")).toHaveAttribute("data-tip", "Found at /Library/Java/JavaVirtualMachines/jdk-21.jdk. Install a newer JDK, or choose one.");
  await card(page).getByRole("button", { name: "Check again", exact: true }).click();
  await expect(statusLine(page)).toContainText("Needs JDK 25 or newer");
  await card(page).getByRole("button", { name: "Choose JDK", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-kind", "ready", { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await openSettings(page);
  await page.getByRole("button", { name: "Language servers", exact: true }).click();
  await expect(page.locator("#sp-lsp-java")).toHaveValue("/preview/jdks/jdk-25");
});

test("a failed install shows a short line, keeps the reason in the tooltip, offers the details, and retries", async ({ page }) => {
  await setup(page, "install-failed");
  await openPanel(page);
  await expect(statusLine(page)).toHaveText("Couldn't install. Check your connection");
  await expect(card(page).locator(".hub-status")).toHaveAttribute("data-tip", /Java support could not be downloaded\. Check your internet connection and try again\. GET .*connection reset by peer/);
  await expect(panel(page).locator("details")).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Copy details", exact: true })).toBeVisible();
  await shot(page, "install-failed-details", "dark");
  await card(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(card(page).locator("[role=progressbar]")).toHaveCount(1);
  await expect(panel(page)).toHaveAttribute("data-kind", "ready", { timeout: 20_000 });
});

test("folder trust: prompt, not now, hover hint and trusting restarts with project dependencies", async ({ page }) => {
  await setup(page, "needs-trust");
  const banner = page.getByRole("region", { name: "Folder trust", exact: true });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Trust this folder to load its dependencies?");
  await expect(banner).not.toContainText("Learn more");
  await expect(topButton(page)).toHaveAttribute("data-badge", "restricted");
  await shot(page, "trust-banner", "dark");
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
  // Not now hides the prompt, the panel footer keeps the choice and its explanation.
  await banner.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(banner).toHaveCount(0);
  await openPanel(page);
  await expect(card(page).locator(".hub-trust")).toHaveText("Untrusted folderWhy?");
  await expect(card(page).locator(".hub-trust")).toHaveAttribute("data-tip", /Only trust folders from a source you trust\./);
  await expect(card(page).getByRole("button", { name: "Trust folder", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // Only until the next app start.
  await page.reload();
  await ready(page);
  await openFile(page, FILE);
  await page.evaluate(() => (window as any).__spanHubPreview.set("needs-trust"));
  await expect(page.getByRole("region", { name: "Folder trust", exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Folder trust", exact: true }).getByRole("button", { name: "Trust folder", exact: true }).click();
  await expect(page.getByRole("region", { name: "Folder trust", exact: true })).toContainText("Restarting Java with its dependencies");
  await shot(page, "trust-restarting", "dark");
  await expect(page.getByRole("region", { name: "Folder trust", exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(topButton(page)).toHaveAttribute("data-badge", "");
  await openPanel(page);
  await expect(card(page).locator(".hub-trust")).toHaveText("Trusted folder");
  await card(page).getByRole("button", { name: "Stop trusting", exact: true }).click();
  // Opening the panel used up the prompt for this folder, so the footer is where the state shows.
  await expect(card(page).locator(".hub-trust")).toHaveText("Untrusted folderWhy?", { timeout: 15_000 });
  await expect(topButton(page)).toHaveAttribute("data-badge", "restricted");
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
  await expect(region.getByRole("switch", { name: "Java on or off" })).toHaveAttribute("aria-checked", "true");
  await shot(page, "settings", "dark");
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await openFile(page, "README.md");
  await expect(topButton(page)).toHaveAttribute("data-tone", "off");
  await expect(topButton(page)).toHaveAttribute("aria-label", "Language intelligence. No language support for this file.");
  await expect(statusButton(page)).toHaveCount(0);
  await openPanel(page);
  await expect(panel(page)).toContainText("No language support for this file type.");
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
