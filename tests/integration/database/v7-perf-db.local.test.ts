import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";
import { coverageCounts, coverageSummary } from "../../../src/linking/coverage";
import { DbBookSource } from "../../../src/sources/db/db-source";

/*
 * V7 §4.12 / #42 C7, C8 on the real library database, in Node (no browser), opened READ-ONLY ("r") and never written. Aggregate
 * numbers only. Each measure is repeated (V7_PERF_REPS, default 3) with a fresh source, so no cache of an earlier repetition helps:
 *   V7_PERF=1 OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db [MEASURE_OUT=file] NODE_OPTIONS=--expose-gc \
 *     npx vitest run tests/integration/database/v7-perf-db.local.test.ts
 * The browser side (long tasks on the page) is tests/validation/browser/perf-v7.spec.ts.
 */
const path = process.env.OTZARIA_DB;
const on = !!process.env.V7_PERF && !!path;
const REPS = Number(process.env.V7_PERF_REPS ?? 3);
const fds: number[] = [];
const fdSource = (p: string): ByteSource => {
  const fd = openSync(p, "r");
  fds.push(fd);
  let reads = 0;
  return {
    size: fstatSync(fd).size,
    async read(offset, length) {
      // a Blob read in the browser is a macrotask; readSync alone would starve timers (and so the heap sampling and cancels)
      if (++reads % 16 === 0) await new Promise((r) => setImmediate(r));
      const buf = new Uint8Array(length);
      return buf.subarray(0, readSync(fd, buf, 0, length, offset));
    },
  };
};
afterAll(() => fds.forEach((fd) => closeSync(fd)));
const log = (line: string) => {
  console.log(line);
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const mb = (n: number) => Math.round(n / 1024 ** 2);

/** wall time and the heap's peak above where it started (sampled every 5 ms, after a GC when --expose-gc) */
async function measure<T>(run: () => Promise<T>): Promise<{ value: T; ms: number; peakMB: number }> {
  gc();
  const start = process.memoryUsage().heapUsed;
  let peak = start;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 5);
  const t0 = performance.now();
  const value = await run();
  const ms = Math.round(performance.now() - t0);
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return { value, ms, peakMB: mb(peak - start) };
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return `min ${s[0]} / median ${s[Math.floor(s.length / 2)]} (${xs.join(", ")})`;
};

describe.runIf(on)("V7 perf on the real library database (C7, C8)", () => {
  it("open, first screen of בראשית, all its links, coverage of 200 books", { timeout: 3_600_000 }, async () => {
    const results: Record<string, { ms: number[]; peak: number[] }> = {};
    const note = (name: string, r: { ms: number; peakMB: number }) => {
      const e = (results[name] ??= { ms: [], peak: [] });
      e.ms.push(r.ms);
      e.peak.push(r.peakMB);
    };
    for (let rep = 0; rep < REPS; rep++) {
      const open = await measure(() => DbBookSource.open("s1", "seforim.db", fdSource(path!)));
      note("open", open);
      const src = open.value;
      const books = await src.books();
      const key = books.find((b) => b.title === "בראשית" && /sefaria/i.test(b.sourceName ?? ""))?.key ?? books.find((b) => b.title === "בראשית")!.key;
      note("firstScreen", await measure(() => src.lines(key, 0, 199)));
      const all = await measure(() => src.existingLinks(key, 0, Number.MAX_SAFE_INTEGER));
      note("existingLinks(בראשית)", all);
      if (rep === 0) log(`[db] בראשית: ${all.value.length} links`);
      {
        const fresh = await DbBookSource.open("s2", "seforim.db", fdSource(path!));
        const c = await measure(() => fresh.coverageEnds(key));
        note("coverageEnds(בראשית)", c);
        if (rep === 0) {
          log(`[db] coverageEnds(בראשית): ${c.value.links} links`);
          // the compact read gives the rules what the Links gave, on the real book
          const b = books.find((x) => x.key === key)!;
          const book = { owns: (r: { key: string }) => r.key === key, lineCount: b.lineCount!, headings: new Set<number>() };
          expect(c.value.links).toBe(all.value.length);
          expect(coverageSummary([], { ...book, ends: c.value })).toEqual(coverageSummary(all.value, book));
          log(`[db] בראשית: the coverage from the ends equals the coverage from the Links`);
        }
        // a stop half a second into the read: how long until the read has stopped (the worker is free for the next call)
        const again = await DbBookSource.open("s4", "seforim.db", fdSource(path!));
        const ctl = new AbortController();
        const p = again.coverageEnds(key, { signal: ctl.signal }).catch(() => "stopped");
        await new Promise((r) => setTimeout(r, 500));
        const t0 = performance.now();
        ctl.abort();
        const got = await p;
        note("stop coverageEnds after 0.5 s", { ms: Math.round(performance.now() - t0), peakMB: 0 });
        if (rep === 0) log(`[db] stop: ${got === "stopped" ? "stopped" : "had finished"}`);
      }
      // 200 books spread over the database (every 40th that has a length): the same choice as the browser measurement
      const keys = books.filter((b) => (b.lineCount ?? 0) > 0).filter((_, i) => i % 40 === 0).slice(0, 200);
      const fresh = await DbBookSource.open("s3", "seforim.db", fdSource(path!));
      const c200 = await measure(async () => {
        let links = 0;
        for (const b of keys) {
          const ls = await fresh.existingLinks(b.key, 0, Number.MAX_SAFE_INTEGER);
          links += ls.length;
          coverageCounts(ls, { owns: (r) => r.key === b.key, lineCount: b.lineCount!, headings: new Set() });
        }
        return links;
      });
      note("coverage200 via existingLinks", c200);
      if (rep === 0) log(`[db] coverage of ${keys.length} books: ${c200.value} links`);
      const fresh2 = await DbBookSource.open("s5", "seforim.db", fdSource(path!));
      const e200 = await measure(async () => {
        let links = 0;
        for (const b of keys) {
          const ends = await fresh2.coverageEnds(b.key);
          links += ends.links;
          coverageCounts([], { owns: (r) => r.key === b.key, lineCount: b.lineCount!, headings: new Set(), ends });
        }
        return links;
      });
      note("coverage200 via coverageEnds", e200);
      if (rep === 0) log(`[db] coverage of ${keys.length} books via ends: ${e200.value} links`);
    }
    for (const [name, r] of Object.entries(results)) log(`[db] ${name}: ms ${stats(r.ms)}; heap peak MB ${stats(r.peak)}`);
    expect(Object.keys(results).length).toBeGreaterThan(0);
  });
});
