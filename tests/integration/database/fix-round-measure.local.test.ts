import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { ExternalLinksReader } from "../../../src/database/otzaria/external-links-reader";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";
import { ROWID } from "../../../src/core/db-mapping";
import { DbBookSource } from "../../../src/sources/db/db-source";
import { MappedDbSource } from "../../../src/sources/db/mapped-source";

/*
 * The edge cases QA_V6_PR1 listed as "known, not measured" (fix round before merge, task 4), measured on the real files,
 * read-only, AGGREGATE numbers only (never a row of text). Runs only with the files:
 *   OTZARIA_PERSONAL_DB=C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db  (v52, external_link, 1.74 GB)
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db                              (the library, link table)
 *   npx vitest run tests/integration/database/fix-round-measure.local.test.ts
 */
const personal = process.env.OTZARIA_PERSONAL_DB;
const library = process.env.OTZARIA_DB;
const fds: number[] = [];
const fdSource = (p: string): ByteSource => {
  const fd = openSync(p, "r");
  fds.push(fd);
  let reads = 0;
  return {
    size: fstatSync(fd).size,
    async read(offset, length) {
      // a Blob read in the browser is a macrotask; readSync alone would starve timers (and so cancel signals) during a scan
      if (++reads % 16 === 0) await new Promise((r) => setImmediate(r));
      const buf = new Uint8Array(length);
      return buf.subarray(0, readSync(fd, buf, 0, length, offset));
    },
  };
};
afterAll(() => fds.forEach((fd) => closeSync(fd)));
/** console.log, and the same line appended to MEASURE_OUT when set (a reporter may swallow stdout) */
const log = (line: string) => {
  console.log(line);
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
};
const ms = (t0: number) => Math.round(performance.now() - t0);
const mb = (n: number) => (n / 1024 ** 2).toFixed(0);
const mem = () => {
  const m = process.memoryUsage();
  return `rss ${mb(m.rss)} MB, heap ${mb(m.heapUsed)} MB, arrayBuffers ${mb(m.arrayBuffers)} MB`;
};

describe.runIf(personal)("v52 (external_link): ranges, memory, cancel", () => {
  it("(b) atLines: a 200-line range seeks; a 400-line range reads the whole book and filters", { timeout: 900_000 }, async () => {
    const sql = new DatabaseSync(personal!, { readOnly: true });
    const top = sql.prepare("SELECT sourceBookId AS b, count(*) AS n, max(sourceLineIndex) AS maxLine FROM external_link GROUP BY sourceBookId ORDER BY n DESC LIMIT 1").get() as { b: number; n: number; maxLine: number };
    sql.close();
    const reader = await OtzariaDbReader.open(fdSource(personal!));
    const ext = (await ExternalLinksReader.open(reader.file, reader.caps))!;
    log(`[b] top book: ${top.n} rows, lines 0..${top.maxLine}`);
    for (const width of [200, 399, 400, 1000, 5000, 10_000, 19_999, 20_000]) {
      const calls = width < 400 ? 20 : 5;
      const t0 = performance.now();
      let rows = 0;
      for (let i = 0; i < calls; i++) rows += (await ext.atLines(top.b, i * width, i * width + width - 1)).length;
      const per = (performance.now() - t0) / calls;
      const chunks = Math.ceil((top.maxLine + 1) / width);
      log(`[b] width ${width}: ${per.toFixed(0)} ms per call (${calls} calls, ${rows} rows) -> a whole walk of ${chunks} calls = ${((per * chunks) / 1000).toFixed(1)} s`);
    }
    const t1 = performance.now();
    const all = await ext.atLines(top.b, 0, Number.MAX_SAFE_INTEGER);
    log(`[b] the whole book in one call: ${all.length} rows in ${ms(t1)} ms`);
  });

  it("(c, e) memory: open, list the biggest book, the internal scan", { timeout: 900_000 }, async () => {
    const before = mem();
    const src = await DbBookSource.open("s1", "v52.db", fdSource(personal!));
    log(`[c] before open: ${before}`);
    log(`[c] after open (${(await src.books()).length} books): ${mem()}`);
    const sql = new DatabaseSync(personal!, { readOnly: true });
    const top = sql.prepare("SELECT sourceBookId AS b FROM external_link GROUP BY sourceBookId ORDER BY count(*) DESC LIMIT 1").get() as { b: number };
    sql.close();
    const t0 = performance.now();
    const listing = await src.linkListing(`s1:${top.b}`);
    if (typeof listing === "string") throw new Error(listing);
    log(`[c] after the listing of the biggest book (${listing.size} links, ${ms(t0)} ms): ${mem()}`);
    expect(listing.size).toBeGreaterThan(0);
  });

  it("(c) a large database through a mapping: the index strategy, and the scan strategy (one pass over 6.6M lines)", { timeout: 1_800_000 }, async () => {
    const two = (order: string) => ({ layout: "two-tables" as const, books: { table: "book", id: "id", title: "title" }, lines: { table: "line", book: "bookId", order, text: "heRef" } });
    log(`[c-mapped] before: ${mem()}`);
    const t0 = performance.now();
    const byIndex = await MappedDbSource.open("m1", "v52.db", fdSource(personal!), two("lineIndex"));
    log(`[c-mapped] index mapping opened (strategy ${byIndex.strategy}, ${(await byIndex.books()).length} books) in ${ms(t0)} ms: ${mem()}`);
    const t1 = performance.now();
    const scan = await MappedDbSource.open("m2", "v52.db", fdSource(personal!), two(ROWID));
    log(`[c-mapped] rowid-ordered mapping opened (strategy ${scan.strategy}) in ${ms(t1)} ms: ${mem()}`);
    expect(["index", "scan"]).toContain(scan.strategy);
  });

  it("(d) cancelling a shared scan: one caller leaves, the other still gets it; all leave, it stops within a moment", { timeout: 900_000 }, async () => {
    const src = await DbBookSource.open("s1", "v52.db", fdSource(personal!));
    const sql = new DatabaseSync(personal!, { readOnly: true });
    const top = sql.prepare("SELECT sourceBookId AS b FROM external_link GROUP BY sourceBookId ORDER BY count(*) DESC LIMIT 1").get() as { b: number };
    sql.close();
    const key = `s1:${top.b}`;
    const a = new AbortController();
    const b = new AbortController();
    const pa = src.linkListing(key, { signal: a.signal });
    const pb = src.linkListing(key, { signal: b.signal });
    await new Promise((r) => setTimeout(r, 300));
    const tA = performance.now();
    a.abort();
    await expect(pa).rejects.toBeDefined();
    log(`[d] first caller left: its promise rejected after ${ms(tA)} ms; the second is still running`);
    const listing = await pb;
    expect(typeof listing).not.toBe("string");
    log(`[d] the second caller got the listing (${(listing as { size: number }).size} links)`);
    // a fresh source (nothing cached): the only caller leaves while the scan runs
    const fresh = await DbBookSource.open("s2", "v52.db", fdSource(personal!));
    const c = new AbortController();
    const pc = fresh.linkListing(key, { signal: c.signal });
    await new Promise((r) => setTimeout(r, 300));
    const tC = performance.now();
    c.abort();
    await expect(pc).rejects.toBeDefined();
    log(`[d] the last caller left: rejected after ${ms(tC)} ms`);
    // and a new caller starts the work again (a cancelled scan is not cached)
    const t3 = performance.now();
    const again = await fresh.linkListing(key);
    log(`[d] a new caller after the cancel got ${(again as { size: number }).size} links in ${ms(t3)} ms`);
  });
});

describe.runIf(library)("the library (link table): existingLinks walks a big book in chunks of 200 lines", () => {
  it("(a) the cost of one chunk and of a whole walk", { timeout: 1_800_000 }, async () => {
    const sql = new DatabaseSync(library!, { readOnly: true });
    const top = sql.prepare("SELECT id, totalLines FROM book ORDER BY totalLines DESC LIMIT 1").get() as { id: number; totalLines: number };
    sql.close();
    const src = await DbBookSource.open("s1", "seforim.db", fdSource(library!));
    const key = `s1:${top.id}`;
    const reader = await OtzariaDbReader.open(fdSource(library!));
    const t0 = performance.now();
    const entries = await reader.lineEntries(top.id);
    log(`[a] biggest book: ${top.totalLines} lines; lineEntries alone: ${ms(t0)} ms (${entries.length} entries)`);
    const calls = 15;
    const t1 = performance.now();
    let links = 0;
    for (let i = 0; i < calls; i++) links += (await src.existingLinks(key, i * 200, i * 200 + 199)).length;
    const per = (performance.now() - t1) / calls;
    const chunks = Math.ceil(top.totalLines / 200);
    log(`[a] existingLinks of a 200-line chunk: ${per.toFixed(0)} ms per call (${calls} calls, ${links} links) -> a whole walk of ${chunks} chunks = ${((per * chunks) / 1000).toFixed(0)} s`);
    // a small book for comparison
    const small = new DatabaseSync(library!, { readOnly: true }).prepare("SELECT id FROM book WHERE totalLines BETWEEN 800 AND 1200 LIMIT 1").get() as { id: number };
    const t2 = performance.now();
    for (let i = 0; i < 5; i++) await src.existingLinks(`s1:${small.id}`, i * 200, i * 200 + 199);
    log(`[a] a ~1000-line book: ${((performance.now() - t2) / 5).toFixed(0)} ms per chunk call`);
  });
});
