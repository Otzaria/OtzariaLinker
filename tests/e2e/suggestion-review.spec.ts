import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Reviewing suggestions (V7 §3.11, findings #41 B22): a commentary written verse by verse against the real Bereshit slice,
 * run by headings in the worker of the built file.
 */
/** a suggestion row's height at most in the narrow panel (#41 B23: 160px in the review; 125px on this fixture before, 75px after) */
const ROW_MAX = 80;
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ"];

async function headingsRun(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto(distUrl);
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join("\n");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
  ]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await expect(page.getByRole("button", { name: /אישור כל הוודאיות/ })).toBeEnabled({ timeout: 30_000 });
  return page.getByRole("table", { name: "הצעות" });
}

test("filter by method, decide from the keyboard on a row, and take a selection back to pending (V7 §3.11)", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  // the first verses open with the verse's own words (dibur hamatchil and headings both find them), the rest only by their heading
  const openings = ["בראשית ברא", "והארץ היתה תהו", "ויאמר אלהים יהי אור", "וירא אלהים את האור"];
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.slice(0, 8).flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `${openings[i] ? `${openings[i]} - ` : ""}ביאור לפסוק ${i + 1}`])].join("\n");
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
  ]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("radio", { name: /כל השיטות שמתאימות, מאוחדות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  const rows = page.getByRole("table", { name: "הצעות" }).locator("tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "הכול", exact: true }).click();
  const all = await rows.count();

  // two methods ran: the filter is offered (every method, and each one), and narrows to the suggestions that method found
  const byEngine = page.getByRole("combobox", { name: "סינון לפי שיטה" });
  await expect(byEngine.locator("option")).toHaveCount(3);
  await byEngine.selectOption({ index: 2 });
  const fewer = await rows.count();
  expect(fewer).toBeGreaterThan(0);
  expect(fewer).toBeLessThan(all);
  await byEngine.selectOption({ index: 0 });
  await expect(rows).toHaveCount(all);
  // one target book: there is nothing to choose between
  await expect(page.getByRole("combobox", { name: "סינון לפי ספר היעד" })).toHaveCount(0);
  // each confidence chip says what the level means
  await expect(page.locator(".filters .chip.conf-certain")).toHaveAttribute("title", /אישור כל הוודאיות/);

  // the keyboard on a focused row: A approves, U takes it back, R rejects
  const row = rows.first();
  await row.focus();
  await page.keyboard.press("a");
  await expect(row).toHaveClass(/st-approved/);
  await page.keyboard.press("u");
  await expect(row).toHaveClass(/st-pending/);
  await page.keyboard.press("r");
  await expect(row).toHaveClass(/st-rejected/);

  // a selection of decided rows goes back to pending in one step
  await rows.nth(1).locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: /^אישור 1$/ }).click();
  await rows.nth(0).locator("input[type=checkbox]").check();
  await rows.nth(1).locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "החזרה להמתנה" }).click();
  await expect(rows.nth(0)).toHaveClass(/st-pending/);
  await expect(rows.nth(1)).toHaveClass(/st-pending/);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("a citations search: the bar says its stage, and a cancel keeps the run on the screen with a re-run (#41 B11)", async ({ page }) => {
  const seen = watchPage(page);
  const lines = ["<h1>חיבור גדול</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 160_000 }, (_, i) => `שורה ${i + 1} כמו שנאמר (בראשית א, ${["א", "ב", "ג", "כח"][i % 4]}) ועוד מילים.`)];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "חיבור גדול.txt", mimeType: "text/plain", buffer: Buffer.from(lines.join("\n")) },
  ]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "חיבור גדול" }).first().locator('button.side-btn[data-side="source"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "מראי מקומות" });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  const task = page.locator(".app-bar .task");
  // the stage, never a bare bar: preparing, then reading the book
  await expect(task.locator(".task-count")).toHaveText(/מכין|קורא את הספר/);
  await task.getByRole("button", { name: "ביטול" }).click();
  await expect(task).toHaveCount(0, { timeout: 20_000 });
  // the run stays: the form does not come back, and the panel says the run stopped and offers it again
  await expect(page.getByRole("button", { name: "חיפוש התאמות" })).toHaveCount(0);
  const stopped = page.locator(".sug-results li.warning", { hasText: "הריצה נעצרה" });
  await expect(stopped).toBeVisible();
  await stopped.getByRole("button", { name: "הרצה חוזרת" }).click();
  // the whole search this time: it ends by itself, whole
  await expect(stopped).toHaveCount(0, { timeout: 90_000 });
  await expect(page.getByRole("table", { name: "הצעות" }).locator("tbody tr").first()).toBeVisible();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * V7 §3.8 and #42 C16: the run form says how many methods run — the one chosen, several ticked, or every one that fits — and which
 * ones will run and why; the line filter's preview is there in a batch and in max-link too, on any of their books.
 */
test("the methods that will run and why; the line filter's preview in pair, batch and max-link (V7 §3.8, #42 C16)", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const commentary = (n: number) => [`<h1>פירוש ${n} על בראשית</h1>`, "[א] <b>בראשית ברא אלהים</b> – פירוש", "<b>והארץ היתה תהו</b> – בלי סימן", "[ב] <b>ויאמר אלהים יהי אור</b> – פירוש"].join("\n");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "פירוש 1 על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(commentary(1)) },
    { name: "פירוש 2 על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(commentary(2)) },
  ]);
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "פירוש 1 על בראשית" }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();

  // pair: one method by default; "every method that fits" lists the methods the plan runs, each with its reason
  const how = page.getByRole("radiogroup", { name: "כמה שיטות" });
  await expect(how.getByRole("radio", { name: "השיטה שבחרתם" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("list", { name: "מה ירוץ" })).toHaveCount(0);
  await how.getByRole("radio", { name: /כל השיטות שמתאימות/ }).click();
  const plan = page.getByRole("list", { name: "מה ירוץ" });
  await expect(plan.locator("li").first()).toBeVisible();
  await expect(plan).toContainText("דיבור המתחיל");
  // several chosen: only the ticked ones run
  await how.getByRole("radio", { name: "כמה שיטות שאבחר" }).click();
  await page.getByRole("group", { name: "השיטות שירוצו" }).getByRole("checkbox", { name: "לפי כותרות" }).uncheck();
  await expect(plan).not.toContainText("לפי כותרות");
  await expect(plan).toContainText("דיבור המתחיל");
  await how.getByRole("radio", { name: "השיטה שבחרתם" }).click();

  // the line filter of dibur hamatchil: its preview in a pair
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });
  await page.getByLabel("אילו שורות של הספר המקשר נכנסות").selectOption("square");
  await page.getByRole("button", { name: /תצוגה מקדימה: אילו שורות ייכנסו/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 מתוך 3 שורות ייכנסו" })).toBeVisible();

  // in a batch: the same preview, on either commentary of the folder
  await page.getByRole("radio", { name: "ספרים רבים (אצווה)" }).click();
  await page.getByLabel("הקובץ או המסד שבו נמצאים הפירושים").selectOption({ index: 1 });
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });
  await page.getByLabel("אילו שורות של הספר המקשר נכנסות").selectOption("square");
  await page.getByLabel("הספר לתצוגה המקדימה").selectOption({ label: "פירוש 2 על בראשית" });
  await page.getByRole("button", { name: /תצוגה מקדימה: אילו שורות ייכנסו/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 מתוך 3 שורות ייכנסו" })).toBeVisible();

  // in max-link: the filter chosen for one method is the run's, with the preview on a book of the plan
  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  await page.getByRole("radio", { name: "קובץ, תיקייה או מסד" }).click();
  await page.getByRole("combobox", { name: "הקובץ או המסד", exact: true }).selectOption({ index: 1 });
  await page.getByRole("region", { name: "הגדרות: לפי דיבור המתחיל" }).getByLabel("אילו שורות של הספר המקשר נכנסות").selectOption("square");
  await page.getByRole("button", { name: /תצוגה מקדימה: אילו שורות ייכנסו/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 מתוך 3 שורות ייכנסו" })).toBeVisible();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * #41 B23: at 1366 the table was 288px wide with rows 160px tall — about four suggestions on a screen — and at 768 it fell below the fold.
 */
for (const [width, height] of [[1366, 768], [768, 1024]] as const) {
  test(`the suggestions table at ${width}×${height}: short rows, and the first ones on the screen (#41 B23)`, async ({ page }) => {
    // the books are chosen in a wide window (at 768 the books panel is folded away), then the window narrows
    const table = await headingsRun(page);
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300);
    const rows = table.locator("tbody tr");
    await expect(rows.nth(5)).toBeVisible();
    const boxes = await rows.evaluateAll((trs) => trs.slice(0, 8).map((tr) => tr.getBoundingClientRect()).map((r) => ({ top: r.top, h: r.height, w: r.width })));
    const median = boxes.map((b) => b.h).sort((a, b) => a - b)[4]!;
    expect(median).toBeLessThanOrEqual(ROW_MAX);
    // the first two rows are on the screen as the panel opens (before: at most one and a half)
    expect(boxes[1]!.top + boxes[1]!.h).toBeLessThanOrEqual(height);
  });
}

test("a second press of 'אישור' takes the approval back to pending, not to rejected (#41 B22)", async ({ page }) => {
  const seen = watchPage(page);
  const table = await headingsRun(page);
  await page.locator(".filters .chip", { hasText: "הכול" }).click();
  const approve = table.getByRole("button", { name: "אישור ההצעה לשורה 4", exact: true });
  await approve.click();
  await expect(approve).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText("1");
  await approve.click();
  await expect(approve).toHaveAttribute("aria-pressed", "false");
  await expect(table.getByRole("button", { name: "דחיית ההצעה לשורה 4", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".filters .chip", { hasText: "נדחתה" })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/** A Hebrew letter as the focused element gets it: Playwright has no key for it on its US layout (`press` throws, `type` sends no keydown). */
const hebrewKey = (page: Page, key: string, mods: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
  page.evaluate(([k, m]) => void (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...m })), [key, mods] as const);

/*
 * V7 PR3/PR4 review, finding 5: the review keys of the one-at-a-time card (A/R/U, ש/ר/ו) act only when the card itself has the focus —
 * "ו" takes an approval back (and its links with it, B22), so typing it while a <summary>, another region's row or a modifier is
 * in play must not touch the shown suggestion.
 */
test("the card's review keys act only on the card itself: not from a <summary>, another region, or with a modifier (finding 5)", async ({ page }) => {
  const seen = watchPage(page);
  await headingsRun(page);
  await page.getByRole("radiogroup", { name: "תצוגת ההצעות" }).getByRole("radio", { name: "כרטיס" }).click();
  const card = page.getByRole("group", { name: "ההצעה הנוכחית" });
  const status = card.locator(".row").first();
  await card.getByRole("button", { name: /^אישור/ }).click();
  await page.getByRole("button", { name: "הקודמת" }).click();
  await expect(status).toContainText("אושרה");

  // a <summary> of the page has the focus: "ו" (and "u") leave the approval as it is
  const summary = page.locator("summary").filter({ visible: true }).first();
  await expect(summary).toHaveCount(1);
  await summary.focus();
  await hebrewKey(page, "ו");
  await page.keyboard.press("u");
  await expect(status).toContainText("אושרה");
  // a focusable item of another region (the books list) has the focus
  const other = page.getByRole("region", { name: "קבצים ומסדים" }).locator("[tabindex='0'], button").first();
  await other.focus();
  await hebrewKey(page, "ו");
  await expect(status).toContainText("אושרה");
  // on the card, with a modifier: nothing
  await card.focus();
  await page.keyboard.press("Shift+U");
  await hebrewKey(page, "ו", { altKey: true });
  await expect(status).toContainText("אושרה");
  // on the card itself: "ו" takes it back to pending
  await hebrewKey(page, "ו");
  await expect(status).toContainText("ממתינה");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
