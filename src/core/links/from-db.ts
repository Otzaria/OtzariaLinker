import { anchorLabelFromHeRef, withAnchorLabel } from "../text/anchor-label";
import { rawOffsetFromVisible } from "../text/offsets";
import { canonicalTypeString, parseConnectionType, TYPE_LABELS, type ConnectionType } from "./connection-type";
import { storedLinkIdentity } from "./equality";
import type { BookRef, Link, LinkSide, RawAnchor } from "./model";
import { storedForm } from "./stored-form";
import { titleDeclaresDependencyOn } from "./titles";
import type { Problem } from "./validate";

/*
 * "העתקה לפרויקט": turning a database link (provenance "db", stored direction) into a project link
 * that a links file can carry — a RECONSTRUCTION, because the database does not keep the record
 * (LINK_FORMATS §4.4, §4.5). The rule: build every file record that the generator would store as
 * exactly this link (same stored lines, same stored type — equality.ts), and pick the most likely
 * one. Anything the record cannot carry, or had to be guessed, is reported, never dropped silently.
 *
 * The candidates, for a link stored S → T with type X:
 *   A  in S's file, S → T, "x"          — the stored direction, as the generator writes it unflipped
 *   B  in T's file, T → S, "source"     — only X = COMMENTARY: the library's commentary files say "source"
 *   C  in T's file, T → S, "x"          — a dependant type the generator flips because T's title is
 *                                         "… על S" and S is a base book (Generator.kt:2283-2291)
 * Each candidate is checked with storedForm (the port of the generator); one that does not come out
 * as the very same stored link is discarded.
 */
export interface AdoptContext {
  /** the line as the database holds it: anchor text (schema 7: with footnote bodies) and heRef; undefined = not loaded */
  line(book: BookRef, index: number): { anchorText: string; heRef: string | null } | undefined;
  /** whether the project holds the links file of a book (imported from the library) */
  hasLinksFile(title: string): boolean;
}

export interface AdoptResult {
  /** the project link, or null when no file record can produce this database link */
  link: Link | null;
  /** errors (why it was not copied), warnings (what is lost or guessed), infos — Hebrew */
  problems: Problem[];
}

interface Candidate {
  name: "A" | "B" | "C";
  source: LinkSide;
  target: LinkSide;
  declaredType: string;
}

export function adoptDbLink(db: Link, id: string, ctx: AdoptContext): AdoptResult {
  const problems: Problem[] = [];
  const add = (severity: Problem["severity"], code: string, message: string) => problems.push({ code, severity, message });
  const stored: ConnectionType = parseConnectionType(db.declaredType).type;
  const S = db.source;
  const T = db.target;

  if (stored === "LINKER") {
    add("error", "adopt/linker", 'קישור משכבת LINKER נבנה מחדש בכל בנייה של אוצריא, ואוצריא מדלגת על רשומת "linker" בקובץ. אי אפשר להעתיק אותו לקובץ קישורים.');
    return { link: null, problems };
  }
  if (S.book.origin === "sefaria" && T.book.origin === "sefaria") {
    add("error", "adopt/sefaria-both", "שני הספרים הם ספרי ספריא. קישור כזה מגיע מספריא, ואוצריא מדלגת על רשומה כזו בקובץ קישורים.");
    return { link: null, problems };
  }

  const want = storedLinkIdentity(db);
  const x = canonicalTypeString(stored);
  const all: Candidate[] = [
    { name: "A", source: S, target: T, declaredType: x },
    ...(stored === "COMMENTARY" ? [{ name: "B" as const, source: T, target: S, declaredType: "source" }] : []),
    { name: "C", source: T, target: S, declaredType: x },
  ];
  const valid = all.filter((c) => storedLinkIdentity(c) === want);
  if (!valid.length) {
    add("error", "adopt/not-reproducible", `אף רשומה בקובץ קישורים לא תישמר באוצריא כמו הקישור הזה (${TYPE_LABELS[stored].he} מ"${S.book.title}" אל "${T.book.title}"): הגנרטור היה הופך אותו או משנה את סוגו. ייתכן שמקורו בספריא או בסקריפט של הגנרטור.`);
    return { link: null, problems };
  }

  // Which file did the record most likely live in? An anchor on the stored source survives only
  // unflipped (Generator.kt:2318-2321), so it pins candidate A. Then a file the project already holds,
  // then the library's convention: a commentary's own file, with "source" (LINK_FORMATS §1.5).
  const anchors0 = (db.dbAnchors ?? []).filter((a) => a.side === 0);
  const flips = (c: Candidate) => storedForm(c).flipped;
  const score = (c: Candidate) =>
    (anchors0.length && !flips(c) ? 8 : 0) + (ctx.hasLinksFile(c.source.book.title) ? 4 : 0) + (titleDeclaresDependencyOn(c.source.book.title, c.target.book.title) ? 2 : 0) + (c.name === "B" ? 1 : 0);
  const chosen = [...valid].sort((a, b) => score(b) - score(a))[0]!;
  const f = storedForm(chosen);

  // heRef_2 is not in the database: the file target's own reference (line.heRef), with the anchor label
  const targetLine = ctx.line(chosen.target.book, chosen.target.line);
  // never blank: the weekly sync rejects an empty heRef_2 (B3)
  let heRef2 = targetLine?.heRef?.trim() ? targetLine.heRef : `${chosen.target.book.title} ${chosen.target.line + 1}`;

  let anchor: RawAnchor | undefined;
  if (anchors0.length && !f.flipped) {
    const a = anchors0[0]!;
    const text = ctx.line(S.book, S.line)?.anchorText;
    if (text === undefined) add("warning", "adopt/anchor-unread", "שורת המקור לא נטענה, ולכן העוגן על המילה לא הועתק.");
    else {
      anchor = {
        rawStart: rawOffsetFromVisible(text, a.charStart),
        ...(a.charEnd !== undefined && { rawEnd: rawOffsetFromVisible(text, a.charEnd) }),
        ...(a.label && { label: a.label }),
      };
      // the generator reads an anchor's label from heRef_2 (" אות X", Generator.kt:2420-2427)
      if (a.label) heRef2 = withAnchorLabel(heRef2, a.label);
      if (a.label && anchorLabelFromHeRef(heRef2) !== a.label) add("warning", "adopt/anchor-label", `לעוגן במסד יש תווית "${a.label}", אבל שם המקום שנבנה לא יישא אותה. תקנו את heRef_2 כך שיסתיים ב"אות ${a.label}".`);
    }
    if (anchors0.length > 1) add("warning", "adopt/anchors-extra", `לקישור במסד ${anchors0.length} עוגנים בשורת המקור; הועתק רק הראשון. כל עוגן נוסף הוא רשומה נפרדת בקובץ.`);
  } else if (anchors0.length) add("warning", "adopt/anchor-lost", "לקישור במסד יש עוגן על מילה, אבל הרשומה שנבחרה מתהפכת באוצריא, ובכיוון הזה העוגן נזרק.");
  if ((db.dbAnchors ?? []).some((a) => a.side === 1)) add("warning", "adopt/anchor-target", "לקישור במסד יש עוגן בצד היעד. לקובץ קישורים אין שדה כזה, והוא לא הועתק.");
  if (db.dbSuppressed?.length) add("warning", "adopt/suppressed", "ספריא מסתירה את הקישור הזה באחד הצדדים (link_suppressed_side). בקובץ קישורים אין דרך לומר זאת, ובקובץ הוא יוצג בשני הצדדים.");

  add("info", "adopt/heref", `heRef_2 אינו נשמר במסד. נלקח שם המקום של שורת היעד במסד ("${heRef2}"). בדקו אותו לפני הייצוא.`);
  if (valid.length > 1)
    add("info", "adopt/direction", `אותו קישור יכול לבוא גם מקובץ הקישורים של "${(chosen.source === S ? T : S).book.title}". הכלי בחר בקובץ של "${chosen.source.book.title}"${chosen.declaredType === "source" ? ' עם הסוג "מקור" (source), כמו בקובצי המפרשים בספרייה' : ""}.`);
  if (stored === "OTHER") add("info", "adopt/type-other", 'במסד הקישור שמור כ"אחר". בקובץ המקורי ייתכן שהיה סוג ריק, לא מוכר, או סוג שאוצריא הורידה ל"אחר". הכלי כותב "other".');
  if (!ctx.hasLinksFile(chosen.source.book.title))
    add("warning", "adopt/no-links-file", `קובץ הקישורים של "${chosen.source.book.title}" לא נטען לפרויקט. ייצוא שלו יחליף את הקובץ שבספרייה, ולכן הכלי לא ייצא את הקישור עד שתטענו את הקובץ (או תאשרו שאין לספר קובץ).`);

  const link: Link = {
    id,
    status: "new",
    provenance: "db-copy",
    source: chosen.source,
    target: chosen.target,
    declaredType: chosen.declaredType,
    heRef2,
    ...(anchor && { anchor }),
  };
  return { link, problems };
}
