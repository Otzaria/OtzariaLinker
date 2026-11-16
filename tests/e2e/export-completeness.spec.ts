import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * V5 P0-5 through the built file: what the check tab says will not be exported is what the export dialog
 * holds back — a link with an error, and a deletion whose file cannot be written (the library file is only
 * a snapshot from a saved project) — each with its reason, and confirming the snapshot delivers the deletion.
 */
const nl = String.fromCharCode(10);
const text = (name: string, lines: string[]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(lines.join(nl)) });
const BASE = text("ספר יסוד.txt", ["<h1>ספר יסוד</h1>", "<h2>פרק א</h2>", "שורה ראשונה.", "שורה שנייה.", "שורה שלישית."]);
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
      links: [
        // a record of the library's file of "ספר שלי", deleted; the project holds only a snapshot of that file
        { id: "f0", status: "deleted", restoreStatus: "existing", provenance: "file", source: side("ספר שלי", 1), target: side("ספר יסוד", 2), declaredType: "reference", heRef2: "ספר יסוד 3", fileIndex: 0 },
        // on the commentary's title line: a heading, never exported
        { id: "u1", status: "new", provenance: "user", source: side("ביאור על ספר יסוד", 0), target: side("ספר יסוד", 2), declaredType: "reference", heRef2: "ספר יסוד 3" },
        { id: "u2", status: "new", provenance: "user", source: side("ביאור על ספר יסוד", 2), target: side("ספר יסוד", 3), declaredType: "reference", heRef2: "ספר יסוד 4" },
      ],
      rejectedSuggestions: [],
      view: { source: "ביאור על ספר יסוד", target: "ספר יסוד" },
      libraryFiles: [{ title: "ספר שלי", records: 1, hash: "0123abcd" }],
    }),
  ),
};

test("the check and the export dialog hold back the same links and deletions, each with its reason", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([BASE, COMM, PROJECT]);

  await page.getByRole("tab", { name: /בדיקה/ }).click({ timeout: 30_000 });
  await page.getByRole("button", { name: "בדיקת הקישורים" }).click();
  await expect(page.getByText("2 קישורים נבדקו")).toBeVisible();
  const blocked = page.locator(".qa-blocked");
  await expect(blocked).toHaveText("קישור אחד לא ייוצא · מחיקה אחת לא תגיע לספרייה");
  await expect(page.getByText(/מחקתם את הרשומה הזו .* תישאר בספרייה/)).toBeVisible();

  await page.getByRole("button", { name: /^ייצוא/ }).click();
  const dialog = page.getByRole("dialog", { name: "ייצוא קובצי קישורים" });
  await expect(dialog.getByText("קישור אחד לא ייוצא, ולמה")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("1 רשומות שמחקתם יישארו בספרייה, ולמה")).toBeVisible();
  await expect(dialog.getByText(/שורה 1 ב?ספר המקור היא שורת כותרת/)).toBeVisible();
  // the dialog's held set is the check's: the same numbers, by the same rule
  await expect(dialog.locator(".stat.bad")).toHaveText(["1לא ייוצאו (שגיאה)", "1מחיקות שלא יגיעו לספרייה"]);
  // before: an empty "ספר שלי_links.json" was written from the snapshot, replacing the library's file
  await expect(dialog.getByText("ספר שלי_links.json", { exact: true })).toHaveCount(1); // only in the "waits for the library file" box
  await expect(dialog.locator(".files").getByText("ספר שלי_links.json")).toHaveCount(0);

  // the user says the snapshot is the library's current file: the deletion goes into an empty file
  await dialog.getByRole("button", { name: "העותק בפרויקט הוא העדכני" }).click();
  await expect(dialog.locator(".files").getByText("ספר שלי_links.json")).toBeVisible();
  await expect(dialog.getByText(/רשומות שמחקתם יישארו בספרייה/)).toHaveCount(0);
  await expect(dialog.getByText("קישור אחד לא ייוצא, ולמה")).toBeVisible();
  expect(seen.errors).toEqual([]);
});
