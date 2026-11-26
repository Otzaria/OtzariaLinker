import { CONNECTION_TYPE_KEY } from "./record";
import { detectLayout, stringifyElement, stringifyInLayout, DEFAULT_LAYOUT } from "./layout";
import type { BookRef, Link, LinkSide } from "../../core/links/model";
import { isRange } from "../../core/links/model";

/*
 * Links from a book of a personal library to a book of the OFFICIAL library, as the zmanenu-library source format writes them
 * (Otzaria/zmanenu-library docs/format.md, "קישור לספרייה הרשמית או למסד אחר — target_library", read 2026-11-26; an
 * organisation repository, taken as a data contract): a record in the personal book's own `<title>_links.json` with
 *   line_index_1     the 1-based line of the personal book
 *   target_library   "official"
 *   book_2           the official book's exact title
 *   heRef_2          the official line's heRef (preferred); without one, line_index_2 (1-based)
 *   Conection Type   as written, NOT reversed (external_link): "source" says the official book is the source of mine
 * Ranges and word anchors are not supported there (the builder ignores them with a warning): they are left out, and said.
 *
 * The 1-based lines are written here, like formats/personal-csv: these records never go through the model's own conversion
 * (convert.ts), which reads and writes the official `_links.json` record and nothing else.
 */
export const OFFICIAL_LIBRARY = "official";

export interface ExternalContext {
  /** a book of the repository being linked (the record's own book) */
  isRepo(book: BookRef): boolean;
  /** a book of the official library */
  isOfficial(book: BookRef): boolean;
  /** the official line's heRef, or null when it has none */
  heRefOf(side: LinkSide): string | null;
}

export type ExternalSkipCode = "external/deleted" | "external/ends" | "external/type" | "external/direction";

export interface ExternalResult {
  /** records by the repository book's title (the file they go into) */
  byTitle: Map<string, Record<string, unknown>[]>;
  skipped: { link: Link; code: ExternalSkipCode; text: string }[];
  /** written, with something left out (a range, an anchor) */
  warnings: { link: Link; text: string }[];
}

/** Which end of a dependency link the dependent book is (stored-form.ts: commentary is base → dependent; source is dependent → base). */
const DEPENDENT_END: Readonly<Record<string, "source" | "target">> = { commentary: "target", source: "source" };

export function externalRecords(links: readonly Link[], ctx: ExternalContext): ExternalResult {
  const out: ExternalResult = { byTitle: new Map(), skipped: [], warnings: [] };
  const seen = new Set<string>();
  for (const l of links) {
    if (l.status === "deleted") {
      out.skipped.push({ link: l, code: "external/deleted", text: "הקישור נמחק." });
      continue;
    }
    const mine = ctx.isRepo(l.source.book) && ctx.isOfficial(l.target.book) ? l.source : ctx.isRepo(l.target.book) && ctx.isOfficial(l.source.book) ? l.target : null;
    if (!mine) {
      out.skipped.push({ link: l, code: "external/ends", text: "הרשומה מחברת ספר של המאגר אל ספר של הספרייה הרשמית; בקישור הזה אין צד כזה." });
      continue;
    }
    const other = mine === l.source ? l.target : l.source;
    const declared = l.declaredType.trim().toLowerCase();
    let type: string;
    if (declared in DEPENDENT_END) {
      if ((DEPENDENT_END[declared] === "source") !== (mine === l.source)) {
        out.skipped.push({ link: l, code: "external/direction", text: `בקישור מסוג "${l.declaredType}" הספר של המאגר הוא ספר הבסיס, והספר הרשמי נשען עליו. רשומת target_library נכתבת בספר של המאגר ואומרת רק "הספר הרשמי הוא המקור שלי"; לכן הקישור לא נכתב.` });
        continue;
      }
      type = "source";
    } else if (declared === "targum") {
      out.skipped.push({ link: l, code: "external/type", text: 'לקישור מסוג "targum" אל ספר רשמי אין צורה מתועדת ברשומת target_library, ולכן הוא לא נכתב. כתבו אותו ידנית אחרי בדיקה.' });
      continue;
    } else if (mine !== l.source) {
      out.skipped.push({ link: l, code: "external/direction", text: `קישור מסוג "${l.declaredType}" יוצא מהספר הרשמי; רשומת target_library נכתבת רק מהספר של המאגר, ובה הסוג אינו מתהפך. לכן הקישור לא נכתב.` });
      continue;
    } else type = declared;
    const heRef = ctx.heRefOf(other)?.trim() || null;
    const rec: Record<string, unknown> = {
      line_index_1: mine.line + 1,
      target_library: OFFICIAL_LIBRARY,
      book_2: other.book.title,
      ...(heRef ? { heRef_2: heRef } : { line_index_2: other.line + 1 }),
      [CONNECTION_TYPE_KEY]: type,
    };
    const lost = [isRange(mine) || isRange(other) ? "טווח" : "", l.anchor ? "עוגן מילים" : ""].filter(Boolean);
    if (lost.length) out.warnings.push({ link: l, text: `${lost.join(" ו")} לא נכתבו: רשומת target_library אינה תומכת בהם.` });
    const key = recordKey(rec);
    if (seen.has(`${mine.book.title}\u0000${key}`)) continue;
    seen.add(`${mine.book.title}\u0000${key}`);
    const list = out.byTitle.get(mine.book.title);
    if (list) list.push(rec);
    else out.byTitle.set(mine.book.title, [rec]);
  }
  return out;
}

const recordKey = (r: Record<string, unknown>): string => JSON.stringify([r.line_index_1, r.target_library, r.book_2, r.heRef_2 ?? null, r.line_index_2 ?? null]);

/**
 * A links file with records added at its end: the existing text is kept byte for byte (its records, its layout), the new elements
 * are written in that layout, and a record the file already has (same line, library, book and place) is not added again.
 * `text` null: a new file. Returns the text and how many records were added.
 */
export function appendRecords(text: string | null, records: readonly Record<string, unknown>[]): { text: string; added: number } {
  const have = new Set<string>();
  if (text !== null) {
    let data: unknown;
    try {
      data = JSON.parse(text.replace(/^﻿/, ""));
    } catch {
      throw new Error("appendRecords: the existing file is not JSON");
    }
    if (!Array.isArray(data)) throw new Error("appendRecords: the existing file is not an array");
    for (const r of data) if (r && typeof r === "object") have.add(recordKey(r as Record<string, unknown>));
  }
  const fresh = records.filter((r) => {
    const k = recordKey(r);
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  if (text === null) return { text: stringifyInLayout(fresh, DEFAULT_LAYOUT), added: fresh.length };
  if (!fresh.length) return { text, added: 0 };
  const layout = detectLayout(text);
  const close = text.lastIndexOf("]");
  const head = text.slice(0, close).replace(/\s+$/, "");
  const tail = text.slice(close + 1);
  const elems = fresh.map((r) => stringifyElement(r, layout));
  const empty = head.endsWith("[");
  const body = layout.indent ? `${empty ? "" : ","}\n${layout.indent}${elems.join(`,\n${layout.indent}`)}\n]` : `${empty ? "" : layout.spaced ? ", " : ","}${elems.join(layout.spaced ? ", " : ",")}]`;
  return { text: `${head}${body}${tail}`, added: fresh.length };
}
