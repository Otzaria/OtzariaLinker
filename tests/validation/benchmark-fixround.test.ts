import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { it } from "vitest";
import type { LinkSide } from "../../src/core/links/model";
import { stripTags } from "../../src/core/text/html";
import { discoverPairs, type DiscoveryBook } from "../../src/linking/discovery";
import { linePairKey, mergeSuggestions, type MergedSuggestion, type MergeItem } from "../../src/linking/merge";
import { competingTargets, planMaxLink, type PlanBook } from "../../src/linking/plan";
import { SourceRegistry } from "../../src/sources/registry";
import { maxlinkJob } from "../../src/workers/maxlink-job";
import { DB, fileBlob } from "./env";

/*
 * Fix round before the merge of PR 2, claim 12: ONE benchmark of the whole pipeline (planner, headings + dibur-hamatchil, merge, "already exists")
 * on a sample of pairs that includes books whose links are only partly there. Read-only, aggregate numbers only; a hand-check file with a few
 * short snippets goes next to the log, never into the repository.
 *
 *   OTZARIA_DB the official seforim.db   V52_DB the personal database   BENCH_OUT a log file (BENCH_OUT.json: the rows; BENCH_OUT.hand.json: snippets)
 *   BENCH_SET  "v52" (commentaries of the personal database against official or personal bases, from discoverPairs)
 *              or "official" (commentaries of the official library against their bases, "X על Y")
 *   BENCH_SEED the sample's seed (default "bench-fixround")
 *
 * Agreement with the database's links is NOT accuracy: the links are partial gold (often coarse, sometimes missing, in one case made to the wrong
 * book of the same title). "found" is what the tool suggests; "existing" is what the database already has between those lines; "agree" is a
 * suggestion whose target is a line the database links that source line to. Every number is of this sample only.
 */
const OUT = process.env.BENCH_OUT;
const SET = process.env.BENCH_SET ?? "v52";
const SEED = process.env.BENCH_SEED ?? "bench-fixround";
const log = (s: string) => OUT && appendFileSync(OUT, s + "\n");
const hash = (k: string) => createHash("sha1").update(`${SEED}:${k}`).digest("hex");
const byHash = <T>(xs: readonly T[], key: (x: T) => string) => [...xs].sort((a, b) => (hash(key(a)) < hash(key(b)) ? -1 : 1));

interface Row {
  group: string;
  dep: string;
  base: string;
  selection?: string;
  depLines: number;
  baseLines: number;
  ms: number;
  suggestions: number;
  byConf: Record<string, number>;
  existing: number;
  fresh: number;
  goldLines: number;
  goldTargets: number;
  onGoldLines: number;
  agreeAny: number;
  judged: number;
  correct: number;
  freshCertainOrHigh: number;
  ambiguousBaseCapped: boolean;
  gatedHeadings: boolean;
  errors: number;
}

it.runIf(DB && OUT)("benchmark of the pipeline on a sample with partly linked books", async () => {
  const reg = new SourceRegistry();
  const files = [{ path: "seforim.db", blob: await fileBlob(DB!) }, ...(SET === "v52" && process.env.V52_DB ? [{ path: "v52.db", blob: await fileBlob(process.env.V52_DB) }] : [])];
  const res = await reg.open(files);
  const all = res.sources.flatMap((s) => s.books);
  const library: PlanBook[] = all.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }) }));
  const byTitle = new Map<string, typeof all>();
  for (const b of all) byTitle.set(b.title, [...(byTitle.get(b.title) ?? []), b]);

  type Pair = { dep: (typeof all)[number]; base: (typeof all)[number]; group: string; selection?: string };
  let pairs: Pair[] = [];
  if (SET === "v52") {
    const v52 = res.sources.find((s) => s.info.id !== res.sources[0]!.info.id)!;
    const linked = new Map<string, { total: number; byKey: Record<string, number>; byBook: Record<string, number> }>();
    for (const b of v52.books.filter((x) => x.title.includes(" על "))) {
      const s = await reg.dbLinkSummary(b.key, {});
      if ("byBook" in s) linked.set(b.key, { total: b.title.startsWith("הערות") ? s.in : s.out, byKey: Object.fromEntries(s.byBook.map((x) => [x.bookKey, b.title.startsWith("הערות") ? x.in : x.out])), byBook: Object.fromEntries(s.byBook.map((x) => [x.title, b.title.startsWith("הערות") ? x.in : x.out])) });
    }
    const disc: DiscoveryBook[] = all.map((b) => ({ key: b.key, title: b.title, origin: b.origin, ...(b.lineCount !== undefined && { lineCount: b.lineCount }), ...(linked.get(b.key) && { linkedLines: linked.get(b.key)!.total, linkedTo: linked.get(b.key)!.byBook, linkedKeys: linked.get(b.key)!.byKey }) }));
    const found = discoverPairs(disc, { dependants: (b) => b.origin === "personal" });
    log(`discovery: ${JSON.stringify(found.summary)}`);
    const eligible = found.proposals.filter((p) => (p.dependant.lineCount ?? 0) >= 30 && (p.dependant.lineCount ?? 0) <= 15_000 && (p.base.lineCount ?? 0) <= 60_000 && p.kind === "commentary" && p.confidence !== "low");
    const take = (pred: (p: (typeof eligible)[number]) => boolean, n: number, group: string): Pair[] => byHash(eligible.filter(pred), (p) => p.dependant.key).slice(0, n).map((p) => ({ dep: all.find((b) => b.key === p.dependant.key)!, base: all.find((b) => b.key === p.base.key)!, group, selection: p.selection }));
    pairs = [
      ...take((p) => p.status === "unlinked", 6, "unlinked"),
      ...take((p) => p.status === "partly-linked", 10, "partly-linked"),
      ...take((p) => p.status === "linked", 8, "linked"),
    ];
    log(`eligible ${eligible.length}: unlinked ${eligible.filter((p) => p.status === "unlinked").length}, partly-linked ${eligible.filter((p) => p.status === "partly-linked").length}, linked ${eligible.filter((p) => p.status === "linked").length}; sample ${pairs.length}`);
  } else {
    // the official library: "X על Y" pairs, grouped by how much of the commentary the database links (gold lines / content lines)
    const cand: Pair[] = [];
    for (const dep of all) {
      const at = dep.title.lastIndexOf(" על ");
      if (at < 0 || (dep.lineCount ?? 0) < 60 || (dep.lineCount ?? 0) > 6000) continue;
      const base = (byTitle.get(dep.title.slice(at + 4)) ?? []).find((b) => b.key !== dep.key && (b.lineCount ?? 0) <= 30_000);
      if (base) cand.push({ dep, base, group: "" });
    }
    const picked: Pair[] = [];
    for (const p of byHash(cand, (x) => x.dep.key)) {
      if (picked.length >= 600) break;
      picked.push(p);
    }
    pairs = picked;
    log(`official candidates ${cand.length}; scanned ${pairs.length} for their coverage`);
  }

  const rows: Row[] = [];
  const hand: { dep: string; base: string; depLine: number; baseLine: number; conf: string; depText: string; baseText: string }[] = [];
  const handPool: { depKey: string; baseKey: string; dep: string; base: string; depLine: number; baseLine: number; conf: string }[] = [];
  const wantedOfficial = { complete: 8, partial: 8 };
  for (const p of pairs) {
    const dep = p.dep;
    const base = p.base;
    // the database's own links between the two books (any direction), by the lines of each: the partial gold
    const own = await reg.existingLinks(dep.key, 0, Number.MAX_SAFE_INTEGER);
    const gold = new Map<number, Set<number>>();
    for (const l of own.filter((x) => x.source.book.title === base.title || x.target.book.title === base.title)) {
      const [m, o] = l.source.book.key === dep.key ? [l.source, l.target] : [l.target, l.source];
      for (let x = m.line; x <= (m.end ?? m.line); x++) {
        const s = gold.get(x) ?? new Set<number>();
        for (let y = o.line; y <= (o.end ?? o.line); y++) s.add(y);
        gold.set(x, s);
      }
    }
    let group = p.group;
    if (SET === "official") {
      // the share of the CONTENT lines (not headings, not blank) the database links to this base; headings are a third of some books and are never linked
      const lines = await reg.lines(dep.key, 0, Number.MAX_SAFE_INTEGER);
      const content = lines.filter((l) => l.heading === null && stripTags(l.text).trim() !== "").length;
      const share = content ? gold.size / content : 0;
      group = share >= 0.9 ? "complete" : share < 0.6 && gold.size >= 5 ? "partial" : "";
      if (!group || wantedOfficial[group as "complete" | "partial"] <= 0) continue;
      wantedOfficial[group as "complete" | "partial"]--;
    }
    const plan = planMaxLink({ selected: [dep.key], library, singleEngines: [], choices: { pairs: [{ dependant: dep.title, base: base.title, dependantKey: dep.key, baseKey: base.key }] } });
    const t0 = performance.now();
    const job = await maxlinkJob(reg, plan.steps, { stepBudgetMs: 240_000 }, {});
    const ms = Math.round(performance.now() - t0);
    const db = new Set(job.dbLinkKeys);
    const items: MergeItem[] = job.items.flatMap((i) => (i.result?.suggestions ?? []).map((suggestion) => ({ suggestion, focus: dep.key })));
    const merged = mergeSuggestions(items, { reference: db, candidateBooks: competingTargets(plan.steps), existing: (s) => (db.has(linePairKey(s)) ? "db" : null) }).suggestions;
    const goldTargets = new Set<number>();
    for (const set of gold.values()) for (const y of set) goldTargets.add(y);
    const sides = (s: MergedSuggestion): [LinkSide, LinkSide] => (s.source.book.key === dep.key ? [s.source, s.target] : [s.target, s.source]);
    const byConf: Record<string, number> = {};
    let existing = 0, onGold = 0, agreeAny = 0, judged = 0, correct = 0, freshHigh = 0;
    for (const s of merged) {
      byConf[s.confidence] = (byConf[s.confidence] ?? 0) + 1;
      const isExisting = s.rules.some((x) => x.startsWith("maxlink/exists-"));
      if (isExisting) existing++;
      const [m, o] = sides(s);
      const g = gold.get(m.line);
      const hit = !!g && [...g].some((y) => y >= o.line && y <= (o.end ?? o.line));
      if (g) (onGold++, hit && agreeAny++);
      if (s.confidence === "certain" || s.confidence === "high") {
        if (g) (judged++, hit && correct++);
        if (!isExisting) {
          freshHigh++;
          if (!g) handPool.push({ depKey: dep.key, baseKey: o.book.key, dep: dep.title, base: o.book.title, depLine: m.line, baseLine: o.line, conf: s.confidence });
        }
      }
    }
    const row: Row = {
      group, dep: dep.title, base: base.title, ...(p.selection && { selection: p.selection }), depLines: dep.lineCount ?? 0, baseLines: base.lineCount ?? 0, ms, suggestions: merged.length, byConf, existing, fresh: merged.length - existing,
      goldLines: gold.size, goldTargets: goldTargets.size, onGoldLines: onGold, agreeAny, judged, correct, freshCertainOrHigh: freshHigh,
      ambiguousBaseCapped: plan.steps.some((s) => s.kind === "pair" && s.ambiguousBase === true), gatedHeadings: job.items.some((i) => i.result?.notes.some((n) => n.code === "title-fit/skipped")), errors: job.items.filter((i) => i.error).length,
    };
    rows.push(row);
    log(JSON.stringify(row));
    if (SET === "official" && wantedOfficial.complete <= 0 && wantedOfficial.partial <= 0) break;
  }

  // a few new certain/high suggestions with no database link on their line, as short snippets for a reader (seeded)
  for (const h of byHash(handPool, (x) => `${x.depKey}#${x.depLine}`).slice(0, 12)) {
    const [a] = await reg.lines(h.depKey, h.depLine, h.depLine);
    const [b] = await reg.lines(h.baseKey, h.baseLine, h.baseLine);
    hand.push({ dep: h.dep, base: h.base, depLine: h.depLine, baseLine: h.baseLine, conf: h.conf, depText: stripTags(a?.text ?? "").slice(0, 160), baseText: stripTags(b?.text ?? "").slice(0, 160) });
  }
  writeFileSync(`${OUT}.hand.json`, JSON.stringify(hand, null, 1));
  writeFileSync(`${OUT}.json`, JSON.stringify({ set: SET, seed: SEED, rows, handPool: handPool.length }, null, 1));
  log(`done: ${rows.length} pairs, new certain/high without a database link on their line ${handPool.length}`);
}, 7_200_000);
