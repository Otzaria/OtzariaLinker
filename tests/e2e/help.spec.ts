import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

test("help: F1 and the app-bar button open the guide; chapters navigate inside it; Esc closes", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(distUrl);

  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", { name: /עזרה/ });
  await expect(help).toBeVisible();
  await expect(help.getByRole("heading", { level: 1 })).toContainText("מדריך למשתמש");
  // markdown was rendered, not shown raw
  await expect(help.locator("table").first()).toBeVisible();
  await expect(help.locator("kbd").first()).toBeVisible();

  const nav = help.getByRole("navigation", { name: "פרקי המדריך" });
  await nav.getByRole("link", { name: /^8\. / }).click();
  await expect(nav.getByRole("link", { name: /^8\. / })).toHaveAttribute("aria-current", "location");
  await expect(help.locator('h2[id^="8-"]')).toBeInViewport();
  expect(page.url()).toBe(distUrl); // an in-guide link never navigates the page

  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();

  await page.getByRole("button", { name: "עזרה" }).click();
  await expect(help).toBeVisible();
  await help.getByRole("button", { name: "סגירת העזרה" }).click();
  await expect(help).toBeHidden();

  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
