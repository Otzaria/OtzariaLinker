import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * 3.8: links.csv for the personal-database build, as a format in the export dialog (advanced mode): the links between a book of
 * the user's own and a book of the official database, one row per line of the personal book. The dialog says when to use it
 * instead of the _links.json files, lists the files and what could not be written (and why), and the check the importer would make.
 * Nothing is written to a database: the result is a ZIP of files.
 */
const nl = String.fromCharCode(10);

test("export: links.csv for a personal library — when to use it, the files, what is left out and why, and the download", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  // a book of mine, with two links to בראשית of the official database: one a commentary-like "source" link, one a type the csv has no word for
  const rec = (l1: number, l2: number, type: string) => `${l1},בראשית,בראשית.txt,${l2},${type}`;
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ספר שלי.txt", mimeType: "text/plain", buffer: Buffer.from(["<h1>ספר שלי</h1>", "שורה ב", "שורה ג", "שורה ד"].join(nl)) },
    { name: "ספר שלי_links.csv", mimeType: "text/csv", buffer: Buffer.from(["line_index_1,heRef_2,path_2,line_index_2,Conection Type", rec(2, 3, "source"), rec(3, 4, "reference")].join(nl)) },
  ]);
  await page.getByRole("tab", { name: /בדיקה/ }).click({ timeout: 30_000 });
  await page.getByRole("checkbox", { name: "מצב מתקדם" }).check();
  await page.getByRole("button", { name: /^ייצוא/ }).click();
  const dialog = page.getByRole("dialog", { name: "ייצוא קובצי קישורים" });
  const format = dialog.getByLabel("פורמט קובצי הקישורים");
  await expect(format).toBeVisible({ timeout: 30_000 });
  await format.selectOption("personal-csv");

  // when to use it, instead of the _links.json files
  const about = dialog.locator(".personal-csv-about");
  await expect(about).toContainText("מתי לבחור בזה");
  await expect(about).toContainText("ספרייה אישית");
  await expect(about).toContainText("הכלי לא כותב לשום מסד");
  // the file, with its rows; what the format cannot say is listed with the reason
  await expect(dialog.locator(".files")).toContainText("links.csv", { timeout: 30_000 });
  await expect(dialog.locator(".files")).toContainText("שורה אחת");
  const left = dialog.locator("details.held").filter({ hasText: "ב־links.csv, ולמה" });
  await expect(left).toContainText("קישור אחד לא ייכלל");
  await left.locator("summary").click();
  await expect(left.locator("li")).toHaveCount(1);

  // the download is a ZIP laid out as the build expects, with the one row
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /^הורדת/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.zip$/);
  const zip = unzipSync(new Uint8Array(readFileSync((await file.path())!)));
  expect(Object.keys(zip)).toEqual(["קישורים/01/links.csv"]);
  const csv = strFromU8(zip["קישורים/01/links.csv"]!);
  expect(csv).toContain("ספר שלי");
  expect(csv.trim().split(/\r?\n/)).toHaveLength(2); // the header and the one row
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
