import { expect, test } from "@playwright/test";

test("breadcrumb folder menus show decoded decorative file icons without changing navigation", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "rpc-node.ts", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Active file path" }).getByRole("button", { name: "src", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Browse folder" });
  const entry = menu.getByRole("menuitem", { name: "rpc.ts", exact: true });
  await expect(entry.locator('.material-file-icon[aria-hidden="true"]')).toHaveCount(1);
  await expect(entry.locator("img").first()).toHaveAttribute("alt", "");
  await expect.poll(() => entry.locator("img").first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("breadcrumb-menu-icons.png") });
  await entry.click();
  await expect(page.getByRole("tab", { name: "rpc.ts", exact: true })).toHaveAttribute("aria-selected", "true");
});
