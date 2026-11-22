import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;

test("headings engine: run in the worker → table → approve all certain → card view → undo", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const heb = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ"];
  // a commentary the database has no links for (Onkelos is already linked there: it would show as "exists")
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...heb.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join(String.fromCharCode(10));
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
  ]);

  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();

  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  const approveAll = page.getByRole("button", { name: /אישור כל הוודאיות/ });
  await expect(approveAll).toBeEnabled({ timeout: 30_000 });
  const n = Number((await approveAll.textContent())!.match(/\(([\d,]+)\)/)![1]!.replace(/,/g, ""));
  expect(n).toBe(20);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/8-suggestions-table.png` });

  await approveAll.click();
  await expect(approveAll).toBeDisabled();
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText(n.toLocaleString("en"));

  await page.getByRole("radio", { name: "כרטיס" }).click();
  await expect(page.getByRole("button", { name: /אישור/ }).first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/9-suggestions-card.png` });

  await page.keyboard.press("Control+z");
  await page.getByRole("radio", { name: "טבלה" }).click();
  await expect(page.getByRole("button", { name: /אישור כל הוודאיות/ })).toBeEnabled();
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 8: the table (and the card view) can be sorted — weakest suggestions first, so the ones that need a human eye
 * come before the certain ones — and the choice is kept when the view changes. Default: the book's order.
 */
test("sort the suggestions: weakest first, strongest first, and back to the book's order; the card view follows", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  // Rashi on Bereshit against Bereshit by the opening words (the real database slice): the levels differ from line to line
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: 'רש"י על בראשית' }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await page.getByRole("button", { name: "הכול", exact: true }).click({ timeout: 30_000 });
  await expect(page.locator("table.sug-table tbody tr").first()).toBeVisible({ timeout: 30_000 });

  const sort = page.getByLabel("מיון ההצעות");
  await expect(sort).toHaveValue("book");
  const levels = () => page.locator("table.sug-table tbody tr .conf").allTextContents();
  const lines = () => page.locator("table.sug-table tbody tr td:nth-child(2)").allTextContents();
  const RANK = ["ודאית", "גבוהה", "אפשרית", "עמומה", "אין התאמה"];
  const book = await lines();
  const bookLevels = await levels();
  expect(new Set(bookLevels).size, "the sample has more than one level").toBeGreaterThan(1);

  await sort.selectOption("worst");
  const worst = (await levels()).map((l) => RANK.indexOf(l));
  expect(worst).toEqual([...worst].sort((a, b) => b - a));
  await expect(page.locator("table.sug-table tbody tr .score").first()).toContainText("%");

  await sort.selectOption("best");
  const best = (await levels()).map((l) => RANK.indexOf(l));
  expect(best).toEqual([...best].sort((a, b) => a - b));
  expect(best[0]).toBe(Math.min(...best));

  // the card view reads the same order: it starts on the table's first row... and stepping goes down the same list
  await page.getByRole("radio", { name: "כרטיס" }).click();
  await expect(page.getByLabel("מיון ההצעות")).toHaveValue("best");
  await expect(page.locator(".builder .conf").first()).toHaveText(RANK[Math.min(...best)]!);

  await page.getByRole("radio", { name: "טבלה" }).click();
  await page.getByLabel("מיון ההצעות").selectOption("book");
  await page.getByRole("button", { name: "הכול", exact: true }).click();
  expect(await lines()).toEqual(book);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 12: both ends of a suggestion are numbered — the source line in its own column, the target line under the place
 * name — in the table, in the one-at-a-time view and on the card, and the number is the one the reader shows.
 */
test("a suggestion shows the target's line number in the table, the step view and the card — the one the reader marks", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: 'רש"י על בראשית' }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await page.getByRole("button", { name: "הכול", exact: true }).click({ timeout: 30_000 });
  const row = page.locator("table.sug-table tbody tr").nth(2);
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.click();
  const marked = await page.locator(".reader.target .ln.picked").first().getAttribute("data-i");
  const n = Number(marked) + 1;
  const place = new RegExp(String.raw`שור(?:ה|ות) ${n}(?!\d)`);
  await expect(row.locator("td").nth(2)).toContainText(place);
  await expect(row.getByRole("checkbox")).toHaveAccessibleName(place);

  await page.getByRole("radio", { name: "בתוך הטקסט" }).click();
  await expect(page.locator(".builder .end.source.set")).toContainText(place);
  await page.getByRole("radio", { name: "כרטיס" }).click();
  await expect(page.locator(".builder .end.target.set .side-badge")).toContainText(/שור(?:ה|ות) \d+/);
  await expect(page.locator(".builder .end.source.set .side-badge")).toContainText(/שור(?:ה|ות) \d+/);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 19: the two sides are named by the job — the commentary and its base, the book body and its notes, the citing and
 * the cited book — and by the neutral "מקור"/"יעד" when no job is known (the manual builder). The ids stay `source` and
 * `target`: the screens carry data-side, which is what tests hold on to.
 */
test("the sides are named by the job: commentary and base, body and notes, citing and cited — and by data-side", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
  const badge = (side: "source" | "target") => page.locator(`.reader[data-side="${side}"] .panel-head .side-badge`);
  const pickBtn = (side: "source" | "target") => page.locator(`.book-list li button.side-btn[data-side="${side}"]`).first();

  // no job yet: the neutral pair
  await expect(badge("source")).toHaveText("מקור");
  await expect(badge("target")).toHaveText("יעד");
  await expect(pickBtn("source")).toHaveText("מקור");

  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "לפי כותרות" });
  await expect(badge("source")).toHaveText("פירוש");
  await expect(badge("target")).toHaveText("בסיס");
  await expect(page.locator('.reader[data-side="source"]')).toHaveAccessibleName("ספר הפירוש");
  await expect(pickBtn("target")).toHaveText("בסיס");
  await expect(pickBtn("target")).toHaveAttribute("title", /ספר הבסיס/);

  await page.getByLabel("שיטה").selectOption({ label: "הערות שוליים" });
  await expect(badge("source")).toHaveText("גוף הספר");
  await expect(badge("target")).toHaveText("הערות");
  await expect(page.locator('.reader[data-side="target"]')).toHaveAccessibleName("ספר ההערות");

  await page.getByLabel("שיטה").selectOption({ label: "מראי מקומות" });
  await expect(badge("source")).toHaveText("מפנה");
  await expect(page.locator('.reader[data-side="source"]')).toHaveAccessibleName("הספר המפנה");

  // the ids did not move: the first book list button of a side still shows the book in that reader
  await page.getByLabel("שיטה").selectOption({ label: "לפי כותרות" });
  await pickBtn("source").click();
  await pickBtn("target").click();
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 11: the words the dibur-hamatchil engine matched are marked on both texts — in the card (tinted and underlined,
 * announced to a screen reader) and, where the browser supports the highlight API, in the readers.
 */
test("dibur hamatchil: the matched words are marked on both texts in the card and in the readers", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: 'רש"י על בראשית' }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await page.getByRole("button", { name: "הכול", exact: true }).click({ timeout: 30_000 });
  await expect(page.locator("table.sug-table tbody tr").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("radio", { name: "כרטיס" }).click();

  const marks = page.locator(".builder mark.match-hl");
  await expect(marks).toHaveCount(2, { timeout: 15_000 });
  // each marked run is a piece of the line it is in, and it is announced
  for (const side of ["source", "target"] as const) {
    const box = page.locator(`.builder .end.${side}.set .snip`);
    const marked = (await box.locator("mark.match-hl").textContent())!;
    expect(marked.trim().length).toBeGreaterThan(1);
    expect((await box.textContent())!).toContain(marked);
    await expect(box.locator(".sr-only")).toHaveText(/מילים שהותאמו/);
  }
  // not colour alone: the mark is underlined
  expect(await marks.first().evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("underline");
  await expect(page.locator(".match-legend")).toBeVisible();

  // in the readers: the same words painted with the highlight API (Chrome and Edge have it; Firefox shows the card only)
  const painted = await page.evaluate(() => {
    const h = (globalThis as unknown as { CSS?: { highlights?: Map<string, { size: number }> } }).CSS?.highlights;
    if (!h) return null;
    return ["match-source", "match-target"].map((n) => h.get(n)?.size ?? 0);
  });
  if (painted) expect(painted.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 26: in pair mode one book can be linked against several targets at once, with every method that fits the pair
 * merged into one run (instead of choosing one method and one target).
 */
test("pair mode: one book against several targets, all methods merged into one run", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const heb = ["א", "ב", "ג", "ד", "ה"];
  const nl = String.fromCharCode(10);
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...heb.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join(nl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
  ]);
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();

  // folded by default: one target, one method
  const more = page.locator("details.more-targets");
  await expect(more).not.toHaveAttribute("open", "");
  await more.locator("summary").click();
  await more.getByRole("group", { name: "עוד ספרי יעד" }).getByRole("checkbox", { name: /^רש"י על בראשית/ }).check();
  await page.getByRole("checkbox", { name: /כל השיטות שמתאימות, מאוחדות/ }).check();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await expect(page.locator(".sug-table tbody tr").first()).toBeVisible({ timeout: 60_000 });
  // one run holding both targets: the summary is a merged (max-link style) run over the two pairs
  await expect(page.locator(".sug-head")).toContainText("קישור מרבי");
  await expect(page.locator(".sug-head")).toContainText("בראשית");
  await expect(page.locator(".sug-head")).toContainText('רש"י על בראשית');
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * 3.7: the suggestions table says which method found each suggestion and what link type it would be — as columns where
 * the panel is wide, and as a line under the target where it is narrow (a phone, or the narrow side panel).
 */
test("suggestions table: the method and the link type of each suggestion, as columns when wide and a line when narrow", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: 'רש"י על בראשית' }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await page.getByRole("button", { name: "הכול", exact: true }).click({ timeout: 30_000 });
  const row = page.locator("table.sug-table tbody tr").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("table.sug-table th.col-meta")).toHaveCount(2);
  await expect(row.locator(".meta-inline")).toContainText("דיבור המתחיל");
  await expect(row.locator(".meta-inline")).toContainText("מקור — מפירוש אל ספר הבסיס"); // the direction type says which way it runs
  await expect(row.locator("td.col-meta").first()).toHaveText("לפי דיבור המתחיל");
  // exactly one of the two forms is on the screen, at whatever width the panel has
  const shown = await row.evaluate((tr) => [getComputedStyle(tr.querySelector(".meta-inline")!).display !== "none", getComputedStyle(tr.querySelector("td.col-meta")!).display !== "none"]);
  expect(shown.filter(Boolean)).toHaveLength(1);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
