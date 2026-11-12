import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Max-link in the built single file: a "folder" of text files — a commentary on a book of the
 * database, and a book with its notes book — against the real database slice. Review the plan, run,
 * read the report, approve the certain suggestions, undo.
 */
const SHOTS = process.env.SHOTS_DIR;

test("max-link: a folder of a commentary and a notes book against the database → plan → run → approve certain → undo", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const heb = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
  const nl = String.fromCharCode(10);
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...heb.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join(nl);
  const main = ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."].join(nl);
  const notes = ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."].join(nl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
    { name: "ספר דוגמה.txt", mimeType: "text/plain", buffer: Buffer.from(main) },
    { name: "הערות לספר דוגמה.txt", mimeType: "text/plain", buffer: Buffer.from(notes) },
  ]);
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  // the folder is chosen by default; the plan: the commentary (two engines), the notes book (footnotes),
  // and the citations engine once on each of the three books
  await expect(page.getByRole("radio", { name: "מקור או תיקייה" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("status").filter({ hasText: "ספרים נבחרו" })).toContainText("6 הרצות");
  const engines = page.getByRole("group", { name: "השיטות שירוצו" });
  await expect(engines.getByRole("checkbox")).toHaveCount(4);
  await page.locator("summary", { hasText: "למה כל ספר" }).click();
  await expect(page.locator(".ml-books")).toContainText("ספר הערות על");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/maxlink-plan.png` });

  // untick and tick again: the count follows
  await engines.getByRole("checkbox", { name: /לפי דיבור המתחיל/ }).uncheck();
  await expect(page.getByRole("status").filter({ hasText: "ספרים נבחרו" })).toContainText("5 הרצות");
  await engines.getByRole("checkbox", { name: /לפי דיבור המתחיל/ }).check();

  // advanced mode: every planned engine has its settings; an invalid one blocks the run
  await page.getByRole("radio", { name: "שני ספרים" }).click();
  await page.getByRole("button", { name: "הגדרות השיטה (מצב מתקדם)" }).click();
  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  const run = page.getByRole("button", { name: "הפעלת קישור מרבי" });
  await expect(page.locator("details.engine-options")).toHaveCount(4);
  const notesForm = page.getByRole("region", { name: "הגדרות: הערות שוליים" });
  await notesForm.locator("summary").click();
  await notesForm.getByLabel("סימני ההערות בספר").selectOption("regex");
  await notesForm.getByLabel("הביטוי הרגולרי").fill("(a+)+");
  await expect(run).toBeDisabled();
  await notesForm.getByLabel("סימני ההערות בספר").selectOption("auto");
  await expect(run).toBeEnabled();

  await run.click();
  const report = page.locator("details.ml-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report.locator("summary").first()).toContainText("דוח הקישור המרבי");
  await expect(page.getByRole("table", { name: "הצעות" }).locator("tbody tr").first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/maxlink-report.png` });

  const approveAll = page.getByRole("button", { name: /אישור כל הוודאיות/ });
  await expect(approveAll).toBeEnabled();
  const n = Number((await approveAll.textContent())!.match(/\(([\d,]+)\)/)![1]!.replace(/,/g, ""));
  expect(n).toBe(13); // 10 verses (headings) + 3 footnote markers; the books cite nothing
  await approveAll.click();
  await expect(approveAll).toBeDisabled();
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText(String(n));
  await expect(report.locator(".tile-approved dd")).toHaveText(String(n));

  await page.keyboard.press("Control+z");
  await expect(approveAll).toBeEnabled();
  await expect(report.locator(".tile-approved dd")).toHaveText("0");
  expect(await page.evaluate(() => (globalThis as unknown as { __linker: { allLinks: { value: unknown[] } } }).__linker.allLinks.value.length)).toBe(0);

  // the report downloads as CSV
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "ייצוא הדוח (CSV)" }).click();
  expect((await download).suggestedFilename()).toMatch(/^קישור-מרבי-.*\.csv$/);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
