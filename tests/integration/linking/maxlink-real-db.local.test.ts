import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceBook } from "../../../src/core/books";
import { linePairKey, mergeSuggestions, type MergeItem } from "../../../src/linking/merge";
import { planMaxLink } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { maxlinkJob } from "../../../src/workers/maxlink-job";

/*
 * Max-link on the FULL library: plan and run every open commentary on one base book, merge, and
 * compare with the links the database already has. Runs only with a real Otzaria database, opened
 * READ-ONLY (openSync(path, "r"), read slice by slice through a Blob-shaped wrapper; nothing is
 * copied or written — fs.openAsBlob fails on this 4.5GB file with "page truncated"):
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/maxlink-real-db.local.test.ts
 *   MAXLINK_BASES="ברכות,בראשית" picks the base books (default: ברכות); MAXLINK_LOG=<file> logs progress.
 *
 * Sanity signals printed per base: how many merged suggestions the database already has
 * ("exists-db"), and how many CONTRADICT it — a suggestion for a commentary line that the database
 * links to other lines of the same base book (a wrong or a coarser link). Precision of "certain"
 * against the database is asserted loosely: the database itself is not complete.
 */
const path = process.env.OTZARIA_DB;
const LOG = process.env.MAXLINK_LOG;
const log = (line: string) => LOG && appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} ${line}
`);
const BASES = (process.env.MAXLINK_BASES ?? "ברכות").split(",").map((s) => s.trim()).filter(Boolean);

/** Just what the registry and the lazy reader call on a Blob: size, slice, arrayBuffer. */
function fileBlob(fd: number, from = 0, to = fstatSync(fd).size): Blob {
  return {
    size: to - from,
    slice: (a = 0, b = to - from) => fileBlob(fd, from + a, from + Math.min(b, to - from)),
    async arrayBuffer() {
      const buf = new Uint8Array(to - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      return buf.buffer.slice(0, n);
    },
  } as unknown as Blob;
}

describe.runIf(path)("max-link on the real seforim.db (read-only)", () => {
  for (const baseTitle of BASES)
    it(`all open commentaries on "${baseTitle}"`, async () => {
      const mem = { peak: 0 };
      const sample = () => (mem.peak = Math.max(mem.peak, process.memoryUsage().rss));
      const timer = setInterval(sample, 200);
      try {
        const reg = new SourceRegistry();
        const t0 = performance.now();
        const fd = openSync(path!, "r");
        const opened = await reg.open([{ path: "seforim.db", blob: fileBlob(fd) }]);
        const books: SourceBook[] = opened.sources.flatMap((s) => s.books);
        const tOpen = performance.now() - t0;
        const base = books.find((b) => b.title === baseTitle && b.origin !== "personal");
        expect(base, `no book "${baseTitle}"`).toBeTruthy();

        const t1 = performance.now();
        const plan = planMaxLink({ selected: [base!.key], library: books });
        const tPlan = performance.now() - t1;
        const viaDb = plan.steps.filter((s) => s.kind === "pair" && s.relation.via === "base-text").length;

        const t2 = performance.now();
        log(`${baseTitle}: ${plan.steps.length} steps planned in ${Math.round(tPlan)} ms`);
        let lastStep = -1;
        const res = await maxlinkJob(reg, plan.steps, {}, {
          progress: (d, n) => {
            sample();
            const step = Math.floor(d / 1000);
            if (step !== lastStep) log(`${step}/${n / 1000} rss=${Math.round(process.memoryUsage().rss / 2 ** 20)}MB`), (lastStep = step);
          },
        });
        const tJob = performance.now() - t2;

        const byId = new Map(plan.steps.map((s) => [s.id, s]));
        const items: MergeItem[] = res.items.flatMap((it) => (it.result?.suggestions ?? []).map((suggestion) => ({ suggestion, focus: byId.get(it.stepId)!.source.key })));
        const db = new Set(res.dbLinkKeys);
        const t3 = performance.now();
        const merged = mergeSuggestions(items, { reference: db, existing: (s) => (db.has(linePairKey(s)) ? "db" : null) });
        const tMerge = performance.now() - t3;

        // the database's links of each commentary line to this base, to spot contradictions
        const dbByLine = new Map<string, Set<number>>();
        for (const k of res.dbLinkKeys) {
          const [a, b] = k.split("|") as [string, string];
          for (const [x, y] of [[a, b], [b, a]] as const) {
            if (!y.startsWith(`${base!.key}#`)) continue;
            const set = dbByLine.get(x) ?? new Set<number>();
            set.add(Number(y.slice(y.indexOf("#") + 1)));
            dbByLine.set(x, set);
          }
        }
        const contradictions = new Map<string, number>();
        const judge = (level: string, only: (s: (typeof merged.suggestions)[number]) => boolean = () => true, record = true) => {
          const list = merged.suggestions.filter((s) => s.confidence === level && only(s));
          let agree = 0;
          let contradict = 0;
          for (const s of list) {
            const [f, o] = s.source.book.key === s.focus ? [s.source, s.target] : [s.target, s.source];
            if (o.book.key !== base!.key) continue;
            const known = dbByLine.get(`${f.book.key}#${f.line}`);
            if (!known) continue;
            const end = o.end ?? o.line;
            if ([...known].some((l) => l >= o.line && l <= end)) agree++;
            else {
              contradict++;
              if (record) {
                const k = `${level} ${f.book.title} [${s.engines.join("+")}]`;
                contradictions.set(k, (contradictions.get(k) ?? 0) + 1);
              }
            }
          }
          return { n: list.length, judged: agree + contradict, agree, contradict, precision: agree + contradict ? +(agree / (agree + contradict)).toFixed(4) : null };
        };
        // the same judgement on the RAW suggestions of each engine (before the merge), for comparison
        const rawJudge = (engine: string, level: string) => {
          let agree = 0;
          let contradict = 0;
          for (const it of items) {
            const s = it.suggestion;
            if (s.engine !== engine || s.confidence !== level) continue;
            const [f, o] = s.source.book.key === it.focus ? [s.source, s.target] : [s.target, s.source];
            const known = o.book.key === base!.key ? dbByLine.get(`${f.book.key}#${f.line}`) : undefined;
            if (!known) continue;
            const end = o.end ?? o.line;
            if ([...known].some((l) => l >= o.line && l <= end)) agree++;
            else contradict++;
          }
          return `${agree}/${agree + contradict}${agree + contradict ? ` = ${(agree / (agree + contradict)).toFixed(4)}` : ""}`;
        };
        const raw = Object.fromEntries(["headings", "dibur-hamatchil", "footnotes"].map((e) => [e, { certain: rawJudge(e, "certain"), high: rawJudge(e, "high") }]));
        const raisedToCertain = merged.suggestions.filter((s) => s.rules.includes("maxlink/raised") && s.confidence === "certain");
        const report = {
          base: baseTitle,
          books: books.length,
          steps: plan.steps.length,
          stepsViaDbRelation: viaDb,
          commentaries: plan.steps.filter((s) => s.engine === "headings").length,
          failed: res.items.filter((i) => i.error).map((i) => `${i.stepId}: ${i.error}`),
          ms: { open: Math.round(tOpen), plan: Math.round(tPlan), job: Math.round(tJob), merge: Math.round(tMerge) },
          peakRssMB: Math.round(mem.peak / 2 ** 20),
          stats: merged.stats,
          existsDb: merged.suggestions.filter((s) => s.rules.includes("maxlink/exists-db")).length,
          certain: judge("certain"),
          high: judge("high"),
          raisedToCertain: raisedToCertain.length,
          raisedToCertainExistsDb: raisedToCertain.filter((s) => s.rules.includes("maxlink/exists-db")).length,
          rawPerEngine: raw,
          // a precise line inside a coarse range another engine gave: how often is it right, by its level
          insideCertainRange: Object.fromEntries(
            ["certain", "high", "possible"].map((level) => [level, judge(level, (s) => s.rules.includes("maxlink/consistent") && s.members.some((m) => m.suggestion.confidence === "certain" && m.suggestion.engine !== s.engine), false)]),
          ),
          suspectPairs: [...new Set(merged.suggestions.filter((s) => s.rules.includes("maxlink/pair-disagree")).map((s) => (s.source.book.key === s.focus ? s.source.book.title : s.target.book.title)))],
          topContradictions: [...contradictions].sort((a, b) => b[1] - a[1]).slice(0, 10),
          slowestSteps: res.items.map((i) => [i.ms, i.stepId.replace(/\|.*>/, "|"), byId.get(i.stepId)!.source.title] as const).sort((a, b) => b[0] - a[0]).slice(0, 5),
        };
        console.log(JSON.stringify(report, null, 1));
        expect(plan.steps.length).toBeGreaterThan(0);
        if (report.certain.judged >= 50) expect(report.certain.precision!).toBeGreaterThan(0.9);
        closeSync(fd);
      } finally {
        clearInterval(timer);
      }
    }, 3_600_000);
});
