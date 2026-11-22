import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbLinksReader } from "../../../src/database/otzaria/links-reader";
import { OtzariaDbReader, type DbBook } from "../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";
import { runHeadingsEngine } from "../../../src/linking/automatic/headings";
import { titleFit } from "../../../src/linking/title-fit";
import { engineBook, goldPairs, measure } from "./headings/measure";

/*
 * Calibration of src/linking/title-fit.ts on the FULL library, read-only. Runs only with a real database:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/title-fit.local.test.ts
 *
 * For every pair it prints the verdict and the metrics, next to the headings engine's precision/recall
 * against the database's own links (the same measure as headings/real-db.local.test.ts). The expectations
 * at the end are the calibration: pairs where the engine is right must be "fit"/"partial", pairs with no
 * shared titles must be "unfit". The numbers behind TITLE_FIT are in docs/AUTOMATION_ENGINE.md §2.
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

/*
 * Expectations come from what the headings engine DID against the database's links (the numbers printed with each
 * pair), not from the verdict: "unfit" only where the engine placed (almost) nothing right because the titles are
 * not the base's; "not-unfit" where it is right on 90%+ of the database's lines.
 */
type Expect = "not-unfit" | "unfit";
const PAIRS: readonly { commentary: string; base: string; expect: Expect; note?: string }[] = [
  { commentary: "תרגום אונקלוס על בראשית", base: "בראשית", expect: "not-unfit" },
  { commentary: 'רש"י על בראשית', base: "בראשית", expect: "not-unfit" },
  { commentary: 'רש"י על ברכות', base: "ברכות", expect: "not-unfit" },
  { commentary: "תוספות על ברכות", base: "ברכות", expect: "not-unfit" },
  { commentary: "ברטנורא על משנה ברכות", base: "משנה ברכות", expect: "not-unfit" },
  { commentary: "שער הציון", base: "משנה ברורה", expect: "not-unfit" },
  { commentary: "ביאור הלכה", base: "שולחן ערוך, אורח חיים", expect: "not-unfit" },
  { commentary: "כסף משנה על משנה תורה, הלכות שבת", base: "משנה תורה, הלכות שבת", expect: "not-unfit" },
  { commentary: 'מלבי"ם על ישעיהו', base: "ישעיהו", expect: "not-unfit" },
  { commentary: 'רמב"ן על בראשית', base: "בראשית", expect: "not-unfit" },
  { commentary: 'ריטב"א על ראש השנה', base: "ראש השנה", expect: "not-unfit" },
  { commentary: "רבינו יונה על משלי", base: "משלי", expect: "not-unfit" },
  { commentary: "אברבנאל על מורה נבוכים", base: "מורה נבוכים", expect: "not-unfit" },
  { commentary: "קובץ שיטות קמאי על מגילה", base: "מגילה", expect: "not-unfit", note: "partial: a third of its headings repeat a place" },
  // titles that are not the base's: the engine placed 0 of 1,668 and 37 of 1,637 of the database's lines
  { commentary: 'ראב"ד על ספרא', base: "ספרא", expect: "unfit" },
  { commentary: "הערות שוליים על מכילתא דרבי שמעון בן יוחאי", base: "מכילתא דרבי שמעון בן יוחאי", expect: "unfit" },
  { commentary: "פסקי תוספות על נדה", base: "נדה", expect: "unfit" },
  // KNOWN LIMIT of a structural check: the titles are the base's, but the numbers are the commentary's own count
  // (0 of 615 right before the consistency guards); only the guards after the run can see that
  { commentary: "הגהות מנחם ציון", base: "שם הגדולים, מערכת ספרים", expect: "not-unfit", note: "own numbering: the guards, not this check, lower it" },
];

/** vitest shows console output only for failing tests; TITLE_FIT_OUT=<file> keeps the table of every pair */
const log = (line: string) => (process.env.TITLE_FIT_OUT ? appendFileSync(process.env.TITLE_FIT_OUT, `${line}${String.fromCharCode(10)}`) : console.info(line));

describe.runIf(path)("title fit on the real library (read-only, calibration)", () => {
  let reader: OtzariaDbReader;
  let links: DbLinksReader;
  let books: DbBook[];
  beforeAll(async () => {
    reader = await OtzariaDbReader.open(source!);
    links = (await DbLinksReader.open(reader.file, reader.caps))!;
    books = await reader.books();
  }, 120_000);

  for (const pair of PAIRS) {
    it(`${pair.commentary} → ${pair.base}`, async () => {
      const c = books.find((b) => b.title === pair.commentary);
      const b = books.find((x) => x.title === pair.base);
      if (!c || !b) return log(`skipped: ${pair.commentary} / ${pair.base} not in this database`);
      const cLines = await reader.lines(c.id);
      const commentary = engineBook(`db:${c.id}`, c.title, cLines);
      const base = engineBook(`db:${b.id}`, b.title, await reader.lines(b.id));
      const fit = titleFit(commentary, base);
      const gold = goldPairs(await links.atLines(cLines.map((l) => l.lineId)), c.id, b.id);
      const m = measure(runHeadingsEngine(commentary, base), gold);
      const x = fit.metrics;
      log(
        `FIT ${fit.verdict.padEnd(7)} ${pair.commentary} → ${pair.base}: density ${x.titleDensity.toFixed(2)} placed ${x.placedShare.toFixed(2)} pathShare ${x.pathShare.toFixed(2)} dup ${x.duplicateShare.toFixed(2)} headings ${x.headings} | engine certain+high ${m.correct}/${m.judged}, recall ${m.recalled}/${m.goldLines}`,
      );
      if (pair.expect === "unfit") expect(fit.verdict).toBe("unfit");
      else expect(fit.verdict).not.toBe("unfit");
    }, 300_000);
  }

  /*
   * A deterministic sample of "X על Y" pairs (Y exists): the verdict next to what the headings engine really did
   * against the database's links, to see that no "fit" pair is a failure and no "unfit" pair is a success.
   * TITLE_FIT_SAMPLE=<count> (default 0 = skipped; ~40 takes a few minutes).
   */
  const SAMPLE = Number(process.env.TITLE_FIT_SAMPLE ?? 0);
  it.runIf(SAMPLE > 0)("sample of pairs by title", async () => {
    const byTitle = new Map(books.map((b) => [b.title, b]));
    const pairs: { c: DbBook; b: DbBook }[] = [];
    for (const c of books) {
      const at = c.title.lastIndexOf(" על ");
      if (at < 0) continue;
      const b = byTitle.get(c.title.slice(at + 4));
      if (b) pairs.push({ c, b });
    }
    const step = Math.max(1, Math.floor(pairs.length / SAMPLE));
    let done = 0;
    for (let i = 0; i < pairs.length && done < SAMPLE; i += step) {
      const { c, b } = pairs[i]!;
      const cLines = await reader.lines(c.id);
      if (cLines.length > 12_000 || cLines.length < 30) continue;
      const bLines = await reader.lines(b.id);
      if (bLines.length > 30_000) continue;
      const commentary = engineBook(`db:${c.id}`, c.title, cLines);
      const base = engineBook(`db:${b.id}`, b.title, bLines);
      const fit = titleFit(commentary, base);
      const gold = goldPairs(await links.atLines(cLines.map((l) => l.lineId)), c.id, b.id);
      if (gold.size < 20) continue;
      const m = measure(runHeadingsEngine(commentary, base), gold);
      const x = fit.metrics;
      done++;
      log(`SAMPLE ${fit.verdict.padEnd(7)} ${c.title} → ${b.title}: density ${x.titleDensity.toFixed(2)} placed ${x.placedShare.toFixed(2)} dup ${x.duplicateShare.toFixed(2)} headings ${x.headings} | engine certain+high ${m.correct}/${m.judged}, recall ${m.recalled}/${m.goldLines}`);
    }
  }, 1_800_000);
});
