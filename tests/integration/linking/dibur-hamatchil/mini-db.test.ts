import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { OtzariaDbReader } from "../../../../src/database/otzaria/reader";
import { DbLinksReader } from "../../../../src/database/otzaria/links-reader";
import { bytesSource } from "../../../../src/database/sqlite/lazy/byte-source";
import { runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import type { EngineBook, EngineResult } from "../../../../src/linking/automatic/types";
import { measure, type Measured } from "./measure";

/*
 * The ד"ה engine on REAL data: רש"י על בראשית against the בראשית slice of
 * tests/fixtures/db/seforim-v7-mini.db (scripts/fixtures/make_mini_db.py), measured against the
 * COMMENTARY links the database already has (stored בראשית → רש"י). The fixture holds only the
 * רש"י lines that link into the slice, without their headings, so the engine runs with no
 * heading windows at all — sequential progress through the base is all it has.
 *
 * Measured (2026-11-11): certain+high 170 right, 0 wrong, 1 unjudged; recall 170/200 = 85%.
 * The full books (real-db.local.test.ts): בראשית 99.7% / 88.5%, ברכות רש"י 98.7% / 73%,
 * ברכות תוספות 98.3% / 68%.
 */
const BYTES = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
let res: EngineResult;
let m: Measured;
let base: EngineBook;

beforeAll(async () => {
  const r = await OtzariaDbReader.open(bytesSource(BYTES));
  const links = (await DbLinksReader.open(r.file, r.caps))!;
  const books = await r.books();
  const load = async (id: number): Promise<EngineBook> => {
    const b = books.find((x) => x.id === id)!;
    return {
      book: { key: `db:${id}`, title: b.title, origin: b.source === "Sefaria" ? "sefaria" : "otzaria", isBaseBook: b.isBaseBook ?? undefined },
      lines: (await r.lines(id)).map((l) => ({ index: l.index, text: r.anchorText(l), heading: /^<h[1-6]/i.test(l.content) ? Number(l.content[2]) : null, heRef: l.heRef })),
    };
  };
  base = await load(1);
  const rashi = await load(3695);
  const gold = new Map<number, Set<number>>();
  for (const k of await links.atLines((await r.lines(3695)).map((l) => l.lineId)))
    if (k.type === "COMMENTARY" && k.source.bookId === 1 && k.target.bookId === 3695)
      gold.set(k.target.lineIndex, (gold.get(k.target.lineIndex) ?? new Set()).add(k.source.lineIndex));
  res = runDiburHamatchilEngine(rashi, base);
  m = measure(res, gold, (s) => s.source.line, (s) => s.target);
});

describe('ד"ה engine on real data: רש"י על בראשית → בראשית (mini fixture)', () => {
  it("certain + high suggestions agree with the database's commentary links", () => {
    expect(m.gold).toBe(200);
    expect(m.precision).toBeGreaterThanOrEqual(0.97);
    expect(m.recall).toBeGreaterThanOrEqual(0.8);
  });

  it("both books are Sefaria books: commentary-side \"source\" records, no anchors, the database heRef as heRef_2", () => {
    expect(res.notes.map((n) => n.code)).toContain("dh/anchors-sefaria");
    for (const s of res.suggestions) {
      expect(s).toMatchObject({ declaredType: "source", source: { book: { key: "db:3695" } }, target: { book: { key: "db:1" } } });
      expect(s.anchor).toBeUndefined();
      const line = base.lines.find((l) => l.index === s.target.line)!;
      expect(s.heRef2).toBe(line.heRef);
    }
  });

  it("every suggestion explains itself", () => {
    for (const s of res.suggestions) {
      expect(s.reasons.length).toBeGreaterThan(0);
      expect(s.rules.length).toBeGreaterThan(0);
      expect(s.reasons.every((r) => /[א-ת]/.test(r.text))).toBe(true);
    }
  });
});
