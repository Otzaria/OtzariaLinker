import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * #42 C26 (V7 §3.20): a focusable separator is a widget, and ARIA requires its value (aria-valuenow, with min and
 * max): axe reported aria-required-attr (critical) three times on every workspace screen. The value is the share of
 * the pair's width the earlier panel has, and the arrow keys change it.
 */
const BOOK = (title: string, lines: string[]) => ({ name: `${title}.txt`, mimeType: "text/plain", buffer: Buffer.from([`<h1>${title}</h1>`, ...lines].join("\n"), "utf8") });

test("every panel splitter says its value, and the arrow keys change it", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([BOOK("ספר", ["שורה אחת"]), BOOK("פירוש על ספר", ["פירוש"])]);
  const splitters = page.locator('[role="separator"][tabindex]');
  await expect(splitters.first()).toBeVisible({ timeout: 30_000 });
  const n = await splitters.count();
  expect(n).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < n; i++) {
    const s = splitters.nth(i);
    await expect(s).toHaveAttribute("aria-valuemin", "0");
    await expect(s).toHaveAttribute("aria-valuemax", "100");
    const v = Number(await s.getAttribute("aria-valuenow"));
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(100);
  }
  const first = splitters.first();
  const before = Number(await first.getAttribute("aria-valuenow"));
  await first.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => Number(await first.getAttribute("aria-valuenow"))).not.toBe(before);
  expect(seen.errors).toEqual([]);
});
