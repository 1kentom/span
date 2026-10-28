import { expect, test, type Locator } from "@playwright/test";
import { ready, screenshot } from "./helpers";

async function style(element: Locator, pseudo?: string) {
  return element.evaluate((node, pseudo) => {
    const value = getComputedStyle(node, pseudo);
    return { color: value.color, background: value.backgroundColor, opacity: Number(value.opacity), transform: value.transform, content: value.content, width: parseFloat(value.width), height: parseFloat(value.height), outline: value.outlineStyle, transition: value.transitionDuration };
  }, pseudo);
}
function neutral(color: string) {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
  expect(channels).toHaveLength(3);
  expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(32);
}
async function noFullRailAccent(handle: Locator) {
  const after = await style(handle, "::after");
  expect(["none", "normal", '""']).toContain(after.content);
  if (after.content === '""') {
    expect(after.width).toBeLessThan(64);
    expect(after.height).toBeLessThan(64);
  }
  neutral((await style(handle)).color);
}

test("collapsed terminal rail overlays its center area without shortening the editor", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Close terminal panel", exact: true }).click();
  const editor = page.getByRole("region", { name: "Editor group 1", exact: true });
  const sidebar = page.getByRole("complementary", { name: "Project", exact: true });
  await expect.poll(async () => {
    const [left, middle] = await Promise.all([sidebar.boundingBox(), editor.boundingBox()]);
    return Math.abs(left!.y + left!.height - middle!.y - middle!.height);
  }).toBeLessThanOrEqual(1);
  const rail = page.getByRole("separator", { name: "Restore terminal panel", exact: true });
  const placement = await rail.evaluate(element => ({ position: getComputedStyle(element).position, parent: element.parentElement?.className, offsetParent: (element as HTMLElement).offsetParent?.className }));
  expect(placement).toEqual({ position: "absolute", parent: "center-area", offsetParent: "center-area" });
  const [railBox, centerBox] = await Promise.all([rail.boundingBox(), page.locator(".center-area").boundingBox()]);
  expect(Math.abs(railBox!.y + railBox!.height - centerBox!.y - centerBox!.height)).toBeLessThanOrEqual(1);
});

test("collapsed rails expose local neutral hover and keyboard focus hints with tooltips", async ({ page }, testInfo) => {
  await ready(page);
  for (const item of [
    { panel: "project", toggle: "Toggle project panel", side: "left" },
    { panel: "AI Assistant", toggle: "Toggle AI Assistant panel", side: "right" },
    { panel: "terminal", toggle: "Toggle terminal panel", side: "bottom" },
  ]) {
    await page.getByRole("button", { name: item.toggle, exact: true }).click();
    const rail = page.getByRole("separator", { name: `Restore ${item.panel} panel`, exact: true });
    await expect(rail).toHaveAttribute("data-panel-side", item.side);
    await rail.hover();
    const grip = rail.locator(".panel-rail-grip");
    await expect(grip).toHaveCSS("opacity", "1");
    await expect.poll(async () => (await style(grip)).transform).toBe("matrix(1.14, 0, 0, 1.14, 0, 0)");
    const flap = await style(grip, "::before");
    neutral(flap.background);
    expect(flap.width).toBeLessThan(64);
    expect(flap.height).toBeLessThan(64);
    await noFullRailAccent(rail);
    await expect(rail.getByRole("tooltip")).toBeVisible();
    await expect(rail.getByRole("tooltip")).toContainText(`Restore ${item.panel} panel`);
    await screenshot(page, testInfo, `handle-${item.side}-hover`);
    await page.mouse.move(720, 20);
    await page.keyboard.press("Tab");
    await rail.focus();
    await expect.poll(() => rail.evaluate(element => element.matches(":focus-visible"))).toBe(true);
    await expect(grip).toHaveCSS("opacity", "1");
    expect((await style(rail)).outline).toBe("none");
    expect((await style(grip)).outline).toBe("solid");
    await expect(rail.getByRole("tooltip")).toBeVisible();
    if (item.side === "right") await rail.press("Enter");
    else await rail.click();
    await expect(page.getByRole("separator", { name: `Resize ${item.panel} panel`, exact: true })).toBeVisible();
  }
});

test("expanded panel and editor group dividers show short faint neutral hints", async ({ page }) => {
  await ready(page);
  for (const name of ["Resize project panel", "Resize AI Assistant panel", "Resize terminal panel"]) {
    const handle = page.getByRole("separator", { name, exact: true });
    await handle.hover();
    await expect(handle.locator(".panel-rail-grip")).toHaveCSS("opacity", "0.14");
    await expect(handle.getByRole("tooltip")).toBeVisible();
    await noFullRailAccent(handle);
  }
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const divider = page.getByRole("separator", { name: "Resize editor groups", exact: true });
  await divider.hover();
  await expect.poll(async () => (await style(divider, "::after")).opacity).toBe(0.14);
  const hint = await style(divider, "::after");
  expect(hint.width).toBeLessThan(16);
  expect(hint.height).toBeLessThan(64);
  neutral(hint.background);
  await expect.poll(async () => (await style(divider, "::before")).opacity).toBe(1);
  expect((await style(divider, "::before")).content).toContain("Resize editor groups");
});

test("panel drag keeps collapse and restore hysteresis instead of reopening at the first movement", async ({ page }) => {
  await ready(page);
  const project = page.getByRole("complementary", { name: "Project", exact: true });
  const handle = page.getByRole("separator", { name: "Resize project panel", exact: true });
  const width = (await project.boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - width + 70, y, { steps: 8 });
  await expect(project).toBeVisible();
  await page.mouse.move(x - width + 50, y, { steps: 3 });
  await expect(project).toBeHidden();
  await page.mouse.up();
  const rail = page.getByRole("separator", { name: "Restore project panel", exact: true });
  const collapsed = (await rail.boundingBox())!;
  const start = collapsed.x + collapsed.width / 2;
  await page.mouse.move(start, y);
  await page.mouse.down();
  await page.mouse.move(start + 110, y, { steps: 8 });
  await expect(project).toBeHidden();
  await page.mouse.move(start + 135, y, { steps: 3 });
  await expect(project).toBeVisible();
  await page.mouse.up();
});

test("handle feedback stays visible with all transitions disabled for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await page.getByRole("button", { name: "Toggle project panel", exact: true }).click();
  const rail = page.getByRole("separator", { name: "Restore project panel", exact: true });
  await rail.hover();
  await expect(rail.locator(".panel-rail-grip")).toHaveCSS("opacity", "1");
  expect((await style(rail.locator(".panel-rail-grip"))).transition).toBe("0s");
  expect((await style(rail.locator(".panel-rail-grip"), "::before")).transition).toBe("0s");
  expect((await style(rail.getByRole("tooltip"))).transition).toBe("0s");
  await expect(rail.getByRole("tooltip")).toBeVisible();
});
