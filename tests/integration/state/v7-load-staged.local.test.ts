import { appendFileSync } from "node:fs";
import { effect } from "@preact/signals";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";
import { fileBlob, fingerprint } from "../../validation/env";

/*
 * V7 §4.9: staged load runs on the real library, through the state layer the app runs (AppStore over the worker's own handlers,
 * tests/support/books-service.ts — the same code without postMessage). For each stage of N books (the dependants of a seeded
 * shuffle of every book the full-library plan pairs with a base; stage N holds the books of every smaller stage):
 *
 *   open · detection (the evidence pass: the database's own links of the selected books) · plan · linking (the max-link job, every
 *   engine the app ticks by default, book after book) · merge (the job's publish: the merged run) · approval of every "certain" ·
 *   QA (quality.run, validateExport) · export (prepareExport, in memory) · project save (projectText) · job persisted (KeyValueStore)
 *   · close · reopen (a new store: the database again, openProject — parse + rebind — and the job restored from the store)
 *
 * Wall time, peak RSS and heap per phase, suggestions, failures. Numbers only; nothing of a book's text is written anywhere.
 *   OTZARIA_DB=… OTZARIA_LOAD_STAGES=10,50,100 [OTZARIA_LOAD_SEED=49] [MEASURE_OUT=file] [OTZARIA_LOAD_STEP_S=180]
 *   npx vitest run tests/integration/state/v7-load-staged.local.test.ts
 * OTZARIA_LOAD_STEP_S: a time budget per step (maxlink-job.ts stepBudgetMs, as the library benchmark sets it) so one slow pair does
 * not stall a stage; the steps it stopped are counted. "0" runs without one, as the app does.
 */
const DB = process.env.OTZARIA_DB;
const STAGES = (process.env.OTZARIA_LOAD_STAGES ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s === "all" ? Infinity : Number(s)));
const SEED = Number(process.env.OTZARIA_LOAD_SEED ?? 49);
const STEP_S = Number(process.env.OTZARIA_LOAD_STEP_S ?? 180);
const log = (line: string) => {
  console.log(line);
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
};
const MB = 2 ** 20;
const gc = () => (globalThis as { gc?: () => void }).gc?.();

function rng(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** peak RSS and heap while a phase runs: an interval, and every progress report of the store's task (the long stretches) */
class Peaks {
  rss = 0;
  heap = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  sample = () => {
    const m = process.memoryUsage();
    this.rss = Math.max(this.rss, m.rss);
    this.heap = Math.max(this.heap, m.heapUsed);
  };
  start() {
    this.rss = 0;
    this.heap = 0;
    this.sample();
    this.timer = setInterval(this.sample, 100);
  }
  stop() {
    clearInterval(this.timer);
    this.sample();
    return { rssMB: Math.round(this.rss / MB), heapMB: Math.round(this.heap / MB) };
  }
}

function makeStore(service: BooksService) {
  const saved: { name: string; size: number }[] = [];
  const store = new AppStore(service, { save: (name, text) => void saved.push({ name, size: typeof text === "string" ? text.length : 0 }) }, loadPreferences(null));
  return { store, saved };
}

function memKv() {
  const mem = new Map<string, string>();
  const kv: KeyValueStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };
  return { mem, kv };
}

/** the service with a step budget (the worker's own option; the app leaves it unset) */
function budgeted(service: BooksService): BooksService {
  if (!STEP_S) return service;
  const run = service.runMaxLink!.bind(service);
  return { ...service, runMaxLink: (steps, options, opts) => run(steps, { ...options, stepBudgetMs: STEP_S * 1000 } as typeof options, opts) };
}

describe.runIf(DB && STAGES.length)("V7 §4.9 staged load on the real library (state layer, read-only)", () => {
  let candidates: string[] | null = null;
  const before = DB ? fingerprint(DB) : "";

  async function phase<T>(rows: Record<string, unknown>[], name: string, run: () => Promise<T> | T): Promise<T> {
    gc();
    const p = new Peaks();
    p.start();
    const t0 = performance.now();
    const v = await run();
    const ms = Math.round(performance.now() - t0);
    const peak = p.stop();
    rows.push({ phase: name, ms, ...peak });
    log(`  ${name}: ${ms.toLocaleString("en")} ms, rss ${peak.rssMB} MB, heap ${peak.heapMB} MB`);
    return v;
  }

  for (const n of STAGES)
    it(`stage of ${n === Infinity ? "every paired" : n} books`, { timeout: 24 * 3600_000 }, async () => {
      const rows: Record<string, unknown>[] = [];
      const { kv, mem } = memKv();
      const { store } = makeStore(budgeted(registryService(new SourceRegistry())));
      const peaks = new Peaks();
      // the store's task reports progress through long synchronous stretches: sample memory there too
      const stopFx = effect(() => void (store.task.value?.done, peaks.sample()));
      store.maxLink.startPersist(kv);
      log(`[stage ${n}] seed ${SEED}, step budget ${STEP_S || "none"} s`);
      await phase(rows, "open", async () => store.openFiles([{ path: "seforim.db", blob: await fileBlob(DB!) }]));
      const src = store.sources.value[0]!;
      expect(src.books.length).toBeGreaterThan(1000);

      if (!candidates) {
        // the full library planned once (titles and declarations; no evidence pass over 8,000 books): the books it pairs with a base
        const full = await phase(rows, "full-library plan", () => store.maxLink.plan({ kind: "source", id: src.info.id }));
        const deps = new Set(full.steps.filter((s) => s.kind === "pair").map((s) => s.source.key));
        const titles = [...deps].map((k) => store.refOf(k).title).sort();
        const r = rng(SEED);
        for (let i = titles.length - 1; i > 0; i--) {
          const j = Math.floor(r() * (i + 1));
          [titles[i], titles[j]] = [titles[j]!, titles[i]!];
        }
        candidates = titles;
        log(`  full plan: ${full.books.length} books, ${full.steps.length} steps, ${deps.size} paired dependants, per engine ${JSON.stringify(full.perEngine)}`);
      }
      const byTitle = new Map(src.books.map((b) => [b.title, b.key] as const));
      const keys = candidates.slice(0, n).flatMap((t) => byTitle.get(t) ?? []);
      const scope = { kind: "books", keys } as const;

      await phase(rows, "detection (evidence)", () => store.maxLink.gatherEvidence(scope));
      const plan = await phase(rows, "plan", () => store.maxLink.plan(scope));
      log(`  plan: ${plan.books.length} books, ${plan.steps.length} steps ${JSON.stringify(plan.perEngine)}, identified ${plan.identified}, estimated ${Math.round(plan.estimatedMs / 1000)} s`);

      peaks.start();
      const t0 = performance.now();
      const shown = await store.maxLink.run(plan, `שלב ${n}`);
      const runMs = Math.round(performance.now() - t0);
      const runPeak = peaks.stop();
      const job = store.maxLink.job.value!;
      const linkMs = job.ms;
      rows.push({ phase: "linking (job)", ms: linkMs, ...runPeak }, { phase: "merge (publish)", ms: runMs - linkMs });
      log(`  linking: ${linkMs.toLocaleString("en")} ms; merge+publish ${runMs - linkMs} ms; rss ${runPeak.rssMB} MB, heap ${runPeak.heapMB} MB`);
      const byStatus: Record<string, number> = {};
      for (const b of job.books) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
      const run = store.suggestions.run.value;
      const outcomes = run?.maxlink?.steps ?? [];
      const stopped = outcomes.filter((o) => o.notes.some((x) => x.code === "engine/aborted")).length;
      const failedSteps = outcomes.filter((o) => o.error).length;
      const byConf: Record<string, number> = {};
      for (const s of run?.result.suggestions ?? []) byConf[s.confidence] = (byConf[s.confidence] ?? 0) + 1;
      const slowest = [...job.books].sort((a, b) => b.ms - a.ms).slice(0, 3).map((b) => `${b.ms} ms (${b.suggestions} raw)`);
      log(`  job: ${job.state}, books ${JSON.stringify(byStatus)}, steps ${outcomes.length} (failed ${failedSteps}, budget-stopped ${stopped}), raw ${job.books.reduce((s, b) => s + b.suggestions, 0)}, merged ${run?.result.suggestions.length ?? 0} ${JSON.stringify(byConf)}, slowest books ${slowest.join("; ")}`);
      expect(shown).toBe(true);
      expect(job.state).toBe("done");

      const approved = await phase(rows, "approve every certain", () => store.suggestions.approve(store.suggestions.pendingAtLeast("certain")));
      log(`  approved ${approved} suggestions → ${store.allLinks.value.length} links${run?.dbLinksUnread?.length ? ` (database links unread for ${run.dbLinksUnread.length} books)` : ""}`);
      const qa = await phase(rows, "QA (validateExport)", () => store.quality.run());
      const codes: Record<string, number> = {};
      for (const i of qa?.issues ?? []) codes[`${i.problem.severity} ${i.problem.code}`] = (codes[`${i.problem.severity} ${i.problem.code}`] ?? 0) + 1;
      log(`  QA: checked ${qa?.checked}, clean ${qa?.clean}, ${JSON.stringify(qa?.bySeverity)}, blocked ${qa?.blocked.length}; by code ${JSON.stringify(codes)}`);
      const exp = await phase(rows, "export (planExport, in memory)", () => store.exchange.prepareExport());
      const bytes = (exp?.files ?? []).reduce((s, f) => s + f.text.length, 0);
      log(`  export: ${JSON.stringify(exp?.counts)}, ${(bytes / 1e6).toFixed(1)}M chars`);
      expect(exp!.counts.heldBack).toBe(qa!.blocked.length);
      const text = await phase(rows, "project save (projectText)", () => store.projectText());
      // the job record and every book's result, as the browser keeps them (maxlink.ts saveNow is on a timer; the results are kept per book)
      await new Promise((r) => setTimeout(r, 1100));
      const kvChars = [...mem.values()].reduce((s, v) => s + v.length, 0);
      log(`  project ${(text.length / 1e6).toFixed(1)}M chars; job kept in ${mem.size} entries, ${(kvChars / 1e6).toFixed(1)}M chars`);
      const links = store.allLinks.value.length;
      const suggestions = run?.result.suggestions.length ?? 0;
      await phase(rows, "close", () => store.closeSource(src.info.id));
      stopFx();

      // reopen: a new store, the database chosen again, the project opened (parse + rebind by title), the job offered again
      const b = makeStore(registryService(new SourceRegistry())).store;
      await phase(rows, "reopen: database", async () => b.openFiles([{ path: "seforim.db", blob: await fileBlob(DB!) }]));
      await phase(rows, "reopen: project (parse + rebind)", () => b.openProject("load.otzlinker.json", text));
      const all = b.allLinks.value;
      const unbound = all.filter((l) => l.source.book.key.startsWith("unresolved:") || l.target.book.key.startsWith("unresolved:")).length;
      log(`  reopened: ${all.length} links, unbound ${unbound}`);
      expect(all.length).toBe(links);
      expect(unbound).toBe(0);
      b.maxLink.startPersist(kv);
      await new Promise((r) => setTimeout(r, 0));
      expect(b.maxLink.jobRestored.value).toBe(true);
      const resumed = await phase(rows, "reopen: job restored (resume → publish)", () => b.maxLink.resume());
      const back = b.suggestions.run.value?.result.suggestions.length ?? 0;
      const st = b.suggestions.state.value;
      const approvedBack = [...st.values()].filter((x) => x === "approved").length;
      log(`  job restored: resumed ${resumed}, ${back} suggestions (was ${suggestions}), approved state ${approvedBack} (approved ${approved})`);
      expect(back).toBe(suggestions);
      expect(approvedBack).toBe(approved);

      log(`[stage ${n}] ${JSON.stringify({ n, books: plan.books.length, steps: plan.steps.length, suggestions, approved, links, rows })}`);
      expect(fingerprint(DB!)).toBe(before);
    });
});
