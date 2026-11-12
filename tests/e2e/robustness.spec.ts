import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/* Security review #2/#6: a corrupt database must fail with a message, and the app must keep working. */
test("a database with a b-tree cycle is refused with a message, and the next file still opens", async ({ page }) => {
  const seen = watchPage(page);
  await page.goto(distUrl);
  const pick = async (name: string, buffer: Buffer) => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "קבצים", exact: true }).click();
    await (await chooser).setFiles([{ name, mimeType: "application/octet-stream", buffer }]);
  };
  await pick("cycle.db", readFileSync(resolve("tests/fixtures/db/hostile/cycle.db")));
  await expect(page.locator(".notice")).toContainText("לא נפתח", { timeout: 15_000 });
  await pick("ספר.txt", Buffer.from("שורה אחת\nשורה שתיים"));
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 15_000 });
  expect(seen.errors).toEqual([]);
});

test("many notices at once: the newest three are shown, the rest fold into 'N more' (audit F16)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".drop-strip").getByRole("button", { name: "קבצים", exact: true }).click();
  // five broken links files: five error notices, which stay until closed
  await (await chooser).setFiles(["א", "ב", "ג", "ד", "ה"].map((t) => ({ name: `${t}_links.json`, mimeType: "application/json", buffer: Buffer.from(`[{"line_index_1": 1, "path_2": "x.txt"`) })));
  await expect(page.locator(".notice.error")).toHaveCount(3);
  await page.getByRole("button", { name: "עוד 2 הודעות" }).click();
  await expect(page.locator(".notice.error")).toHaveCount(5);
  await page.getByRole("button", { name: "רק ההודעות האחרונות" }).click();
  await expect(page.locator(".notice.error")).toHaveCount(3);
});
