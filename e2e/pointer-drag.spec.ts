import { expect, test, type Locator, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "package.json", exact: true })).toBeVisible();
  // WebView2's native OS drop handler can intercept HTML drag events. Internal
  // movement must work without a browser DataTransfer or dragstart lifecycle.
  await page.evaluate(() => document.addEventListener("dragstart", event => event.preventDefault(), true));
}
async function move(page: Page, source: Locator, target: Locator, finish = true) {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox(); const to = await target.boundingBox();
  if (!from || !to) throw new Error("Drag endpoints must be visible");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  if (finish) await page.mouse.up();
}

test("internal pointer dragging works while native HTML dragging is blocked", async ({ page }) => {
  await ready(page); await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const first = page.getByRole("region", { name: "Editor group 1", exact: true });
  const second = page.getByRole("region", { name: "Editor group 2", exact: true });
  await move(page, first.getByRole("tab", { name: "package.json", exact: true }), second.locator(".editor-documents"));
  await expect(first.getByRole("tab", { name: "package.json", exact: true })).toHaveCount(0);
  await expect(second.getByRole("tab", { name: "package.json", exact: true })).toHaveAttribute("aria-selected", "true");
  const file = page.getByRole("treeitem").filter({ hasText: /^\.env\.local$/ });
  await move(page, file, second.locator(".editor-documents"));
  await expect(second.getByRole("textbox", { name: "Edit .env.local", exact: true })).toBeVisible();
});

test("Alt-copy preserves dirty shared text and cancellation never moves the tab", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const first = page.getByRole("region", { name: "Editor group 1", exact: true });
  const second = page.getByRole("region", { name: "Editor group 2", exact: true });
  await first.getByRole("tab", { name: "package.json", exact: true }).click();
  const editor = first.getByRole("textbox", { name: "Edit package.json", exact: true });
  await editor.press("End"); await editor.press("Enter"); await editor.pressSequentially("dirty-pointer-text");
  await page.keyboard.down("Alt"); await move(page, first.getByRole("tab", { name: "package.json", exact: true }), second.locator(".editor-documents")); await page.keyboard.up("Alt");
  await expect(first.getByRole("tab", { name: "package.json", exact: true })).toHaveCount(1);
  await expect(second.getByRole("textbox", { name: "Edit package.json", exact: true })).toContainText("dirty-pointer-text");
  await expect(first.locator(".dirty-dot")).not.toHaveCount(0);
  for (const cancel of ["Escape", "pointercancel", "blur"]) {
    await move(page, first.getByRole("tab", { name: "package.json", exact: true }), second.locator(".editor-documents"), false);
    await expect(page.locator(".internal-drag-preview")).toBeVisible();
    if (cancel === "Escape") await page.keyboard.press("Escape");
    else await page.evaluate(kind => window.dispatchEvent(kind === "blur" ? new Event("blur") : new PointerEvent("pointercancel", { pointerId: 1 })), cancel);
    await page.mouse.up();
    await expect(page.locator(".internal-drag-preview")).toHaveCount(0);
    await expect(first.getByRole("tab", { name: "package.json", exact: true })).toHaveCount(1);
    await expect(editor).toContainText("dirty-pointer-text");
  }
});

test("click threshold, invalid areas and close buttons preserve normal actions", async ({ page }) => {
  await ready(page);
  const tab = page.getByRole("tab", { name: "package.json", exact: true }); const box = (await tab.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 23, box.y + 12); await page.mouse.up();
  await expect(tab).toHaveAttribute("aria-selected", "true"); await expect(page.locator(".internal-drag-preview")).toHaveCount(0);
  await move(page, tab, page.getByRole("button", { name: "Settings", exact: true }));
  await expect(tab).toHaveCount(1); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Close package.json", exact: true }).click();
  await expect(tab).toHaveCount(0);
});

test("removed source groups cancel safely and CSS zoom keeps hit testing aligned", async ({ page }, testInfo) => {
  await ready(page); await page.getByRole("button", { name: "Split editor", exact: true }).click();
  const first = page.getByRole("region", { name: "Editor group 1", exact: true });
  const second = page.getByRole("region", { name: "Editor group 2", exact: true });
  await page.evaluate(() => { document.documentElement.style.zoom = "1.2"; document.querySelector<HTMLElement>(".ide")!.style.height = "calc(100dvh / 1.2)"; });
  await move(page, first.getByRole("tab", { name: "package.json", exact: true }), second.locator(".editor-documents"), false);
  await expect(page.locator(".internal-drag-preview")).toBeVisible();
  await expect(second).toHaveCSS("box-shadow", /inset/);
  await page.screenshot({ path: testInfo.outputPath("pointer-drag-zoom.png") });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('[aria-label="Close editor group 1"]')!.click());
  await expect(first).toHaveCount(0); await page.mouse.up();
  await expect(page.locator(".internal-drag-preview")).toHaveCount(0);
  await expect(second.getByRole("tab", { name: "package.json", exact: true })).toHaveCount(0);
});
