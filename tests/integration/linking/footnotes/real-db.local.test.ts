import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { headingLevel } from "../../../../src/core/text/html";
import { DbLinksReader } from "../../../../src/database/otzaria/links-reader";
import { OtzariaDbReader } from "../../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../../src/database/sqlite/lazy/byte-source";
import { runFootnotesEngine } from "../../../../src/linking/automatic/footnotes";
import type { EngineBook } from "../../../../src/linking/automatic/types";
import { benchFromLineNotes, score, type Score } from "./line-note-bench";

/*
 * Footnotes engine against the FULL library database. Runs only when asked:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/footnotes/real-db.local.test.ts
 * The file is opened read-only ("r") and never written.
 *
 * 1. מדרש ויסעו ↔ its notes book — the library's FOOTNOTES links are the truth.
 * 2. 25 books (a fixed random sample, seed 7, of the books with 30–3000 schema-7 line_note rows):
 *    the merged "הערות על X" companion is rebuilt from line_note and the engine must find every
 *    note again (see line-note-bench.ts). Printed: precision, recall, exact anchors.
 */
const path = process.env.OTZARIA_DB;
const fd = path ? openSync(path, "r") : -1;
const source: ByteSource | null = path
  ? {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        const n = readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n);
      },
    }
  : null;
afterAll(() => {
  if (path) closeSync(fd);
});

const SAMPLE = [
  "איסור והיתר הארוך", "סדר גן עדן (ילקוט מדרשים)", "חברותא על ביצה", "מסכת אצילות (ילקוט מדרשים)", 'רי"ף יבמות',
  "שות מוהרץ", "שו״ת משכיל לדוד", "כתבי רבי אברהם אזולאי", "שות רבי שלמה ברוך", "שושני יעקב חלק א",
  "סדר ארקים (ילקוט מדרשים)", "מדרש זו היא שנאמרה ברוח הקודש (ילקוט מדרשים)", "חברותא על מעילה", "אור החמה על ספר הזהר", "דרכי הוראה",
  "טופסי גיטין", "סוד קיומנו או המחנך", "חברותא על ראש השנה", "ספר אליהו (ילקוט מדרשים)", "אהבת חסד",
  "חידושי רבי יהודה הצרפתי על מסכת פסחים", "בנין עולם", "גידולי שמואל על מסכת נדרים", 'רי"ף בבא בתרא', "טור ברקת - הלכות סוכה, לולב, חנוכה ומגילה",
];

describe.runIf(path)("footnotes engine on the real seforim.db (read-only)", () => {
  let reader: OtzariaDbReader;
  let ids: Map<string, number>;
  beforeAll(async () => {
    reader = await OtzariaDbReader.open(source!);
    ids = new Map((await reader.books()).map((b) => [b.title, b.id]));
  });

  const engineBook = async (title: string, key: string): Promise<EngineBook> => ({
    book: { key, title, origin: "otzaria" },
    lines: (await reader.lines(ids.get(title)!)).map((l) => ({ index: l.index, text: l.content, heading: headingLevel(l.content), heRef: l.heRef })),
  });

  it("מדרש ויסעו: the same 16 links the library has", async () => {
    const mainTitle = "מדרש ויסעו (ילקוט מדרשים)";
    const notesTitle = "הערות באותיות על מדרש ויסעו (ילקוט מדרשים)";
    const main = await engineBook(mainTitle, "m");
    const notes = await engineBook(notesTitle, "n");
    const links = (await DbLinksReader.open(reader.file, reader.caps))!;
    const mainLineIds = (await reader.lines(ids.get(mainTitle)!)).map((l) => l.lineId);
    const truth = (await links.atLines(mainLineIds))
      .filter((x) => x.type === "FOOTNOTES" && x.target.bookId === ids.get(notesTitle))
      .map((x) => `${x.source.lineIndex}>${x.target.lineIndex}`)
      .sort();
    const got = runFootnotesEngine(main, notes).suggestions.map((s) => `${s.source.line}>${s.target.line}`).sort();
    console.log(`מדרש ויסעו: truth ${truth.length}, suggested ${got.length}, correct ${got.filter((g) => truth.includes(g)).length}`);
    expect(got).toEqual(truth);
  });

  it("rebuilt companions of 25 books: precision, recall and exact anchors", async () => {
    const rows: (Score & { title: string; mode: string })[] = [];
    for (const title of SAMPLE) {
      const id = ids.get(title);
      if (id === undefined) continue;
      const lines = await reader.lines(id);
      // plain: no headings in the notes (numbering only); headings: the book's headings copied in;
      // greedy: plain with Link-Notes' original marker-by-marker chapter rules, for comparison
      const runs = [["plain", false, "global"], ["headings", true, "global"], ["greedy", false, "greedy"]] as const;
      for (const [mode, withHeadings, chapterAlignment] of runs) {
        const b = benchFromLineNotes(title, lines, withHeadings);
        rows.push({ title, mode, ...score(b, runFootnotesEngine(b.main, b.notes, { includeInlineNoteMarkers: true, chapterAlignment })) });
      }
    }
    const sum = (mode: string, k: keyof Score) => rows.filter((x) => x.mode === mode).reduce((a, x) => a + (x[k] as number), 0);
    for (const x of rows)
      console.log(`${x.mode.padEnd(8)} ${String(x.truth).padStart(5)} ${String(x.suggested).padStart(5)} P=${x.precision.toFixed(3)} R=${x.recall.toFixed(3)} anchors=${x.anchorsExact}/${x.correct} certain=${x.certainCorrect}/${x.certain}  ${x.title}`);
    for (const mode of ["plain", "headings", "greedy"]) {
      const truth = sum(mode, "truth");
      const suggested = sum(mode, "suggested");
      const correct = sum(mode, "correct");
      console.log(
        `TOTAL ${mode}: truth ${truth}, suggested ${suggested}, correct ${correct}, P=${(correct / suggested).toFixed(4)}, R=${(correct / truth).toFixed(4)}, ` +
          `anchors exact ${sum(mode, "anchorsExact")}/${correct}, certain precision ${(sum(mode, "certainCorrect") / sum(mode, "certain")).toFixed(4)} (${sum(mode, "certain")})`,
      );
      expect(sum(mode, "anchorsExact")).toBe(correct);
      if (mode === "greedy") continue;
      expect(correct / suggested).toBeGreaterThan(0.99);
      expect(correct / truth).toBeGreaterThan(0.99);
      expect(sum(mode, "certainCorrect") / sum(mode, "certain")).toBeGreaterThan(0.999);
    }
  }, 600_000);
});
