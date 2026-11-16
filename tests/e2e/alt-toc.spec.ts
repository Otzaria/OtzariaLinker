import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { distUrl, watchPage } from "./helpers";

/*
 * The alt_toc editor end to end, in the built single file offline: open a book and its links file →
 * links tab → "מבני כותרות" → new structure → fill from the book's headings → gematria numbering →
 * save (undoable) → export: one ZIP with links/, alt_toc/ and _report.txt.
 */
const NL = String.fromCharCode(10);
const BOOK = ["<h1>פרשה א</h1>", "פסוק 1", "<h2>x</h2>", "פסוק 2", "<h2>x</h2>", "פסוק 3", "<h1>פרשה ב</h1>", "<h2>x</h2>", "פסוק 4"].join(NL);
const SHOTS = process.env.SHOTS_DIR;
const LINKS = JSON.stringify([{ line_index_1: 2, heRef_2: "בסיס 1", path_2: "בסיס.txt", line_index_2: 1, "Conection Type": "reference" }]);

test("alt_toc: build a structure from the headings, number it, save, export it with the links", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "חומש שלי.txt", mimeType: "text/plain", buffer: Buffer.from(BOOK) },
    { name: "חומש שלי_links.json", mimeType: "application/json", buffer: Buffer.from(LINKS) },
  ]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });

  await page.getByRole("tab", { name: /קישורים/ }).click();
  await page.getByRole("button", { name: /^מבני כותרות/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByLabel("הספר")).toHaveValue("חומש שלי");
  await dlg.getByLabel("מפתח המבנה החדש (באנגלית)").fill("Parasha");
  await dlg.getByRole("button", { name: "מבנה חדש" }).click();
  await dlg.getByLabel("שם התצוגה של המבנה").fill("פרשה");
  await dlg.getByRole("button", { name: "מילוי מכותרות הספר" }).click();
  await expect(dlg.getByLabel("כותרת צומת 5")).toHaveValue("x");
  await dlg.getByRole("button", { name: "מספור בגימטריה" }).click();
  await expect(dlg.getByLabel("כותרת צומת 2")).toHaveValue("עליה א");
  await expect(dlg.getByLabel("כותרת צומת 3")).toHaveValue("עליה ב");
  await expect(dlg.getByLabel("כותרת צומת 5")).toHaveValue("עליה א");
  await expect(dlg.getByLabel("שורה של עליה ב", { exact: true })).toHaveValue("5");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/alt-toc-editor.png` });
  await dlg.getByRole("button", { name: "שמירה" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole("button", { name: "מבני כותרות (1)" })).toBeVisible();

  // one undoable action
  await page.getByRole("button", { name: "ביטול הפעולה האחרונה" }).click();
  await expect(page.getByRole("button", { name: "מבני כותרות", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ביצוע חוזר" }).click();
  await expect(page.getByRole("button", { name: "מבני כותרות (1)" })).toBeVisible();

  await page.getByRole("button", { name: /^ייצוא/ }).click();
  const exp = page.getByRole("dialog");
  await expect(exp).toContainText("alt_toc/חומש שלי_alt_toc.json");
  await expect(exp).toContainText("חומש שלי_links.json");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/alt-toc-export.png` });
  const download = page.waitForEvent("download");
  await exp.getByRole("button", { name: "הורדת ZIP" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^links-\d{4}-\d\d-\d\d\.zip$/);
  const zip = unzipSync(readFileSync((await file.path())!));
  expect(Object.keys(zip).sort()).toEqual(["_report.txt", "alt_toc/חומש שלי_alt_toc.json", "links/חומש שלי_links.json"]);
  expect(JSON.parse(strFromU8(zip["alt_toc/חומש שלי_alt_toc.json"]!))).toEqual([
    {
      key: "Parasha",
      heTitle: "פרשה",
      nodes: [
        { heTitle: "פרשה א", line: 1, children: [{ heTitle: "עליה א", line: 3 }, { heTitle: "עליה ב", line: 5 }] },
        { heTitle: "פרשה ב", line: 7, children: [{ heTitle: "עליה א", line: 8 }] },
      ],
    },
  ]);
  expect(strFromU8(zip["_report.txt"]!)).toContain("alt_toc/חומש שלי_alt_toc.json  (1 מבנים, 5 צמתים)");
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
