import { expect, test } from "@playwright/test";

// Browser preview only: the trust port is the labelled PREVIEW FIXTURE (ui/src/lib/workspace-trust.ts), not the backend.
test("the trust question is asked once, as a centred modal, and not again", async ({ page }) => {
  await page.goto("/?trust=prompt");
  const dialog = page.getByRole("dialog", { name: "Do you trust this folder?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("pom.xml")).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(4);
  // The sample root /preview/intellij has no parent folder narrow enough to trust as a whole.
  await expect(dialog.getByLabel(/Trust all folders in/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "Trust folder" }).click();
  await expect(dialog).toHaveCount(0);
  // A reload is a new app session in the fixture, so it asks again; Escape leaves it undecided.
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("no question without the fixture prompt", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: "Do you trust this folder?" })).toHaveCount(0);
});
