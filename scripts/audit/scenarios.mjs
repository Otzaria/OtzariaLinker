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
  const t0 = Date.now();
  await dialog.getByText("בודק את כל הקישורים מול הספרים…").waitFor({ state: "detached", timeout: 300_000 }).catch(() => {});
  s.timings.exportCheck = Date.now() - t0;
  await wait(p, 800);
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
async function runMaxLink(s, p, scope, { timeout = 300_000 } = {}) {
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
  // progress samples while it runs (the app bar's progress bar)
  const samples = [];
  const timer = setInterval(async () => {
    try {
      const v = await p.locator(".app-bar .task progress").evaluate((e) => `${e.value}/${e.max}`);
      samples.push(`${Math.round((Date.now() - t) / 1000)}s:${v}`);
    } catch {}
  }, 30_000);
  try {
    await p.locator("details.ml-report").waitFor({ timeout });
    await idle(p, timeout);
  } finally {
    clearInterval(timer);
    if (samples.length) s.note(`התקדמות: ${samples.join(" ")}`);
  }
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

async function dbVsDb(s, p, IN, from, to, toLabel) {
  await s.click(task(p, "מסד מול מסד"), "'מסד מול מסד'");
  await s.pick(sheetBtn(p, "המסד שממנו מקשרים: מסד נתונים"), [from], `שלב 1: 'מסד נתונים' ← ${from.split("/").pop()}`);
  await wait(p, 1500);
  await s.pick(sheetBtn(p, "המסד שאליו מקשרים: מסד נתונים"), [to], `שלב 2: 'מסד נתונים' ← ${toLabel}`);
  await wait(p, 1500);
  await s.shot("start-sheet");
  s.note(`הגיליון: ${(await p.getByRole("dialog").innerText()).replace(/\s+/g, " ").slice(0, 500)}`);
  await s.click(sheetBtn(p, "התחלה"), "'התחלה'");
  await idle(p);
  await wait(p, 1500);
  await s.shot("workspace");
  s.note(`מקורות: ${(await p.locator(".sources-panel").innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
}

export async function s5(s, { IN }) {
  const p = await s.open();
  await dbVsDb(s, p, IN, `${IN}/db/אישי-פירושים.db`, OTZ(IN), "seforim.db");
  await runMaxLink(s, p);
  await approveAll(s, p);
  await s.shot("approved");
  await exportFlow(s, p, "export");
  s.note("אחרי הייצוא: קובצי _links.json. אין דרך לכתוב את הקישורים חזרה לתוך המסד האישי (הכלי קורא מסדים בלבד).");
  s.verdict = "works with friction";
}
s5.title = "מסד אוצריא ומסד אישי יחד";

export async function s6(s, { IN }) {
  const p = await s.open();
  s.decide("אין משימה 'לראות קישורים שבמסד': מה לבחור? (עריכת קישורים קיימים מבקשת קובצי json)");
  await s.pick(p.locator(".drop-strip").getByRole("button", { name: "מסד נתונים" }), [OTZ(IN)], "במסך הפתיחה, בצד: 'מסד נתונים' ← seforim.db");
  await idle(p);
  await wait(p, 1500);
  await s.shot("workspace");
  await setBook(s, p, 'רש"י על בראשית', "source", "'מקור' ליד 'רש\"י על בראשית'");
  s.decide("איפה רואים את הקישורים שכבר במסד? (לשונית 'קישורים' ← 'קישורים מהמסד')");
  await s.click(p.getByRole("tab", { name: /^קישורים/ }), "לשונית 'קישורים'");
  await s.shot("links-tab");
  await s.click(p.getByRole("tab", { name: /קישורים מהמסד/ }), "'קישורים מהמסד'");
  await idle(p);
  await wait(p, 1500);
  await s.shot("db-links");
  s.note(`קישורים מהמסד: ${(await sideText(p)).slice(0, 700)}`);
  const mark = p.getByRole("button", { name: "סימון המוצגים" });
  if (await mark.count()) {
    await s.click(mark, "'סימון המוצגים'");
    await s.click(p.getByRole("button", { name: /העתקה לפרויקט \(/ }), "'העתקה לפרויקט'");
    await idle(p);
    await wait(p, 1000);
    await s.shot("copied");
  }
  await exportFlow(s, p, "export", { tryPrivate: false });
  s.verdict = "works with friction";
}
s6.title = "טעינת קישורים שכבר קיימים במסד";

export async function s7(s, { IN }) {
  const p = await s.open();
  await s.click(task(p, "עריכת קישורים קיימים"), "'עריכת קישורים קיימים'");
  await s.pick(sheetBtn(p, "קובצי הקישורים: תיקייה"), `${IN}/s7/links`, "שלב 1: 'תיקייה' ← links (שלושה קבצים, אחד שבור)");
  await wait(p, 1500);
  await s.shot("start-sheet-1");
  await s.pick(sheetBtn(p, "הספרים שהקישורים מצביעים אליהם: תיקייה"), `${IN}/s7/books`, "שלב 2: 'תיקייה' ← books");
  await wait(p, 1500);
  await s.shot("start-sheet-2");
  await s.click(sheetBtn(p, "התחלה"), "'התחלה'");
  await idle(p);
  await wait(p, 1500);
  await s.shot("workspace");
  s.note(`קישורים: ${(await sideText(p)).slice(0, 700)}`);
  s.verdict = "works with friction";
}
s7.title = "טעינת קובצי קישורים קיימים מתיקייה";

export async function s8(s, { IN }) {
  const p = await s.open();
  await dbVsDb(s, p, IN, `${IN}/db/אישי-פירושים.db`, `${IN}/db/אישי-מקורות.db`, "אישי-מקורות.db");
  await runMaxLink(s, p);
  await approveAll(s, p);
  await s.shot("approved");
  await exportFlow(s, p, "export");
  s.verdict = "works with friction";
}
s8.title = "קישור בין שני מסדים אישיים";

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

/** Working set of the Chrome processes Playwright launched (their profile dir is playwright's), in MB. */
export function chromeMb() {
  try {
    const ps = "$ProgressPreference='SilentlyContinue'; (Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*playwright*' } | Measure-Object -Property WorkingSetSize -Sum).Sum";
    const out = execSync(`powershell -NoProfile -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Math.round(Number(out.trim()) / 1048576);
  } catch {
    return -1;
  }
}

export async function s9(s, { IN }) {
  const p = await s.open();
  s.note(`זיכרון Chrome בהתחלה: ${chromeMb()} MB`);
  await s.click(task(p, "תיקייה מול אוצריא"), "'תיקייה מול אוצריא'");
  let t = Date.now();
  await s.pick(sheetBtn(p, "התיקייה: תיקייה"), `${IN}/s9/מאות`, "שלב 1: 'תיקייה' ← 300 פירושים");
  await p.locator(".start-task .opened").first().waitFor({ timeout: 300_000 });
  s.timings.openFolder = Date.now() - t;
  await s.pick(sheetBtn(p, "מסד אוצריא: מסד נתונים"), [OTZ(IN)], "שלב 2: 'מסד נתונים' ← seforim.db");
  await wait(p, 2000);
  await s.shot("start-sheet");
  await s.click(sheetBtn(p, "התחלה"), "'התחלה'");
  await idle(p);
  await wait(p, 1500);
  await s.shot("workspace");
  s.note(`זיכרון אחרי פתיחה: ${chromeMb()} MB`);
  await runMaxLink(s, p);
  s.note(`זיכרון אחרי הקישור המרבי: ${chromeMb()} MB`);
  t = Date.now();
  await approveAll(s, p);
  s.timings.approve = Date.now() - t;
  await s.shot("approved");
  s.note(`אחרי אישור: ${(await p.locator(".sug-head").innerText()).replace(/\s+/g, " ")}`);
  t = Date.now();
  const out = await exportFlow(s, p, "export");
  s.timings.export = Date.now() - t;
  if (out.path && out.file.endsWith(".zip")) {
    const z = unzipSync(new Uint8Array(readFileSync(out.path)));
    s.note(`ZIP: ${Object.keys(z).length} קבצים, למשל ${Object.keys(z).slice(0, 3).join(", ")}`);
  }
  s.note(`זיכרון בסוף: ${chromeMb()} MB`);
  s.verdict = "works with friction";
}
s9.title = "אצווה של מאות ספרים";

const FOUR = ["בראשית", "ביאור חדש על בראשית", "ספר דוגמה", "הערות על ספר דוגמה"];

/** Builds a small project (four TXT books, max-link, approve certain) and saves it. */
async function buildAndSave(s, p, IN, dir) {
  await s.pick(p.locator(".drop-strip").getByRole("button", { name: "קבצים" }), FOUR.map((t) => `${IN}/s3/${t}.txt`), "'קבצים' ← ארבעה ספרים");
  await idle(p);
  await runMaxLink(s, p, "כל הספרים הפתוחים");
  await approveAll(s, p);
  const dl = p.waitForEvent("download", { timeout: 20_000 });
  await s.click(p.getByRole("button", { name: "שמירת פרויקט" }), "שמירת הפרויקט (סמל הדיסקט)");
  const d = await dl;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${d.suggestedFilename()}`;
  await d.saveAs(file);
  s.note(`נשמר: ${d.suggestedFilename()} (${Math.round(statSync(file).size / 1024)} KB)`);
  return file;
}

export async function s10(s, { IN }) {
  const p = await s.open();
  const file = await buildAndSave(s, p, IN, `${IN}/../out/s10`);
  await s.shot("saved");
  const before = (await p.locator(".app-bar .export").innerText()).trim();
  // a reload in the same browser: the recovery banner
  await p.reload();
  await wait(p, 2500);
  await s.shot("reload-recovery");
  s.note(`אחרי רענון: ${(await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  await s.context.close();
  // another day: a fresh browser profile, the saved file
  await s.open();
  const q = s.page;
  s.decide("איך ממשיכים? ('פרויקט שמור' בצד מסך הפתיחה)");
  await s.pick(q.locator(".drop-strip").getByRole("button", { name: "פרויקט שמור" }), [file], "'פרויקט שמור' ← הקובץ");
  await idle(q);
  await wait(q, 2000);
  await s.shot("reopened");
  s.note(`ייצוא לפני: ${before}; אחרי פתיחה: ${(await q.locator(".app-bar .export").innerText().catch(() => "—")).trim()}`);
  s.note(`אחרי פתיחה: ${(await q.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 700)}`);
  const books = await q.locator(".book-list li").count();
  s.note(`ספרים ברשימה אחרי פתיחת הפרויקט: ${books}`);
  if (!books) {
    s.repeat("צריך לפתוח שוב את ארבעת הספרים");
    const group = q.getByRole("group", { name: "סוג המקור להוספה" });
    if (!(await group.isVisible().catch(() => false))) await s.click(q.getByRole("button", { name: "הוספת מקור" }), "'הוספת מקור'");
    await s.pick(group.getByRole("button", { name: "קבצים", exact: true }), FOUR.map((t) => `${IN}/s3/${t}.txt`), "'קבצים' ← ארבעת הספרים שוב");
    await idle(q);
    await wait(q, 1500);
    await s.shot("reopened-books");
    s.note(`אחרי פתיחת הספרים: ${(await q.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 500)}`);
  }
  s.verdict = "works with friction";
}
s10.title = "שמירת פרויקט ופתיחה מחדש";

export async function s11(s, { IN }) {
  const p = await s.open();
  await s.click(task(p, "עריכת קישורים קיימים"), "'עריכת קישורים קיימים'");
  await s.pick(sheetBtn(p, "קובצי הקישורים: תיקייה"), `${IN}/s7/links`, "שלב 1: 'תיקייה' ← links");
  await wait(p, 1000);
  await s.pick(sheetBtn(p, "הספרים שהקישורים מצביעים אליהם: תיקייה"), `${IN}/s7/books`, "שלב 2: 'תיקייה' ← books");
  await wait(p, 1000);
  await s.click(sheetBtn(p, "התחלה"), "'התחלה'");
  await idle(p);
  await s.lap("started");
  const det = p.locator(".notice details summary").first();
  if (await det.count()) {
    await s.click(det, "'פרטים' בהודעה על הקובץ");
    s.note(`פרטי ההודעה: ${(await p.locator(".notice").first().innerText()).replace(/\s+/g, " ").slice(0, 1200)}`);
    await s.shot("load-details");
  }
  for (const x of await p.locator(".notice .icon-btn[aria-label='סגירה']").all()) await x.click({ timeout: 1000 }).catch(() => {});
  await s.click(p.getByRole("tab", { name: /^בדיקה/ }), "לשונית 'בדיקה'");
  await s.shot("qa-empty");
  await s.click(p.locator(".side-panel .panel-body .btn.filled").first(), "הרצת הבדיקה");
  await idle(p);
  await wait(p, 1000);
  await s.lap("qaDone");
  await s.shot("qa-report");
  s.note(`דוח הבדיקה: ${(await sideText(p)).slice(0, 1500)}`);
  const fix = p.getByRole("button", { name: "תיקון" }).first();
  if (await fix.count()) {
    await s.click(fix, "'תיקון' ליד הבעיה הראשונה");
    await wait(p, 800);
    await s.shot("qa-fix-builder");
    s.note(`הבונה אחרי 'תיקון': ${(await sideText(p)).slice(0, 700)}`);
    s.decide("מה בדיוק לתקן? לבחור שורת יעד אחרת? איזו?");
    await s.click(p.locator('.reader.target .ln[data-i="5"] .tx'), "לחיצה על שורת יעד נכונה");
    await wait(p, 500);
    await s.shot("qa-fix-picked");
    const save = p.locator(".builder").getByRole("button", { name: /שמירת השינויים|יצירת קישור/ }).first();
    if (await save.count()) {
      await save.scrollIntoViewIfNeeded();
      await s.shot("qa-fix-save");
      if (await save.isDisabled()) {
        s.note(`'${(await save.innerText()).trim()}' מושבת: ${(await p.locator(".builder .problems, .builder [role=alert]").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 500)}`);
        s.confuse("'תיקון' פותח את הבונה, אבל כפתור השמירה מושבת עד שממלאים ציון ספריא באנגלית (ref_2)");
        s.decide("מה לכתוב בשדה 'ref_2 — ציון ספריא באנגלית של היעד'?");
        await s.type(p.locator(".builder").getByPlaceholder(/Genesis/).last(), "Genesis 1:4", "הקלדת 'Genesis 1:4' בשדה ref_2");
        await wait(p, 500);
      }
      if (await save.isEnabled()) await s.click(save, `'${(await save.innerText()).trim()}'`);
    }
    await wait(p, 500);
  }
  await s.click(p.getByRole("tab", { name: /^בדיקה/ }), "חזרה ללשונית 'בדיקה'");
  const del = p.getByRole("button", { name: "מחיקה" }).first();
  if (await del.count()) await s.click(del, "'מחיקה' ליד בעיה");
  const rerun = p.locator(".side-panel").getByRole("button", { name: /הרצה מחדש|בדיקה מחדש/ }).first();
  if (await rerun.count()) await s.click(rerun, "הרצת הבדיקה מחדש");
  await idle(p);
  await wait(p, 800);
  await s.lap("qaAgainDone");
  await s.shot("qa-after");
  s.note(`אחרי תיקון: ${(await sideText(p)).slice(0, 900)}`);
  await exportFlow(s, p, "export");
  await s.lap("exported");
  s.verdict = "works with friction";
}
s11.title = "בדיקת קישורים ותיקון שגיאות";

export async function s12(s, { IN }) {
  const p = await s.open();
  await buildAndSave(s, p, IN, `${IN}/../out/s12`);
  const out = await exportFlow(s, p, "export");
  let report = "";
  if (out.path && out.file.endsWith(".zip")) {
    const z = unzipSync(new Uint8Array(readFileSync(out.path)));
    s.note(`ZIP: ${Object.keys(z).join(", ")}`);
    report = z["_report.txt"] ? strFromU8(z["_report.txt"]) : "";
  } else {
    await s.click(p.locator(".app-bar .export"), "'ייצוא' שוב, בשביל הדוח");
    const dl = p.waitForEvent("download", { timeout: 20_000 });
    await s.click(p.getByRole("dialog").getByRole("button", { name: /הורדת הדוח/ }), "'הורדת הדוח'");
    report = readFileSync(await (await dl).path(), "utf8");
    await s.click(p.getByRole("dialog").getByRole("button", { name: "סגירה" }), "'סגירה'");
  }
  mkdirSync(`${IN}/../out/s12`, { recursive: true });
  writeFileSync(`${IN}/../out/s12/_report.txt`, report, "utf8");
  s.note(`הדוח: ${report.replace(/\s+/g, " ").slice(0, 1500)}`);
  await s.click(p.getByRole("button", { name: "עזרה" }), "עזרה (F1)");
  await wait(p, 1000);
  const help = (await p.getByRole("dialog").innerText()).replace(/\s+/g, " ");
  const hits = [...help.matchAll(/.{0,200}(MoreBooks|links\/|תיקיית הספרייה|להכניס לאוצריא|לשלוח|Pull Request|PR\b).{0,200}/g)].map((m) => m[0]);
  s.note(`עזרה — ${help.length} תווים; קטעים על החזרה לאוצריא: ${hits.slice(0, 4).join(" ‖ ") || "לא נמצא"}`);
  await s.shot("help");
  s.verdict = "works with friction";
}
s12.title = "ייצוא והחזרה לאוצריא";

/**
 * 9b — the same batch against the REAL library database (read-only, opened through the file picker,
 * never copied). Runs only when AUDIT_REAL_DB names it. A watchdog closes the browser context if
 * Chrome's working set passes AUDIT_MAX_MB (default 3500).
 */
export async function s13(s, { IN }) {
  const DB = process.env.AUDIT_REAL_DB;
  if (!DB) {
    s.verdict = "skipped (AUDIT_REAL_DB not set)";
    return;
  }
  const max = Number(process.env.AUDIT_MAX_MB ?? 3500);
  let peak = 0;
  const dog = setInterval(() => {
    const mb = chromeMb();
    peak = Math.max(peak, mb);
    if (mb > max) {
      s.note(`כלב השמירה סגר את הדפדפן: ${mb} MB`);
      void s.context?.close();
    }
  }, 5000);
  try {
    const p = await s.open();
    await s.click(task(p, "תיקייה מול אוצריא"), "'תיקייה מול אוצריא'");
    await s.pick(sheetBtn(p, "התיקייה: תיקייה"), `${IN}/s9/מאות`, "שלב 1: 'תיקייה' ← 300 פירושים");
    await p.locator(".start-task .opened").first().waitFor({ timeout: 300_000 });
    let t = Date.now();
    await s.pick(sheetBtn(p, "מסד אוצריא: מסד נתונים"), [DB], "שלב 2: 'מסד נתונים' ← seforim.db האמיתי (4.5GB)");
    await p.locator(".start-task li").nth(1).locator(".opened").waitFor({ timeout: 600_000 });
    s.timings.openRealDb = Date.now() - t;
    await s.shot("start-sheet");
    s.note(`הגיליון: ${(await p.getByRole("dialog").innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
    s.note(`זיכרון אחרי פתיחת המסד: ${chromeMb()} MB`);
    await s.click(sheetBtn(p, "התחלה"), "'התחלה'");
    await idle(p, 600_000);
    await wait(p, 2000);
    await s.shot("workspace");
    t = Date.now();
    await runMaxLink(s, p, undefined, { timeout: Number(process.env.AUDIT_REAL_TIMEOUT ?? 1_500_000) });
    s.timings.maxlinkTotal = Date.now() - t;
    s.note(`זיכרון אחרי הקישור המרבי: ${chromeMb()} MB`);
    await approveAll(s, p);
    await s.shot("approved");
    t = Date.now();
    await exportFlow(s, p, "export");
    s.timings.exportTotal = Date.now() - t;
    s.verdict = "works with friction";
  } finally {
    clearInterval(dog);
    s.note(`שיא זיכרון Chrome (דגימה כל 5 שניות): ${peak} MB`);
  }
}
s13.title = "אצווה של 300 ספרים מול המסד האמיתי (9ב)";

/** Extra checks: unsaved work after closing the tab, and a personal database in another layout. */
export async function s14(s, { IN, MINI_DB }) {
  const p = await s.open();
  await s.pick(p.locator(".drop-strip").getByRole("button", { name: "קבצים" }), FOUR.map((t) => `${IN}/s3/${t}.txt`), "'קבצים' ← ארבעה ספרים");
  await idle(p);
  await s.click(p.getByRole("tab", { name: "בונה" }), "'בונה'");
  await s.click(p.locator('.reader.source .ln[data-i="3"] .tx'), "שורה במקור");
  await s.click(p.locator('.reader.target .ln[data-i="3"] .tx'), "שורה ביעד");
  await s.key("Control+Enter", "Ctrl+Enter");
  await wait(p, 3000);
  // the tab is closed by mistake and opened again (same browser profile)
  const q = await s.context.newPage();
  await p.close();
  await q.goto(p.url().split("#")[0]);
  await wait(q, 2500);
  s.page = q;
  await s.shot("recovery");
  s.note(`אחרי סגירה ופתיחה: ${(await q.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  // a personal database in a different layout (not Otzaria's): the mapping wizard
  await s.pick(q.locator(".drop-strip").getByRole("button", { name: "מסד נתונים" }), [`${MINI_DB.replace(/seforim-v7-mini\.db$/, "generic/books-lines.db")}`], "'מסד נתונים' ← מסד במבנה אחר");
  await wait(q, 2500);
  await s.shot("generic-db");
  s.note(`מסד במבנה אחר: ${(await q.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 900)}`);
  s.verdict = "checked";
}
s14.title = "בדיקות נוספות: שחזור עבודה ומסד במבנה אחר";
