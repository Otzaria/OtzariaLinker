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
  await s.click(p.getByRole("button", { name: /^ייצוא/ }), "'ייצוא'");
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
