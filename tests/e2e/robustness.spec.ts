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
