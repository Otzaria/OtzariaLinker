import { describe, expect, it } from "vitest";
import type { BookRef, Link, LinkSide } from "../../../../src/core/links/model";
import { parsePersonalLinksCsv, PERSONAL_LINKS_HEADER, personalLinkRows, personalRowKey, readPersonalRowKeys, validatePersonalRows, writePersonalLinksCsv, type PersonalExportContext, type PersonalLinkRow } from "../../../../src/formats/personal-csv";

/*
 * The personal-database build's links.csv (YairDaniel11/Otzarya-Unofficial-Books: CLAUDE.md §7 and "תיעוד יצירת קישורים וסדר
 * הדורות" §4-5, read as a data contract only — no code of it is used): header `מקור,ספר_מקור,מקור_אישי,ספר_יעד,מיקום_יעד,סוג,
 * יעד_אישי,קטגוריית_מקור`; מקור = a 1-based line of the personal book's text file; ספר_יעד = the title in the official database;
 * מיקום_יעד = a heading of that book; סוג פירוש or תרגום; UTF-8 with BOM, CRLF; imported all-or-nothing per file, so split into
 * numbered folders of at most 25,000 rows ("קבצי קובץ": 60,000), a source book never split across files.
 */
const book = (title: string, origin: BookRef["origin"]): BookRef => ({ key: title, title, origin });
const PERSONAL = book("פירוש אישי", "personal");
const PERSONAL2 = book("קובץ שיטות", "personal");
const OFFICIAL = book("ברכות", "otzaria");
const SA = book("שולחן ערוך, אורח חיים", "otzaria");
const side = (b: BookRef, line: number, end?: number): LinkSide => ({ book: b, line, ...(end !== undefined && { end }) });
let n = 0;
const link = (source: LinkSide, target: LinkSide, declaredType = "commentary"): Link => ({ id: `l${n++}`, status: "new", provenance: "user", source, target, declaredType, heRef2: "" });

const ctx: PersonalExportContext = {
  isPersonal: (b) => b.origin === "personal",
  isOfficial: (b) => b.origin === "otzaria",
  contentLine: (_b, line) => line !== 0,
  positionOf: (s) => (s.book.title === OFFICIAL.title ? (s.line < 10 ? "ב." : "ג.") : s.book.title === SA.title ? "סימן ב" : null),
};

describe("personalLinkRows — our links as rows", () => {
  it("a commentary: the personal book's line (1-based), the official title and the heading of the place, type פירוש", () => {
    const { rows, skipped } = personalLinkRows([link(side(PERSONAL, 4), side(OFFICIAL, 3), "source")], ctx);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([{ sourceLine: 5, sourceBook: "פירוש אישי", targetBook: "ברכות", position: "ב.", type: "פירוש" }]);
  });

  it("the record written the other way (the official book as the source, an anchored dibur-hamatchil record) gives the same row", () => {
    const a = personalLinkRows([link(side(OFFICIAL, 3), side(PERSONAL, 4))], ctx).rows;
    expect(a).toEqual([{ sourceLine: 5, sourceBook: "פירוש אישי", targetBook: "ברכות", position: "ב.", type: "פירוש" }]);
  });

  it("a translation is תרגום; a type the format has no word for is skipped, with the reason (never written as something else)", () => {
    expect(personalLinkRows([link(side(OFFICIAL, 3), side(PERSONAL, 4), "targum")], ctx).rows[0]!.type).toBe("תרגום");
    const { rows, skipped } = personalLinkRows([link(side(PERSONAL, 4), side(OFFICIAL, 3), "reference")], ctx);
    expect(rows).toEqual([]);
    expect(skipped[0]!.code).toBe("csv/type");
    // the reason names the type as the user sees it, not as the file spells it
    expect(skipped[0]!.text).toContain("הפניה");
    expect(skipped[0]!.text).not.toContain("reference");
  });

  it("skipped, each with its reason: both ends personal or both official, a heading or blank source line, no heading for the place, a deleted link", () => {
    const why = (l: Link) => personalLinkRows([l], ctx).skipped.map((s) => s.code);
    expect(why(link(side(PERSONAL, 4), side(PERSONAL2, 2)))).toEqual(["csv/ends"]);
    expect(why(link(side(OFFICIAL, 4), side(SA, 2)))).toEqual(["csv/ends"]);
    expect(why(link(side(PERSONAL, 0), side(OFFICIAL, 3), "source"))).toEqual(["csv/source-line"]);
    expect(why(link(side(PERSONAL, 4), side(book("ספר אחר", "otzaria"), 3), "source"))).toEqual(["csv/no-position"]);
    expect(why({ ...link(side(PERSONAL, 4), side(OFFICIAL, 3)), status: "deleted" })).toEqual(["csv/deleted"]);
  });

  it("a range on the personal side is one row per line (the format has no range), a repeated row once", () => {
    const { rows } = personalLinkRows([link(side(PERSONAL, 2, 4), side(OFFICIAL, 3), "source"), link(side(PERSONAL, 3), side(OFFICIAL, 3), "source")], ctx);
    expect(rows.map((r) => r.sourceLine)).toEqual([3, 4, 5]);
  });
});

describe("personalLinkRows — the direction of the link (QA round 2, C)", () => {
  const rowsOf = (l: Link) => personalLinkRows([l], ctx);
  it("commentary and targum are stored base to dependent: the personal book must be the TARGET; source is dependent to base: the personal book must be the SOURCE", () => {
    expect(rowsOf(link(side(OFFICIAL, 3), side(PERSONAL, 4), "commentary")).rows).toHaveLength(1);
    expect(rowsOf(link(side(OFFICIAL, 3), side(PERSONAL, 4), "targum")).rows[0]!.type).toBe("תרגום");
    expect(rowsOf(link(side(PERSONAL, 4), side(OFFICIAL, 3), "source")).rows).toHaveLength(1);
  });
  it("the opposite direction says the opposite (the personal book would be the base), so it is skipped with csv/direction and a reason", () => {
    for (const l of [link(side(PERSONAL, 4), side(OFFICIAL, 3), "commentary"), link(side(PERSONAL, 4), side(OFFICIAL, 3), "targum"), link(side(OFFICIAL, 3), side(PERSONAL, 4), "source")]) {
      const r = rowsOf(l);
      expect(r.rows, l.declaredType).toEqual([]);
      expect(r.skipped.map((s) => s.code)).toEqual(["csv/direction"]);
      expect(r.skipped[0]!.text).toContain("הבסיס");
    }
  });
});

describe("personalLinkRows — a range end from a file is not a loop bound (QA round 2, A)", () => {
  const short: PersonalExportContext = { ...ctx, contentLine: (_b, line) => line >= 1 && line < 10, lineCount: () => 10 };
  it("a personal range of 2^53-1 is clamped to the book's last line, and finishes at once", () => {
    const t0 = Date.now();
    const { rows } = personalLinkRows([link(side(PERSONAL, 2, Number.MAX_SAFE_INTEGER), side(OFFICIAL, 3), "source")], short);
    expect(rows.map((r) => r.sourceLine)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("a range of three million lines in a ten-line book is ten lines at most, not three million rows", () => {
    const { rows } = personalLinkRows([link(side(PERSONAL, 1, 3_000_000), side(OFFICIAL, 3), "source")], short);
    expect(rows).toHaveLength(9);
  });
});

describe("writePersonalLinksCsv — the files", () => {
  const row = (line: number, bookTitle = "פירוש אישי", target = "ברכות", position = "ב.", type: PersonalLinkRow["type"] = "פירוש"): PersonalLinkRow => ({ sourceLine: line, sourceBook: bookTitle, targetBook: target, position, type });

  it("BOM, CRLF, the header, ' כן' / 'לא' constants, a comma in a title quoted — as the format's own files are", () => {
    const [f] = writePersonalLinksCsv([row(5), row(6, "פירוש אישי", "שולחן ערוך, אורח חיים", "סימן ב")]).files;
    expect(f!.folder).toBe("קישורים/01");
    expect(f!.text.charCodeAt(0)).toBe(0xfeff);
    const lines = f!.text.slice(1).split("\r\n");
    expect(lines[0]).toBe(PERSONAL_LINKS_HEADER.join(","));
    expect(lines[1]).toBe("5,פירוש אישי,כן,ברכות,ב.,פירוש,לא,");
    expect(lines[2]).toBe('6,פירוש אישי,כן,"שולחן ערוך, אורח חיים",סימן ב,פירוש,לא,');
    expect(f!.text.endsWith("\r\n")).toBe(true);
  });

  it("splits into numbered folders of at most 25,000 rows, a source book never across two files", () => {
    const rows = [...Array.from({ length: 20_000 }, (_, i) => row(i + 1, "א")), ...Array.from({ length: 10_000 }, (_, i) => row(i + 1, "ב")), ...Array.from({ length: 3, }, (_, i) => row(i + 1, "ג"))];
    const { files } = writePersonalLinksCsv(rows);
    expect(files.map((f) => [f.folder, f.rows, f.books])).toEqual([["קישורים/01", 20_000, ["א"]], ["קישורים/02", 10_003, ["ב", "ג"]]]);
  });

  it("a book bigger than the limit has a file of its own (never split)", () => {
    const { files } = writePersonalLinksCsv(Array.from({ length: 26 }, (_, i) => row(i + 1, "א")), { chunkRows: 10 });
    expect(files.map((f) => f.rows)).toEqual([26]);
  });

  it("the 'קובץ' books go to their own folders, 60,000 rows each (their import is slow)", () => {
    const { files } = writePersonalLinksCsv([row(1, "פירוש אישי"), row(1, "קובץ שיטות"), row(2, "קובץ שיטות")]);
    expect(files.map((f) => [f.folder, f.rows])).toEqual([["קישורים/01", 1], ["קישורים - קבצי קובץ (גדולים)/01", 2]]);
    const many = writePersonalLinksCsv([...Array.from({ length: 40_000 }, (_, i) => row(i + 1, "קובץ א")), ...Array.from({ length: 30_000 }, (_, i) => row(i + 1, "קובץ ב"))]);
    expect(many.files.map((f) => f.folder)).toEqual(["קישורים - קבצי קובץ (גדולים)/01", "קישורים - קבצי קובץ (גדולים)/02"]);
  });

  it("is deterministic: rows sorted by book and line, so the same links give the same files", () => {
    const a = writePersonalLinksCsv([row(9, "ב"), row(2, "א"), row(1, "ב")]).files[0]!.text;
    const b = writePersonalLinksCsv([row(1, "ב"), row(9, "ב"), row(2, "א")]).files[0]!.text;
    expect(a).toBe(b);
    expect(a.split("\r\n")[1]).toContain("א");
  });

  it("no rows, no files", () => {
    expect(writePersonalLinksCsv([]).files).toEqual([]);
  });
});

describe("parsePersonalLinksCsv and the round trip", () => {
  const rows: PersonalLinkRow[] = [
    { sourceLine: 5, sourceBook: "פירוש אישי", targetBook: "ברכות", position: "ב.", type: "פירוש" },
    { sourceLine: 6, sourceBook: "פירוש אישי", targetBook: "שולחן ערוך, אורח חיים", position: "סימן ב", type: "פירוש" },
    { sourceLine: 7, sourceBook: 'פירוש "מצוטט"', targetBook: "אונקלוס", position: "פרק א", type: "תרגום" },
    { sourceLine: 8, sourceBook: "פירוש אישי", targetBook: "ברכות", position: "ג:", type: "פירוש", sourceCategory: 190 } as PersonalLinkRow,
  ];

  it("write then parse gives the same rows, with no problems (BOM and CRLF, quoted commas and quotes included)", () => {
    const text = writePersonalLinksCsv(rows).files.map((f) => f.text).join("");
    // the single file holds all four
    const one = writePersonalLinksCsv(rows).files[0]!.text;
    const parsed = parsePersonalLinksCsv(one);
    expect(parsed.problems).toEqual([]);
    expect([...parsed.rows].sort((a, b) => a.sourceLine - b.sourceLine)).toEqual([...rows].sort((a, b) => a.sourceLine - b.sourceLine));
    expect(text.length).toBeGreaterThan(0);
  });

  it("a file the format's own tool wrote reads (LF or CRLF, with or without the BOM)", () => {
    const text = "מקור,ספר_מקור,מקור_אישי,ספר_יעד,מיקום_יעד,סוג,יעד_אישי,קטגוריית_מקור\n6,פרי חדש או״ח,כן,\"שולחן ערוך, אורח חיים\",סימן ב,פירוש,לא,\n";
    const p = parsePersonalLinksCsv(text);
    expect(p.problems).toEqual([]);
    expect(p.rows).toEqual([{ sourceLine: 6, sourceBook: "פרי חדש או״ח", targetBook: "שולחן ערוך, אורח חיים", position: "סימן ב", type: "פירוש" }]);
  });

  it("a wrong header or a malformed row is reported with its line, and the file is not trusted", () => {
    expect(parsePersonalLinksCsv("a,b\n1,2\n").problems[0]!.code).toBe("csv/header");
    const bad = "מקור,ספר_מקור,מקור_אישי,ספר_יעד,מיקום_יעד,סוג,יעד_אישי,קטגוריית_מקור\nx,א,כן,ב,ג,פירוש,לא,\n3,א,כן,ב\n";
    const p = parsePersonalLinksCsv(bad);
    expect(p.problems.map((x) => [x.code, x.line])).toEqual([["csv/line", 2], ["csv/fields", 3]]);
  });
});

describe("validatePersonalRows — the all-or-nothing rules of the import", () => {
  const ok: PersonalLinkRow = { sourceLine: 5, sourceBook: "א", targetBook: "ברכות", position: "ב.", type: "פירוש" };
  it("clean rows: no problems", () => {
    expect(validatePersonalRows([ok], { targetExists: () => true, positionExists: () => true })).toEqual([]);
  });
  it("an empty field, a line under 1, a repeated row, a title the official database lacks, a heading that book lacks — each its own code", () => {
    const codes = (rs: PersonalLinkRow[], c = { targetExists: (t: string) => t === "ברכות", positionExists: (_t: string, p: string) => p === "ב." }) => validatePersonalRows(rs, c).map((p) => p.code);
    expect(codes([{ ...ok, position: "" }])).toEqual(["csv/empty-field"]);
    expect(codes([{ ...ok, sourceLine: 0 }])).toEqual(["csv/line"]);
    expect(codes([ok, ok])).toEqual(["csv/duplicate"]);
    expect(codes([{ ...ok, targetBook: "ספר שאין" }])).toEqual(["csv/unknown-target"]);
    expect(codes([{ ...ok, position: "ג." }])).toEqual(["csv/unknown-position"]);
  });
});



describe("a line break inside a field (#42 C23)", () => {
  const row = (position: string): PersonalLinkRow => ({ sourceLine: 3, sourceBook: "ספר", targetBook: "בראשית", position, type: "פירוש" });
  it("is refused: Otzaria reads the file line by line, so a quoted multi-line field would split the row", () => {
    for (const p of ["פרק א\nפסוק ב", "פרק א\rפסוק ב", "פרק א\r\n"]) expect(validatePersonalRows([row(p)]).map((x) => x.code)).toEqual(["csv/line-break"]);
    expect(validatePersonalRows([row("פרק א")])).toEqual([]);
  });
});

// V7 round 2 review, finding 11: the runner reads a repository's existing links.csv files so that a row they hold is not written again.
// parsePersonalLinksCsv trusts only this tool's exact header, so a file with another header gave no rows — and the duplicates were
// written with no word. The build of Otzarya-Unofficial-Books reads its files by COLUMN NAME (csv.DictReader), so the columns a row's
// identity needs (personalRowKey) are read by name: another order, a missing optional column, an extra one are the same rows. A file
// without one of those columns is not a links.csv the build can read: said, with what is missing.
describe("readPersonalRowKeys: an existing links.csv's rows by column name", () => {
  const key = (sourceLine: number, sourceBook: string, targetBook: string, position: string) => personalRowKey({ sourceLine, sourceBook, targetBook, position });

  it("this tool's header, another order, without קטגוריית_מקור, with an extra column: the same keys", () => {
    const rows = '6,פרי חדש,כן,"שולחן ערוך, אורח חיים",סימן ב,פירוש,לא,\r\n7,פרי חדש,כן,ברכות,ב.,הפניה,לא,\r\n';
    const own = readPersonalRowKeys(`﻿${PERSONAL_LINKS_HEADER.join(",")}\r\n${rows}`);
    expect(own.missing).toEqual([]);
    expect([...own.keys].sort()).toEqual([key(6, "פרי חדש", "שולחן ערוך, אורח חיים", "סימן ב"), key(7, "פרי חדש", "ברכות", "ב.")].sort());
    const other = readPersonalRowKeys('ספר_יעד,מיקום_יעד,מקור,ספר_מקור,הערה\n"שולחן ערוך, אורח חיים",סימן ב,6,פרי חדש,x\nברכות,ב.,7,פרי חדש,\n');
    expect(other.missing).toEqual([]);
    expect([...other.keys].sort()).toEqual([...own.keys].sort());
  });

  it("a row without a line number or with an empty key field is no row; a header without a key column is said, with the columns", () => {
    const r = readPersonalRowKeys("מקור,ספר_מקור,ספר_יעד,מיקום_יעד\nx,א,ב,ג\n0,א,ב,ג\n3,א,,ג\n4,א,ב\n5,א,ב,ג\n");
    expect([...r.keys]).toEqual([key(5, "א", "ב", "ג")]);
    expect(readPersonalRowKeys("source,book,target,place\n1,א,ב,ג\n")).toEqual({ keys: new Set(), missing: ["מקור", "ספר_מקור", "ספר_יעד", "מיקום_יעד"] });
    expect(readPersonalRowKeys("מקור,ספר_מקור,ספר_יעד\n1,א,ב\n").missing).toEqual(["מיקום_יעד"]);
    expect(readPersonalRowKeys("").missing).toEqual(["מקור", "ספר_מקור", "ספר_יעד", "מיקום_יעד"]);
  });
});
