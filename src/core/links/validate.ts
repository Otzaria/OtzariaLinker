import { isRange, type BookRef, type Link } from "./model";
import { storedForm } from "./stored-form";
import { isMergeableCompanionTitle, normalizeTitle } from "./titles";

/*
 * Will this link reach Otzaria as intended? Every rule below is a gate of the generator or of the
 * library's weekly pipeline (docs/contracts/LINK_FORMATS.md §1.4, §1.6–1.8, §4.2). Pure: the caller
 * supplies what it knows about the lines; unknown lines produce "not verified" notes, never guesses.
 *
 *   error   — the record will be dropped/rejected, or breaks the file for the pipeline
 *   warning — it will be stored, but not as the user probably expects (part lost, type changed…)
 *   info    — worth knowing (e.g. could not be verified)
 */
export type Severity = "error" | "warning" | "info";

export interface Problem {
  code: string;
  severity: Severity;
  message: string;
}

export interface LineFacts {
  /** false: the generator never creates this line (empty heading) */
  exists: boolean;
  heading: number | null;
  /** length of the anchor text (the string the generator counts offsets on) */
  anchorLength: number;
}

export interface ValidationContext {
  /** undefined when the line is not loaded — the check is then reported as not verified */
  line(book: BookRef, index: number): LineFacts | undefined;
  lineCount(book: BookRef): number | undefined;
}

export function validateLink(link: Link, ctx: ValidationContext): Problem[] {
  const out: Problem[] = [];
  const add = (severity: Severity, code: string, message: string) => out.push({ code, severity, message });
  const { source: s, target: t } = link;

  if (link.provenance === "db")
    add("error", "export/db-link", "זה קישור קיים מהמסד. אי אפשר לכתוב אותו חזרה לקובץ קישורים כאילו נכתב שם (המידע המקורי שלו לא נשמר במסד).");

  const f = storedForm(link);
  if (f.skipped === "linker") add("error", "export/linker", 'קישורים מסוג "קישור אוטומטי" (linker) אינם מיובאים לאוצריא. בחרו סוג אחר.');
  if (f.skipped === "sefaria-both") add("error", "export/sefaria-both", "שני הספרים הם ספרי ספריא. אוצריא אינה מייבאת קישור כזה מקובץ.");
  if (!f.knownType) add("warning", "export/unknown-type", `סוג הקשר "${link.declaredType}" אינו מוכר לאוצריא, והקישור יישמר כ"אחר".`);
  if (f.downgraded)
    add("warning", "export/downgraded", `"${t.book.title}" הוא ספר בסיס ו"${s.book.title}" אינו בצורה "X על ${t.book.title}", ולכן הקישור יישמר כ"אחר" ולא יופיע בפאנל המפרשים.`);
  if (f.uncertain) add("info", "export/base-unknown", "לא ידוע אם אחד הספרים הוא ספר בסיס, ולכן לא בטוח באיזה פאנל באוצריא הקישור יופיע.");

  if (!link.heRef2.trim()) add("error", "export/heref-missing", "חסר שם המקום ביעד (heRef_2). זה שדה חובה, ובלעדיו כל הקובץ נדחה.");
  if (t.book.origin === "unknown") add("warning", "export/target-unknown", `הספר "${t.book.title}" לא נמצא באף מקור פתוח. אם אין ספר בשם הזה בדיוק במסד, הקישור יידחה.`);
  if (isMergeableCompanionTitle(t.book.title))
    add("warning", "export/companion-merged", `"${t.book.title}" מתחיל ב"הערות על". ספר כזה ממוזג לתוך ספר הבסיס, וכל הקישורים אליו נמחקים בשקט. שם בטוח: "הערות ל…".`);
  if (t.book.origin === "otzaria" && t.book.title !== normalizeTitle(t.book.title))
    add("error", "export/title-not-normalized", `שם הספר "${t.book.title}" כתוב עם מירכאות או רווחים שאוצריא מנרמלת (למשל "→״). במסד הוא נקרא "${normalizeTitle(t.book.title)}", והקישור לא יימצא.`);

  sideChecks("המקור", link.source, ctx, add);
  sideChecks("היעד", link.target, ctx, add);
  anchorChecks(link, f.flipped, ctx, add);
  sefariaChecks(link, add);
  return out;
}

type Add = (severity: Severity, code: string, message: string) => void;

function sideChecks(label: string, side: Link["source"], ctx: ValidationContext, add: Add) {
  const count = ctx.lineCount(side.book);
  if (side.line < 0 || (count !== undefined && side.line >= count))
    return add("error", "export/line-out-of-range", `שורה ${side.line + 1} ב${label} אינה קיימת (בספר ${count ?? "?"} שורות).`);
  const facts = ctx.line(side.book, side.line);
  if (!facts) add("info", "export/line-not-verified", `שורת ${label} לא נטענה, ולכן לא נבדק אם היא כותרת.`);
  else if (!facts.exists) add("error", "export/line-not-in-db", `שורה ${side.line + 1} ב${label} היא כותרת ריקה, ואוצריא לא יוצרת אותה במסד. הקישור יידחה.`);
  else if (facts.heading !== null) add("error", "export/heading-line", `שורה ${side.line + 1} ב${label} היא שורת כותרת. אוצריא מדלגת על קישור שאחד מקצותיו כותרת — קשרו לשורה שאחריה.`);

  if (side.end !== undefined && side.end <= side.line) add("warning", "export/range-ignored", `סוף הטווח ב${label} אינו אחרי ההתחלה, והטווח יתעלם.`);
  if (isRange(side)) {
    if (count !== undefined && side.end! >= count) add("error", "export/range-out-of-range", `סוף הטווח ב${label} (שורה ${side.end! + 1}) מעבר לסוף הספר.`);
    const endFacts = ctx.line(side.book, side.end!);
    if (endFacts?.heading != null) add("warning", "export/range-end-heading", `הטווח ב${label} מסתיים בשורת כותרת. אוצריא תשמיט את הטווח ותשאיר קישור לשורה אחת.`);
  }
}

function anchorChecks(link: Link, flipped: boolean, ctx: ValidationContext, add: Add) {
  const a = link.anchor;
  if (!a) return;
  if (flipped) add("warning", "export/anchor-dropped-flip", "הקישור נשמר באוצריא בכיוון ההפוך (מקור/תלוי), ובכיוון הזה העוגן על המילה נזרק.");
  const facts = ctx.line(link.source.book, link.source.line);
  if (a.rawStart < 0 || (facts && a.rawStart > facts.anchorLength))
    add("warning", "export/anchor-out-of-line", "העוגן מצביע מחוץ לטקסט השורה, ואוצריא תזרוק אותו (הקישור עצמו יישמר).");
  if (a.rawEnd !== undefined && (a.rawEnd < a.rawStart || (facts && a.rawEnd > facts.anchorLength)))
    add("warning", "export/anchor-end-ignored", "סוף העוגן אינו תקין, ואוצריא תשמור עוגן נקודה בלבד.");
}

function sefariaChecks(link: Link, add: Add) {
  const srcSef = link.source.book.origin === "sefaria";
  const tgtSef = link.target.book.origin === "sefaria";
  if (link.ref1 !== undefined && link.ref2 !== undefined) add("error", "sefaria/both-refs", "ברשומה יש גם ref_1 וגם ref_2. מותר רק אחד מהם.");
  if (link.ref1 !== undefined && !srcSef) add("error", "sefaria/ref1-side", "ref_1 מותר רק כשספר המקור הוא ספר ספריא.");
  if (link.ref2 !== undefined && !tgtSef) add("error", "sefaria/ref2-side", "ref_2 מותר רק כשספר היעד הוא ספר ספריא.");
  const isNew = link.status === "new" || link.provenance === "user" || link.provenance === "auto";
  if (srcSef && !tgtSef && link.ref1 === undefined)
    add(isNew ? "error" : "warning", "sefaria/ref1-required", "ספר המקור הוא ספר ספריא: הסנכרון השבועי של הספרייה דורש ref_1 (ציון ספריא באנגלית).");
  if (tgtSef && !srcSef && link.ref2 === undefined)
    add(isNew ? "error" : "warning", "sefaria/ref2-required", "ספר היעד הוא ספר ספריא: הסנכרון השבועי של הספרייה דורש ref_2 (ציון ספריא באנגלית).");
  if ((srcSef || tgtSef) && link.anchor?.rawEnd !== undefined)
    add("error", "sefaria/anchor-range", "עוגן עם סוף (end) אינו נתמך בקישור שנוגע בספר ספריא.");
  if (tgtSef && !srcSef && link.anchor)
    add("error", "sefaria/anchor-into-sefaria", "עוגן (start) אינו מותר בקישור מספר אוצריא אל ספר ספריא.");
  if (link.ref1 !== undefined && link.anchor && link.passthrough?.["anchor_src_hash"] === undefined)
    add("error", "sefaria/pending-anchor-hash", "עוגן חדש עם ref_1 דורש anchor_src_hash, שרק הסנכרון של הספרייה מחשב. הסירו את העוגן או השאירו אותו לתהליך הספרייה.");
}

/** Problems of a whole export: per-link problems plus links that collapse into one in the database. */
export function validateExport(links: readonly Link[], ctx: ValidationContext, keyOf: (l: Link) => string): Map<string, Problem[]> {
  const out = new Map<string, Problem[]>();
  const seen = new Map<string, string>();
  for (const l of links) {
    const problems = validateLink(l, ctx);
    const key = keyOf(l);
    const first = seen.get(key);
    if (first !== undefined)
      problems.push({ code: "export/duplicate", severity: "warning", message: "קישור זהה (אחרי ההמרה של אוצריא) כבר קיים בייצוא. במסד שניהם יהיו קישור אחד." });
    else seen.set(key, l.id);
    out.set(l.id, problems);
  }
  return out;
}
