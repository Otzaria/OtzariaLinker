import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import initSqlJs from "sql.js";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The correctness findings of the product audit (docs/reviews/PRODUCT_AUDIT.md), through the built
 * file as a user meets them:
 *   F2  — a text file named "בראשית" is the user's book: sent to the library its link is held back in
 *         plain words (no request for English refs), for private use it is written;
 *   F9  — when every link is held back the export dialog says so, and offers private use;
 *   F12 — a personal database in the Otzaria schema is labelled "מסד אישי", not "מסד אוצריא".
 */
const require = createRequire(import.meta.url);
const nl = String.fromCharCode(10);
const BASE = ["<h1>בראשית</h1>", "<h2>פרק א</h2>", "בראשית ברא אלהים את השמים ואת הארץ.", "והארץ היתה תהו ובהו."];
const COMM = ["<h1>ביאור חדש על בראשית</h1>", "<h2>פרק א</h2>", "בראשית ברא - ביאור.", "תהו ובהו - ביאור."];
const text = (name: string, lines: string[]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(lines.join(nl)) });

async function openFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent("filechooser");
  const pickBtn = page.getByRole("button", { name: "קבצים", exact: true });
  if (!(await pickBtn.isVisible())) await page.getByRole("button", { name: "הוספת מקור" }).click();
  await pickBtn.click();
  await (await chooser).setFiles(files);
}

test("F2 + F9: a link to the user's own בראשית is held back for the library in plain words, and private use writes it", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const sheet = ["line_index_1,heRef_2,path_2,line_index_2,Conection Type", "3,בראשית א,בראשית.txt,3,source"].join(nl);
  await openFiles(page, [text("בראשית.txt", BASE), text("ביאור חדש על בראשית.txt", COMM), { name: "ביאור חדש על בראשית_links.csv", mimeType: "text/csv", buffer: Buffer.from(sheet) }]);
  // the switch is offered where it matters, and is off for the user's files
  const sw = page.locator(".source-row").getByRole("checkbox", { name: "ספרי ספריית אוצריא" });
  await expect(sw).toHaveCount(1, { timeout: 30_000 });
  await expect(sw).not.toBeChecked();

  await page.getByRole("button", { name: /ייצוא/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("הקישור היחיד נעצר")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("אין מה לייצא")).toHaveCount(0);
  await expect(dialog.getByText(/ספר שלכם/)).toBeVisible();
  await expect(dialog.getByText(/ציון ספריא באנגלית/)).toHaveCount(0);
  await dialog.getByRole("button", { name: "ייצוא לשימוש פרטי" }).click();
  await expect(dialog.getByText("ביאור חדש על בראשית_links.json")).toBeVisible();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "הורדת הקובץ" }).click();
  const records = JSON.parse(readFileSync((await (await download).path())!, "utf8"));
  expect(records).toEqual([expect.objectContaining({ line_index_1: 3, path_2: "בראשית.txt", line_index_2: 3 })]);
  expect(records[0].ref_2).toBeUndefined();
  expect(seen.errors).toEqual([]);
});

test("F12: a personal database in the Otzaria schema is labelled personal", async ({ page }) => {
  const seen = watchPage(page);
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const db = new SQL.Database();
  db.exec(readFileSync(resolve("tests/fixtures/schemas/v5.sql"), "utf8"));
  db.run("insert into source(id,name) values(1,'אישי')");
  db.run("insert into category(id,parentId,title,level) values(1,null,'ספרייה אישית',0)");
  db.run("insert into book(id,categoryId,sourceId,title,totalLines) values(1,1,1,'בראשית',4)");
  BASE.forEach((ln, i) => db.run("insert into line(id,bookId,lineIndex,content,heRef,charCount) values(?,?,?,?,?,?)", [i + 1, 1, i, ln, null, ln.length]));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await openFiles(page, [
    { name: "אישי-מקורות.db", mimeType: "application/octet-stream", buffer: Buffer.from(db.export()) },
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
  ]);
  const rows = page.locator(".source-row");
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.filter({ hasText: "אישי-מקורות.db" }).locator(".src-badge")).toHaveText("מסד אישי");
  await expect(rows.filter({ hasText: "seforim.db" }).locator(".src-badge")).toHaveText("מסד אוצריא");
  // the official database's books are the library's: its switch is on; the personal one's is off
  await expect(rows.filter({ hasText: "seforim.db" }).getByRole("checkbox", { name: "ספרי ספריית אוצריא" })).toBeChecked();
  await expect(rows.filter({ hasText: "אישי-מקורות.db" }).getByRole("checkbox", { name: "ספרי ספריית אוצריא" })).not.toBeChecked();
  expect(seen.errors).toEqual([]);
});
