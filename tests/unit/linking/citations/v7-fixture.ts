import type { BookOrigin, BookRef } from "../../../../src/core/links/model";
import { toGematria } from "../../../../src/core/text/gematria";
import { buildRefIndex, runCitationsEngine, type CitationLibrary, type CitationsOptions, type RefLine } from "../../../../src/linking/automatic/citations";
import type { EngineBook } from "../../../../src/linking/automatic";

/*
 * An in-memory library for the V7 round (issues #23, #41 B6–B9, #42 C17–C21): skeleton books with the heRef shapes of
 * seforim.db (docs/AUTOMATION_ENGINE.md §6.4) — "ברכות, יג:, א", "בראשית, א, א", "ויקרא רבה, ג, א" — and no book text.
 * A chapter or an amud has a heading line with no heRef before its first line, as the database's books do.
 */
export const ref = (key: string, title: string, origin: BookOrigin = "sefaria"): BookRef => ({ key, title, origin });

/** a book by chapter and verse (or parsha and paragraph): `sizes[c]` lines under chapter c+1, each after a heading line */
export function chapters(title: string, sizes: readonly number[]): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  sizes.forEach((n, c) => {
    out.push({ index: out.length, heRef: null });
    for (let v = 1; v <= n; v++) out.push({ index: out.length, heRef: `${title}, ${toGematria(c + 1)}, ${toGematria(v)}` });
  });
  return out;
}

/** a tractate (or a commentary on one) from daf 2 to `last`, three lines an amud, each amud after a heading line */
export function dapim(title: string, last: number): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (let d = 2; d <= last; d++)
    for (const side of [".", ":"]) {
      out.push({ index: out.length, heRef: null });
      for (let s = 1; s <= 3; s++) out.push({ index: out.length, heRef: `${title}, ${toGematria(d)}${side}, ${toGematria(s)}` });
    }
  return out;
}

export interface FixtureBook {
  readonly book: BookRef;
  readonly refs: RefLine[];
}

export function libraryOf(books: readonly FixtureBook[]): CitationLibrary {
  const byKey = new Map(books.map((b) => [b.book.key, b] as const));
  return {
    catalog: books.map((b) => ({ book: b.book })),
    index: (b) => buildRefIndex(b, byKey.get(b.key)!.refs),
    heRefAt: (b, line) => byKey.get(b.key)?.refs.find((r) => r.index === line)?.heRef ?? null,
  };
}

export const B = {
  gen: ref("gen", "בראשית"),
  lev: ref("lev", "ויקרא"),
  josh: ref("josh", "יהושע"),
  sam1: ref("sam1", "שמואל א"),
  levR: ref("levR", "ויקרא רבה"),
  ber: ref("ber", "ברכות"),
  shab: ref("shab", "שבת"),
  hor: ref("hor", "הוריות"),
  ned: ref("ned", "נדרים"),
  bei: ref("bei", "ביצה"),
  meg: ref("meg", "מגילה"),
  bb: ref("bb", "בבא בתרא"),
  tosBer: ref("tosBer", "תוספות על ברכות"),
  rashbamBb: ref("rashbamBb", 'רשב"ם על בבא בתרא'),
} as const;

export const BOOKS: FixtureBook[] = [
  { book: B.gen, refs: chapters("בראשית", [8, 6, 5]) },
  { book: B.lev, refs: chapters("ויקרא", [5, 5, 5]) },
  { book: B.josh, refs: chapters("יהושע", [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]) },
  { book: B.sam1, refs: chapters("שמואל א", [5, 5, 6]) },
  { book: B.levR, refs: chapters("ויקרא רבה", [3, 3, 3]) },
  { book: B.ber, refs: dapim("ברכות", 20) },
  { book: B.shab, refs: dapim("שבת", 40) },
  { book: B.hor, refs: dapim("הוריות", 14) },
  { book: B.ned, refs: dapim("נדרים", 60) },
  { book: B.bei, refs: dapim("ביצה", 20) },
  { book: B.meg, refs: dapim("מגילה", 30) },
  { book: B.bb, refs: dapim("בבא בתרא", 125) },
  { book: B.tosBer, refs: dapim("תוספות על ברכות", 20) },
  { book: B.rashbamBb, refs: dapim('רשב"ם על בבא בתרא', 125) },
];
export const LIB = libraryOf(BOOKS);

export const sourceOf = (lines: readonly string[], origin: BookOrigin = "otzaria", title = "חיבור כלשהו"): EngineBook => ({
  book: ref("src", title, origin),
  lines: lines.map((text, index) => ({ index, text, heading: /^<h\d/.test(text) ? 2 : null })),
});

export const run = (text: string | readonly string[], options: CitationsOptions = {}, lib: CitationLibrary = LIB, origin: BookOrigin = "otzaria") =>
  runCitationsEngine(sourceOf(typeof text === "string" ? [text] : text, origin), lib, options);

/** the heRef of a target line in the fixture */
export const heRefOf = (book: BookRef, line: number): string | null => BOOKS.find((b) => b.book.key === book.key)?.refs.find((r) => r.index === line)?.heRef ?? null;
