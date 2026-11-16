import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook, SourceLine } from "../../src/core/books";
import { otzariaBookTitle } from "../../src/core/links/titles";
import { SourceRegistry } from "../../src/sources/registry";
import { TextFilesSource } from "../../src/sources/text/text-source";
import { DB, fileBlob, fingerprint, gitBlobs, gitFiles, gitHead, LIBRARY, ms, record, tally } from "./env";

/*
 * Check 4 — books of the library folders opened as TEXT sources (TextFilesSource: the generator's
 * line split) vs the same books in the database: line count, heading lines, and every line's text
 * (the .txt line vs the database line with its schema-7 note bodies put back — the string the
 * generator counts anchor offsets on).
 *
 * The books: whole folders (default: three small sources) plus the largest non-Sefaria books of the
 * database that the clone has. The .txt files are read AS COMMITTED (gitFiles in env.ts).
 *   OTZARIA_DB=… OTZARIA_LIBRARY=… [VALIDATE_TEXT_FOLDERS="a/ספרים/אוצריא;b/…"] npx vitest run --config vitest.validation.config.ts tests/validation/library-texts.test.ts
 */
const FOLDERS = (process.env.VALIDATE_TEXT_FOLDERS ?? "wikisourceToOtzaria/ספרים/אוצריא;BeitAharonVeYisraelToOtzaria/ספרים/אוצריא;Ben-YehudaToOtzaria/ספרים/אוצריא").split(";");
const LARGEST = 6;

describe.runIf(DB && LIBRARY)("check 4: library .txt books vs the database", () => {
  const before = DB ? fingerprint(DB) : "";
  let registry: SourceRegistry;
  let dbBooks: SourceBook[];
  beforeAll(async () => {
    registry = new SourceRegistry();
    const opened = await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
    dbBooks = opened.sources[0]!.books;
  });
  afterAll(() => expect(fingerprint(DB!)).toBe(before));

  it("line counts, headings and line text", async () => {
    const t0 = performance.now();
    const all = gitFiles(LIBRARY!, (p) => p.endsWith(".txt") && /\/ספרים\/אוצריא\/|^DictaToOtzaria\/ערוך\/ספרים\//.test(p));
    const sourceOf = (p: string) => p.split("/")[0]!;
    const stem = (p: string) => p.split("/").at(-1)!.replace(/\.txt$/, "");
    const dbOf = (p: string) => dbBooks.find((b) => b.title === otzariaBookTitle(stem(p)) && b.sourceName === sourceOf(p));
    // whole folders, then the largest non-Sefaria database books found in the clone
    const chosen = all.filter((f) => FOLDERS.some((d) => f.path.startsWith(`${d}/`)));
    const large = dbBooks.filter((b) => b.sourceName !== "Sefaria").sort((a, b) => (b.lineCount ?? 0) - (a.lineCount ?? 0));
    let added = 0;
    for (const b of large) {
      if (added >= LARGEST) break;
      const f = all.find((x) => otzariaBookTitle(stem(x.path)) === b.title && sourceOf(x.path) === b.sourceName);
      if (f && !chosen.includes(f)) (chosen.push(f), added++);
    }

    const rows: { path: string; db: string; txtLines: number; dbLines: number; headings: string; sameText: number; rehydrated: number; sameStored: number; merged: number; mergedAfterMarker: number; differ: number; example?: string; ms: number }[] = [];
    const notInDb: string[] = [];
    for (const [f, bytes] of gitBlobs(LIBRARY!, chosen)) {
      const b = dbOf(f.path);
      if (!b) { notInDb.push(f.path); continue; }
      const t1 = performance.now();
      const text = new TextFilesSource("t", "library", [{ path: f.path, read: async () => new Uint8Array(bytes) }]);
      const key = (await text.books())[0]!.key;
      const txt = await text.lines(key);
      const db = await registry.lines(b.key, 0, Number.MAX_SAFE_INTEGER);
      let sameText = 0, rehydrated = 0, sameStored = 0, merged = 0, mergedAfterMarker = 0, differ = 0;
      let example: string | undefined;
      for (let i = 0; i < Math.min(txt.length, db.length); i++) {
        const a = txt[i]!.text;
        const d = db[i]!;
        if (a === d.anchorText) {
          sameText++;
          if (d.anchorText !== d.text) rehydrated++; // the line has line_note rows: rehydrateLine rebuilt the .txt line exactly
        } else if (a === d.text) sameStored++;
        else if (unmerge(d.anchorText) === a) {
          merged++; // a "הערות על" companion was merged into this line by the generator
          // rehydrateLine put each body right after its marker's </sup> (or the line has no marker)
          if (/<i class="footnote">/.test(d.anchorText) && !BODY_NOT_AFTER_MARKER.test(d.anchorText)) mergedAfterMarker++;
        }
        else {
          differ++;
          example ??= `line ${i}: ${firstDifference(a, d.anchorText)}`;
        }
      }
      rows.push({ path: f.path, db: b.title, txtLines: txt.length, dbLines: db.length, headings: headingDiff(txt, db), sameText, rehydrated, sameStored, merged, mergedAfterMarker, differ, ...(example && { example }), ms: ms(t1) });
      text.close();
    }
    const summary = record("library-texts", {
      library: gitHead(LIBRARY!),
      folders: FOLDERS,
      books: rows.length,
      notInDb,
      lineCount: tally(rows.map((r) => (r.txtLines === r.dbLines ? "equal" : r.txtLines > r.dbLines ? "txt longer" : "db longer"))),
      headings: tally(rows.map((r) => r.headings)),
      lines: {
        total: rows.reduce((n, r) => n + Math.min(r.txtLines, r.dbLines), 0),
        sameAsAnchorText: rows.reduce((n, r) => n + r.sameText, 0),
        ofWhichRehydrated: rows.reduce((n, r) => n + r.rehydrated, 0),
        sameAsStoredOnly: rows.reduce((n, r) => n + r.sameStored, 0),
        companionMerged: rows.reduce((n, r) => n + r.merged, 0),
        companionMergedBodyAfterMarker: rows.reduce((n, r) => n + r.mergedAfterMarker, 0),
        differ: rows.reduce((n, r) => n + r.differ, 0),
      },
      booksWithDifferences: rows.filter((r) => r.differ || r.txtLines !== r.dbLines || r.headings !== "same").map((r) => ({ ...r })),
      largest: rows.filter((r) => !FOLDERS.some((d) => r.path.startsWith(`${d}/`))).map((r) => `${r.db}: ${r.txtLines} lines, ${r.ms} ms`),
      ms: ms(t0),
    });
    console.info(JSON.stringify({ ...summary, booksWithDifferences: summary.booksWithDifferences.slice(0, 15) }, null, 1));
    expect(rows.length).toBeGreaterThan(0);
  });
});

const BODY_NOT_AFTER_MARKER = /(?<!<\/sup>)<i class="footnote">/;

/** The .txt line a merged line came from: note bodies out, footnote-marker class off (HearotCompanionMerge). */
function unmerge(line: string): string {
  return line.replace(/<i class="footnote">[\s\S]*?<\/i>/g, "").replace(/<sup class="footnote-marker">/g, "<sup>");
}

function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: txt ${JSON.stringify(a.slice(Math.max(0, i - 15), i + 45))} | db ${JSON.stringify(b.slice(Math.max(0, i - 15), i + 45))}`;
}

function headingDiff(txt: readonly SourceLine[], db: readonly SourceLine[]): string {
  const key = (l: SourceLine) => `${l.index}|${l.heading}`;
  const a = txt.filter((l) => l.heading !== null && l.existsInDb).map(key);
  const b = db.filter((l) => l.heading !== null).map(key);
  if (JSON.stringify(a) === JSON.stringify(b)) return "same";
  return a.length === b.length ? "same count, other lines/levels" : `${a.length} vs ${b.length}`;
}
