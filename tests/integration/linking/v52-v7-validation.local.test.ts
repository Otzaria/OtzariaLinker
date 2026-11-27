import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceBook } from "../../../src/core/books";
import { baseTitleKey } from "../../../src/core/links/titles";
import { discoverPairs, type DiscoveryBook, type PairProposal } from "../../../src/linking/discovery";
import { planMaxLink } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";
import { fileBlob, fingerprint } from "../../validation/env";

/*
 * V7 §4.10: the personal database v52 (otzarya-unofficial-books-52.db) through the tool's own reader, and a batch run on it.
 * Read-only: both databases are opened as Blobs over openSync(path, "r") (tests/validation/env.ts fileBlob); size and mtime are
 * compared before and after. Prints counts and book titles only — never a line of text (docs/validation/V7_V52_VALIDATION.md).
 *
 *   OTZARIA_DB=<seforim.db> OTZARIA_PERSONAL_DB=<v52.db> OTZARIA_V52_V7=analysis|batch|all [MEASURE_OUT=file]
 *   [OTZARIA_V52_BATCH=150] [OTZARIA_V52_SEED=52] [OTZARIA_V52_STEP_S=180] [OTZARIA_V52_PARTS=official|own]
 *   npx vitest run tests/integration/linking/v52-v7-validation.local.test.ts
 *
 * analysis: the books, their kinds, the links (internal = both ends in v52, external = into the official library), the flags the
 * reader puts on them (out of range, header, reverse duplicate, ambiguous title), the lines each book has linked (coverageEnds),
 * titles shared with the official library, and the base relations discovery and the planner find, with the lines still unlinked.
 * batch: max-link through the app's state layer on (a) a seeded subset of v52 commentaries whose base is in the official library,
 * (b) every v52 commentary whose base is in v52 itself; every "certain" approved; QA and the export (in memory), counted by outcome.
 */
const OFFICIAL = process.env.OTZARIA_DB;
const V52 = process.env.OTZARIA_PERSONAL_DB;
const MODE = process.env.OTZARIA_V52_V7 ?? "";
const BATCH = Number(process.env.OTZARIA_V52_BATCH ?? 150);
const SEED = Number(process.env.OTZARIA_V52_SEED ?? 52);
const STEP_S = Number(process.env.OTZARIA_V52_STEP_S ?? 180);
const PARTS = process.env.OTZARIA_V52_PARTS;
const log = (line: string) => {
  console.log(line);
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
};
const tally = (xs: Iterable<string>) => {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};
const add = (m: Record<string, number>, k: string, n = 1) => void (m[k] = (m[k] ?? 0) + n);
function rng(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled = <T>(xs: readonly T[], seed: number): T[] => {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

describe.runIf(OFFICIAL && V52 && MODE)("V7 §4.10: v52 through the tool (read-only)", () => {
  const before = OFFICIAL && V52 ? [fingerprint(OFFICIAL), fingerprint(V52)] : [];

  it.runIf(MODE === "analysis" || MODE === "all")("analysis", { timeout: 6 * 3600_000 }, async () => {
    const reg = new SourceRegistry();
    let t0 = performance.now();
    const res = await reg.open([{ path: "seforim.db", blob: await fileBlob(OFFICIAL!) }, { path: "otzarya-unofficial-books-52.db", blob: await fileBlob(V52!) }]);
    const [official, v52] = [res.sources[0]!, res.sources[1]!];
    log(`[analysis] open ${Math.round(performance.now() - t0)} ms; official ${official.books.length} books, v52 ${v52.books.length} books (${v52.info.kind}, warnings ${v52.info.warnings.map((w) => w.code).join(",") || "none"})`);
    const v52Keys = new Set(v52.books.map((b) => b.key));
    const lines = v52.books.reduce((s, b) => s + (b.lineCount ?? 0), 0);
    log(`  v52 lines ${lines}; books without lines ${v52.books.filter((b) => !b.lineCount).length}; with declared bases ${v52.books.filter((b) => b.bases?.length).length}; dependence ${JSON.stringify(tally(v52.books.map((b) => b.dependence ?? "-")))}`);

    /* kinds by title (the rules discovery reads: "X על Y", "הערות על Y") */
    const kindOf = (b: SourceBook) => (b.title.startsWith("הערות") ? "notes" : / על /.test(b.title) ? "on" : "other");
    log(`  kinds by title: ${JSON.stringify(tally(v52.books.map(kindOf)))}`);

    /* the links of every book, as the reader lists them */
    t0 = performance.now();
    const linkTypes: Record<string, number> = {};
    const flags: Record<string, number> = {};
    const unlisted: Record<string, number> = {};
    let out = 0, inn = 0, outInternal = 0, outExternal = 0, unavailable = 0;
    const linkedTo = new Map<string, { total: number; byBook: Record<string, number>; byKey: Record<string, number> }>();
    for (const b of v52.books) {
      const s = await reg.dbLinkSummary(b.key, {});
      if (!("byBook" in s)) {
        unavailable++;
        continue;
      }
      out += s.out;
      inn += s.in;
      for (const t of s.byType) add(linkTypes, `${t.type}/out`, t.out), add(linkTypes, `${t.type}/in`, t.in);
      for (const f of s.flags ?? []) add(flags, f.flag, f.count);
      for (const [k, v] of Object.entries(s.unlisted ?? {})) add(unlisted, k, v);
      for (const x of s.byBook) {
        if (v52Keys.has(x.bookKey)) outInternal += x.out;
        else outExternal += x.out;
      }
      const notes = b.title.startsWith("הערות");
      if (s.out || s.in) linkedTo.set(b.key, { total: notes ? s.in : s.out, byBook: Object.fromEntries(s.byBook.map((x) => [x.title, notes ? x.in : x.out])), byKey: Object.fromEntries(s.byBook.map((x) => [x.bookKey, notes ? x.in : x.out])) });
    }
    log(`  link summaries ${Math.round(performance.now() - t0)} ms: outgoing ${out} (into v52 ${outInternal}, into the official library ${outExternal}), incoming ${inn}, unavailable ${unavailable}`);
    log(`  by type (each link counted at both its ends when both are in v52): ${JSON.stringify(linkTypes)}`);
    log(`  flags (the same counting): ${JSON.stringify(flags)}; unlisted rows: ${JSON.stringify(unlisted)}`);

    /* the lines each book has linked (either direction), from the compact ends the coverage reads */
    t0 = performance.now();
    const coverage = new Map<string, { linked: number; lines: number }>();
    const bands: Record<string, number> = {};
    let ends = 0;
    for (const b of v52.books) {
      const e = await reg.coverageEnds(b.key);
      ends += e.line.length;
      const seen = new Set<number>();
      for (let i = 0; i < e.line.length; i++) for (let x = e.line[i]!; x <= Math.max(e.line[i]!, e.end[i]!); x++) seen.add(x);
      const n = b.lineCount ?? 0;
      const linked = [...seen].filter((x) => x < n).length;
      coverage.set(b.key, { linked, lines: n });
      const share = n ? linked / n : 0;
      add(bands, !linked ? "0" : share < 0.1 ? "<10%" : share < 0.3 ? "10-30%" : share < 0.7 ? "30-70%" : share < 0.95 ? "70-95%" : "95-100%");
    }
    log(`  coverage ${Math.round(performance.now() - t0)} ms (${ends} ends): books by share of lines linked ${JSON.stringify(bands)}`);

    /* titles shared with the official library */
    const officialTitles = new Map(official.books.map((b) => [b.title, b] as const));
    const officialKeys = new Map<string, string[]>();
    for (const b of official.books) (officialKeys.get(baseTitleKey(b.title)) ?? officialKeys.set(baseTitleKey(b.title), []).get(baseTitleKey(b.title))!).push(b.title);
    const exact = v52.books.filter((b) => officialTitles.has(b.title));
    const equivalent = v52.books.filter((b) => !officialTitles.has(b.title) && officialKeys.has(baseTitleKey(b.title)));
    log(`  titles also in the official library: exact ${exact.length}, equivalent by baseTitleKey ${equivalent.length}`);
    log(`    exact: ${exact.map((b) => `${b.title} (${b.lineCount}/${officialTitles.get(b.title)!.lineCount} lines, ${coverage.get(b.key)!.linked} linked)`).join("; ")}`);
    log(`    equivalent: ${equivalent.slice(0, 40).map((b) => `${b.title} ~ ${officialKeys.get(baseTitleKey(b.title))!.join("/")}`).join("; ")}`);

    /* base relations: discovery (names + the book's own links), then the planner on the same books */
    const all = [...official.books, ...v52.books];
    const disc: DiscoveryBook[] = all.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }), ...(linkedTo.get(b.key) && { linkedLines: coverage.get(b.key)!.linked, linkedTo: linkedTo.get(b.key)!.byBook, linkedKeys: linkedTo.get(b.key)!.byKey }) }));
    const found = discoverPairs(disc, { dependants: (b) => v52Keys.has(b.key) });
    log(`  discovery: ${JSON.stringify(found.summary)}`);
    log(`    unresolved reasons: ${JSON.stringify(tally(found.unresolved.map((u) => u.reason.replace(/"[^"]*"/g, "\"…\""))))}`);
    const group = (p: PairProposal) => `${p.status}/${p.baseIsOfficial ? "official" : "v52"}`;
    const byGroup: Record<string, { pairs: number; lines: number; unlinkedLines: number }> = {};
    for (const p of found.proposals) {
      const g = (byGroup[group(p)] ??= { pairs: 0, lines: 0, unlinkedLines: 0 });
      const c = coverage.get(p.dependant.key)!;
      g.pairs++;
      g.lines += c.lines;
      g.unlinkedLines += c.lines - c.linked;
    }
    log(`    by status/base: ${JSON.stringify(byGroup)}`);
    log(`    markers: ${JSON.stringify(tally(found.proposals.flatMap((p) => p.markers.map((m) => (typeof m === "string" ? m : (m as { code?: string }).code ?? JSON.stringify(m))))))}; selection ${JSON.stringify(found.summary.bySelection)}`);
    const opportunities = found.proposals.filter((p) => p.status !== "linked").sort((a, b) => (coverage.get(b.dependant.key)!.lines - coverage.get(b.dependant.key)!.linked) - (coverage.get(a.dependant.key)!.lines - coverage.get(a.dependant.key)!.linked));
    log(`    completion opportunities (not linked, base found): ${opportunities.length}; top by unlinked lines: ${opportunities.slice(0, 12).map((p) => `${p.dependant.title} → ${p.base.title} (${p.baseIsOfficial ? "official" : "v52"}, ${coverage.get(p.dependant.key)!.lines - coverage.get(p.dependant.key)!.linked} lines)`).join("; ")}`);

    t0 = performance.now();
    const plan = planMaxLink({ selected: v52.books.map((b) => b.key), library: all.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.bases && { bases: b.bases }), ...(b.dependence && { dependence: b.dependence }), ...(b.lineCount !== undefined && { lineCount: b.lineCount }) })) });
    const pairSteps = plan.steps.filter((s) => s.kind === "pair");
    const planned = new Set(pairSteps.map((s) => s.source.key));
    const intoOfficial = new Set(pairSteps.filter((s) => s.kind === "pair" && !v52Keys.has(s.target.key)).map((s) => s.source.key));
    log(`  planner (titles and declarations, ${Math.round(performance.now() - t0)} ms): ${plan.books.length} books, identified ${plan.identified}, paired ${planned.size} (into the official library ${intoOfficial.size}), steps ${JSON.stringify(plan.perEngine)}, unpaired with a reason ${plan.books.filter((b) => b.unpaired).length}`);
    log(`    unpaired reasons: ${JSON.stringify(tally(plan.books.filter((b) => b.unpaired).map((b) => b.unpaired!.replace(/"[^"]*"/g, "\"…\"").slice(0, 120))))}`);
    expect(v52.books.length).toBeGreaterThan(3000);
    expect([fingerprint(OFFICIAL!), fingerprint(V52!)]).toEqual(before);
  });

  it.runIf(MODE === "batch" || MODE === "all")("batch runs: v52 commentaries on the official library, and on v52 itself", { timeout: 12 * 3600_000 }, async () => {
    const service = registryService(new SourceRegistry());
    const run = service.runMaxLink!.bind(service);
    // a time budget per step (the worker's own option, as the library benchmark sets it): one slow pair does not stall the run
    const budgeted = STEP_S ? { ...service, runMaxLink: ((steps, options, opts) => run(steps, { ...options, stepBudgetMs: STEP_S * 1000 } as typeof options, opts)) as typeof run } : service;
    const store = new AppStore(budgeted, { save: () => {} }, loadPreferences(null));
    let t0 = performance.now();
    await store.openFiles([{ path: "seforim.db", blob: await fileBlob(OFFICIAL!) }, { path: "otzarya-unofficial-books-52.db", blob: await fileBlob(V52!) }]);
    const [official, v52] = store.sources.value;
    log(`[batch] open ${Math.round(performance.now() - t0)} ms`);
    const v52Keys = new Set(v52!.books.map((b) => b.key));

    // which v52 books the planner pairs, and with what: the official library preferred where a base title is in both
    const full = store.maxLink.plan({ kind: "source", id: v52!.info.id }, undefined, official!.info.id);
    const pairs = full.steps.filter((s) => s.kind === "pair");
    const toOfficial = [...new Set(pairs.filter((s) => s.kind === "pair" && !v52Keys.has(s.target.key)).map((s) => s.source.key))];
    const toOwn = [...new Set(pairs.filter((s) => s.kind === "pair" && v52Keys.has(s.target.key)).map((s) => s.source.key))].filter((k) => !toOfficial.includes(k));
    log(`  paired v52 books: into the official library ${toOfficial.length}, only into v52 ${toOwn.length}`);
    const pick = (keys: string[], n: number) => shuffled(keys.map((k) => store.refOf(k).title).sort(), SEED).slice(0, n).map((t) => keys.find((k) => store.refOf(k).title === t)!);

    for (const [name, keys, prefer] of [
      ["v52 → official", pick(toOfficial, BATCH), official!.info.id],
      ["v52 → v52", pick(toOwn, BATCH), v52!.info.id],
    ] as const) {
      // OTZARIA_V52_PARTS=official|own: one of the two runs only
      if (PARTS && !(PARTS === "official" ? name === "v52 → official" : name === "v52 → v52")) continue;
      store.maxLink.discardJob();
      store.deleteLinks(store.allLinks.value.map((l) => l.id));
      const scope = { kind: "books", keys } as const;
      t0 = performance.now();
      await store.maxLink.gatherEvidence(scope);
      const plan = store.maxLink.plan(scope, undefined, prefer);
      log(`[${name}] ${keys.length} books, lines ${keys.reduce((s, k) => s + (store.books.value.get(k)!.lineCount ?? 0), 0)}; plan ${plan.steps.length} steps ${JSON.stringify(plan.perEngine)} in ${Math.round(performance.now() - t0)} ms (with the evidence pass)`);
      t0 = performance.now();
      const shown = await store.maxLink.run(plan, name, { preferSource: prefer });
      const job = store.maxLink.job.value!;
      const sr = store.suggestions.run.value;
      const outcomes = sr?.maxlink?.steps ?? [];
      const sugs = sr?.result.suggestions ?? [];
      const st = store.suggestions.state.value;
      log(`  run ${Math.round(performance.now() - t0)} ms (job ${job.ms} ms): ${job.state}, books ${JSON.stringify(tally(job.books.map((b) => b.status)))}, steps ${outcomes.length} (failed ${outcomes.filter((o) => o.error).length}, stopped by the budget ${outcomes.filter((o) => o.notes.some((x) => x.code === "engine/aborted")).length})`);
      log(`  suggestions ${sugs.length}: ${JSON.stringify(tally(sugs.map((s) => s.confidence)))}; by engine ${JSON.stringify(tally(sugs.map((s) => s.engine)))}; already in a database ${[...st.values()].filter((x) => x === "exists").length}; into the official library ${sugs.filter((s) => !v52Keys.has(s.target.book.key) || !v52Keys.has(s.source.book.key)).length}`);
      log(`  notes: ${JSON.stringify(tally(outcomes.flatMap((o) => o.notes.map((n) => n.code))))}`);
      log(`  slowest books: ${[...job.books].sort((a, b) => b.ms - a.ms).slice(0, 5).map((b) => `${b.title} ${b.ms} ms`).join("; ")}`);
      if (!shown) continue;
      const approved = store.suggestions.approve(store.suggestions.pendingAtLeast("certain"));
      log(`  approved ${approved} certain → ${store.allLinks.value.length} links${sr?.dbLinksUnread?.length ? `; database links unread for ${sr.dbLinksUnread.length} books` : ""}`);
      for (const purpose of ["submission", "private"] as const) {
        store.exportPurpose.value = purpose;
        const qa = await store.quality.run();
        const exp = await store.exchange.prepareExport();
        log(`  [${purpose}] QA: ${qa?.checked} checked, ${qa?.clean} clean, ${JSON.stringify(qa?.bySeverity)}, by category ${JSON.stringify(qa?.byCategory)}, by code ${JSON.stringify(tally((qa?.issues ?? []).map((i) => `${i.problem.severity} ${i.problem.code}`)))}`);
        log(`  [${purpose}] export: ${JSON.stringify(exp?.counts)}; held back by code ${JSON.stringify(tally((exp?.heldBack ?? []).flatMap((h) => h.problems.filter((p) => p.severity === "error").map((p) => p.code))))}; warnings by code ${JSON.stringify(tally((exp?.warned ?? []).flatMap((h) => h.problems.map((p) => p.code))))}`);
      }
    }
    expect([fingerprint(OFFICIAL!), fingerprint(V52!)]).toEqual(before);
  });
});
