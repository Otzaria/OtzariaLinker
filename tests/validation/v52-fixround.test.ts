import { appendFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import type { LinkSide } from "../../src/core/links/model";
import { discoverPairs, type DiscoveryBook } from "../../src/linking/discovery";
import { linePairKey, mergeSuggestions, type MergedSuggestion, type MergeItem } from "../../src/linking/merge";
import { competingTargets, evidenceFromCounts, linkedFields, linkedProps, planMaxLink, type PlanBook } from "../../src/linking/plan";
import { SourceRegistry } from "../../src/sources/registry";
import { maxlinkJob } from "../../src/workers/maxlink-job";
import { DB, fileBlob } from "./env";

/*
 * Fix round before the merge of PR 2, claim 9: "ספר הנר על ברכות" in the personal database (v52) against BOTH books titled "ברכות" (the
 * personal one and the official one), read-only, through the registry the app uses. Aggregate numbers only: no book text is read or written.
 *
 *   OTZARIA_DB  the official seforim.db     V52_DB  the personal database     FIXROUND_OUT  a file the run appends its log to
 *   FIXROUND_DEP (default "ספר הנר על ברכות")  FIXROUND_BASE (default "ברכות")
 */
const OUT = process.env.FIXROUND_OUT;
const log = (s: string) => OUT && appendFileSync(OUT, s + "\n");
const DEP = process.env.FIXROUND_DEP ?? "ספר הנר על ברכות";
const BASE = process.env.FIXROUND_BASE ?? "ברכות";

it.runIf(DB && process.env.V52_DB && OUT)("the shared-title case against both candidate bases", async () => {
  const reg = new SourceRegistry();
  const res = await reg.open([{ path: "seforim.db", blob: await fileBlob(DB!) }, { path: "v52.db", blob: await fileBlob(process.env.V52_DB!) }]);
  const [official, v52] = [res.sources[0]!, res.sources[1]!];
  const all = [...official.books, ...v52.books];
  const dep = v52.books.find((b) => b.title === DEP);
  if (!dep) throw new Error(`no book "${DEP}" in v52`);
  const bases = all.filter((b) => b.title === BASE);
  log(`dependant ${dep.key} (${dep.lineCount} lines); books titled "${BASE}": ${bases.map((b) => `${b.key} ${b.origin} ${b.lineCount} lines`).join(" | ")}`);

  /* what the database says: its links of the dependant, by the lines of the other book */
  const links = await reg.existingLinks(dep.key, 0, Number.MAX_SAFE_INTEGER);
  const toBase = links.filter((l) => l.source.book.title === BASE || l.target.book.title === BASE);
  const gold = new Map<number, Set<number>>();
  let maxTarget = -1;
  for (const l of toBase) {
    const [m, o] = l.source.book.key === dep.key ? [l.source, l.target] : [l.target, l.source];
    maxTarget = Math.max(maxTarget, o.end ?? o.line);
    for (let x = m.line; x <= (m.end ?? m.line); x++) {
      const set = gold.get(x) ?? new Set<number>();
      for (let y = o.line; y <= (o.end ?? o.line); y++) set.add(y);
      gold.set(x, set);
    }
  }
  const beyond = (b: { lineCount?: number }) => toBase.filter((l) => (l.source.book.key === dep.key ? l.target : l.source).line >= (b.lineCount ?? Infinity)).length;
  log(`database links of the dependant to a book titled "${BASE}": ${toBase.length}; dependant lines ${gold.size}; highest target line ${maxTarget}; links past the end of each candidate: ${bases.map((b) => `${b.key}=${beyond(b)}`).join(", ")}`);

  /* 1. discovery, with the evidence the registry can give */
  const summary = await reg.dbLinkSummary(dep.key, {});
  const byKey = "byBook" in summary ? Object.fromEntries(summary.byBook.map((x) => [x.bookKey, x.out + x.in])) : {};
  const byTitle = "byBook" in summary ? Object.fromEntries(summary.byBook.map((x) => [x.title, x.out + x.in])) : {};
  log(`link summary by book: ${JSON.stringify(byKey)}`);
  const disc: DiscoveryBook[] = all
    .filter((b) => b.key === dep.key || b.title === BASE)
    .map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }), ...(b.key === dep.key && { linkedLines: gold.size, linkedTo: byTitle, linkedKeys: byKey, linkedMaxLine: Object.fromEntries(bases.map((x) => [x.key, maxTarget])) }) }));
  const found = discoverPairs(disc, { dependants: (b) => b.key === dep.key });
  for (const p of found.proposals) log(`discovery: base ${p.base.key} (${p.base.origin}); confidence ${p.confidence}; selection ${p.selection}; evidence ${JSON.stringify(p.evidence)}; markers ${JSON.stringify(p.markers)}`);

  /* 2. the plan as the app makes it, with no choice made */
  const library: PlanBook[] = all.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }) }));
  const fields = "byBook" in summary ? linkedFields(evidenceFromCounts(dep.key, summary.byBook)).get(dep.key) : undefined;
  const lib = library.map((x) => (x.key === dep.key ? { ...x, ...linkedProps(fields) } : x));
  const auto = planMaxLink({ selected: [dep.key], library: lib, singleEngines: [] });
  log(`default plan: ${auto.steps.map((s) => `${s.engine}->${s.kind === "pair" ? s.target.key : "-"}`).join(", ")}; decisions ${JSON.stringify(auto.books[0]!.decisions)}; baseSources ${JSON.stringify(auto.baseSources)}`);

  /* 2b. the default plan, run as the app runs it: what reaches the user, and at which confidence */
  {
    const job = await maxlinkJob(reg, auto.steps, { stepBudgetMs: 180_000 }, {});
    const db = new Set(job.dbLinkKeys);
    const items: MergeItem[] = job.items.flatMap((i) => (i.result?.suggestions ?? []).map((suggestion) => ({ suggestion, focus: dep.key })));
    const merged = mergeSuggestions(items, { reference: db, candidateBooks: competingTargets(auto.steps), existing: (s) => (db.has(linePairKey(s)) ? "db" : null) }).suggestions;
    const byConf: Record<string, number> = {};
    for (const m of merged) byConf[m.confidence] = (byConf[m.confidence] ?? 0) + 1;
    const flagged = auto.steps.filter((x) => x.kind === "pair" && x.ambiguousBase).length;
    log(`default plan run: steps flagged ambiguousBase ${flagged}/${auto.steps.length}; suggestions ${merged.length} by confidence ${JSON.stringify(byConf)}; targets ${JSON.stringify([...new Set(merged.map((m) => (m.source.book.key === dep.key ? m.target : m.source).book.key))])}`);
  }

  /* 3. each candidate base, chosen explicitly */
  const rows: unknown[] = [];
  for (const base of bases) {
    const plan = planMaxLink({ selected: [dep.key], library: lib, singleEngines: [], choices: { pairs: [{ dependant: dep.title, base: base.title, dependantKey: dep.key, baseKey: base.key }] } });
    const t0 = performance.now();
    const job = await maxlinkJob(reg, plan.steps, { stepBudgetMs: 180_000 }, {});
    const db = new Set(job.dbLinkKeys);
    const items: MergeItem[] = job.items.flatMap((i) => (i.result?.suggestions ?? []).map((suggestion) => ({ suggestion, focus: dep.key })));
    const merged = mergeSuggestions(items, { reference: db, candidateBooks: competingTargets(plan.steps), existing: (s) => (db.has(linePairKey(s)) ? "db" : null) }).suggestions;
    const sides = (s: MergedSuggestion): [LinkSide, LinkSide] => (s.source.book.key === dep.key ? [s.source, s.target] : [s.target, s.source]);
    const byConf: Record<string, number> = {};
    let judged = 0, correct = 0, noGold = 0, fresh = 0, anyJudged = 0, anyAgree = 0, anyNear = 0;
    for (const s of merged) {
      byConf[s.confidence] = (byConf[s.confidence] ?? 0) + 1;
      if (!s.rules.some((x) => x.startsWith("maxlink/exists-"))) fresh++;
      {
        // every suggestion with a database link on its line, whatever its confidence: how well does this base fit the database's links
        const [m0, o0] = sides(s);
        const g0 = gold.get(m0.line);
        if (g0) {
          anyJudged++;
          if ([...g0].some((y) => y >= o0.line && y <= (o0.end ?? o0.line))) anyAgree++;
          else if ([...g0].some((y) => Math.abs(y - o0.line) <= 1)) anyNear++;
        }
      }
      if (s.confidence !== "certain" && s.confidence !== "high") continue;
      const [m, o] = sides(s);
      const g = gold.get(m.line);
      if (!g) (noGold++);
      else (judged++, [...g].some((y) => y >= o.line && y <= (o.end ?? o.line)) && correct++);
    }
    const row = { base: base.key, origin: base.origin, lines: base.lineCount, steps: plan.steps.map((s) => s.engine), suggestions: merged.length, byConf, fresh, certainOrHigh: (byConf["certain"] ?? 0) + (byConf["high"] ?? 0), judgedAgainstDb: judged, agreeWithDb: correct, noDbLinkToJudge: noGold, anyConfidence: { onGoldLines: anyJudged, agree: anyAgree, offByOne: anyNear }, notes: job.items.flatMap((i) => (i.result?.notes ?? []).map((n) => n.code)), errors: job.items.filter((i) => i.error).map((i) => i.error), ms: Math.round(performance.now() - t0) };
    rows.push(row);
    log(`candidate ${JSON.stringify(row)}`);
  }
  writeFileSync(`${OUT}.json`, JSON.stringify({ dep: dep.key, bases: bases.map((b) => b.key), rows }, null, 1));
}, 3_600_000);
