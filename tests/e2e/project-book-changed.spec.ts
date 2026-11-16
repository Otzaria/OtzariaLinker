import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * V5 P1-10 through the built file: a saved project reopened after one of its books was edited. The user
 * is told which book changed, the check marks its links, and "the links were checked" clears it.
 */
const nl = String.fromCharCode(10);
const text = (name: string, lines: string[]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(lines.join(nl)) });
// saved when "ספר יסוד" had 5 lines; a line was added at the top since
const BASE = text("ספר יסוד.txt", ["<h1>ספר יסוד</h1>", "הקדמה שנוספה.", "<h2>פרק א</h2>", "שורה ראשונה.", "שורה שנייה.", "שורה שלישית."]);
const COMM = text("ביאור על ספר יסוד.txt", ["<h1>ביאור על ספר יסוד</h1>", "<h2>פרק א</h2>", "ביאור ראשון.", "ביאור שני."]);
const side = (title: string, line: number) => ({ book: { title, origin: "otzaria" }, line });
const PROJECT = {
  name: "עבודה.otzlinker.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      format: "otzaria-linker-project",
      version: 1,
      savedAt: "2026-11-01T10:00:00.000Z",
      app: "4.0.0",
      sources: [],
      links: [{ id: "u1", status: "new", provenance: "user", source: side("ביאור על ספר יסוד", 2), target: side("ספר יסוד", 2), declaredType: "reference", heRef2: "ספר יסוד 3" }],
      rejectedSuggestions: [],
      view: { source: "ביאור על ספר יסוד", target: "ספר יסוד" },
      bookLines: [{ title: "ספר יסוד", lines: 5 }, { title: "ביאור על ספר יסוד", lines: 4 }],
    }),
  ),
};

test("a book edited since the project was saved is named, its links are marked, and the user can clear it", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([BASE, COMM, PROJECT]);
  await expect(page.getByText(/ספר אחד השתנה מאז שהפרויקט נשמר/).first()).toBeVisible({ timeout: 30_000 });

  await page.getByRole("tab", { name: /בדיקה/ }).click();
  await page.getByRole("button", { name: "בדיקת הקישורים" }).click();
  await expect(page.getByRole("button", { name: "הספר השתנה 1", exact: true })).toBeVisible();
  await expect(page.getByText(/היו בו 5 שורות, ועכשיו 6/)).toBeVisible();
  await page.getByRole("button", { name: "הקישורים נבדקו" }).click();
  await expect(page.getByRole("button", { name: /^הספר השתנה/ })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});
