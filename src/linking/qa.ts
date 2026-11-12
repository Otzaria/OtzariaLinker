import type { Link } from "../core/links/model";
import { asExported, validateExport, type Problem, type Severity, type ValidationContext } from "../core/links/validate";

/*
 * Link quality report (stage 16). It reuses the export rules — QA and export must never disagree —
 * and groups every problem into a category a person can act on, with a plain-language title.
 */
export type QaCategory =
  | "duplicate"
  | "missing-book"
  | "out-of-range"
  | "heading"
  | "anchor"
  | "type"
  | "sefaria"
  | "title"
  | "reference"
  | "unverified"
  | "in-db"
  | "db-copy"
  | "library-file"
  | "other";

export const QA_CATEGORIES: Readonly<Record<QaCategory, { title: string; hint: string }>> = {
  duplicate: { title: "כפולים", hint: "שני קישורים שבמסד יהפכו לקישור אחד" },
  "missing-book": { title: "ספר לא נמצא", hint: "אחד הספרים אינו פתוח, או ששמו לא קיים במסד" },
  "out-of-range": { title: "מחוץ לספר", hint: "שורה או טווח אחרי סוף הספר" },
  heading: { title: "קישור לכותרת", hint: "אוצריא מדלגת על קישור שאחד מקצותיו שורת כותרת" },
  anchor: { title: "עוגן לא תקין", hint: "העוגן ייזרק או יתקצר" },
  type: { title: "סוג קשר", hint: "סוג לא מוכר, או קישור שיישמר כ\"אחר\"" },
  sefaria: { title: "כללי ספריא", hint: "ציוני ספריא, טווחים ועוגנים בקישורים לספרי ספריא" },
  title: { title: "שם ספר", hint: "שם שאוצריא מנרמלת או ממזגת" },
  reference: { title: "שם המקום", hint: "שם המקום ביעד חסר" },
  unverified: { title: "לא נבדק", hint: "השורה לא נטענה, ולכן לא נבדקה" },
  "in-db": { title: "כבר במסד", hint: "המסד הפתוח כבר מכיל קישור בין אותן שורות" },
  "db-copy": { title: "הועתק מהמסד", hint: "קישורים שהועתקו מהמסד: מה ששוחזר, ומה חסר כדי לייצא אותם בבטחה" },
  "library-file": { title: "קובץ הספרייה", hint: "הקובץ שייוצא יחליף את קובץ הקישורים של הספר בספרייה: טענו אותו מהספרייה או אשרו במפורש" },
  other: { title: "אחר", hint: "" },
};

const CATEGORY_OF: Record<string, QaCategory> = {
  "export/duplicate": "duplicate",
  "export/source-unknown": "missing-book",
  "export/target-unknown": "missing-book",
  "export/line-out-of-range": "out-of-range",
  "export/range-out-of-range": "out-of-range",
  "export/range-ignored": "out-of-range",
  "export/heading-line": "heading",
  "export/line-not-in-db": "heading",
  "export/range-end-heading": "heading",
  "export/anchor-dropped-flip": "anchor",
  "export/anchor-end-ignored": "anchor",
  "export/anchor-out-of-line": "anchor",
  "export/unknown-type": "type",
  "export/downgraded": "type",
  "export/linker": "type",
  "export/base-unknown": "type",
  "export/sefaria-both": "sefaria",
  "export/title-not-normalized": "title",
  "export/companion-merged": "title",
  "export/companion-merge-cancelled": "title",
  "export/companion-merge-broken": "title",
  "export/heref-missing": "reference",
  "export/line-not-verified": "unverified",
  "export/in-db": "in-db",
  "export/in-db-other-type": "in-db",
  "export/db-copy": "db-copy",
  "export/db-copy-no-file": "db-copy",
  "export/file-unverified": "library-file",
  "export/library-file-not-loaded": "library-file",
  "export/file-held": "library-file",
  "export/unsafe-title": "title",
  "export/reversed-dependency": "type",
  "export/anchor-on-notes-line": "anchor",
};
export const categoryOf = (code: string): QaCategory => CATEGORY_OF[code] ?? (code.startsWith("sefaria/") ? "sefaria" : "other");

/*
 * What to do about a problem, for the saved report (qa-html.ts): by code where one action fits,
 * otherwise by category. Many messages already end with an instruction; this line says it on its own,
 * so a reader of the report sees the action next to every issue.
 */
const FIX_BY_CODE: Readonly<Record<string, string>> = {
  "export/duplicate": "מחקו את ההעתק (\"מחיקת העתקים כפולים\" בלשונית הבדיקה), או קשרו אותו לשורה אחרת.",
  "export/heading-line": "קשרו לשורה שאחרי הכותרת.",
  "export/line-not-in-db": "קשרו לשורה שאחרי הכותרת הריקה.",
  "export/range-end-heading": "קצרו את הטווח כך שיסתיים לפני שורת הכותרת.",
  "export/range-ignored": "תקנו בבונה את סוף הטווח כך שיהיה אחרי ההתחלה, או הסירו אותו.",
  "export/anchor-dropped-flip": "הסירו את העוגן, או בחרו סוג קשר שנשמר בכיוון הזה.",
  "export/anchor-on-notes-line": "הסירו את העוגן מהקישור.",
  "export/anchor-end-ignored": "סמנו מחדש את המילים בבונה, או השאירו עוגן על מילה אחת.",
  "export/anchor-out-of-line": "סמנו מחדש את המילים בבונה.",
  "export/unknown-type": "בחרו בבונה סוג קשר מהרשימה.",
  "export/linker": "בחרו בבונה סוג קשר אחר.",
  "export/reversed-dependency": "בחרו בבונה את הסוג \"מקור\".",
  "export/sefaria-both": "מחקו את הקישור, או קשרו לספר שאינו של ספריא.",
  "export/heref-missing": "כתבו בבונה שם מקום ביעד, למשל שם הספר ומספר הפרק.",
  "export/line-not-verified": "פתחו את הספר (או את המסד שבו הוא נמצא) והריצו את הבדיקה שוב.",
  "export/in-db": "אם הקישור כבר נמצא בספרייה, מחקו אותו מהפרויקט.",
  "export/in-db-other-type": "אין צורך לתקן. ודאו שאינכם יוצרים קישור כפול.",
  "export/db-copy": "בדקו את שם המקום ביעד ואת סוג הקשר לפני הייצוא.",
  "export/file-held": "תקנו את הבעיה של הקובץ כולו שמתוארת בהסבר.",
  "export/unsafe-title": "שנו את שם הספר במקור שלו.",
  "export/title-not-normalized": "כתבו את שם הספר בדיוק כפי שהוא במסד.",
  "sefaria/both-refs": "הסירו בבונה את אחד משני ציוני ספריא.",
  "sefaria/ref1-side": "הסירו בבונה את ציון ספריא של המקור.",
  "sefaria/ref2-side": "הסירו בבונה את ציון ספריא של היעד.",
  "sefaria/both-sides": "מחקו את הקישור: קישור בין שני ספרי ספריא לא נשלח מקובץ.",
  "sefaria/ref1-required": "כתבו בבונה את ציון ספריא של שורת המקור (באנגלית), או בחרו בחלון הייצוא \"לשימוש פרטי\".",
  "sefaria/ref2-required": "כתבו בבונה את ציון ספריא של שורת היעד (באנגלית), או בחרו בחלון הייצוא \"לשימוש פרטי\".",
  "sefaria/range-side": "קשרו שורה אחת במקום טווח בצד של ספר ספריא.",
  "sefaria/anchor-range": "השאירו עוגן על מילה אחת, בלי סוף.",
  "sefaria/anchor-into-sefaria": "הסירו את העוגן.",
  "sefaria/not-library-edition": "בחרו בחלון הייצוא \"לשימוש פרטי\", או סמנו את המקור כ\"ספרי ספריית אוצריא\" אם הספר הוא עותק של ספר הספרייה.",
  "sefaria/pending-anchor-hash": "הסירו את העוגן, או השאירו אותו לתהליך של הספרייה.",
};

const FIX_BY_CATEGORY: Readonly<Record<QaCategory, string>> = {
  duplicate: FIX_BY_CODE["export/duplicate"]!,
  "missing-book": "פתחו את המסד או את קובץ הספר, או תקנו את שם הספר כך שיהיה זהה בדיוק לשם במסד.",
  "out-of-range": "תקנו בבונה את מספר השורה או את סוף הטווח לשורה שקיימת בספר.",
  heading: FIX_BY_CODE["export/heading-line"]!,
  anchor: "סמנו מחדש את המילים בבונה, או הסירו את העוגן.",
  type: "בחרו בבונה סוג קשר מתאים.",
  sefaria: "תקנו את ציון ספריא או את העוגן לפי ההסבר.",
  title: "בדקו את שם הספר מול השם שבמסד.",
  reference: FIX_BY_CODE["export/heref-missing"]!,
  unverified: FIX_BY_CODE["export/line-not-verified"]!,
  "in-db": FIX_BY_CODE["export/in-db"]!,
  "db-copy": "טענו את קובץ הקישורים של הספר מהספרייה לפני הייצוא.",
  "library-file": "טענו את קובץ הקישורים של הספר מהספרייה, או אשרו בחלון הייצוא שזה קובץ חדש.",
  other: "פתחו את הקישור בבונה ותקנו לפי ההסבר.",
};

/**
 * The one-click remedy the check offers next to a problem, when there is one (product audit F8): the
 * builder cannot fix a rule of the library's sync or an anchor the library refuses, so "fix in the
 * builder" alone left the error where it was.
 *   "private"     — export for private use: the library's Sefaria rules become warnings or do not apply;
 *   "drop-anchor" — remove the word anchor the library refuses or that breaks a notes merge.
 */
export type QaAction = "private" | "drop-anchor";
const PRIVATE_REMEDY = new Set(["sefaria/ref1-required", "sefaria/ref2-required", "sefaria/range-side", "sefaria/both-sides", "sefaria/not-library-edition"]);
const ANCHOR_REMEDY = new Set(["sefaria/anchor-range", "sefaria/anchor-into-sefaria", "sefaria/pending-anchor-hash", "export/anchor-on-notes-line", "export/anchor-dropped-flip", "export/companion-merge-broken"]);

export function qaAction(p: Problem, purpose: "submission" | "private" = "submission"): QaAction | null {
  if (p.severity === "info") return null;
  if (ANCHOR_REMEDY.has(p.code)) return "drop-anchor";
  if (purpose !== "private" && p.severity === "error" && PRIVATE_REMEDY.has(p.code)) return "private";
  return null;
}

/** One sentence: what the user can do about this problem (Hebrew). */
export const suggestedFix = (code: string, category: QaCategory = categoryOf(code)): string => FIX_BY_CODE[code] ?? FIX_BY_CATEGORY[category];

export interface QaIssue {
  link: Link;
  category: QaCategory;
  problem: Problem;
}

export interface QaReport {
  checked: number;
  /** links with no warning or error */
  clean: number;
  issues: QaIssue[];
  bySeverity: Record<Severity, number>;
  byCategory: Partial<Record<QaCategory, number>>;
}

export function runQa(links: readonly Link[], ctx: ValidationContext): QaReport {
  const live = links.filter((l) => l.status !== "deleted" && l.provenance !== "db");
  const problems = validateExport(live, ctx);
  const issues: QaIssue[] = [];
  let clean = 0;
  for (const l of live) {
    // as the export acts on them (asExported): an untouched library record is kept, its errors are warnings
    const ps = asExported(l, problems.get(l.id) ?? []).filter((p) => p.code !== "export/base-unknown"); // informational only
    if (!ps.some((p) => p.severity !== "info")) clean++;
    for (const p of ps) issues.push({ link: l, category: categoryOf(p.code), problem: p });
  }
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.problem.severity] - order[b.problem.severity] || a.link.source.book.title.localeCompare(b.link.source.book.title, "he") || a.link.source.line - b.link.source.line);
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  const byCategory: Partial<Record<QaCategory, number>> = {};
  for (const i of issues) {
    bySeverity[i.problem.severity]++;
    byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  }
  return { checked: live.length, clean, issues, bySeverity, byCategory };
}

/** Of each group of duplicates, every link but the first — safe to delete in one action. */
export function redundantDuplicates(report: QaReport): string[] {
  return report.issues.filter((i) => i.problem.code === "export/duplicate").map((i) => i.link.id);
}

/** The report as CSV (UTF-8 with BOM so Excel shows Hebrew), for review outside the tool. */
export function qaCsv(report: QaReport): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["חומרה", "קטגוריה", "ספר מקור", "שורת מקור", "ספר יעד", "שורת יעד", "שם המקום ביעד", "סוג", "הסבר", "קוד", "פרטים טכניים"];
  const sev: Record<Severity, string> = { error: "שגיאה", warning: "אזהרה", info: "מידע" };
  const rows = report.issues.map((i) =>
    [sev[i.problem.severity], QA_CATEGORIES[i.category].title, i.link.source.book.title, i.link.source.line + 1, i.link.target.book.title, i.link.target.line + 1, i.link.heRef2, i.link.declaredType, i.problem.message, i.problem.code, i.problem.detail ?? ""].map(esc).join(","),
  );
  return `﻿${[head.map(esc).join(","), ...rows].join("\r\n")}\r\n`;
}
