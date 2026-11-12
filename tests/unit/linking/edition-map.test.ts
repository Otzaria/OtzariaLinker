import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { editionRows, lineMappingCsv, rowCounts, type EditionDiff, type EditionRow } from "../../../src/linking/edition-map";
import { diffLines, findMoves } from "../../../src/matching/line-diff";

/** The alignment of two editions, as the worker computes it (workers/engine-job.ts diffJob). */
function diff(oldLines: readonly string[], newLines: readonly string[]): EditionDiff {
  const m = diffLines(oldLines, newLines);
  return { to: m.to, fate: m.fate, similarity: m.similarity, moves: findMoves(oldLines, newLines, m.to), newLength: newLines.length };
}

const book = Array.from({ length: 12 }, (_, i) => `שורה מספר ${i} עם תוכן ייחודי משלה בספר`);
const kinds = (rows: readonly EditionRow[]) => rows.map((r) => `${r.kind}:${r.old}>${r.new}`);

describe("edition rows", () => {
  it("reads like a diff: deletions, then insertions, then the next aligned pair", () => {
    const next = [...book];
    next.splice(2, 1, "שורה חדשה לגמרי שלא הייתה"); // line 2 replaced by an unrelated line
    next[5] = next[5]!.replace("תוכן", "טקסט"); // edited
    const rows = editionRows(diff(book, next));
    expect(kinds(rows).slice(0, 7)).toEqual(["same:0>0", "same:1>1", "deleted:2>-1", "inserted:-1>2", "same:3>3", "same:4>4", "changed:5>5"]);
    expect(rowCounts(rows)).toMatchObject({ same: 10, changed: 1, deleted: 1, inserted: 1, moved: 0 });
  });

  it("a line moved verbatim is 'moved' at its old place and 'moved-in' at its new place", () => {
    const next = [...book.slice(0, 3), ...book.slice(4, 10), book[3]!, ...book.slice(10)];
    const rows = editionRows(diff(book, next));
    expect(rows).toContainEqual({ old: 3, new: 9, kind: "moved" });
    expect(rows).toContainEqual({ old: 3, new: 9, kind: "moved-in" });
    expect(rows.findIndex((r) => r.kind === "moved")).toBeLessThan(rows.findIndex((r) => r.kind === "moved-in"));
  });

  it("repeated or blank lines are never paired as moves (that would be a guess)", () => {
    const old = ["א ב ג", "", "חוזר", "ד ה ו", "חוזר"];
    const next = ["ד ה ו", "חוזר", "", "א ב ג"];
    const m = diffLines(old, next);
    for (const [i] of findMoves(old, next, m.to)) expect(old[i]!.trim() && old[i] !== "חוזר").toBeTruthy();
  });
});

describe("line mapping CSV", () => {
  const next = [...book];
  next.splice(2, 1);
  next[4] = next[4]!.replace("תוכן", "טקסט");
  next.push("שורה חדשה בסוף");
  const d = diff(book, next);
  const csv = lineMappingCsv(editionRows(d), d);
  const lines = csv.slice(1).split("\r\n");

  it("has the QA CSV's conventions: BOM, CRLF, every value quoted, header first", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toMatch(/[^\r]\n/);
    expect(lines[0]).toBe('"שורה במהדורה הישנה","שורה במהדורה החדשה","מצב","דמיון","קוד"');
    for (const l of lines.filter(Boolean)) expect(l).toMatch(/^"[^"]*"(,"[^"]*")*$/);
  });

  it("numbers lines from 1, one row per old line and per inserted line", () => {
    expect(lines).toContain('"1","1","זהה","","same"');
    expect(lines).toContain('"3","","נמחקה","","deleted"');
    expect(lines).toContain('"","12","נוספה","","inserted"');
    expect(lines.find((l) => l.endsWith('"changed"'))).toMatch(/^"6","5","נערכה","\d+%","changed"$/);
    expect(lines.filter(Boolean).length).toBe(1 + book.length + 1);
  });

  it("is deterministic", () => {
    expect(lineMappingCsv(editionRows(d), d)).toBe(csv);
  });
});

describe("property: the mapping old → new", () => {
  /** Mapping rows (what the CSV holds): every row but the other end of a move. */
  const mapping = (rows: readonly EditionRow[]) => rows.filter((r) => r.kind !== "moved-in");

  const check = (a: string[], b: string[]) => {
    const rows = editionRows(diff(a, b));
    const map = mapping(rows);
    // unchanged (and edited) lines keep their order: strictly increasing new numbers
    const kept = map.filter((r) => r.kind === "same" || r.kind === "changed");
    for (let k = 1; k < kept.length; k++) expect(kept[k]!.new).toBeGreaterThan(kept[k - 1]!.new);
    // never two old lines on one new line
    const targets = map.filter((r) => r.new >= 0 && r.old >= 0).map((r) => r.new);
    expect(new Set(targets).size).toBe(targets.length);
    // every line of each edition exactly once
    expect(map.filter((r) => r.old >= 0).map((r) => r.old)).toEqual(a.map((_, i) => i));
    expect(map.filter((r) => r.new >= 0).map((r) => r.new).sort((x, y) => x - y)).toEqual(b.map((_, j) => j));
    // a "same" line is the same text
    for (const r of kept) if (r.kind === "same") expect(b[r.new]).toBe(a[r.old]);
  };

  it("holds on random editions with repeats and blanks", () => {
    const line = fc.constantFrom("א ב", "ג ד", "ה ו", "ז ח ט", "", "י כ ל", "מ נ ס ע", "פ צ");
    fc.assert(fc.property(fc.array(line, { maxLength: 40 }), fc.array(line, { maxLength: 40 }), (a, b) => check(a, b)));
  });

  it("holds when distinct lines are reordered, dropped and added (moves happen)", () => {
    let moved = 0;
    const editions = fc
      .uniqueArray(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 40 })
      .chain((ids) => fc.tuple(fc.constant(ids), fc.shuffledSubarray(ids), fc.array(fc.integer({ min: 300, max: 400 }), { maxLength: 4 })));
    fc.assert(
      fc.property(editions, ([ids, kept, added]) => {
        const a = ids.map((n) => `שורה ${n} בספר`);
        const b = [...kept, ...added].map((n) => `שורה ${n} בספר`);
        check(a, b);
        moved += rowCounts(editionRows(diff(a, b))).moved;
      }),
    );
    expect(moved).toBeGreaterThan(0); // the generator really produces moves
  });
});
