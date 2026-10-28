import { expect, test } from "@playwright/test";

for (const surface of ["file", "folder", "tab", "editor", "breadcrumb"] as const) {
  test(`path copy uses the ordinary copy glyph in ${surface} menus`, async ({ page }, testInfo) => {
    await page.goto("/");
    await expect(page.getByRole("tab", { name: "rpc-node.ts", exact: true })).toBeVisible();
    const source = surface === "tab" ? page.getByRole("tab", { name: "rpc-node.ts", exact: true })
      : surface === "editor" ? page.getByRole("textbox", { name: "Edit rpc-node.ts", exact: true })
      : surface === "breadcrumb" ? page.getByRole("navigation", { name: "Active file path" }).getByRole("button", { name: "rpc-node.ts", exact: true })
      : page.getByRole("treeitem").filter({ hasText: surface === "folder" ? /^assets$/ : /^rpc-node\.ts$/ });
    await source.click({ button: "right" });
    const paths = page.getByRole("menuitem", { name: "Copy path", exact: true });
    await expect(paths.locator(".icon").first()).toHaveCSS("mask-image", /rounded-linear\/copy\.svg/);
    await paths.hover();
    for (const name of ["Copy filename", "Copy relative path", "Copy absolute path"]) {
      const item = page.getByRole("menuitem", { name, exact: true });
      await expect(item).toBeVisible();
      await expect(item.locator(".icon").first()).toHaveCSS("mask-image", /rounded-linear\/copy\.svg/);
    }
    if (surface === "breadcrumb") await page.screenshot({ path: testInfo.outputPath("copy-path-plain-copy.png") });
  });
}
