import { expect, test } from "@playwright/test";
import { modifier, ready, screenshot } from "./helpers";

for (const panel of [
  { side: "left", name: "project", toggle: "Toggle project panel", cursor: "col-resize" },
  { side: "right", name: "AI Assistant", toggle: "Toggle AI Assistant panel", cursor: "col-resize" },
  { side: "bottom", name: "terminal", toggle: "Toggle terminal panel", cursor: "row-resize" },
]) {
  test(`${panel.side} restore bump joins the edge with smooth shoulders`, async ({ page }, testInfo) => {
    await ready(page);
    await page.getByRole("button", { name: panel.toggle, exact: true }).click();
    const rail = page.getByRole("separator", { name: `Restore ${panel.name} panel`, exact: true });
    const grip = rail.locator(".panel-rail-grip");
    const base = await grip.evaluate(node => {
      const fill = getComputedStyle(node, "::before");
      const style = getComputedStyle(node);
      return { mask: fill.maskImage, clip: fill.clipPath, color: fill.backgroundColor, opacity: style.opacity, transition: style.transitionProperty, duration: style.transitionDuration };
    });
    expect(base.mask).toContain("C");
    expect(base.mask).toContain("svg");
    expect(base.clip).toBe("none");
    expect(base.opacity).toBe("1");
    expect(base.transition).toBe("transform");
    expect(base.duration).toBe("0.16s");
    await expect(rail).toHaveCSS("position", "absolute");
    await expect(rail).toHaveCSS("cursor", panel.cursor);
    const [rest, center] = await Promise.all([grip.boundingBox(), page.locator(".center-area").boundingBox()]);
    if (panel.side === "left") expect(Math.abs(rest!.x - center!.x)).toBeLessThanOrEqual(1);
    if (panel.side === "right") expect(Math.abs(rest!.x + rest!.width - center!.x - center!.width)).toBeLessThanOrEqual(1);
    if (panel.side === "bottom") expect(Math.abs(rest!.y + rest!.height - center!.y - center!.height)).toBeLessThanOrEqual(1);
    await rail.hover();
    await expect(grip).toHaveCSS("transform", "matrix(1.14, 0, 0, 1.14, 0, 0)");
    await expect(grip).toHaveCSS("opacity", "1");
    const hovered = await grip.evaluate(node => ({ fill: getComputedStyle(node, "::before").backgroundColor, dots: getComputedStyle(node.querySelector("i")!).transform }));
    expect(hovered.fill).toBe(base.color);
    expect(hovered.dots).toBe("matrix(1.35, 0, 0, 1.35, 0, 0)");
    await expect(rail.getByRole("tooltip")).toBeVisible();
    await screenshot(page, testInfo, `rounded-handle-${panel.side}-1440`);
    const view = (await grip.boundingBox())!;
    await page.screenshot({ path: testInfo.outputPath(`rounded-handle-${panel.side}-detail.png`), clip: { x: Math.max(0, view.x - 28), y: Math.max(0, view.y - 28), width: view.width + 56, height: view.height + 56 } });
    await page.keyboard.press("Tab");
    await rail.focus();
    await expect(grip).toHaveCSS("outline-style", "solid");
    await expect(rail).toHaveCSS("outline-style", "none");
    await rail.press("Enter");
    await expect(page.getByRole("separator", { name: `Resize ${panel.name} panel`, exact: true })).toBeVisible();
  });
}

test("collapsed bottom bump overlays the full height editor without adding an offset", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Hide terminal", exact: true }).click();
  const editor = (await page.getByRole("region", { name: "Editor group 1", exact: true }).boundingBox())!;
  const project = (await page.getByRole("complementary", { name: "Project", exact: true }).boundingBox())!;
  expect(Math.abs(editor.y + editor.height - project.y - project.height)).toBeLessThanOrEqual(1);
  const rail = page.getByRole("separator", { name: "Restore terminal panel", exact: true });
  expect(await rail.evaluate(node => ({ parent: node.parentElement?.className, offsetParent: (node as HTMLElement).offsetParent?.className }))).toEqual({ parent: "center-area", offsetParent: "center-area" });
});

test("rounded bump feedback is immediate for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ready(page);
  await page.getByRole("button", { name: "Toggle project panel", exact: true }).click();
  const rail = page.getByRole("separator", { name: "Restore project panel", exact: true });
  await rail.hover();
  const grip = rail.locator(".panel-rail-grip");
  await expect(grip).toHaveCSS("transition-duration", "0s");
  await expect(grip.locator("i").first()).toHaveCSS("transition-duration", "0s");
  await expect(grip).toHaveCSS("transform", "matrix(1.14, 0, 0, 1.14, 0, 0)");
  await expect(rail.getByRole("tooltip")).toBeVisible();
});

for (const zoomed of [false, true]) {
  test(`collapsed bump targets leave editor edges usable${zoomed ? " at 1.2 zoom" : ""}`, async ({ page }) => {
    await ready(page);
    if (zoomed) {
      await page.keyboard.press(`${modifier}+=`);
      await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe("1.2");
    }
    for (const panel of [
      { side: "left", name: "project", toggle: "Toggle project panel", direction: 1 },
      { side: "right", name: "AI Assistant", toggle: "Toggle AI Assistant panel", direction: -1 },
      { side: "bottom", name: "terminal", toggle: "Toggle terminal panel", direction: -1 },
    ]) {
      await page.getByRole("button", { name: panel.toggle, exact: true }).click();
      const rail = page.getByRole("separator", { name: `Restore ${panel.name} panel`, exact: true });
      const grip = rail.locator(".panel-rail-grip");
      await expect(rail).toHaveCSS("pointer-events", "none");
      await expect(grip).toHaveCSS("pointer-events", "auto");
      const [bump, center] = await Promise.all([grip.boundingBox(), page.locator(".center-area").boundingBox()]);
      const outside = panel.side === "bottom"
        ? { x: center!.x + 40, y: center!.y + center!.height - 3 }
        : { x: panel.side === "right" ? bump!.x + bump!.width - 3 : bump!.x + 3, y: center!.y + 80 };
      expect(await page.evaluate(point => Boolean(document.elementFromPoint(point.x, point.y)?.closest(".panel-handle")), outside)).toBe(false);
      await page.mouse.move(outside.x, outside.y);
      if (panel.side === "right") {
        const scroller = page.locator(".cm-scroller").first();
        const point = await scroller.evaluate(node => { const rect = node.getBoundingClientRect(); return { x: rect.right - 4, y: rect.top + 80 }; });
        expect(await page.evaluate(point => Boolean(document.elementFromPoint(point.x, point.y)?.closest(".cm-editor")), point)).toBe(true);
      }
      await grip.hover();
      const target = (await grip.boundingBox())!;
      const x = target.x + target.width / 2; const y = target.y + target.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + (panel.side === "bottom" ? 0 : panel.direction * 145), y + (panel.side === "bottom" ? panel.direction * 145 : 0), { steps: 10 });
      await page.mouse.up();
      await expect(page.getByRole("separator", { name: `Resize ${panel.name} panel`, exact: true })).toBeVisible();
      await page.getByRole("button", { name: panel.toggle, exact: true }).click();
      await page.keyboard.press("Tab"); await rail.focus();
      await expect(grip).toHaveCSS("outline-style", "solid");
      await rail.press("Enter");
      await expect(page.getByRole("separator", { name: `Resize ${panel.name} panel`, exact: true })).toBeVisible();
    }
  });
}
