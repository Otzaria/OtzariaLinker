import { appendFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { linesFingerprint } from "../../../src/core/text/fingerprint";
import { SourceRegistry } from "../../../src/sources/registry";
import { readEdition } from "../../../src/state/edition";
import { fileBlob } from "../linking/citations/file-blob";

/*
 * V7 §1.1 (item 5 of the owner's round 2): what an EDITION fingerprint costs on the real official database, against reading the
 * whole book. The decision (docs/contracts/DATABASE_SUPPORT_MATRIX.md §9) rests on these numbers. Read-only: a read-only Blob over the
 * file, never read whole; its size and last-modified time are checked before and after.
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db EDITION_LOG=C:/tmp/edition.log npx vitest run tests/integration/database/edition-fingerprint-real-db.local.test.ts
 * The numbers are printed to EDITION_LOG (vitest hides console output of a passing test).
 */
const path = process.env.OTZARIA_DB;
const log = (line: string) => (process.env.EDITION_LOG ? appendFileSync(process.env.EDITION_LOG, `${line}\n`) : console.log(line));

describe.runIf(path)("edition fingerprint on the real seforim.db (read-only)", () => {
  it("costs a few lines per book, is stable, and tells books apart", { timeout: 1_800_000 }, async () => {
    const before = statSync(path!);
    const r = new SourceRegistry();
    const t0 = performance.now();
    const opened = await r.open([{ path: "seforim.db", blob: fileBlob(path!) }]);
    expect(opened.skipped, JSON.stringify(opened.skipped)).toEqual([]);
    const books = opened.sources[0]!.books;
    log(`open: ${Math.round(performance.now() - t0)} ms, ${books.length} books, file ${before.size} bytes`);

    const bySize = [...books].sort((a, b) => (b.lineCount ?? 0) - (a.lineCount ?? 0));
    const largest = bySize.slice(0, 10);
    const spread = books.filter((_, i) => i % Math.max(1, Math.floor(books.length / 300)) === 0).slice(0, 300);
    const lines = (k: string, from: number, to: number) => r.lines(k, from, to);

    // the edition of the largest books and of 300 books across the database, each read once, cold
    const timed = async (list: typeof books) => {
      const ms: number[] = [];
      const out = new Map<string, string>();
      for (const b of list) {
        const s = performance.now();
        out.set(b.key, await readEdition(lines, b.key, b.lineCount!));
        ms.push(performance.now() - s);
      }
      ms.sort((a, b) => a - b);
      return { out, ms, total: ms.reduce((a, b) => a + b, 0) };
    };
    const big = await timed(largest);
    log(`largest 10 (${largest[0]!.lineCount}…${largest.at(-1)!.lineCount} lines): edition ${big.total.toFixed(0)} ms in all, median ${big.ms[5]!.toFixed(1)} ms, max ${big.ms.at(-1)!.toFixed(1)} ms`);
    const wide = await timed(spread);
    log(`300 books across the database: edition ${wide.total.toFixed(0)} ms in all, median ${wide.ms[150]!.toFixed(1)} ms, p95 ${wide.ms[284]!.toFixed(1)} ms, max ${wide.ms.at(-1)!.toFixed(1)} ms`);

    // the alternative: a fingerprint of every line (core/text/fingerprint.ts, the batch job's), on the three largest books
    for (const b of largest.slice(0, 3)) {
      const s = performance.now();
      linesFingerprint((await r.lines(b.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => l.text));
      log(`full fingerprint of "${b.title}" (${b.lineCount} lines): ${(performance.now() - s).toFixed(0)} ms`);
    }

    // stable: read again, the same; distinct: no two of the 300 books share one
    for (const b of spread.slice(0, 20)) expect(await readEdition(lines, b.key, b.lineCount!)).toBe(wide.out.get(b.key));
    expect(new Set(wide.out.values()).size).toBe(wide.out.size);

    const after = statSync(path!);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    log(`file unchanged: ${after.size} bytes, mtime ${new Date(after.mtimeMs).toISOString()}`);
  });
});
