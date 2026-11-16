/*
 * The V5 UX audit's driver (docs/reviews/UX_AUDIT_V5.md). Not a test (it lives under scripts/).
 *
 *   npm run build
 *   py scripts/audit/make_inputs.py <inputs-dir>        # then the extra folders below
 *   node scripts/audit/ux-v5.mjs <inputs-dir> <out-dir> [tasks|gallery|all] [task letters…]
 *
 * Two parts:
 *  - tasks: the five main tasks of the audit (a–e), done through the UI only, the way a user who never
 *    read the guide would — clicks, decisions, technical terms on screen, dead ends — with a screenshot
 *    of every step (desktop, light);
 *  - gallery: every screen and dialog, in light and dark, at 1440×900, 1024×768 and 820×1180, each one
 *    scanned for horizontal scroll, content past the edge of the window and clipped text.
 * Inputs besides make_inputs.py: <in>/tractate (four commentaries on one tractate, TXT, needs the real
 * database: AUDIT_REAL_DB=<path to seforim.db>, opened read-only through the file chooser) and
 * <in>/b200 (200 commentaries on Genesis; the first 200 of make_inputs.py's s9).
 * Everything is written to <out-dir> (screenshots, gallery.json, tasks.json); the report picks a few.
 */
import { mkdirSync, writeFileSync, readdirSync, cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launch, Scenario, MINI_DB } from "./harness.mjs";

const [IN, OUT_DIR = ".bench/ux-v5", PART = "all", ...ONLY] = process.argv.slice(2);
if (!IN) throw new Error("usage: node scripts/audit/ux-v5.mjs <inputs-dir> <out-dir> [tasks|gallery|all] [letters…]");
const REAL_DB = process.env.AUDIT_REAL_DB;
const SHOTS = join(OUT_DIR, "shots");
const GAL = join(OUT_DIR, "gallery");
mkdirSync(SHOTS, { recursive: true });
mkdirSync(GAL, { recursive: true });

const VIEWPORTS = { d: { width: 1440, height: 900 }, t: { width: 1024, height: 768 }, p: { width: 820, height: 1180 } };
const wait = (p, ms) => p.waitForTimeout(ms);
const gallery = [];

/** What is wrong with the layout on screen now: page scroll, things past the edge, clipped text. */
async function layoutScan(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const out = { hscroll: 0, offscreen: [], clipped: [], ellipsis: 0, ellipsisSamples: [], hscrollers: [] };
    const se = document.scrollingElement;
    out.hscroll = Math.max(0, se.scrollWidth - se.clientWidth);
    const name = (el) => {
      const cls = (el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "");
      const txt = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 50);
      return `${el.tagName.toLowerCase()}${cls}${txt ? ` «${txt}»` : ""}`;
    };
    // the top layer (an open modal dialog) hides the rest: only scan it then
    const modal = [...document.querySelectorAll("dialog[open]")].at(-1);
    const root = modal ?? document.body;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return null;
      return { r, cs };
    };
    for (const el of root.querySelectorAll("*")) {
      if (el.closest(".sr-only, svg")) continue;
      const v = visible(el);
      if (!v) continue;
      const { r, cs } = v;
      // past the window's edge (and not inside something that scrolls sideways on purpose)
      if ((r.right > vw + 1 || r.left < -1) && !el.parentElement?.closest("[data-hscroll], .vlist, table, .table-wrap, .cmp-table-wrap") && el.children.length === 0 && (el.innerText || "").trim()) {
        if (out.offscreen.length < 12) out.offscreen.push(`${name(el)} [${Math.round(r.left)}…${Math.round(r.right)}]`);
      }
      const overflowsX = el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0;
      if (!overflowsX) continue;
      if (cs.overflowX === "auto" || cs.overflowX === "scroll") {
        if (out.hscrollers.length < 8 && el.scrollWidth - el.clientWidth > 4) out.hscrollers.push(`${name(el)} (+${el.scrollWidth - el.clientWidth}px)`);
      } else if (cs.textOverflow === "ellipsis") {
        out.ellipsis++;
        if (out.ellipsisSamples.length < 6) out.ellipsisSamples.push(name(el));
      } else if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && (el.innerText || "").trim() && el.children.length < 4) {
        if (out.clipped.length < 10) out.clipped.push(`${name(el)} (+${el.scrollWidth - el.clientWidth}px)`);
      }
    }
    return out;
  });
}

/** One state in six variants (two themes × three windows), scanned; the page comes back to desktop, light. */
async function capture(page, id, title) {
  const entry = { id, title, variants: {} };
  for (const [vk, vp] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(vp);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await wait(page, 200);
      const file = `${id}-${vk}-${theme}.png`;
      await page.screenshot({ path: join(GAL, file) });
      const scan = theme === "light" ? await layoutScan(page) : undefined;
      entry.variants[`${vk}-${theme}`] = { file, ...(scan && { scan }) };
    }
  }
  await page.setViewportSize(VIEWPORTS.d);
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  gallery.push(entry);
  writeFileSync(join(OUT_DIR, "gallery.json"), JSON.stringify(gallery, null, 2), "utf8");
  console.log(`  gallery ${id}`);
}
async function safe(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`  ! ${label}: ${String(e.message ?? e).split("\n")[0]}`);
  }
}

const task = (p, title) => p.locator(".task-card", { hasText: title });
const guided = (p) => p.locator("main.guided");
const nextBtn = (p) => guided(p).locator(".guided-foot").getByRole("button", { name: /^הבא/ });
async function idle(p, timeout = 600_000) {
  await wait(p, 300);
  await p.locator(".app-bar .task").waitFor({ state: "detached", timeout }).catch(() => {});
}
/** Opens files from the home screen's drop strip, or "הוספת מקור" in the workspace. */
async function openFiles(s, p, files, what = "'קבצים' ובחירה") {
  const btn = p.getByRole("button", { name: "קבצים", exact: true });
  if (!(await btn.isVisible().catch(() => false))) await s.click(p.getByRole("button", { name: "הוספת מקור" }), "'הוספת מקור'");
  await s.pick(btn.first(), files, what);
  await idle(p);
  await wait(p, 600);
}
async function openFolder(s, p, dir, what = "'תיקייה' ובחירה") {
  const btn = p.getByRole("button", { name: "תיקייה", exact: true });
  if (!(await btn.isVisible().catch(() => false))) await s.click(p.getByRole("button", { name: "הוספת מקור" }), "'הוספת מקור'");
  await s.pick(btn.first(), dir, what);
  await idle(p);
  await wait(p, 600);
}

/* ------------------------------------------------------------------ tasks */

/** (a) a folder of commentaries → the Otzaria database, through the guided flow. */
async function taskA(s, { gal }) {
  const p = await s.open();
  const dir = join(IN, "a");
  if (!existsSync(dir)) {
    cpSync(join(IN, "s4", "הספרייה שלי"), dir, { recursive: true });
    rmSync(join(dir, "תורה"), { recursive: true, force: true });
  }
  if (gal) await capture(p, "home", "מסך הפתיחה");
  s.decide("איזה כרטיס מתאים ל'תיקיית פירושים מול אוצריא'? (תיקייה מול אוצריא / כמה ספרים יחד / ספר ופירוש)");
  await s.click(task(p, "תיקייה מול אוצריא"), "במסך הפתיחה: 'תיקייה מול אוצריא'");
  await s.shot("a-1-files-empty");
  if (gal) await capture(p, "guided-files-empty", "מודרך 1: בחירת ספרים (ריק)");
  await s.pick(guided(p).getByRole("button", { name: "הספרים: תיקייה" }), dir, "'תיקייה' ובחירת התיקייה");
  await guided(p).getByRole("list", { name: "נבחרו" }).waitFor({ timeout: 60_000 });
  await wait(p, 800);
  await s.shot("a-1-files");
  if (gal) await capture(p, "guided-files", "מודרך 1: בחירת ספרים");
  await s.click(nextBtn(p), "'הבא'");
  await wait(p, 800);
  await s.shot("a-2-books");
  if (gal) await capture(p, "guided-books", "מודרך 2: מה נמצא");
  await s.click(nextBtn(p), "'הבא'");
  await wait(p, 600);
  await s.shot("a-3-db-needed");
  if (gal) await capture(p, "guided-db-needed", "מודרך 3: צריך את מסד אוצריא");
  await s.pick(guided(p).getByRole("button", { name: "מסד אוצריא: מסד נתונים" }), [MINI_DB], "'בחירת מסד אוצריא' ובחירת seforim.db");
  await guided(p).getByText("כל ספרי הבסיס נמצאו.").waitFor({ timeout: 60_000 }).catch(() => {});
  await wait(p, 600);
  await s.shot("a-3-db");
  if (gal) await capture(p, "guided-db", "מודרך 3: המסד נפתח");
  await s.click(nextBtn(p), "'הבא'");
  await wait(p, 1000);
  await s.shot("a-4-plan");
  if (gal) await capture(p, "guided-plan", "מודרך 4: התוכנית");
  s.decide("בשביל מה הקישורים? (לספרייה / לשימוש שלי)");
  await s.click(guided(p).getByRole("button", { name: "הפעלה" }), "'הפעלה'");
  await guided(p).getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$|^כל הוודאיות אושרו$/ }).waitFor({ timeout: 300_000 });
  await wait(p, 600);
  await s.shot("a-5-run");
  if (gal) await capture(p, "guided-run", "מודרך 5: תוצאות");
  const all = guided(p).getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$/ });
  if (await all.isEnabled().catch(() => false)) await s.click(all, "'אישור כל הוודאיות'");
  const review = guided(p).getByRole("button", { name: "מעבר עליהן" });
  if (await review.isEnabled().catch(() => false)) {
    s.decide("לעבור על ההצעות הלא ודאיות?");
    await s.click(review, "'מעבר עליהן'");
    await wait(p, 600);
    await s.shot("a-5-review");
    if (gal) await capture(p, "guided-review", "מודרך 5: כרטיס בדיקה");
    const approve = guided(p).getByRole("region", { name: "ההצעות לבדיקה" }).getByRole("button", { name: /^אישור/ }).first();
    if (await approve.isVisible().catch(() => false)) await s.click(approve, "'אישור' בכרטיס");
  }
  await s.click(nextBtn(p), "'הבא'");
  const dl = guided(p).getByRole("button", { name: /^הורדת/ });
  await dl.waitFor({ timeout: 120_000 });
  await wait(p, 1500);
  await s.shot("a-6-finish");
  if (gal) await capture(p, "guided-finish", "מודרך 6: בדיקה והורדה");
  if (await dl.isEnabled()) {
    const d = p.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
    await s.click(dl, "'הורדת…'");
    const file = await d;
    if (file) s.note(`הורד: ${file.suggestedFilename()}`);
    await wait(p, 800);
    await s.shot("a-6-next");
    if (gal) await capture(p, "guided-next", "מודרך 6: מה עכשיו");
  } else s.note("כפתור ההורדה מושבת");
  s.verdict = "done";
}

/** (b) four commentaries on one tractate → the Gemara in the real database. */
async function taskB(s, { gal }) {
  if (!REAL_DB) return (s.verdict = "skipped: AUDIT_REAL_DB not set");
  const p = await s.open();
  const dir = join(IN, "tractate");
  const files = readdirSync(dir).map((f) => join(dir, f));
  s.decide("ארבעה פירושים על מסכת אחת: איזה כרטיס? (ספר ופירוש / כמה ספרים יחד / תיקייה מול אוצריא)");
  await s.click(task(p, "כמה ספרים יחד"), "במסך הפתיחה: 'כמה ספרים יחד'");
  await s.pick(guided(p).getByRole("button", { name: "הספרים: קבצים" }), files, "'קבצים' ובחירת ארבעת הפירושים");
  await guided(p).getByRole("list", { name: "נבחרו" }).waitFor({ timeout: 60_000 });
  await wait(p, 800);
  await s.click(nextBtn(p), "'הבא'");
  await wait(p, 800);
  await s.shot("b-2-books");
  await s.click(nextBtn(p), "'הבא'");
  await wait(p, 600);
  await s.shot("b-3-db-needed");
  const t0 = Date.now();
  await s.pick(guided(p).getByRole("button", { name: "מסד אוצריא: מסד נתונים" }), [REAL_DB], "'בחירת מסד אוצריא' ובחירת seforim.db האמיתי");
  await guided(p).getByText("כל ספרי הבסיס נמצאו.").waitFor({ timeout: 120_000 }).catch(() => {});
  s.timings.openRealDb = Date.now() - t0;
  await wait(p, 600);
  await s.shot("b-3-db");
  await s.click(nextBtn(p), "'הבא'");
  await wait(p, 1500);
  await s.shot("b-4-plan");
  if (gal) await capture(p, "guided-plan-tractate", "מודרך 4: תוכנית — ארבעה פירושים על מסכת");
  const t1 = Date.now();
  await s.click(guided(p).getByRole("button", { name: "הפעלה" }), "'הפעלה'");
  await wait(p, 4000);
  await s.shot("b-5-running");
  if (gal) await capture(p, "guided-running", "מודרך 5: עבודה רצה (השהיה/עצירה)");
  await guided(p).getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$|^כל הוודאיות אושרו$/ }).waitFor({ timeout: 900_000 });
  s.timings.run = Date.now() - t1;
  await wait(p, 600);
  await s.shot("b-5-run");
  s.note(`תוצאה: ${(await guided(p).locator(".guided-body").innerText()).replace(/\s+/g, " ").slice(0, 600)}`);
  const all = guided(p).getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$/ });
  if (await all.isEnabled().catch(() => false)) await s.click(all, "'אישור כל הוודאיות'");
  // what does the user see of one commentary on the Gemara? the workspace, the reader with the links
  await s.click(guided(p).getByRole("button", { name: "פתיחה בסביבת העבודה" }), "'פתיחה בסביבת העבודה' (לראות את הקישורים על הטקסט)");
  await wait(p, 2000);
  await s.shot("b-ws");
  if (gal) await capture(p, "ws-tractate", "סביבת העבודה: פירוש על הגמרא, קישורים מאושרים");
  // a line with links: click the first source line that has a mark
  const marked = p.locator(".reader.source .ln.linked, .reader.source .ln.has-link, .reader.source .ln[data-links]").first();
  if (await marked.count()) {
    await s.click(marked, "לחיצה על שורה מקושרת במקור");
    await wait(p, 800);
    await s.shot("b-ws-line");
    if (gal) await capture(p, "ws-tractate-line", "סביבת העבודה: שורה מקושרת נבחרה");
  } else s.note("לא נמצאה שורה מסומנת כמקושרת בקורא המקור");
  s.verdict = "done";
}

/** (c) a folder of 200 commentaries → the Otzaria database, with pause and resume in the middle. */
async function taskC(s, { gal }) {
  const p = await s.open();
  await s.click(task(p, "תיקייה מול אוצריא"), "במסך הפתיחה: 'תיקייה מול אוצריא'");
  await s.pick(guided(p).getByRole("button", { name: "הספרים: תיקייה" }), join(IN, "b200"), "'תיקייה' ובחירת 200 הפירושים");
  await guided(p).getByRole("list", { name: "נבחרו" }).waitFor({ timeout: 120_000 });
  await wait(p, 800);
  await s.click(nextBtn(p), "'הבא'");
  await wait(p, 800);
  await s.shot("c-2-books");
  if (gal) await capture(p, "guided-books-200", "מודרך 2: 200 ספרים");
  await s.click(nextBtn(p), "'הבא'");
  await s.pick(guided(p).getByRole("button", { name: "מסד אוצריא: מסד נתונים" }), [MINI_DB], "'בחירת מסד אוצריא'");
  await guided(p).getByText("כל ספרי הבסיס נמצאו.").waitFor({ timeout: 60_000 }).catch(() => {});
  await s.click(nextBtn(p), "'הבא'");
  await wait(p, 1500);
  await s.shot("c-4-plan");
  const t1 = Date.now();
  await s.click(guided(p).getByRole("button", { name: "הפעלה" }), "'הפעלה'");
  const pause = p.getByRole("button", { name: /^השהיה/ }).first();
  if (await pause.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await wait(p, 1500);
    await s.shot("c-5-running");
    await s.click(pause, "'השהיה' באמצע");
    await wait(p, 2500);
    await s.shot("c-5-paused");
    if (gal) await capture(p, "guided-paused", "מודרך 5: עבודה מושהית");
    const resume = p.getByRole("button", { name: /^המשך/ }).first();
    await s.click(resume, "'המשך'");
  } else s.note("לא נראה כפתור השהיה בזמן הריצה");
  await guided(p).getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$|^כל הוודאיות אושרו$/ }).waitFor({ timeout: 900_000 });
  s.timings.run = Date.now() - t1;
  await wait(p, 800);
  await s.shot("c-5-run");
  if (gal) await capture(p, "guided-run-200", "מודרך 5: תוצאות 200 ספרים");
  const all = guided(p).getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$/ });
  if (await all.isEnabled().catch(() => false)) await s.click(all, "'אישור כל הוודאיות'");
  await s.click(nextBtn(p), "'הבא'");
  const dl = guided(p).getByRole("button", { name: /^הורדת/ });
  await dl.waitFor({ timeout: 300_000 });
  await wait(p, 2000);
  await s.shot("c-6-finish");
  if (await dl.isEnabled()) {
    const d = p.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
    await s.click(dl, "'הורדת…'");
    const f = await d;
    if (f) s.note(`הורד: ${f.suggestedFilename()}`);
  }
  // the same job in the workspace: the job panel and the per-book report
  await s.click(guided(p).getByRole("button", { name: "פתיחה בסביבת העבודה" }).or(p.getByRole("button", { name: "פתיחה בסביבת העבודה" })).first(), "'פתיחה בסביבת העבודה'").catch(() => {});
  await wait(p, 1500);
  if (gal) {
    await safe("ws-maxlink", async () => {
      await p.getByRole("tab", { name: /הצעות/ }).click();
      await wait(p, 800);
      await capture(p, "ws-suggestions-200", "סביבת העבודה: הצעות אחרי קישור מרבי של 200 ספרים");
    });
  }
  s.verdict = "done";
}

/** (d) existing links files: load, see them on the text, check, fix one, compare and merge. */
async function taskD(s, { gal }) {
  const p = await s.open();
  s.decide("איזה כרטיס? 'עריכת קישורים קיימים'");
  await s.click(task(p, "עריכת קישורים קיימים"), "במסך הפתיחה: 'עריכת קישורים קיימים'");
  await p.getByRole("dialog").waitFor();
  if (gal) await capture(p, "sheet-edit-links", "גיליון משימה: עריכת קישורים קיימים");
  await s.pick(p.getByRole("button", { name: "קובצי הקישורים: תיקייה" }), join(IN, "s7", "links"), "שלב 1 'תיקייה' ← links/");
  await wait(p, 1200);
  await s.pick(p.getByRole("button", { name: "הספרים שהקישורים מצביעים אליהם: תיקייה" }), join(IN, "s7", "books"), "שלב 2 'תיקייה' ← books/");
  await wait(p, 1200);
  await s.shot("d-sheet");
  if (gal) await capture(p, "sheet-edit-links-done", "גיליון משימה: אחרי בחירת שני השלבים");
  await s.click(p.getByRole("button", { name: "התחלה" }), "'התחלה'");
  await idle(p);
  await wait(p, 1500);
  await s.shot("d-links");
  if (gal) await capture(p, "ws-links-table", "סביבת העבודה: טבלת הקישורים");
  // one link: click it in the table, see both lines
  const item = p.locator(".vlist .link-item").first();
  if (await item.count()) {
    await s.click(item, "לחיצה על קישור בטבלה");
    await wait(p, 1000);
    await s.shot("d-link-selected");
    if (gal) await capture(p, "ws-link-selected", "סביבת העבודה: קישור נבחר — המקור והיעד מודגשים");
  }
  await s.click(p.getByRole("tab", { name: /בדיקה/ }), "לשונית 'בדיקה'");
  const run = p.getByRole("button", { name: /בדיקת הקישורים|הרצה מחדש/ }).first();
  if (await run.isVisible().catch(() => false)) await s.click(run, "'הרצת הבדיקה'");
  await idle(p);
  await wait(p, 1200);
  await s.shot("d-qa");
  if (gal) await capture(p, "ws-qa", "סביבת העבודה: דוח הבדיקה");
  const fix = p.getByRole("button", { name: "תיקון" }).first();
  if (await fix.isVisible().catch(() => false)) {
    await s.click(fix, "'תיקון' ליד השגיאה הראשונה");
    await wait(p, 1000);
    await s.shot("d-fix");
    if (gal) await capture(p, "ws-builder-edit", "סביבת העבודה: הבונה במצב עריכה");
  }
  s.verdict = "done";
}

/** (e) export: the same project for private use and for the library. */
async function taskE(s, { gal }) {
  const p = await s.open();
  await s.click(task(p, "ספר ופירוש"), "במסך הפתיחה: 'ספר ופירוש'");
  await s.pick(p.getByRole("button", { name: "הפירוש: קבצים" }), [join(IN, "s2", "ביאור חדש על בראשית.txt")], "שלב 1 'קבצים' ← הפירוש");
  await wait(p, 800);
  await s.pick(p.getByRole("button", { name: "ספר הבסיס, אם הוא במקור אחר: מסד נתונים" }), [MINI_DB], "שלב 2 'מסד נתונים' ← seforim.db");
  await wait(p, 1200);
  if (gal) await capture(p, "sheet-commentary", "גיליון משימה: ספר ופירוש");
  await s.click(p.getByRole("button", { name: "התחלה" }), "'התחלה'");
  await idle(p);
  await wait(p, 1200);
  await s.shot("e-ws");
  if (gal) await capture(p, "ws-four", "סביבת העבודה: ארבעה טורים, לפני חיפוש");
  await s.click(p.getByRole("button", { name: "חיפוש התאמות" }), "'חיפוש התאמות'");
  await idle(p);
  await wait(p, 1000);
  await s.shot("e-suggestions");
  if (gal) await capture(p, "ws-suggestions-table", "סביבת העבודה: הצעות — טבלה");
  const certain = p.getByRole("button", { name: /אישור כל הוודאיות/ });
  if (await certain.isEnabled().catch(() => false)) await s.click(certain, "'אישור כל הוודאיות'");
  await wait(p, 600);
  // export: the library (default) and private use
  await s.click(p.locator(".app-bar .export"), "'ייצוא'");
  const dlg = p.getByRole("dialog");
  await dlg.getByText("בודק את כל הקישורים מול הספרים…").waitFor({ state: "detached", timeout: 120_000 }).catch(() => {});
  await wait(p, 1200);
  await s.shot("e-export-library");
  if (gal) await capture(p, "dlg-export-library", "דיאלוג הייצוא: לספרייה");
  s.note(`ייצוא לספרייה: ${(await dlg.innerText()).replace(/\s+/g, " ").slice(0, 700)}`);
  const purpose = dlg.getByRole("combobox", { name: "למה מיועד הייצוא" });
  if (await purpose.count()) {
    s.decide("למה מיועד הייצוא?");
    await s.click(purpose, "פתיחת 'בשביל מה הקישורים?'");
    await purpose.selectOption("private");
  } else {
    const radio = dlg.getByRole("radio", { name: /שימוש שלי|פרטי/ }).first();
    await s.click(radio, "בחירת 'לשימוש שלי'");
  }
  await wait(p, 1500);
  await s.shot("e-export-private");
  if (gal) await capture(p, "dlg-export-private", "דיאלוג הייצוא: לשימוש פרטי");
  s.note(`ייצוא פרטי: ${(await dlg.innerText()).replace(/\s+/g, " ").slice(0, 700)}`);
  const btn = dlg.getByRole("button", { name: /^הורדת (ZIP|הקובץ)$/ }).first();
  if (await btn.isEnabled().catch(() => false)) {
    const d = p.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
    await s.click(btn, "'הורדת הקובץ'");
    const f = await d;
    if (f) s.note(`הורד: ${f.suggestedFilename()}`);
    await wait(p, 800);
    await s.shot("e-export-next");
    if (gal) await capture(p, "dlg-export-next", "דיאלוג הייצוא: מה עכשיו");
  }
  s.verdict = "done";
}

/* ------------------------------------------------------------------ gallery-only states */

async function galleryRest(browser) {
  const s = new Scenario(browser, 90, "gallery");
  const p = await s.open();
  // the workspace with two TXT books and suggestions in the three views, the presets, menus
  await safe("workspace", async () => {
    await openFiles(s, p, [join(IN, "s1", "בראשית.txt"), join(IN, "s1", "ביאור חדש על בראשית.txt")]);
    await capture(p, "ws-two-books", "סביבת העבודה: שני ספרי TXT");
    await p.getByRole("tab", { name: /הצעות/ }).click();
    await wait(p, 500);
    await capture(p, "ws-suggest-form", "סביבת העבודה: טופס ההצעות");
    await p.getByRole("button", { name: "חיפוש התאמות" }).click();
    await idle(p);
    for (const v of ["בתוך הטקסט", "כרטיס"]) {
      await p.getByRole("radiogroup", { name: "תצוגת ההצעות" }).getByRole("radio", { name: v }).click();
      await wait(p, 600);
      await capture(p, `ws-suggestions-${v === "כרטיס" ? "card" : "inline"}`, `סביבת העבודה: הצעות — ${v}`);
    }
    await p.getByRole("radiogroup", { name: "תצוגת ההצעות" }).getByRole("radio", { name: "טבלה" }).click();
    await p.getByRole("checkbox", { name: "בחירת הכול בעמוד" }).check().catch(() => {});
    const approve = p.getByRole("button", { name: /^אישור \d/ }).first();
    if (await approve.isVisible().catch(() => false)) await approve.click();
    await wait(p, 600);
    await p.getByRole("tab", { name: /בונה/ }).click();
    await p.locator(".reader.source .ln").nth(3).click();
    await p.locator(".reader.target .ln").nth(4).click();
    await wait(p, 600);
    await capture(p, "ws-builder", "סביבת העבודה: הבונה עם בחירה");
    await p.getByRole("tab", { name: /קישורים/ }).click();
    await wait(p, 600);
    await capture(p, "ws-links-list", "סביבת העבודה: רשימת הקישורים (פרויקט)");
    for (const preset of ["שני טקסטים וחלונית צד", "מקור מעל יעד"]) {
      await p.getByRole("button", { name: "פריסת סביבת העבודה" }).click();
      await p.getByRole("menuitemradio", { name: preset }).or(p.getByRole("menuitem", { name: preset })).first().click();
      await wait(p, 600);
      await capture(p, `ws-preset-${preset === "מקור מעל יעד" ? "stack" : "drawer"}`, `פריסה: ${preset}`);
    }
    await p.getByRole("button", { name: "פריסת סביבת העבודה" }).click();
    await p.getByRole("menuitemradio", { name: "ארבעה טורים" }).or(p.getByRole("menuitem", { name: "ארבעה טורים" })).first().click();
    await p.getByRole("button", { name: "הגדרות" }).click();
    await wait(p, 300);
    await capture(p, "menu-settings", "תפריט ההגדרות");
    await p.keyboard.press("Escape");
    await p.getByRole("button", { name: "פריסת סביבת העבודה" }).click();
    await wait(p, 300);
    await capture(p, "menu-layout", "תפריט הפריסה");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Control+h");
    await wait(p, 300);
    await capture(p, "menu-history", "רשימת הפעולות");
    await p.keyboard.press("Escape");
    // advanced mode: the builder's raw fields
    await p.locator(".app-bar .switch input").check();
    await p.getByRole("tab", { name: /בונה/ }).click();
    await p.locator(".reader.source .ln").nth(5).click();
    await p.locator(".reader.target .ln").nth(6).click();
    await wait(p, 400);
    await capture(p, "ws-builder-advanced", "סביבת העבודה: הבונה במצב מתקדם");
    await p.locator(".app-bar .switch input").uncheck();
    await p.keyboard.press("F1");
    await wait(p, 800);
    await capture(p, "dlg-help", "העזרה");
    await p.keyboard.press("Escape");
  });
  await s.close();

  // the database's own links, the compare/merge dialog, the links table with a file
  const s2 = new Scenario(browser, 91, "gallery-db");
  const p2 = await s2.open();
  await safe("db links / compare", async () => {
    await openFiles(s2, p2, [MINI_DB]);
    await capture(p2, "ws-db-open", "סביבת העבודה: מסד אוצריא פתוח");
    const books = p2.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
    await books.filter({ hasText: /^ארצות החיים/ }).getByRole("button", { name: "מקור" }).click({ timeout: 30_000 });
    await p2.getByRole("tab", { name: /קישורים/ }).first().click();
    await wait(p2, 500);
    const dbBtn = p2.getByRole("button", { name: /קישורים מהמסד|מהמסד/ }).first();
    if (await dbBtn.isVisible().catch(() => false)) await dbBtn.click();
    await wait(p2, 1500);
    await capture(p2, "ws-db-links", "סביבת העבודה: הקישורים שבמסד");
    await p2.getByRole("button", { name: "השוואה ומיזוג" }).click();
    const dlg = p2.getByRole("dialog");
    await wait(p2, 500);
    await capture(p2, "dlg-compare-empty", "השוואה ומיזוג: פתוח");
    const MEIR = "המאיר לארץ על ארצות החיים";
    const YEHUDA = "ארץ יהודה על ארצות החיים";
    const rec = (a, title, t, end) => ({ line_index_1: a, heRef_2: `${title} ${t}`, path_2: `${title}.txt`, line_index_2: t, ...(end && { line_index_2_end: end }), "Conection Type": "commentary" });
    const V2 = [rec(333, YEHUDA, 314, 317), rec(397, YEHUDA, 450, 460), rec(425, MEIR, 1980), rec(613, YEHUDA, 672, 711), rec(500, MEIR, 2000)];
    const f = join(OUT_DIR, "ארצות החיים_links.json");
    writeFileSync(f, JSON.stringify(V2, null, 2), "utf8");
    const ch = p2.waitForEvent("filechooser");
    await dlg.getByRole("button", { name: /הוספת קובצי/ }).click();
    await (await ch).setFiles([f]);
    await wait(p2, 800);
    await dlg.getByRole("button", { name: "קריאת הקישורים מהמסד" }).click().catch(() => {});
    await wait(p2, 1200);
    await dlg.getByRole("button", { name: "השוואה", exact: true }).click().catch(() => {});
    await wait(p2, 1200);
    await capture(p2, "dlg-compare", "השוואה ומיזוג: תוצאת השוואה");
    await dlg.getByRole("button", { name: "סגירה" }).first().click();
  });
  await s2.close();

  // the database wizard: a generic database, and one with no books
  for (const [id, file, title] of [["dlg-dbmap", "tests/fixtures/db/generic/books-lines.db", "אשף מיפוי מסד"], ["dlg-dbmap-nobooks", "tests/fixtures/db/wizard/settings-log.db", "אשף מיפוי: לא נמצאו ספרים"]]) {
    const s3 = new Scenario(browser, 92, id);
    const p3 = await s3.open();
    await safe(id, async () => {
      const ch = p3.waitForEvent("filechooser");
      await p3.getByRole("button", { name: "קבצים", exact: true }).click();
      await (await ch).setFiles([file]);
      await p3.getByRole("dialog", { name: /איך לקרוא את המסד/ }).waitFor({ timeout: 30_000 });
      await wait(p3, 1200);
      await capture(p3, id, title);
    });
    await s3.close();
  }

  // records in another layout, the relink dialog, the alt-toc dialog, a start sheet, recovery card
  const s4 = new Scenario(browser, 93, "gallery-misc");
  const p4 = await s4.open();
  await safe("records", async () => {
    const records = [
      { from: "ביאור חדש על בראשית", source_line: 2, book: "בראשית", to_line: 2, type: "commentary" },
      { from: "ביאור חדש על בראשית", source_line: 4, book: "בראשית", to_line: 3, type: "commentary" },
    ];
    const f = join(OUT_DIR, "export.json");
    writeFileSync(f, JSON.stringify(records), "utf8");
    const ch = p4.waitForEvent("filechooser");
    await p4.getByRole("button", { name: "קבצים", exact: true }).click();
    await (await ch).setFiles([join(IN, "s1", "בראשית.txt"), join(IN, "s1", "ביאור חדש על בראשית.txt"), f]);
    await p4.getByRole("dialog", { name: /ייבוא קישורים/ }).waitFor({ timeout: 30_000 });
    await wait(p4, 1000);
    await capture(p4, "dlg-records", "ייבוא קישורים במבנה אחר");
    await p4.keyboard.press("Escape");
  });
  await safe("relink", async () => {
    const v1 = ["<h1>ספר</h1>", "שורה ראשונה של הספר", "שורה שנייה של הספר", "שורה שלישית של הספר"];
    const dir1 = join(OUT_DIR, "relink-old");
    const dir2 = join(OUT_DIR, "relink-new");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir1, "ספר.txt"), v1.join("\n"));
    writeFileSync(join(dir1, "ספר_links.json"), JSON.stringify([2, 3].map((l) => ({ line_index_1: l, heRef_2: "בראשית א, א", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "commentary" }))));
    writeFileSync(join(dir2, "ספר.txt"), ["<h1>ספר</h1>", "הקדמה חדשה לגמרי", ...v1.slice(1)].join("\n"));
    await openFiles(s4, p4, [join(dir1, "ספר.txt"), join(dir1, "ספר_links.json")]);
    await openFiles(s4, p4, [join(dir2, "ספר.txt")]);
    await p4.getByRole("tab", { name: /קישורים/ }).click();
    await p4.getByRole("button", { name: "מעבר למהדורה חדשה של ספר" }).click();
    await wait(p4, 600);
    await capture(p4, "dlg-relink", "מעבר למהדורה חדשה");
    await p4.getByRole("dialog").getByRole("button", { name: "השוואה" }).click();
    await wait(p4, 1200);
    await capture(p4, "dlg-relink-diff", "מעבר למהדורה חדשה: השוואה");
    await p4.keyboard.press("Escape");
    await wait(p4, 300);
    await p4.getByRole("button", { name: /^מבני כותרות/ }).click();
    await wait(p4, 600);
    await capture(p4, "dlg-alt-toc", "מבני כותרות");
    await p4.keyboard.press("Escape");
  });
  await s4.close();

  const s5 = new Scenario(browser, 94, "gallery-sheets");
  const p5 = await s5.open();
  await safe("sheets", async () => {
    for (const id of ["relink", "db-links", "manual"]) {
      await p5.evaluate((h) => (location.hash = h), `#/start/${id}`);
      await p5.getByRole("dialog").waitFor();
      await wait(p5, 400);
      await capture(p5, `sheet-${id}`, `גיליון משימה: ${id}`);
      await p5.keyboard.press("Escape");
      await wait(p5, 300);
    }
  });
  await s5.close();
}

/* ------------------------------------------------------------------ main */

const TASKS = { a: [taskA, "תיקיית פירושים מול מסד אוצריא (מודרך)"], b: [taskB, "ארבעה פירושים על מסכת מול הגמרא (המסד האמיתי)"], c: [taskC, "תיקייה של 200 ספרים"], d: [taskD, "תיקון קישורים קיימים"], e: [taskE, "ייצוא לשימוש פרטי ולספרייה"] };
const browser = await launch();
const results = {};
try {
  if (PART === "tasks" || PART === "all") {
    for (const [k, [fn, title]] of Object.entries(TASKS)) {
      if (ONLY.length && !ONLY.includes(k)) continue;
      const s = new Scenario(browser, k, title);
      const t = Date.now();
      try {
        await fn(s, { gal: PART === "all" });
      } catch (e) {
        s.errors.push(`script: ${String(e.message ?? e).split("\n")[0]}`);
        try { await s.shot("failure"); } catch {}
        if (s.verdict === "?") s.verdict = "script failed";
      } finally {
        await s.close();
      }
      // the harness names shots s<id>-…; for a letter id that is "s0a-…" — move them under shots/
      results[k] = s.toJSON();
      console.log(`task ${k}: ${s.verdict} ${Date.now() - t} ms, ${s.clicks} clicks, ${s.decisions.length} decisions, errors: ${s.errors.length}`);
      writeFileSync(join(OUT_DIR, "tasks.json"), JSON.stringify(results, null, 2), "utf8");
    }
  }
  if (PART === "gallery" || PART === "all") await galleryRest(browser);
} finally {
  await browser.close();
}
