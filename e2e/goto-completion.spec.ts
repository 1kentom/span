import { expect, test } from "@playwright/test";
import { ready } from "./helpers";

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 640 }]) {
  test(`Goto has a fixed 70% viewport height with stable results and preview at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await ready(page);
    await page.evaluate(async () => {
      const componentPath = "/src/components/Goto.tsx";
      const runtimePath = "/node_modules/.vite/deps/solid-js_web.js";
      const [{ Goto }, { render }] = await Promise.all([import(componentPath), import(runtimePath)]);
      const host = document.createElement("div"); host.className = "ide"; host.id = "goto-fixture"; document.body.append(host);
      render(() => Goto({
        files: Array.from({ length: 100 }, (_, index) => ({ path: `src/file-${String(index).padStart(3, "0")}.ts`, name: `file-${String(index).padStart(3, "0")}.ts`, isDir: false })),
        onOpen: () => {}, onClose: () => {}, onOpenFolder: () => {}, onPreview: async () => "const preview = true;\n\nexport default preview;",
      }), host);
    });
    const dialog = page.locator("#goto-fixture").getByRole("dialog", { name: "Goto", exact: true });
    const input = dialog.getByRole("combobox", { name: "Find a file", exact: true });
    await expect(input).toBeFocused(); await expect(dialog.getByRole("option")).toHaveCount(100);
    await expect(dialog.locator(".goto-preview")).toContainText("const preview");
    const before = await dialog.boundingBox(); const previewBefore = await dialog.locator(".goto-preview").boundingBox();
    expect(before).not.toBeNull(); expect(Math.abs(before!.height - viewport.height * 0.7)).toBeLessThan(2);
    const scroll = await dialog.locator(".goto-results").evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.height); expect(scroll.height).toBeGreaterThan(50);
    await input.fill("nothing matches"); await expect(dialog.getByRole("option")).toHaveCount(0); await expect(dialog.locator(".goto-preview")).toContainText("Select a file to preview");
    const empty = await dialog.boundingBox(); const previewEmpty = await dialog.locator(".goto-preview").boundingBox();
    expect(empty!.height).toBeCloseTo(before!.height, 0); expect(previewEmpty!.height).toBeCloseTo(previewBefore!.height, 0); expect(previewEmpty!.y).toBeCloseTo(previewBefore!.y, 0);
    await input.fill("file-050"); await expect(dialog.getByRole("option")).toHaveCount(1); await input.press("Tab");
    await expect(input).toHaveValue("src/file-050.ts"); await expect(input).toBeFocused();
    expect(await input.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, length: element.value.length }))).toEqual({ start: 15, end: 15, length: 15 });
    const single = await dialog.boundingBox(); expect(single!.height).toBeCloseTo(before!.height, 0);
  });
}
