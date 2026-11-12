import { SOURCE_VIEW_TYPES } from "./connection-type";
import type { LinkMatch } from "./equality";
import { isRange, type BookRef, type Link } from "./model";
import { storedForm } from "./stored-form";
import { isMergeableCompanionTitle, normalizeTitle, titleDeclaresDependencyOn, unsafeFileTitle } from "./titles";

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
  /** the line receives footnote bodies (schema 7 line_note / a merged "הערות על" companion) */
  hasNotes?: boolean;
}

export interface ValidationContext {
  /** undefined when the line is not loaded — the check is then reported as not verified */
  line(book: BookRef, index: number): LineFacts | undefined;
  lineCount(book: BookRef): number | undefined;
  /**
   * Whether the project holds a book's links file loaded from the library in this session
   * ("imported"), only a snapshot of it restored from a saved project ("unverified"), the user
   * confirmed the export may write the book's file without it ("confirmed-new"), or none of these
   * ("missing"). Absent = unknown: the file rules are skipped.
   */
  linksFile?(sourceTitle: string): LinksFileState;
  /**
   * The open library database says this book has links of its own (book_has_links.hasSourceLinks),
   * so the library may hold a links file for it. Absent or false = not known.
   */
  libraryMayHaveFile?(sourceTitle: string): boolean;
  /** How a link matches the links of the open databases (core/links/equality.ts); absent = not checked. */
  existing?(link: Link): LinkMatch | null;
}

export type LinksFileState = "imported" | "unverified" | "confirmed-new" | "missing";

/*
 * Problems that are about the book's WHOLE links file, not one link: the file would replace the
 * library's file wrongly. Every link of that book is held back — also untouched imports and in expert
 * mode — or the written file would silently drop the library's other records (security review A1–A4).
 */
export const FILE_LEVEL_CODES: ReadonlySet<string> = new Set(["export/unsafe-title", "export/file-unverified", "export/library-file-not-loaded", "export/db-copy-no-file", "export/file-held"]);

export function validateLink(link: Link, ctx: ValidationContext): Problem[] {
  const out: Problem[] = [];
  const add = (severity: Severity, code: string, message: string) => out.push({ code, severity, message });
  const { source: s, target: t } = link;

  // the source title is the file name: one that is not a plain file name is never written (A4)
  const unsafe = unsafeFileTitle(s.book.title);
  if (unsafe) add("error", "export/unsafe-title", `אי אפשר לכתוב קובץ קישורים בשם "${s.book.title}": ${unsafe}. שנו את שם הספר במקור שלו.`);
  if (link.provenance === "db")
    add("error", "export/db-link", "זה קישור קיים מהמסד. אי אפשר לכתוב אותו חזרה לקובץ קישורים כאילו נכתב שם (המידע המקורי שלו לא נשמר במסד).");
  if (link.provenance === "db-copy") {
    // A links file REPLACES the book's whole file in the library. A copied database link says the
    // library most likely HAS a file for this book, so writing a new one would delete its other links.
    if (ctx.linksFile?.(s.book.title) === "missing")
      add("error", "export/db-copy-no-file", `הקישור הועתק מהמסד, וקובץ הקישורים של "${s.book.title}" לא נטען לפרויקט. קובץ שייוצא יחליף את כל הקובץ שבספרייה וימחק את שאר הקישורים שבו. טענו את "${s.book.title}_links.json" מהספרייה, או אשרו שאין לספר קובץ.`);
    add("info", "export/db-copy", "הקישור הועתק מהמסד ושוחזר ממנו: heRef_2, הסוג המקורי והקובץ שבו ישב אינם שמורים במסד. בדקו אותם לפני הייצוא.");
  }
  // The book's file is a snapshot from a saved project, not the library's current file: writing it
  // would replace the library's file with what may be an old (or forged) copy (security review A3).
  const fileState = link.provenance !== "db" ? ctx.linksFile?.(s.book.title) : undefined;
  if (fileState === "unverified")
    add("error", "export/file-unverified", `קובץ הקישורים של "${s.book.title}" נשמר בפרויקט ולא נטען מהספרייה בהפעלה הזו. ייתכן שהוא ישן, והייצוא היה מחליף בו את הקובץ העדכני שבספרייה. טענו שוב את "${s.book.title}_links.json" מהספרייה, או אשרו במפורש שהעותק שבפרויקט הוא העדכני.`);
  // A new link of a book whose library file is not loaded, when the database says the book has links
  // of its own: the exported file would REPLACE that file and drop its records (compatibility review).
  if (fileState === "missing" && link.provenance !== "db-copy" && link.provenance !== "file" && ctx.libraryMayHaveFile?.(s.book.title))
    add("error", "export/library-file-not-loaded", `במסד יש קישורים של "${s.book.title}", ולכן כנראה יש לו קובץ קישורים בספרייה. קובץ שייוצא בלעדיו יחליף אותו וימחק את שאר הקישורים שבו. טענו את "${s.book.title}_links.json" מהספרייה, או אשרו שאין לספר קובץ.`);
  const match = link.provenance === "user" || link.provenance === "auto" || link.provenance === "import" ? ctx.existing?.(link) : null;
  if (match === "same-link")
    add("warning", "export/in-db", "הקישור הזה כבר קיים במסד: אותן שורות ואותו סוג, אחרי ההמרה של אוצריא. אם רשומה שלו כבר נמצאת בקובץ אחר בספרייה, הייצוא רק יכפיל אותה.");
  else if (match === "same-lines") add("info", "export/in-db-other-type", "במסד כבר יש קישור בין שתי השורות האלה, בסוג אחר או בכיוון אחר.");

  const f = storedForm(link);
  if (f.skipped === "linker") add("error", "export/linker", 'קישורים מסוג "קישור אוטומטי" (linker) אינם מיובאים לאוצריא. בחרו סוג אחר.');
  if (f.skipped === "sefaria-both") add("error", "export/sefaria-both", "שני הספרים הם ספרי ספריא. אוצריא אינה מייבאת קישור כזה מקובץ.");
  if (!f.knownType) add("warning", "export/unknown-type", `סוג הקשר "${link.declaredType}" אינו מוכר לאוצריא, והקישור יישמר כ"אחר".`);
  if (f.downgraded)
    add("warning", "export/downgraded", `"${t.book.title}" הוא ספר בסיס ו"${s.book.title}" אינו בצורה "X על ${t.book.title}", ולכן הקישור יישמר כ"אחר" ולא יופיע בפאנל המפרשים.`);
  // Compatibility review #1: a commentary file that says "commentary" toward its own base book is
  // stored commentary → base, so the app shows the BASE in the commentary's commentary panel. Only
  // Sefaria priority-list books are base books (isBaseBook), so the generator does not fix it.
  if (!f.skipped && !f.flipped && SOURCE_VIEW_TYPES.has(f.stored) && titleDeclaresDependencyOn(f.storedSource.book.title, f.storedTarget.book.title))
    add("warning", "export/reversed-dependency", `הקישור יישמר הפוך: "${f.storedTarget.book.title}" יופיע כמפרש של "${f.storedSource.book.title}". בקישור מפירוש אל הספר שעליו נכתב בחרו את הסוג "מקור" (source).`);
  if (f.uncertain) add("info", "export/base-unknown", "לא ידוע אם אחד הספרים הוא ספר בסיס, ולכן לא בטוח באיזה פאנל באוצריא הקישור יופיע.");

  // The generator accepts an empty heRef_2, but the library's weekly sync rejects a blank one
  // (ManualLinksJson.kt:271,302-304) and fails the whole refresh — an error (compatibility review B3).
  if (!link.heRef2.trim()) add("error", "export/heref-missing", "שם המקום ביעד (heRef_2) ריק. הסנכרון השבועי של הספרייה דוחה רשומה כזו ונכשל כולו. כתבו שם מקום, למשל שם הספר ומספר השורה.");
  // The source title is the links file's name: when no book has it, the generator matches nothing
  // and drops the WHOLE file (seen in the library: "וזה לשונו - שובבי׳׳ם_links.json", whose book is
  // "…שובבי״ם" in the database — real-data validation, check 3).
  if (s.book.origin === "unknown") add("warning", "export/source-unknown", `ספר המקור "${s.book.title}" לא נמצא באף מקור פתוח. אם אין ספר בשם הזה בדיוק במסד, אוצריא תדלג על כל קובץ הקישורים שלו.`);
  if (t.book.origin === "unknown") add("warning", "export/target-unknown", `הספר "${t.book.title}" לא נמצא באף מקור פתוח. אם אין ספר בשם הזה בדיוק במסד, הקישור יידחה.`);
  // "הערות על X" (LINK_FORMATS §1.11, Generator.kt:929-937,1004-1008): merged into the base only when no
  // record of the base's file has a word anchor on a line that receives a note. An anchored record
  // CANCELS the merge — the companion stays a book and the links are kept (compatibility review B5).
  if (isMergeableCompanionTitle(t.book.title)) {
    if (link.anchor)
      add("info", "export/companion-merge-cancelled", `"${t.book.title}" מתחיל ב"הערות על", ואוצריא ממזגת ספר כזה לתוך ספר הבסיס. אבל לרשומה הזו יש עוגן על שורה שמקבלת הערה, וזה מבטל את המיזוג: ההערות יישארו ספר נפרד והקישורים יישמרו.`);
    else
      add("warning", "export/companion-merged", `"${t.book.title}" מתחיל ב"הערות על". אם כל תנאי המיזוג מתקיימים, אוצריא תשלב את ההערות בשורות של "${s.book.title}", והרשומות אליו לא יישמרו כקישורים. כדי שההערות יישארו ספר עם קישורים, תנו לו שם כמו "הערות ל…", או קשרו עם עוגן.`);
  }
  if (t.book.origin === "otzaria" && t.book.title !== normalizeTitle(t.book.title))
    add("error", "export/title-not-normalized", `שם הספר "${t.book.title}" כתוב עם מירכאות או רווחים שאוצריא מנרמלת (למשל "→״). במסד הוא נקרא "${normalizeTitle(t.book.title)}", והקישור לא יימצא.`);

  sideChecks("ספר המקור", link.source, ctx, add);
  sideChecks("ספר היעד", link.target, ctx, add);
  anchorChecks(link, f.flipped, ctx, add);
  sefariaChecks(link, add);
  return out;
}

type Add = (severity: Severity, code: string, message: string) => void;

/**
 * The base's links file in the library merges "הערות על X" today (its records to X have no anchor),
 * and the export adds or edits a record with a word anchor on one of those note lines: that cancels
 * the merge (Generator.kt:1004-1008) — X becomes a separate book and the notes leave the base's
 * lines. Said on every such anchored record (compatibility review B5).
 */
function companionMergeChecks(links: readonly Link[], out: Map<string, Problem[]>): void {
  const noteLines = new Map<string, Set<number>>(); // "<base>|<companion>" → base lines the library merges today
  for (const l of links)
    if (l.provenance === "file" && l.status === "existing" && !l.anchor && isMergeableCompanionTitle(l.target.book.title)) {
      const k = `${l.source.book.title}|${l.target.book.title}`;
      noteLines.set(k, (noteLines.get(k) ?? new Set()).add(l.source.line));
    }
  if (!noteLines.size) return;
  for (const l of links) {
    if (!l.anchor || (l.provenance === "file" && l.status === "existing")) continue;
    for (const [k, lines] of noteLines) {
      const [base, companion] = k.split("|") as [string, string];
      if (l.source.book.title !== base || !lines.has(l.source.line)) continue;
      out.get(l.id)?.push({
        code: "export/companion-merge-broken",
        severity: "warning",
        message: `קובץ הקישורים של "${base}" בספרייה ממזג היום את "${companion}" לתוך הספר (רשומות בלי עוגן). לרשומה הזו יש עוגן על שורה ${l.source.line + 1}, שמקבלת הערה, וזה יבטל את המיזוג: "${companion}" ייכנס לאוצריא כספר נפרד, וההערות לא יופיעו עוד בתוך שורות "${base}". אם זה לא מה שרציתם, הסירו את העוגן.`,
      });
      break;
    }
  }
}

function sideChecks(label: string, side: Link["source"], ctx: ValidationContext, add: Add) {
  const count = ctx.lineCount(side.book);
  if (side.line < 0 || (count !== undefined && side.line >= count))
    return add("error", "export/line-out-of-range", `שורה ${side.line + 1} ב${label} אינה קיימת (בספר ${count ?? "?"} שורות).`);
  const facts = ctx.line(side.book, side.line);
  if (!facts) add("info", "export/line-not-verified", `שורת ${label} לא נטענה, ולכן לא נבדק אם היא כותרת.`);
  else if (!facts.exists) add("error", "export/line-not-in-db", `שורה ${side.line + 1} ב${label} היא כותרת ריקה, ואוצריא לא יוצרת אותה במסד. הקישור יידחה.`);
  else if (facts.heading !== null) add("error", "export/heading-line", `שורה ${side.line + 1} ב${label} היא שורת כותרת. אוצריא מדלגת על קישור שאחד מקצותיו כותרת — קשרו לשורה שאחריה.`);

  if (side.end !== undefined && side.end <= side.line) add("warning", "export/range-ignored", `סוף הטווח ב${label} אינו אחרי ההתחלה, והטווח לא ייחשב.`);
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
  // Compatibility review #3: an anchor on a line that receives merged notes cancels the whole
  // "הערות על" merge in the generator (Generator.kt:937,1004-1008), and the offsets then shift.
  if (facts?.hasNotes && link.source.book.origin !== "sefaria")
    add("warning", "export/anchor-on-notes-line", "בשורה הזו משולבות הערות שוליים. עוגן כאן מבטל באוצריא את מיזוג ספר ההערות כולו, והמילים המסומנות יזוזו. עדיף קישור בלי עוגן.");
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
  if (srcSef && !tgtSef && link.ref1 === undefined)
    // a warning, not an error: only the library's weekly sync needs it; the generator ignores it (UX review #8)
    add("warning", "sefaria/ref1-required", "ספר המקור הוא ספר ספריא. כדי לשלוח את הקישור לספריית אוצריא, הוסיפו את ציון ספריא באנגלית (ref_1). לשימוש פרטי אפשר בלי.");
  if (tgtSef && !srcSef && link.ref2 === undefined)
    add("warning", "sefaria/ref2-required", "ספר היעד הוא ספר ספריא. כדי לשלוח את הקישור לספריית אוצריא, הוסיפו את ציון ספריא באנגלית (ref_2). לשימוש פרטי אפשר בלי.");
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
  // the file-level rule: one link that holds its book's file back holds every link of that book
  const heldFiles = new Map<string, Problem>();
  for (const l of links) {
    const problems = validateLink(l, ctx);
    const key = keyOf(l);
    const first = seen.get(key);
    if (first !== undefined)
      problems.push({ code: "export/duplicate", severity: "warning", message: "קישור זהה (אחרי ההמרה של אוצריא) כבר קיים בייצוא. במסד שניהם יהיו קישור אחד." });
    else seen.set(key, l.id);
    out.set(l.id, problems);
    const fileLevel = problems.find((p) => FILE_LEVEL_CODES.has(p.code));
    if (fileLevel && !heldFiles.has(l.source.book.title)) heldFiles.set(l.source.book.title, fileLevel);
  }
  companionMergeChecks(links, out);
  if (heldFiles.size)
    for (const l of links) {
      const why = heldFiles.get(l.source.book.title);
      const problems = out.get(l.id)!;
      if (why && !problems.some((p) => FILE_LEVEL_CODES.has(p.code)))
        problems.push({ code: "export/file-held", severity: "error", message: `כל קובץ הקישורים של "${l.source.book.title}" מוחזק, ולכן גם הקישור הזה: ${why.message}` });
    }
  return out;
}
