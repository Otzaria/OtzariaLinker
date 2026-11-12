/* The twelve scenarios of the product audit, in the owner's order. Each records what a user does. */
import { readFileSync } from "node:fs";

const wait = (p, ms) => p.waitForTimeout(ms);
const task = (p, title) => p.locator(".task-card", { hasText: title });
const sheetBtn = (p, label) => p.getByRole("button", { name: label, exact: true });
async function idle(p, timeout = 120_000) {
  // a running task shows its label in the app bar; wait until it is gone
  await wait(p, 300);
  await p.locator(".app-bar .task").waitFor({ state: "detached", timeout }).catch(() => {});
}
/** The export dialog: what it says, why links are held back, and the download (private purpose if needed). */
export async function exportFlow(s, p, name, { tryPrivate = true } = {}) {
  const exp = p.locator(".app-bar .export");
  if (await exp.isDisabled()) {
    s.note("כפתור 'ייצוא' מושבת: אין קישורים בפרויקט");
    await s.shot(name);
    return { disabled: true };
  }
  await s.click(exp, "'ייצוא'");
  const dialog = p.getByRole("dialog");
  await dialog.locator(".stats, p").first().waitFor({ timeout: 60_000 });
  await wait(p, 1500);
  const held = dialog.locator("summary", { hasText: /לא ייוצאו, ולמה/ });
  if (await held.count()) {
    if (!(await dialog.locator("details.held[open]").count())) await s.click(held.first(), "פתיחת 'קישורים לא ייוצאו, ולמה'");
    s.note(`ייצוא — מוחזקים: ${(await dialog.locator("details.held").first().innerText()).replace(/\s+/g, " ").slice(0, 500)}`);
  }
  await s.shot(name);
  const out = { dialog: (await dialog.innerText()).replace(/\s+/g, " ").slice(0, 700) };
  s.note(`ייצוא — הדיאלוג: ${out.dialog}`);
  const btn = dialog.getByRole("button", { name: /^הורדת (ZIP|הקובץ)$/ });
  if (!(await btn.isEnabled()) && tryPrivate) {
    s.decide("הייצוא חסום: לשנות את 'הייצוא מיועד ל…' לשימוש פרטי?");
    await s.click(dialog.getByRole("combobox", { name: "למה מיועד הייצוא" }), "פתיחת 'הייצוא מיועד ל…'");
    await dialog.getByRole("combobox", { name: "למה מיועד הייצוא" }).selectOption("private");
    await wait(p, 1500);
    await s.shot(`${name}-private`);
    out.private = (await dialog.innerText()).replace(/\s+/g, " ").slice(0, 500);
    s.note(`ייצוא — שימוש פרטי: ${out.private}`);
  }
  if (await btn.isEnabled()) {
    const dl = p.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
    await s.click(btn, "'הורדת הקובץ / ZIP'");
    const d = await dl;
    if (d) {
      out.file = d.suggestedFilename();
      out.path = await d.path();
      s.note(`הורד: ${out.file}`);
      if (out.file.endsWith(".json")) s.note(`תוכן: ${readFileSync(out.path, "utf8").slice(0, 300)}`);
    }
  } else {
    s.note("ייצוא — כפתור ההורדה נשאר מושבת");
    await s.click(dialog.getByRole("button", { name: "סגירה" }), "'סגירה'");
  }
  return out;
}

async function sideText(p) { return (await p.locator(".side-panel").innerText()).replace(/\s+/g, " "); }

export async function s1(s, { IN }) {
  const p = await s.open();
  await s.shot("home");
  s.decide("איזו משימה מתאימה ל'שני ספרי TXT'? (ספר ופירוש / עבודה ידנית מתקדמת)");
  await s.click(task(p, "ספר ופירוש"), "במסך הפתיחה: 'ספר ופירוש'");
  s.decide("בשלב 'הפירוש': קבצים / תיקייה / מסד");
  await s.pick(sheetBtn(p, "הפירוש: קבצים"), [`${IN}/s1/בראשית.txt`, `${IN}/s1/ביאור חדש על בראשית.txt`], "'קבצים' ובחירת שני הקבצים יחד");
  await wait(p, 800);
  await s.shot("start-sheet");
  await s.click(sheetBtn(p, "התחלה"), "'התחלה'");
  await idle(p);
  await s.shot("workspace");
  await s.click(p.getByRole("button", { name: "חיפוש התאמות" }), "'חיפוש התאמות' (שיטה: לפי כותרות, נבחרה אוטומטית)");
  await idle(p);
  await wait(p, 800);
  await s.shot("headings-result");
  s.note(`תוצאה (כותרות): ${await sideText(p)}`.slice(0, 600));
  await s.lap("headings");
  // the headings engine cannot place verse headings on a TXT base without them: try the next method
  const certain = p.getByRole("button", { name: /אישור כל הוודאיות/ });
  if (!(await certain.count()) || !(await certain.isEnabled())) {
    s.decide("אין הצעות ודאיות: לנסות שיטה אחרת? איזו?");
    await s.click(p.getByRole("button", { name: "הרצה חדשה" }), "'הרצה חדשה'");
    await s.click(p.locator("select").first(), "פתיחת רשימת השיטות");
    await p.locator("select").first().selectOption({ label: "לפי דיבור המתחיל" });
    s.step("בחירת 'לפי דיבור המתחיל'");
    await s.click(p.getByRole("button", { name: "חיפוש התאמות" }), "'חיפוש התאמות'");
    await idle(p);
    await wait(p, 800);
    await s.shot("dh-result");
    s.note(`תוצאה (דיבור המתחיל): ${await sideText(p)}`.slice(0, 600));
    await s.lap("dh");
  }
  if ((await certain.count()) && (await certain.isEnabled())) {
    await s.click(certain, "'אישור כל הוודאיות'");
  }
  // the rest: approve what is left after looking at it
  const pending = p.getByRole("checkbox", { name: "בחירת הכול בעמוד" });
  if (await pending.count()) {
    s.decide("לאשר את ההצעות הלא־ודאיות שנשארו? (צריך לעבור עליהן)");
    await s.click(pending, "סימון כל ההצעות שנשארו");
    const ok = p.getByRole("button", { name: /^אישור \d+$/ });
    if (await ok.count()) await s.click(ok, "'אישור N'");
  }
  await s.shot("approved");
  // a manual link too: the builder
  await s.click(p.getByRole("tab", { name: "בונה" }), "לשונית 'בונה' — קישור ידני");
  await s.click(p.locator('.reader.source .ln[data-i="3"] .tx'), "לחיצה על שורה בפירוש");
  await s.click(p.locator('.reader.target .ln[data-i="3"] .tx'), "לחיצה על שורה בבראשית");
  await s.shot("builder");
  await s.key("Control+Enter", "Ctrl+Enter ליצירת הקישור");
  await wait(p, 500);
  await s.shot("builder-after");
  await exportFlow(s, p, "export");
  await s.lap("end");
  s.verdict = "works with friction";
}
s1.title = "ספר TXT מול ספר TXT";

const OTZ = (IN) => `${IN}/otzaria/seforim.db`; // the mini fixture, under the name a user picks
const bookRow = (p, title) => p.locator(".book-list li").filter({ hasText: title });
async function setBook(s, p, title, side, what) {
  let row = bookRow(p, title).first();
  if (!(await row.isVisible().catch(() => false))) {
    await s.type(p.getByPlaceholder("חיפוש ספר…").first(), title, `חיפוש '${title}' ברשימת הספרים`);
    await wait(p, 500);
    row = bookRow(p, title).first();
  }
  await s.click(row.getByRole("button", { name: side === "source" ? "מקור" : "יעד" }), what ?? `'${side === "source" ? "מקור" : "יעד"}' ליד '${title}'`);
  await wait(p, 600);
}
async function approveAll(s, p) {
  const certain = p.getByRole("button", { name: /אישור כל הוודאיות/ });
  const n = Number(((await certain.innerText().catch(() => "")).match(/\(([\d,]+)\)/)?.[1] ?? "0").replace(/,/g, ""));
  if (n > 0) await s.click(certain, `'אישור כל הוודאיות (${n})'`);
  const all = p.getByRole("checkbox", { name: "בחירת הכול בעמוד" });
  const rows = await p.locator('table[aria-label="הצעות"] tbody tr').count();
  if (rows > 0) {
    s.decide(`${rows} הצעות לא־ודאיות נשארו: לעבור עליהן אחת־אחת או לאשר את כולן?`);
    await s.click(all, "סימון כל ההצעות שנשארו בעמוד");
    const ok = p.getByRole("button", { name: /^אישור \d+$/ });
    if (await ok.count()) await s.click(ok, "'אישור N'");
  }
  return n;
}
async function runMaxLink(s, p, scope) {
  await s.click(p.getByRole("tab", { name: /הצעות/ }), "לשונית 'הצעות'");
  const ml = p.getByRole("radio", { name: "קישור מרבי" });
  if ((await ml.getAttribute("aria-checked")) !== "true") await s.click(ml, "'קישור מרבי'");
  if (scope) {
    const r = p.getByRole("radio", { name: scope });
    if ((await r.getAttribute("aria-checked")) !== "true") await s.click(r, `'${scope}'`);
  }
  await wait(p, 1500);
  const plan = (await p.locator(".ml-plan").innerText().catch(() => "")).replace(/\s+/g, " ");
  s.note(`תוכנית: ${plan.slice(0, 400)}`);
  const why = p.locator("summary", { hasText: "למה כל ספר" });
  if (await why.count()) {
    await s.click(why, "'למה כל ספר'");
    s.note(`למה כל ספר: ${(await p.locator(".ml-books").innerText()).replace(/\s+/g, " ").slice(0, 900)}`);
  }
  await s.shot("maxlink-plan");
  const t = Date.now();
  await s.click(p.getByRole("button", { name: "הפעלת קישור מרבי" }), "'הפעלת קישור מרבי'");
  await p.locator("details.ml-report").waitFor({ timeout: 300_000 });
  await idle(p, 300_000);
  s.timings.maxlinkRun = Date.now() - t;
  await wait(p, 800);
  s.note(`תוצאה: ${(await sideText(p)).slice(0, 700)}`);
  await s.shot("maxlink-result");
}

export async function s2(s, { IN }) {
  const p = await s.open();
  await s.click(task(p, "ספר ופירוש"), "'ספר ופירוש'");
  await s.pick(sheetBtn(p, "הפירוש: קבצים"), [`${IN}/s2/ביאור חדש על בראשית.txt`], "שלב 1: 'קבצים' ← הפירוש");
  s.decide("שלב 2 'לא חובה': האם צריך? איפה מסד אוצריא?");
  await s.pick(sheetBtn(p, "ספר הבסיס, אם הוא במקור אחר: מסד נתונים"), [OTZ(IN)], "שלב 2: 'מסד נתונים' ← seforim.db (הדבקת הנתיב בחלון הבחירה)");
  await wait(p, 1500);
  await s.shot("start-sheet");
  await s.click(sheetBtn(p, "התחלה"), "'התחלה'");
  await idle(p);
  await wait(p, 1000);
  await s.shot("workspace");
  const side = await sideText(p);
  s.note(`אחרי 'התחלה': ${side.slice(0, 300)}`);
  if (/בחרו ספר בחלונית היעד/.test(side)) {
    s.confuse("ספר הבסיס (בראשית) לא נבחר לבד, למרות ששם הפירוש הוא 'ביאור חדש על בראשית'");
    s.decide("איזה ספר במסד הוא ספר הבסיס?");
    await setBook(s, p, "בראשית", "target");
  }
  await s.click(p.getByRole("button", { name: "חיפוש התאמות" }), "'חיפוש התאמות'");
  await idle(p);
  await wait(p, 800);
  s.note(`תוצאה: ${(await sideText(p)).slice(0, 600)}`);
  await s.shot("result");
  const src = await p.locator(".reader.source .panel-head").innerText();
  if (!src.includes("ביאור חדש")) {
    s.confuse(`אחרי 'התחלה' ספר המקור הוא '${src.replace(/\s+/g, " ").trim()}' ולא הפירוש שנבחר בשלב 1; ההרצה מצאה רק קישורים שכבר קיימים במסד, '0 ממתינות'`);
    s.decide("למה אין מה לאשר? להבין שנבחר ספר אחר, ולבחור את הפירוש ידנית");
    await s.click(p.getByRole("button", { name: "הרצה חדשה" }), "'הרצה חדשה'");
    await setBook(s, p, "ביאור חדש על בראשית", "source", "'מקור' ליד 'ביאור חדש על בראשית'");
    await s.click(p.getByRole("button", { name: "חיפוש התאמות" }), "'חיפוש התאמות' שוב");
    await idle(p);
    await wait(p, 800);
    s.note(`תוצאה 2: ${(await sideText(p)).slice(0, 600)}`);
    await s.shot("result-2");
    s.repeat("הרצת החיפוש פעמיים כי בפעם הראשונה רץ על ספר אחר");
  }
  await approveAll(s, p);
  await s.shot("approved");
  await exportFlow(s, p, "export");
  s.verdict = "works with friction";
}
s2.title = "פירוש TXT מול מסד אוצריא";

export async function s3(s, { IN }) {
  const p = await s.open();
  s.decide("אין משימה '4 ספרים': איזו לבחור? (ספר ופירוש / ספר והערות / עבודה ידנית / ישר 'קבצים')");
  await s.pick(p.locator(".drop-strip").getByRole("button", { name: "קבצים" }), ["בראשית", "ביאור חדש על בראשית", "ספר דוגמה", "הערות על ספר דוגמה"].map((t) => `${IN}/s3/${t}.txt`), "במסך הפתיחה, בצד: 'קבצים' ← ארבעת הקבצים");
  await idle(p);
  await wait(p, 1000);
  await s.shot("workspace");
  await runMaxLink(s, p, "כל הספרים הפתוחים");
  await approveAll(s, p);
  await s.shot("approved");
  await exportFlow(s, p, "export");
  s.verdict = "works with friction";
}
s3.title = "ארבעה ספרים, קישור אוטומטי";

export async function s4(s, { IN }) {
  const p = await s.open();
  s.decide("'תיקייה מול אוצריא' דורשת גם מסד; התיקייה כבר מכילה את ספרי הבסיס");
  await s.click(task(p, "תיקייה מול אוצריא"), "'תיקייה מול אוצריא'");
  await s.pick(sheetBtn(p, "התיקייה: תיקייה"), `${IN}/s4/הספרייה שלי`, "שלב 1: 'תיקייה' ← הספרייה שלי (עם תתי־תיקיות, קובץ md ותמונה)");
  await wait(p, 1500);
  await s.pick(sheetBtn(p, "מסד אוצריא: מסד נתונים"), [OTZ(IN)], "שלב 2: 'מסד נתונים' ← seforim.db");
  await wait(p, 1500);
  await s.shot("start-sheet");
  await s.click(sheetBtn(p, "התחלה"), "'התחלה'");
  await idle(p);
  await wait(p, 1500);
  await s.shot("workspace");
  s.note(`מקורות: ${(await p.locator(".sources-panel").innerText()).replace(/\s+/g, " ").slice(0, 600)}`);
  await runMaxLink(s, p);
  await approveAll(s, p);
  await s.shot("approved");
  await exportFlow(s, p, "export");
  s.verdict = "works with friction";
}
s4.title = "תיקייה עם תתי־תיקיות";
