import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { syntheticLinksFile, SYNTH_SOURCE } from "../../support/synthetic-links";

/*
 * V7 §4.12 / #42 C5 measurement, in Node (no browser): the import of a 235k-record links file and the autosave of a
 * 100k-link project, on synthetic records (tests/support/synthetic-links.ts) over the schema-7 slice. Prints numbers only;
 * the browser side (long tasks) is tests/validation/browser/perf-v7.spec.ts. Runs only when asked:
 *   V7_PERF=1 [MEASURE_OUT=file] npx vitest run tests/integration/state/v7-perf-measure.local.test.ts
 */
const on = !!process.env.V7_PERF;
const log = (line: string) => {
  console.log(line);
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
};
const mb = (n: number) => (n / 1024 ** 2).toFixed(0);
const gc = () => (globalThis as { gc?: () => void }).gc?.();

function makeStore() {
  const reg = new SourceRegistry();
  const service = {
    open: (f) => reg.open(f),
    lines: (k, a, b) => reg.lines(k, a, b),
    existingLinks: (k, a, b) => reg.existingLinks(k, a, b),
    close: async (id) => reg.close(id),
    altToc: (k) => reg.altToc(k),
    headings: (k) => reg.headings(k),
  } as BooksService;
  return new AppStore(service, { save: () => {} }, loadPreferences(null));
}
const DB = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });

/** samples heapUsed every few ms while `run` runs; returns the peak above the start */
async function withPeak<T>(run: () => Promise<T>): Promise<{ value: T; ms: number; peakMB: number }> {
  gc();
  const start = process.memoryUsage().heapUsed;
  let peak = start;
  const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 5);
  const t0 = performance.now();
  const value = await run();
  const ms = performance.now() - t0;
  clearInterval(t);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  return { value, ms, peakMB: Number(mb(peak - start)) };
}

describe.runIf(on)("V7 perf (Node): import and autosave", () => {
  it("import of 235,000 records", { timeout: 600_000 }, async () => {
    const text = syntheticLinksFile(235_000);
    log(`[import] file: ${(text.length / 1e6).toFixed(1)}M chars, ${mb(Buffer.byteLength(text))} MB UTF-8`);
    for (let rep = 0; rep < 3; rep++) {
      const store = makeStore();
      await store.openFiles([DB()]);
      // the longest synchronous stretch is what blocks the page: time each turn of the event loop the import takes
      let longest = 0;
      let turns = 0;
      let last = performance.now();
      let done = false;
      const tick = () => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        turns++;
        last = now;
        if (!done) setImmediate(tick);
      };
      setImmediate(tick);
      const r = await withPeak(async () => {
        last = performance.now();
        await store.exchange.importLinksFile(`${SYNTH_SOURCE}_links.json`, text);
      });
      done = true;
      longest = Math.max(longest, performance.now() - last);
      log(`[import] rep ${rep + 1}: ${r.ms.toFixed(0)} ms total, longest block ${longest.toFixed(0)} ms over ${turns} turns, heap peak +${r.peakMB} MB, links ${store.allLinks.value.length}`);
      expect(store.allLinks.value.length).toBe(235_000);
    }
  });

  it("autosave of a 100,000-link project after one edit", { timeout: 600_000 }, async () => {
    const store = makeStore();
    await store.openFiles([DB()]);
    await store.exchange.importLinksFile(`${SYNTH_SOURCE}_links.json`, syntheticLinksFile(100_000));
    let size = 0;
    const kv: KeyValueStore = { get: async () => null, set: async (_k, v) => void (size = v.length), delete: async () => {} };
    // the first save serializes every link; later ones only the changed link
    const first = performance.now();
    const text = store.projectText();
    log(`[autosave] first serialization: ${(performance.now() - first).toFixed(0)} ms, ${(text.length / 1e6).toFixed(1)}M chars (${mb(Buffer.byteLength(text))} MB UTF-8)`);
    // what the browser's autosave keeps since #42 C5 (app/idb-store.ts): the same text, gzip-compressed
    const gz = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
    log(`[autosave] stored compressed: ${(gz.size / 1048576).toFixed(1)} MB`);
    for (let rep = 0; rep < 3; rep++) {
      const id = store.allLinks.value[rep]!.id;
      store.deleteLinks([id]);
      const t0 = performance.now();
      store.projectText();
      log(`[autosave] rep ${rep + 1}: projectText after one edit ${(performance.now() - t0).toFixed(0)} ms`);
    }
    void kv;
    void size;
  });
});
