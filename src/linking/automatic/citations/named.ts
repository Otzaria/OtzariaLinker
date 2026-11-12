import type { BookRef } from "../../../core/links/model";
import type { AltTocStructure } from "../../../core/alt-toc/model";
import { collectionOf, normTitle, type Collection } from "./aliases";
import { citationTokens, type Tok } from "./text";

/*
 * Units cited by NAME rather than by number: a chapter of the Talmud ("פרק הזהב", "בפ' המדיר") and a
 * parsha of the Torah ("בפרשת וירא"). The names come from the library itself — the alternative TOC
 * structures the database has (alt_toc: "Chapters"/פרקים of every Bavli tractate, "Parasha"/פרשות of
 * the five books of the Torah), never from a table written here. Each unit is a range of lines: from
 * its entry's line to the line before the next entry (the last one runs to the end of the book).
 *
 * Pure: the worker job reads the structures (workers/citations-job.ts) and hands them over.
 */

export type UnitKind = "chapter" | "parsha";

export interface NamedUnit {
  readonly book: BookRef;
  readonly collection: Collection;
  readonly kind: UnitKind;
  /** the name as the structure writes it */
  readonly name: string;
  /** 0-based first and last (inclusive) line */
  readonly line: number;
  readonly end: number;
  /** 1-based position in its book */
  readonly ordinal: number;
}

/** One book's named units as a source gives them. */
export interface NamedUnitSource {
  readonly book: BookRef;
  readonly kind: UnitKind;
  /** in book order; `line` is 0-based */
  readonly entries: readonly { readonly name: string; readonly line: number }[];
  /** the book's last line (0-based), the end of its last unit */
  readonly lastLine: number;
}

export interface UnitMatch {
  readonly unit: NamedUnit;
  /** the words written are the whole of the structure's name (not only its start) */
  readonly full: boolean;
}

/** The names that start at a token: the units whose names match the most words there. */
export interface UnitMatches {
  readonly matches: readonly UnitMatch[];
  /** token index just past the matched words */
  readonly to: number;
}

/** The alt_toc structure that names a book's units, by the structure's key (or its Hebrew title). */
const STRUCTURE: Readonly<Record<UnitKind, { keys: readonly string[]; heTitles: readonly string[] }>> = {
  chapter: { keys: ["Chapters", "Chapter"], heTitles: ["פרקים"] },
  parsha: { keys: ["Parasha"], heTitles: ["פרשות", "פרשה"] },
};

/** Which kind of named unit a book's structures are read for: the Bavli's chapters, the Torah's parshiyot. */
export function unitKindOf(title: string): UnitKind | null {
  const t = normTitle(title);
  if (collectionOf(t) === "bavli") return "chapter";
  if (TORAH.has(t)) return "parsha";
  return null;
}

const TORAH = new Set(["בראשית", "שמות", "ויקרא", "במדבר", "דברים"]);

/**
 * A book's named units from its alt_toc structures: the top-level entries of the matching structure,
 * each running to the line before the next one. Null when the book has no such structure, or its
 * entries are not in book order (no guess about a range then).
 */
export function unitsFromAltToc(book: BookRef, kind: UnitKind, structures: readonly AltTocStructure[], lastLine: number): NamedUnitSource | null {
  const want = STRUCTURE[kind];
  const s = structures.find((x) => want.keys.includes(x.key)) ?? structures.find((x) => x.heTitle !== undefined && want.heTitles.includes(x.heTitle));
  if (!s) return null;
  const top = s.entries.filter((e) => e.level === 0 && e.heTitle.trim());
  if (!top.length) return null;
  const entries = top.map((e) => ({ name: e.heTitle.trim(), line: e.line - 1 }));
  for (let i = 1; i < entries.length; i++) if (entries[i]!.line <= entries[i - 1]!.line) return null;
  if (entries[0]!.line < 0 || entries.at(-1)!.line > lastLine) return null;
  return { book, kind, entries, lastLine };
}

/**
 * A word as compared: letters with final forms unified, and ו/י between the first and the last letter
 * dropped — books write "האשה רבה" for the structure's "האישה רבה", "בחוקתי" for "בחקתי", "פינחס" for
 * "פנחס". The last letter stays ("ממנו" is not "מומין"), and so does a final א ("תצא" is not "תצוה").
 */
export function looseWord(key: string): string {
  if (key.length < 3) return key;
  return key[0]! + key.slice(1, -1).replace(/[וי]/g, "") + key.at(-1)!;
}

/** A name as compared (loose words joined by a space), or null when it has no Hebrew word. */
export function unitNameKey(name: string): string | null {
  const words = citationTokens(name).filter((t) => t.kind === "word");
  return words.length ? words.map((t) => looseWord(t.key)).join(" ") : null;
}

export class NamedUnitIndex {
  /** first (loose) word → names starting with it */
  private readonly byFirst = new Map<string, { words: readonly string[]; units: NamedUnit[] }[]>();
  /** book key → its units, in order */
  readonly byBook = new Map<string, readonly NamedUnit[]>();

  static build(sources: readonly NamedUnitSource[]): NamedUnitIndex {
    const ix = new NamedUnitIndex();
    const byKey = new Map<string, { words: readonly string[]; units: NamedUnit[] }>();
    for (const s of sources) {
      const collection = collectionOf(s.book.title);
      const list: NamedUnit[] = [];
      s.entries.forEach((e, i) => {
        const end = i + 1 < s.entries.length ? s.entries[i + 1]!.line - 1 : s.lastLine;
        const unit: NamedUnit = { book: s.book, collection, kind: s.kind, name: e.name, line: e.line, end: Math.max(e.line, end), ordinal: i + 1 };
        list.push(unit);
        const key = unitNameKey(e.name);
        if (!key) return;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { words: key.split(" "), units: [] };
          byKey.set(key, entry);
          const first = ix.byFirst.get(entry.words[0]!) ?? [];
          first.push(entry);
          ix.byFirst.set(entry.words[0]!, first);
        }
        entry.units.push(unit);
      });
      ix.byBook.set(s.book.key, [...(ix.byBook.get(s.book.key) ?? []), ...list]);
    }
    return ix;
  }

  get size(): number {
    return this.byBook.size;
  }

  /**
   * The units of the given kinds whose names start at toks[i] (the chapter word carries any prefix
   * letters, the name has none), keeping those that match the MOST words: "פרק האשה רבה" is
   * יבמות's "האישה רבה", not פסחים' "האשה". A unit whose name is longer than what matched is a
   * partial match ("פרק האשה" may be נדה's "האשה שהיא עושה"). Words with quote marks never match.
   */
  matchAt(toks: readonly Tok[], i: number, kinds: readonly UnitKind[]): UnitMatches | null {
    const t = toks[i];
    if (!t || t.kind !== "word" || t.gershayim || t.geresh) return null;
    let best = 0;
    let out: UnitMatch[] = [];
    for (const e of this.byFirst.get(looseWord(t.key)) ?? []) {
      const units = e.units.filter((u) => kinds.includes(u.kind));
      if (!units.length) continue;
      let m = 0;
      while (m < e.words.length) {
        const x = toks[i + m];
        if (!x || x.kind !== "word" || x.gershayim || x.geresh || looseWord(x.key) !== e.words[m]) break;
        m++;
      }
      if (m < best) continue;
      if (m > best) {
        best = m;
        out = [];
      }
      for (const u of units) out.push({ unit: u, full: m === e.words.length });
    }
    return best ? { matches: out, to: i + best } : null;
  }
}
