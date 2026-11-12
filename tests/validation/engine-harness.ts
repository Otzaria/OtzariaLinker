import type { BookRef, LinkSide } from "../../src/core/links/model";
import type { Confidence, EngineResult, Suggestion } from "../../src/linking/automatic/types";
import type { SourceRegistry } from "../../src/sources/registry";
import { citationsJob } from "../../src/workers/citations-job";
import { engineJob } from "../../src/workers/engine-job";

/*
 * The engines under evaluation (check 5), one entry each. A case says how to run the engine on the
 * real registry and which stored link types of the database are its ground truth. The scoring in
 * engines.test.ts is shared: suggestions are reduced to (source line → target book, line range) in the
 * direction of `role`, and compared with the gold links of the same books.
 *
 * Adding an engine = adding one entry. The citations engine (single-book: one book, the targets are
 * whatever it cites; gold = the database's citation layers LINKER and REFERENCE) runs on a list of
 * books (VALIDATE_CITATION_BOOKS, or the default in engines.test.ts).
 */
export interface EngineRun {
  registry: SourceRegistry;
  /** the commentary (pair engines) or the scanned book (single-book engines) */
  source: BookRef;
  /** the base book; absent for single-book engines */
  target?: BookRef;
}

export interface EngineCase {
  id: string;
  /**
   * "pair": commentary → base pairs of the database (gold: its links between the two books);
   * "single-book": one book, any targets (gold: links stored from it);
   * "library-footnotes": a main book and its "הערות על" companion from the library clone (gold: the
   * library's own footnote records — the database merges those companions into line_note, so it has
   * no links to compare with).
   */
  pairs: "pair" | "single-book" | "library-footnotes";
  /** stored connection types (connection_type.name) that count as ground truth */
  goldTypes: readonly string[];
  run(input: EngineRun): Promise<readonly Suggestion[]>;
}

/** The last full result of a worker-job run (for VALIDATE_DUMP in engines.test.ts: the lines an engine could not place). */
export let lastResult: EngineResult | null = null;
const viaWorkerJob = (engine: "headings" | "dibur-hamatchil" | "footnotes") => async ({ registry, source, target }: EngineRun) => (lastResult = await engineJob(registry, engine, source, target!, {}, {})).suggestions;

export const ENGINE_CASES: readonly EngineCase[] = [
  { id: "headings", pairs: "pair", goldTypes: ["COMMENTARY"], run: viaWorkerJob("headings") },
  { id: "dibur-hamatchil", pairs: "pair", goldTypes: ["COMMENTARY"], run: viaWorkerJob("dibur-hamatchil") },
  { id: "footnotes", pairs: "library-footnotes", goldTypes: ["footnotes", "footnote"], run: async ({ registry, source, target }) => (await engineJob(registry, "footnotes", source, target!, {}, {})).suggestions },
  { id: "citations", pairs: "single-book", goldTypes: ["LINKER", "REFERENCE"], run: async ({ registry, source }) => (await citationsJob(registry, source, {}, {})).suggestions },
];

/** A gold link reduced to the evaluated direction: line of the "from" book → lines of the other book. */
export interface GoldLink {
  from: number;
  toBook: number;
  to: number;
  toEnd: number;
}

export interface Scored {
  suggestions: number;
  byConfidence: Partial<Record<Confidence, { n: number; judged: number; correct: number }>>;
  /** gold "from" lines */
  goldLines: number;
  /** gold lines hit by a correct certain/high suggestion */
  recalledStrong: number;
  /** gold lines hit by a correct suggestion of any confidence */
  recalledAny: number;
  wrong: string[];
}

/**
 * Scores suggestions against gold. `fromKey`: the book whose lines are the "from" side. A suggestion
 * whose stored source is the other book is turned around (dibur-hamatchil writes base → commentary).
 * Judged = the "from" line has gold; correct = the other side (line or range) covers a gold line.
 */
export function score(suggestions: readonly Suggestion[], gold: readonly GoldLink[], fromKey: string, bookIdOf: (key: string) => number): Scored {
  const byLine = new Map<number, GoldLink[]>();
  for (const g of gold) byLine.set(g.from, [...(byLine.get(g.from) ?? []), g]);
  const out: Scored = { suggestions: suggestions.length, byConfidence: {}, goldLines: byLine.size, recalledStrong: 0, recalledAny: 0, wrong: [] };
  const strong = new Set<number>();
  const any = new Set<number>();
  for (const s of suggestions) {
    const [from, to]: [LinkSide, LinkSide] = s.source.book.key === fromKey ? [s.source, s.target] : [s.target, s.source];
    const c = (out.byConfidence[s.confidence] ??= { n: 0, judged: 0, correct: 0 });
    c.n++;
    const g = byLine.get(from.line);
    if (!g) continue;
    c.judged++;
    const toBook = bookIdOf(to.book.key);
    const end = to.end ?? to.line;
    const ok = g.some((x) => x.toBook === toBook && x.to <= end && x.toEnd >= to.line);
    if (ok) {
      c.correct++;
      any.add(from.line);
      if (s.confidence === "certain" || s.confidence === "high") strong.add(from.line);
    } else if (out.wrong.length < 12 && (s.confidence === "certain" || s.confidence === "high"))
      out.wrong.push(`${s.confidence} ${from.line} → ${to.line}${end !== to.line ? `-${end}` : ""} (gold ${g.slice(0, 3).map((x) => `${x.to}${x.toEnd !== x.to ? `-${x.toEnd}` : ""}`).join(",")}) ${s.heRef2}`);
  }
  out.recalledStrong = strong.size;
  out.recalledAny = any.size;
  return out;
}

export type { EngineResult };
