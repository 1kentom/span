import { expect, test } from "@playwright/test";

test("browser preview exposes agent unavailability without synthetic responses", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Agents require the desktop app", { exact: true })).toBeVisible();
  await expect(page.getByText("This browser preview cannot start local agent processes, so nothing here talks to an agent.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send prompt", exact: true })).toBeDisabled();
  await expect(page.getByText("Browser preview · agent unavailable", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Select agent", exact: true }).click();
  const agents = page.getByRole("dialog", { name: "Agents", exact: true });
  await expect(agents.getByText("Open span desktop to connect an ACP agent.", { exact: true })).toBeVisible();
  await expect(agents.getByRole("button")).toHaveCount(0);
});
