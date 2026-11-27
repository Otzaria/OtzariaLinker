import { describe, expect, it } from "vitest";
import type { SourceBook } from "../../../src/core/books";
import { repoList, repoReportCsv, type RepoRow } from "../../../src/state/repository";

/*
 * The repository list (V7 §3.13): filters and orders over the small rows, and the report. A book whose links could not be read is
 * "unknown", never a book with 0 links: it does not sort with the books that have none, and the report leaves its counts empty.
 */
const book = (key: string, title: string, lineCount?: number): SourceBook => ({ key, title, ...(lineCount !== undefined && { lineCount }) }) as SourceBook;
const row = (key: string, p: Partial<RepoRow> = {}): RepoRow => ({ key, title: key, total: 0, out: 0, in: 0, typesOut: {}, ends: { same: 0, library: 0, other: 0, unresolved: 0 }, flags: [], top: [], ...p });
const cov = (unlinked: number, suitable = 10) => ({ suitable, unlinked, linked: suitable - unlinked, partial: 0, multiple: 0, notSuitable: 0, exact: true, at: 0 });

const BOOKS = [book("a", "אלף", 10), book("b", "בית", 20), book("c", "גימל", 30), book("d", "דלת", 40), book("e", "הא", 50)];
const ROWS = new Map<string, RepoRow>([
  ["a", row("a", { total: 0 })],
  ["b", row("b", { unavailable: "אין טבלת קישורים" })],
  ["c", row("c", { total: 12, out: 12, coverage: cov(4), flags: [{ flag: "ambiguous-title", count: 5 }], top: [{ key: "x", title: "x", links: 12 }], related: 1 })],
  ["d", row("d", { total: 3, out: 3, coverage: cov(0), top: [{ key: "x", title: "x", links: 2 }, { key: "y", title: "y", links: 1 }], related: 2 })],
  // e: not read yet
]);
const keys = (o: Parameters<typeof repoList>[2]) => repoList(BOOKS, ROWS, o).map((b) => b.key);

describe("the repository list", () => {
  it("a book whose links could not be read sorts with the unknown, never with the books that have no links", () => {
    expect(keys({ query: "", filter: "all", sort: "links-asc" })).toEqual(["a", "d", "c", "b", "e"]);
    expect(keys({ query: "", filter: "all", sort: "links-desc" })).toEqual(["c", "d", "a", "b", "e"]);
  });

  it("filters: no links, partially linked (some links and unlinked lines), unreadable", () => {
    expect(keys({ query: "", filter: "no-links", sort: "title" })).toEqual(["a"]);
    expect(keys({ query: "", filter: "partial", sort: "title" })).toEqual(["c"]);
    expect(keys({ query: "", filter: "unreadable", sort: "title" })).toEqual(["b"]);
  });

  it("orders by problems (flagged links) and by the number of linked books", () => {
    expect(keys({ query: "", filter: "all", sort: "problems" })).toEqual(["c", "a", "d", "b", "e"]);
    expect(keys({ query: "", filter: "all", sort: "related" })).toEqual(["d", "c", "a", "b", "e"]);
  });
});

describe("the repository report", () => {
  it("one row per book, its counts; an unread book says so, with no zeros in its counts", () => {
    const csv = repoReportCsv(BOOKS, ROWS, "seforim.db").split("\r\n");
    expect(csv[0]).toBe('"מקור","ספר","שורות","קישורים","יוצאים","נכנסים","ספרים מקושרים","קישורים מסומנים","שורות תוכן","שורות בלי קישור","מצב"');
    expect(csv[1]).toBe('"seforim.db","אלף","10","0","0","0","0","0","","","בלי קישורים"');
    expect(csv[2]).toBe('"seforim.db","בית","20","","","","","","","","לא נקרא: אין טבלת קישורים"');
    expect(csv[3]).toBe('"seforim.db","גימל","30","12","12","0","1","5","10","4","מקושר חלקית"');
    expect(csv[5]).toBe('"seforim.db","הא","50","","","","","","","","לא נבדק"');
    expect(csv).toHaveLength(6);
  });
});
