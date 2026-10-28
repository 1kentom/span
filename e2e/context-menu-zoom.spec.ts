import { expect, test } from "@playwright/test";
import { ready } from "./helpers";

for (const factor of [1, 1.2]) {
  test(`context menus and nested submenus fit the visible viewport at CSS zoom ${factor}`, async ({ page }) => {
    await ready(page);
    await page.evaluate(async factor => {
      document.documentElement.style.zoom = String(factor);
      const componentPath = "/src/components/ContextMenu.tsx"; const runtimePath = "/node_modules/.vite/deps/solid-js_web.js";
      const [{ ContextMenu }, { render }] = await Promise.all([import(componentPath), import(runtimePath)]);
      const host = document.createElement("div"); host.className = "ide"; host.id = "menu-zoom-fixture"; document.body.append(host);
      render(() => ContextMenu({ x: 1400, y: 450, label: "Zoomed actions", onClose: () => {}, items: [
        { id: "paths", label: "Copy path", icon: "menu-path", children: Array.from({ length: 50 }, (_, index) => ({ id: `copy-${index}`, label: `Copy path option ${index + 1}`, onSelect: () => {} })) },
        ...Array.from({ length: 11 }, (_, index) => ({ id: `action-${index}`, label: `Action ${index + 1}`, onSelect: () => {} })),
      ] }), host);
    }, factor);
    const menu = page.getByRole("menu", { name: "Zoomed actions", exact: true });
    await expect(menu).toBeVisible();
    const fit = async (selector: typeof menu) => {
      await expect.poll(async () => { const box = await selector.boundingBox(); return !!box && box.x >= 7 && box.y >= 7 && box.x + box.width <= 1440 - 7 && box.y + box.height <= 900 - 7; }).toBe(true);
    };
    await fit(menu);
    await menu.getByRole("menuitem", { name: "Copy path", exact: true }).focus(); await page.keyboard.press("ArrowRight");
    const submenu = page.getByRole("menu", { name: "Copy path", exact: true }); await expect(submenu).toBeVisible(); await fit(submenu);
    await expect(submenu).toHaveClass(/context-submenu-left/);
    expect(await submenu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await page.keyboard.press("Escape"); await expect(submenu).toBeHidden(); await expect(menu.getByRole("menuitem", { name: "Copy path", exact: true })).toBeFocused();
  });
}
