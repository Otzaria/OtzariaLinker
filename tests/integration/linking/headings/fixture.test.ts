import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { DbLinksReader } from "../../../../src/database/otzaria/links-reader";
import { OtzariaDbReader } from "../../../../src/database/otzaria/reader";
import { bytesSource } from "../../../../src/database/sqlite/lazy/byte-source";
import { runHeadingsEngine } from "../../../../src/linking/automatic/headings";
import type { EngineBook } from "../../../../src/linking/automatic/types";
import { engineBook, goldPairs, measure, summary } from "./measure";

/*
 * The headings engine on REAL data: תרגום אונקלוס על בראשית (book 3201, lines 0–119) against בראשית
 * (book 1, lines 0–119 plus scattered lines kept for other links — a SPARSE slice), from the schema-7
 * fixture. The database already links every verse of the targum to its verse (TARGUM, stored
 * בראשית → אונקלוס); those links are the answer key.
 */
const BYTES = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
let onkelos: EngineBook;
let bereshit: EngineBook;
let gold: Map<number, Set<number>>;

beforeAll(async () => {
  const reader = await OtzariaDbReader.open(bytesSource(BYTES));
  const books = await reader.books();
  const title = (id: number) => books.find((b) => b.id === id)!.title;
  const onkLines = await reader.lines(3201);
  onkelos = engineBook("db:3201", title(3201), onkLines);
  bereshit = engineBook("db:1", title(1), await reader.lines(1));
  const links = (await DbLinksReader.open(reader.file, reader.caps))!;
  gold = goldPairs(await links.atLines(onkLines.map((l) => l.lineId)), 3201, 1);
});

describe("headings engine on the real fixture: אונקלוס → בראשית", () => {
  it("links every verse of the targum to its verse, matching the database's links", () => {
    const r = runHeadingsEngine(onkelos, bereshit, { declaredType: "targum" });
    const m = measure(r, gold);
    console.info(summary("fixture אונקלוס→בראשית", m));
    expect(r.notes.map((n) => n.code)).toContain("heading/markers-parallel");
    expect(m.goldLines).toBeGreaterThan(100);
    expect(m.correct).toBe(m.judged);
    expect(m.exact).toBe(m.judged);
    expect(m.recalled / m.goldLines).toBeGreaterThan(0.95);
  });

  it("uses the base line's heRef and never targets a heading line", () => {
    const r = runHeadingsEngine(onkelos, bereshit);
    const s = r.suggestions.find((x) => x.source.line === 3)!;
    expect(s.target.line).toBe(2);
    expect(s.heRef2).toBe("בראשית, א, א");
    const lineAt = new Map(bereshit.lines.map((l) => [l.index, l]));
    for (const x of r.suggestions) {
      expect(lineAt.get(x.target.line)!.heading).toBeNull();
      expect(lineAt.get(x.target.end ?? x.target.line)!.heading).toBeNull();
    }
    // the author line "אונקלוס הגר" has no structural position
    expect(r.unmatched.map((u) => u.line)).toContain(1);
  });
});
