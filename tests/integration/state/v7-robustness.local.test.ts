import { appendFileSync } from "node:fs";
import { setFlagsFromString, writeHeapSnapshot } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { BookResult } from "../../../src/linking/batch-job";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { emptyLinkState } from "../../../src/state/history";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";
import { fileBlob, fingerprint } from "../../validation/env";

/*
 * V7 round 2, items 10 and 11 (docs/reviews/V7_PERFORMANCE.md §9.4 and §10), on the real library through the state layer, read only.
 * For a stage of N books (the same seeded selection as v7-load-staged.local.test.ts: the dependants of a seeded shuffle of every book
 * the full-library plan pairs with a base):
 *   item 10 — what the max-link job keeps in memory per finished book (its BookResult: the raw suggestions of each step, the database
 *             links' keys), measured as the heap it holds beyond the merged run the user reviews, before and after the release;
 *   item 11 — the quality check of the approved links, old (existingLinks per run of lines) against new (existingMatchIndexes, one
 *             call per book), each in a fresh store over the same saved project: wall time, worker calls, and the issues compared.
 * Numbers only. Stops the process if RSS passes OTZARIA_RSS_LIMIT_MB (default 5,000): the machine is shared.
 *   OTZARIA_DB=… OTZARIA_ROBUST_STAGES=10,50 [OTZARIA_LOAD_SEED=49] [OTZARIA_LOAD_STEP_S=180] [OTZARIA_QA_OLD=1] [MEASURE_OUT=file]
 *   npx vitest run tests/integration/state/v7-robustness.local.test.ts
 */
const DB = process.env.OTZARIA_DB;
const STAGES = (process.env.OTZARIA_ROBUST_STAGES ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
const SEED = Number(process.env.OTZARIA_LOAD_SEED ?? 49);
const STEP_S = Number(process.env.OTZARIA_LOAD_STEP_S ?? 180);
const QA_OLD = process.env.OTZARIA_QA_OLD !== "0";
const RSS_LIMIT = Number(process.env.OTZARIA_RSS_LIMIT_MB ?? 5000) * 2 ** 20;
const MB = 2 ** 20;
const log = (line: string) => {
  console.log(line);
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
};
// vitest runs the file in a worker where node's --expose-gc does not reach: the flag is set here, and gc taken from a fresh context
// (without a real GC every "heap after" is just wherever the collector happened to be)
setFlagsFromString("--expose-gc");
const realGc = runInNewContext("gc") as () => void;
const gc = () => {
  for (let i = 0; i < 3; i++) realGc();
};
const heapMB = () => (gc(), Math.round(process.memoryUsage().heapUsed / MB));

/** the shared machine: never past the limit */
const guard = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > RSS_LIMIT) {
    log(`!! RSS ${Math.round(rss / MB)} MB passed the limit of ${Math.round(RSS_LIMIT / MB)} MB: stopping`);
    process.exit(3);
  }
}, 250);
guard.unref();

function rng(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function memKv() {
  const mem = new Map<string, string>();
  const kv: KeyValueStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };
  return { mem, kv };
}

/** the service with a step budget, and the heap (after a GC) each time a book's call returns: what a finished book leaves behind */
function budgeted(service: BooksService, perBook: number[]): BooksService {
  const run = service.runMaxLink!.bind(service);
  return {
    ...service,
    runMaxLink: async (steps, options, opts) => {
      const r = await run(steps, (STEP_S ? { ...options, stepBudgetMs: STEP_S * 1000 } : options) as typeof options, opts);
      perBook.push(heapMB());
      return r;
    },
  };
}

/** the job's results in memory (private: measured, not changed) */
const resultsOf = (store: AppStore) => (store.maxLink as unknown as { results: Map<string, BookResult> }).results;

function counted(service: BooksService, batched: boolean) {
  const calls = { existingLinks: 0, existingMatchIndexes: 0 };
  const s: BooksService = { ...service, existingLinks: (...a) => (calls.existingLinks++, service.existingLinks(...a)) };
  if (batched) s.existingMatchIndexes = (...a) => (calls.existingMatchIndexes++, service.existingMatchIndexes!(...a));
  else delete s.existingMatchIndexes;
  return { service: s, calls };
}

describe.runIf(DB && STAGES.length)("V7 round 2: memory per finished book, and the batched QA (real library, read only)", () => {
  let candidates: string[] | null = null;
  const before = DB ? fingerprint(DB) : "";

  for (const n of STAGES)
    it(`stage of ${n} books`, { timeout: 12 * 3600_000 }, async () => {
      const { kv, mem } = memKv();
      const perBook: number[] = [];
      const store = new AppStore(budgeted(registryService(new SourceRegistry()), perBook), { save: () => {} }, loadPreferences(null));
      store.maxLink.startPersist(kv);
      log(`[robust ${n}] seed ${SEED}, step budget ${STEP_S || "none"} s, heap at start ${heapMB()} MB`);
      await store.openFiles([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
      const src = store.sources.value[0]!;
      if (!candidates) {
        const full = store.maxLink.plan({ kind: "source", id: src.info.id });
        const deps = new Set(full.steps.filter((s) => s.kind === "pair").map((s) => s.source.key));
        const titles = [...deps].map((k) => store.refOf(k).title).sort();
        const r = rng(SEED);
        for (let i = titles.length - 1; i > 0; i--) {
          const j = Math.floor(r() * (i + 1));
          [titles[i], titles[j]] = [titles[j]!, titles[i]!];
        }
        candidates = titles;
      }
      const byTitle = new Map(src.books.map((b) => [b.title, b.key] as const));
      const scope = { kind: "books", keys: candidates.slice(0, n).flatMap((t) => byTitle.get(t) ?? []) } as const;
      await store.maxLink.gatherEvidence(scope);
      const plan = store.maxLink.plan(scope);
      const h0 = heapMB();
      const t0 = performance.now();
      expect(await store.maxLink.run(plan, `שלב ${n}`)).toBe(true);
      const runMs = Math.round(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 1100)); // the job record's save is on a timer
      const job = store.maxLink.job.value!;
      const results = resultsOf(store);

      // ---- item 10: what is kept per finished book
      let raw = 0;
      let keys = 0;
      let keyChars = 0;
      let chars = 0;
      for (const r of results.values()) {
        raw += r.steps.reduce((s, st) => s + (st.item.result?.suggestions.length ?? 0), 0);
        keys += r.dbLinkKeys.length;
        keyChars += r.dbLinkKeys.reduce((s, k) => s + k.length, 0);
        chars += JSON.stringify(r).length;
      }
      const kvChars = [...mem.values()].reduce((s, v) => s + v.length, 0);
      const finished = results.size;
      const merged = store.suggestions.run.value!.result.suggestions.length;
      const slope = perBook.length > 4 ? (perBook.at(-1)! - perBook[1]!) / (perBook.length - 2) : 0;
      log(
        `  item 10: ${plan.books.length} books, run ${runMs.toLocaleString("en")} ms, ${finished} results in memory: raw suggestions ${raw.toLocaleString("en")}, merged ${merged.toLocaleString("en")}, database link keys ${keys.toLocaleString("en")} (${(keyChars / 1e6).toFixed(1)}M chars); results as JSON ${(chars / 1e6).toFixed(1)}M chars; kept in the store ${(kvChars / 1e6).toFixed(1)}M chars`,
      );
      log(`  item 10: heap after each book (first, quarter, half, last): ${[perBook[0], perBook[Math.floor(perBook.length / 4)], perBook[Math.floor(perBook.length / 2)], perBook.at(-1)].join(" / ")} MB over ${perBook.length} books → ${slope.toFixed(2)} MB a finished book`);
      log(`  job: ${job.state}, books ${JSON.stringify(job.books.reduce<Record<string, number>>((m, b) => ((m[b.status] = (m[b.status] ?? 0) + 1), m), {}))}`);

      // ---- approval, the project saved
      const approved = store.suggestions.approve(store.suggestions.pendingAtLeast("certain"));
      const text = store.projectText();
      const links = store.allLinks.value.length;
      log(`  approved ${approved} → ${links} links; project ${(text.length / 1e6).toFixed(1)}M chars`);

      // ---- item 10: the heap, released part by part (cumulative; nothing is restored): the job's results, the merged run under
      // review, the job's copy in the store (the test's Map stands for IndexedDB, which is not on the heap in the browser), the source
      const parts: [string, number][] = [["everything", heapMB()]];
      results.clear();
      parts.push(["the job's results", heapMB()]);
      store.suggestions.run.value = null;
      store.suggestions.dbLinkKeys.value = new Set();
      parts.push(["the merged run", heapMB()]);
      mem.clear();
      parts.push(["the stored copy", heapMB()]);
      await store.closeSource(src.info.id);
      parts.push(["the database source", heapMB()]);
      store.maxLink.discardJob();
      parts.push(["the job (record, plan)", heapMB()]);
      store.maxLink.evidence.value = new Map();
      parts.push(["the evidence", heapMB()]);
      store.lines.forgetAll();
      parts.push(["the line caches", heapMB()]);
      store.linkState.value = emptyLinkState();
      store.notices.value = [];
      parts.push(["the project's links, their history and the notices", heapMB()]);
      if (process.env.OTZARIA_HEAP_SNAPSHOT) log(`  heap snapshot: ${writeHeapSnapshot(process.env.OTZARIA_HEAP_SNAPSHOT)}`);
      log(`  item 10: heap before the run ${h0} MB; ${parts.map(([what, mb], i) => (i ? `without ${what} ${mb} MB (-${parts[i - 1]![1] - mb})` : `${what} ${mb} MB`)).join("; ")}`);

      // ---- item 11: the quality check, old and new, each in a fresh store over the same project
      const runs: { batched: boolean; ms: number; calls: { existingLinks: number; existingMatchIndexes: number }; issues: string[]; rssMB: number }[] = [];
      for (const batched of QA_OLD ? [true, false, true] : [true]) {
        gc();
        const { service, calls } = counted(registryService(new SourceRegistry()), batched);
        const s = new AppStore(service, { save: () => {} }, loadPreferences(null));
        await s.openFiles([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
        await s.openProject("robust.otzlinker.json", text);
        expect(s.allLinks.value.length).toBe(links);
        calls.existingLinks = 0;
        calls.existingMatchIndexes = 0;
        let rss = 0;
        const t = setInterval(() => (rss = Math.max(rss, process.memoryUsage().rss)), 100);
        const q0 = performance.now();
        const qa = await s.quality.run();
        const ms = Math.round(performance.now() - q0);
        clearInterval(t);
        const issues = (qa?.issues ?? []).map((i) => `${i.link.id} ${i.problem.code}`).sort();
        runs.push({ batched, ms, calls: { ...calls }, issues, rssMB: Math.round(Math.max(rss, process.memoryUsage().rss) / MB) });
        log(`  item 11: QA ${batched ? "batched" : "old (per run)"}: ${ms.toLocaleString("en")} ms for ${links} links (${(ms / Math.max(1, links)).toFixed(1)} ms a link), calls ${JSON.stringify(calls)}, issues ${issues.length}, rss ${runs.at(-1)!.rssMB} MB`);
        await s.closeSource(s.sources.value[0]!.info.id);
      }
      for (const r of runs.slice(1)) expect(r.issues).toEqual(runs[0]!.issues);
      if (runs.length > 1) log(`  item 11: the issues are the same in all ${runs.length} runs`);
      expect(fingerprint(DB!)).toBe(before);
    });
});
