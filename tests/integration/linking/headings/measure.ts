import type { DbLine } from "../../../../src/database/otzaria/reader";
import type { DbLinkRow } from "../../../../src/database/otzaria/links-reader";
import { headingLevel } from "../../../../src/core/text/html";
import type { EngineBook, EngineResult } from "../../../../src/linking/automatic/types";

/* Shared by the fixture test and the local full-database test: DB lines → EngineBook, and a
   precision/recall measure of the engine's suggestions against the links already in the database. */

export function engineBook(key: string, title: string, lines: readonly DbLine[]): EngineBook {
  return {
    book: { key, title, origin: "otzaria" },
    lines: lines.map((l) => ({ index: l.index, text: l.content, heading: headingLevel(l.content), heRef: l.heRef })),
  };
}

/** commentary line index → base line indexes it is linked to, from links stored in EITHER direction */
export function goldPairs(rows: readonly DbLinkRow[], commentaryId: number, baseId: number): Map<number, Set<number>> {
  const gold = new Map<number, Set<number>>();
  const add = (c: number, b: number, bEnd?: number) => {
    const s = gold.get(c) ?? new Set<number>();
    for (let x = b; x <= (bEnd ?? b); x++) s.add(x);
    gold.set(c, s);
  };
  for (const r of rows) {
    if (r.source.bookId === commentaryId && r.target.bookId === baseId) add(r.source.lineIndex, r.target.lineIndex, r.target.endIndex);
    else if (r.source.bookId === baseId && r.target.bookId === commentaryId) add(r.target.lineIndex, r.source.lineIndex, r.source.endIndex);
  }
  return gold;
}

export interface Measure {
  /** "certain" + "high" suggestions on lines that have a gold link */
  readonly judged: number;
  /** of those, the target (line or range) contains a gold base line */
  readonly correct: number;
  /** of those, a single-line target equal to a gold line */
  readonly exact: number;
  /** gold commentary lines */
  readonly goldLines: number;
  /** gold commentary lines with a correct certain/high suggestion */
  readonly recalled: number;
  readonly certain: { readonly judged: number; readonly correct: number };
  readonly byConfidence: Readonly<Record<string, number>>;
  readonly wrong: readonly string[];
}

export function measure(result: EngineResult, gold: ReadonlyMap<number, ReadonlySet<number>>): Measure {
  let judged = 0, correct = 0, exact = 0, cJudged = 0, cCorrect = 0;
  const recalled = new Set<number>();
  const byConfidence: Record<string, number> = {};
  const wrong: string[] = [];
  for (const s of result.suggestions) {
    byConfidence[s.confidence] = (byConfidence[s.confidence] ?? 0) + 1;
    if (s.confidence !== "certain" && s.confidence !== "high") continue;
    const g = gold.get(s.source.line);
    if (!g) continue;
    judged++;
    const end = s.target.end ?? s.target.line;
    const hit = [...g].some((x) => x >= s.target.line && x <= end);
    if (hit) { correct++; recalled.add(s.source.line); if (end === s.target.line && g.has(s.target.line)) exact++; }
    else if (wrong.length < 15) wrong.push(`${s.source.line} → ${s.target.line}${end !== s.target.line ? `-${end}` : ""} (gold ${[...g].slice(0, 4).join(",")}) ${s.heRef2}`);
    if (s.confidence === "certain") { cJudged++; if (hit) cCorrect++; }
  }
  return { judged, correct, exact, goldLines: gold.size, recalled: recalled.size, certain: { judged: cJudged, correct: cCorrect }, byConfidence, wrong };
}

export const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");

export function summary(name: string, m: Measure): string {
  return `${name}: precision(certain+high) ${pct(m.correct, m.judged)} (${m.correct}/${m.judged}), exact-line ${pct(m.exact, m.judged)}, ` +
    `precision(certain) ${pct(m.certain.correct, m.certain.judged)} (${m.certain.correct}/${m.certain.judged}), ` +
    `recall ${pct(m.recalled, m.goldLines)} (${m.recalled}/${m.goldLines}); by confidence ${JSON.stringify(m.byConfidence)}`;
}
