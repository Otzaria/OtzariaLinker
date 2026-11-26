import type { BookRef, Link } from "./model";

/*
 * A book's existing (database) links as the coverage rules read them (linking/coverage.ts), in a compact form (#42 C7, C8):
 * one entry per END of a live link that lies in the book (a link inside the book has two), and the place each end points to.
 * The worker builds it next to the database (sources/db/db-source.ts reads it from the book's link indexes, without building a
 * Link per row); the page gets a few typed arrays instead of a quarter of a million objects (בראשית: 235,898 links).
 *
 * The numbers are the ones the rules read from a Link: an end's `line` and `end` are LinkSide.line and `LinkSide.end ?? line`;
 * a place is the other end's book TITLE, line and `end ?? line` (the rules compare places by title: a project link and a
 * database link to the same lines are one place).
 */
export interface CoverageEnds {
  /** how many links the ends come from (a link with both ends in the book counts once): what a reading reports as counted */
  readonly links: number;
  /** per end: its line in the book, 0-based */
  readonly line: Int32Array;
  /** per end: its last line (`end ?? line`, as stored: not clamped) */
  readonly end: Int32Array;
  /** per end: the place it points to (index into the place arrays) */
  readonly place: Int32Array;
  /** per place: the book (index into `titles`), its line and its `end ?? line` */
  readonly placeTitle: Int32Array;
  readonly placeLine: Int32Array;
  readonly placeEnd: Int32Array;
  readonly titles: readonly string[];
}

/** Collects ends one by one, interning places and titles. */
export class CoverageEndsBuilder {
  private readonly line: number[] = [];
  private readonly end: number[] = [];
  private readonly place: number[] = [];
  private readonly placeTitle: number[] = [];
  private readonly placeLine: number[] = [];
  private readonly placeEnd: number[] = [];
  private readonly titles: string[] = [];
  private readonly titleIds = new Map<string, number>();
  /** per title id: place key (line * 2^23 + end, both below MAX_BOOK_LINES < 2^23 in practice; else a string key) → place id */
  private readonly places = new Map<number, Map<number | string, number>>();
  links = 0;

  add(line: number, end: number, otherTitle: string, otherLine: number, otherEnd: number): void {
    let t = this.titleIds.get(otherTitle);
    if (t === undefined) {
      t = this.titles.length;
      this.titles.push(otherTitle);
      this.titleIds.set(otherTitle, t);
      this.places.set(t, new Map());
    }
    const byKey = this.places.get(t)!;
    const key = placeKey(otherLine, otherEnd);
    let p = byKey.get(key);
    if (p === undefined) {
      p = this.placeTitle.length;
      byKey.set(key, p);
      this.placeTitle.push(t);
      this.placeLine.push(otherLine);
      this.placeEnd.push(otherEnd);
    }
    this.line.push(line);
    this.end.push(end);
    this.place.push(p);
  }

  build(): CoverageEnds {
    return {
      links: this.links,
      line: Int32Array.from(this.line),
      end: Int32Array.from(this.end),
      place: Int32Array.from(this.place),
      placeTitle: Int32Array.from(this.placeTitle),
      placeLine: Int32Array.from(this.placeLine),
      placeEnd: Int32Array.from(this.placeEnd),
      titles: this.titles,
    };
  }
}

/** a place's key inside its book: a number when both lines are small integers (always, for a real book), else a string */
export const placeKey = (line: number, end: number): number | string =>
  Number.isInteger(line) && Number.isInteger(end) && line >= 0 && end >= 0 && line < 2 ** 23 && end < 2 ** 23 ? line * 2 ** 23 + end : `${line}-${end}`;

/**
 * The ends of the live links that lie in a book (`owns`), from Links: the fallback for a source that cannot read its links in
 * the compact form directly (external_link, user_link, a mapped database), and the reference the compact reads are tested against.
 */
export function coverageEndsOf(links: readonly Link[], owns: (ref: BookRef) => boolean): CoverageEnds {
  const b = new CoverageEndsBuilder();
  // the count a reading reports is of the links read (as `links.length` was), whatever their ends
  b.links = links.length;
  for (const l of links) {
    if (l.status === "deleted") continue;
    for (const [mine, other] of [[l.source, l.target], [l.target, l.source]] as const)
      if (owns(mine.book)) b.add(mine.line, mine.end ?? mine.line, other.book.title, other.line, other.end ?? other.line);
  }
  return b.build();
}
