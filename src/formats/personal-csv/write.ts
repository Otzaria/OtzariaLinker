import type { BookRef, Link, LinkSide } from "../../core/links/model";
import { csvField } from "../sefaria-csv/write";

/*
 * `links.csv` of the personal-database build (YairDaniel11/Otzarya-Unofficial-Books: CLAUDE.md §7 and "תיעוד יצירת קישורים וסדר
 * הדורות" §4-5). Read as a DATA CONTRACT only — the repository carries no stated license, so nothing of its code is used here
 * (AGENTS.md §2.7: ideas and data contracts only, outside the organisation):
 *
 *   header   מקור,ספר_מקור,מקור_אישי,ספר_יעד,מיקום_יעד,סוג,יעד_אישי,קטגוריית_מקור
 *   מקור          a 1-based line of the personal book's text file (headings and blank lines are not linked)
 *   ספר_מקור      the personal book's file name without its extension
 *   מקור_אישי     always "כן";  יעד_אישי  always "לא"  (the target is a book of the official database)
 *   ספר_יעד       the book's title in the official database
 *   מיקום_יעד     the heading of the place in that book (a daf "ב.", a chapter "פרק א", "סימן ב", "פרק X הלכה Y")
 *   סוג           "פירוש", or "תרגום" for a translation — the only two words the files use
 *   קטגוריית_מקור the folder id of the source, only when the book's name is not unique in the library; otherwise empty
 * UTF-8 with a BOM, CRLF line ends, quoted as CSV only when a field has a comma, a quote or a line break (the files have
 * "שולחן ערוך, אורח חיים" quoted). The import is all-or-nothing per file, so the rows are split into numbered folders of at most
 * 25,000 rows ("קישורים/01…"), the books named "קובץ…" in folders of their own with 60,000 ("קישורים - קבצי קובץ (גדולים)/01…"),
 * a source book never split between two files. Our link model has no `מקור` for a heading line: such lines are skipped.
 */
export const PERSONAL_LINKS_HEADER = ["מקור", "ספר_מקור", "מקור_אישי", "ספר_יעד", "מיקום_יעד", "סוג", "יעד_אישי", "קטגוריית_מקור"] as const;

export type PersonalLinkType = "פירוש" | "תרגום";

export interface PersonalLinkRow {
  /** 1-based line of the personal book's text file */
  sourceLine: number;
  sourceBook: string;
  targetBook: string;
  position: string;
  type: PersonalLinkType;
  /** the id of the source's library folder, when the name is not unique */
  sourceCategory?: number;
}

/** What the writer needs to know about the books (the state layer answers it from the open sources). */
export interface PersonalExportContext {
  /** a book of the personal database (the source of every row) */
  isPersonal(book: BookRef): boolean;
  /** a book of the official database (the target of every row) */
  isOfficial(book: BookRef): boolean;
  /** false for a heading or a blank line of the personal book (0-based line) */
  contentLine(book: BookRef, line: number): boolean;
  /** the heading of the place in the official book that the side names, or null when the book has no heading for it */
  positionOf(side: LinkSide): string | null;
  /** the library folder id of a personal book whose name is not unique */
  categoryOf?(book: BookRef): number | undefined;
  /** how many lines the book has: a range `end` read from a file never walks past it (default: MAX_RANGE_LINES) */
  lineCount?(book: BookRef): number | undefined;
}

/** The longest range walked when the book's length is not known (formats may import only core, so this is not linking/coverage's cap). */
const MAX_RANGE_LINES = 5_000_000;

export type PersonalSkipCode = "csv/deleted" | "csv/ends" | "csv/type" | "csv/source-line" | "csv/no-position";

export interface PersonalSkip {
  link: Link;
  code: PersonalSkipCode;
  text: string;
}

const TYPE_OF: Readonly<Record<string, PersonalLinkType>> = { commentary: "פירוש", source: "פירוש", targum: "תרגום" };

/** Our links as rows. A link the format cannot say is skipped, with the reason — never written as something it is not. */
export function personalLinkRows(links: readonly Link[], ctx: PersonalExportContext): { rows: PersonalLinkRow[]; skipped: PersonalSkip[] } {
  const rows: PersonalLinkRow[] = [];
  const skipped: PersonalSkip[] = [];
  const seen = new Set<string>();
  const skip = (link: Link, code: PersonalSkipCode, text: string) => skipped.push({ link, code, text });
  for (const l of links) {
    if (l.status === "deleted") {
      skip(l, "csv/deleted", "הקישור נמחק.");
      continue;
    }
    const mine = ctx.isPersonal(l.source.book) && ctx.isOfficial(l.target.book) ? l.source : ctx.isPersonal(l.target.book) && ctx.isOfficial(l.source.book) ? l.target : null;
    if (!mine) {
      skip(l, "csv/ends", "הקובץ מחבר ספר אישי אל ספר של המאגר הרשמי; בקישור הזה שני הצדדים באותו מאגר.");
      continue;
    }
    const other = mine === l.source ? l.target : l.source;
    const type = TYPE_OF[l.declaredType.trim().toLowerCase()];
    if (!type) {
      skip(l, "csv/type", `לסוג "${l.declaredType}" אין מילה בקובץ הזה (רק פירוש ותרגום), ולכן לא נכתב.`);
      continue;
    }
    const position = ctx.positionOf(other);
    if (!position) {
      skip(l, "csv/no-position", `בספר "${other.book.title}" אין כותרת למקום של שורה ${other.line + 1}, והקובץ מזהה את היעד לפי כותרת.`);
      continue;
    }
    let any = false;
    const last = Math.min(mine.end ?? mine.line, (ctx.lineCount?.(mine.book) ?? MAX_RANGE_LINES) - 1);
    for (let line = Math.max(mine.line, 0); line <= last; line++) {
      if (!ctx.contentLine(mine.book, line)) continue;
      any = true;
      const row: PersonalLinkRow = { sourceLine: line + 1, sourceBook: mine.book.title, targetBook: other.book.title, position, type };
      const category = ctx.categoryOf?.(mine.book);
      if (category !== undefined) row.sourceCategory = category;
      const key = `${row.sourceBook}\u0000${row.sourceLine}\u0000${row.targetBook}\u0000${row.position}\u0000${row.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (!any) skip(l, "csv/source-line", "שורת המקור היא כותרת או שורה ריקה, והקובץ אינו מקשר אותן.");
  }
  return { rows, skipped };
}

export interface PersonalCsvFile {
  /** the folder inside the export: "קישורים/01" */
  folder: string;
  name: "links.csv";
  text: string;
  rows: number;
  /** the source books the file holds, in order */
  books: string[];
}

export interface PersonalCsvOptions {
  /** rows per file for ordinary books (default 25,000) */
  chunkRows?: number;
  /** rows per file for the books named "קובץ…" (default 60,000) */
  kovetzRows?: number;
}

const ROOT = "קישורים";
const KOVETZ_ROOT = "קישורים - קבצי קובץ (גדולים)";
const isKovetz = (title: string) => title.startsWith("קובץ");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function personalRowLine(r: PersonalLinkRow): string {
  return [r.sourceLine, r.sourceBook, "כן", r.targetBook, r.position, r.type, "לא", r.sourceCategory ?? ""].map(csvField).join(",");
}

/** The rows as files, deterministic: sorted by source book, line and target; a repeated row once; a book never split. */
export function writePersonalLinksCsv(rows: readonly PersonalLinkRow[], options: PersonalCsvOptions = {}): { files: PersonalCsvFile[] } {
  const sorted = [...rows].sort((a, b) => cmp(a.sourceBook, b.sourceBook) || a.sourceLine - b.sourceLine || cmp(a.targetBook, b.targetBook) || cmp(a.position, b.position) || cmp(a.type, b.type));
  const unique = sorted.filter((r, i) => i === 0 || personalRowLine(r) !== personalRowLine(sorted[i - 1]!));
  const byBook = new Map<string, PersonalLinkRow[]>();
  for (const r of unique) {
    const list = byBook.get(r.sourceBook);
    if (list) list.push(r);
    else byBook.set(r.sourceBook, [r]);
  }
  const files: PersonalCsvFile[] = [];
  const pack = (books: [string, PersonalLinkRow[]][], limit: number, root: string) => {
    let current: { books: string[]; rows: PersonalLinkRow[] } | null = null;
    const flush = () => {
      if (!current) return;
      const text = "﻿" + [PERSONAL_LINKS_HEADER.join(","), ...current.rows.map(personalRowLine)].join("\r\n") + "\r\n";
      files.push({ folder: `${root}/${String(files.filter((f) => f.folder.startsWith(`${root}/`)).length + 1).padStart(2, "0")}`, name: "links.csv", text, rows: current.rows.length, books: current.books });
      current = null;
    };
    for (const [title, list] of books) {
      if (current && current.rows.length + list.length > limit) flush();
      current ??= { books: [], rows: [] };
      current.books.push(title);
      current.rows.push(...list);
    }
    flush();
  };
  const entries = [...byBook];
  pack(entries.filter(([t]) => !isKovetz(t)), options.chunkRows ?? 25_000, ROOT);
  pack(entries.filter(([t]) => isKovetz(t)), options.kovetzRows ?? 60_000, KOVETZ_ROOT);
  return { files };
}

export type PersonalCsvProblemCode = "csv/header" | "csv/fields" | "csv/line" | "csv/constants" | "csv/type" | "csv/empty-field" | "csv/duplicate" | "csv/unknown-target" | "csv/unknown-position";

export interface PersonalCsvProblem {
  code: PersonalCsvProblemCode;
  /** 1-based line of the file (the header is line 1), or the 1-based index of the row for validatePersonalRows */
  line: number;
  text: string;
}

/** Splits CSV text into records, honouring quotes (a doubled quote is one) and either line ending; blank lines are dropped. */
function records(text: string): string[][] {
  const out: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "") out.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") endField();
    else if (c === "\n") endRow();
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) endRow();
  return out;
}

/** Reads a file of this format (the tool's own, or ours): the rows, and every problem with its line — a file with any is not trusted. */
export function parsePersonalLinksCsv(text: string): { rows: PersonalLinkRow[]; problems: PersonalCsvProblem[] } {
  const rows: PersonalLinkRow[] = [];
  const problems: PersonalCsvProblem[] = [];
  const recs = records(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!recs.length || recs[0]!.join(",") !== PERSONAL_LINKS_HEADER.join(",")) {
    problems.push({ code: "csv/header", line: 1, text: `כותרת הקובץ צריכה להיות ${PERSONAL_LINKS_HEADER.join(",")}.` });
    return { rows, problems };
  }
  for (const [i, f] of recs.slice(1).entries()) {
    const line = i + 2;
    if (f.length !== PERSONAL_LINKS_HEADER.length) {
      problems.push({ code: "csv/fields", line, text: `בשורה ${f.length} שדות במקום ${PERSONAL_LINKS_HEADER.length}.` });
      continue;
    }
    const [src, sourceBook, personal, targetBook, position, type, targetPersonal, category] = f as [string, string, string, string, string, string, string, string];
    if (!/^[1-9]\d*$/.test(src.trim())) {
      problems.push({ code: "csv/line", line, text: `"${src}" אינו מספר שורה (מבוסס 1).` });
      continue;
    }
    if (personal !== "כן" || targetPersonal !== "לא") {
      problems.push({ code: "csv/constants", line, text: 'בעמודות מקור_אישי ויעד_אישי צריך להיות "כן" ו"לא".' });
      continue;
    }
    if (type !== "פירוש" && type !== "תרגום") {
      problems.push({ code: "csv/type", line, text: `הסוג "${type}" אינו פירוש או תרגום.` });
      continue;
    }
    const row: PersonalLinkRow = { sourceLine: Number(src), sourceBook, targetBook, position, type };
    if (/^\d+$/.test(category.trim())) row.sourceCategory = Number(category);
    rows.push(row);
  }
  return { rows, problems };
}

export interface PersonalValidation {
  /** whether the official database has a book of this title */
  targetExists?(title: string): boolean;
  /** whether that book has a heading with this text (its tocEntry) */
  positionExists?(title: string, position: string): boolean;
}

/**
 * The rules the import enforces on a whole file, all-or-nothing: no empty field, a line number from 1, no repeated row, a target
 * book the official database has, and a heading of it. A file with one problem is refused whole, so the writer reports them all.
 */
export function validatePersonalRows(rows: readonly PersonalLinkRow[], v: PersonalValidation = {}): PersonalCsvProblem[] {
  const out: PersonalCsvProblem[] = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const at = i + 1;
    const p = (code: PersonalCsvProblemCode, text: string) => out.push({ code, line: at, text });
    if (!r.sourceBook.trim() || !r.targetBook.trim() || !r.position.trim()) {
      p("csv/empty-field", "שם ספר המקור, שם הספר שביעד או כותרת המקום ריקים.");
      continue;
    }
    if (!Number.isInteger(r.sourceLine) || r.sourceLine < 1) {
      p("csv/line", `מספר שורה ${r.sourceLine} אינו תקין (מבוסס 1).`);
      continue;
    }
    const key = personalRowLine(r);
    if (seen.has(key)) {
      p("csv/duplicate", "השורה חוזרת על שורה קודמת.");
      continue;
    }
    seen.add(key);
    if (v.targetExists && !v.targetExists(r.targetBook)) p("csv/unknown-target", `"${r.targetBook}" אינו שם של ספר במאגר הרשמי.`);
    else if (v.positionExists && !v.positionExists(r.targetBook, r.position)) p("csv/unknown-position", `בספר "${r.targetBook}" אין כותרת "${r.position}".`);
  }
  return out;
}

