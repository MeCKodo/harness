import { expect, test } from "@playwright/test";

test("dashboard renders the user-visible heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
});
