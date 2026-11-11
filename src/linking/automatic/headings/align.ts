import { phraseSimilarity } from "../../../matching/similarity";
import type { PathElement } from "./numbering";

/*
 * Aligns a commentary path with a base unit's path. Levels are matched by KIND and NUMBER, not by
 * heading depth (h2 in one book may be h3 in the other). Order is preserved. A level that one book
 * has and the other does not ("missing headings") may be skipped at a cost; the base unit's LAST
 * element must be aligned, so the target is always the deepest matched level. Commentary levels
 * after the aligned one that the base does have, but not here, make the match PARTIAL.
 */

export interface AlignContext {
  /** numbered kinds present in the base book's headings */
  readonly baseKinds: ReadonlySet<string>;
  readonly baseHasNamed: boolean;
  /** the base numbers units without a kind word (inline "(יב)" lines or bare numeral headings) */
  readonly baseHasUnnamed: boolean;
  readonly commentaryKinds: ReadonlySet<string>;
  readonly commentaryHasNamed: boolean;
}

export type AlignEventCode =
  | "same-number"
  | "inline-number"
  | "same-name"
  | "similar-name"
  | "daf-amud"
  | "daf-both-amudim"
  | "daf-coarse"
  | "skip-commentary"
  | "skip-base"
  | "missing";

export interface AlignEvent {
  readonly code: AlignEventCode;
  readonly c?: PathElement;
  readonly b?: PathElement;
  readonly sim?: number;
}

export interface Alignment {
  /** total cost, ≥ 0 (0 = exact) */
  readonly penalty: number;
  readonly events: readonly AlignEvent[];
  /** commentary levels that could not be placed under the target (0 = full match) */
  readonly missing: number;
}

/** Costs. Every skip pushes a match under the "certain" threshold (0.95) on its own. */
export const COST = {
  inlineNumber: 0.01,
  dafBothAmudim: 0.02,
  dafCoarse: 0.06,
  skip: 0.06,
  /** a named grouping heading ("פרשת נח") when the other book has no named headings at all */
  skipNamedNoise: 0.02,
  firstMissing: 0.3,
  moreMissing: 0.05,
} as const;

const NAME_MIN = 0.85;

function compat(c: PathElement, b: PathElement): { cost: number; ev: AlignEvent } | null {
  if (c.kind === "name" || b.kind === "name") {
    if (c.kind !== "name" || b.kind !== "name") return null;
    const sim = c.name === b.name ? 1 : phraseSimilarity(c.name, b.name);
    if (sim === 1) return { cost: 0, ev: { code: "same-name", c, b } };
    if (sim >= NAME_MIN) return { cost: (1 - sim) * 0.5, ev: { code: "similar-name", c, b, sim } };
    return null;
  }
  if (c.kind === "daf" || b.kind === "daf") {
    if (c.kind !== "daf" || b.kind !== "daf" || c.n !== b.n) return null;
    if (c.amud === b.amud) return { cost: 0, ev: { code: "daf-amud", c, b } };
    if (c.amud === undefined) return { cost: COST.dafBothAmudim, ev: { code: "daf-both-amudim", c, b } };
    if (b.amud === undefined) return { cost: COST.dafCoarse, ev: { code: "daf-coarse", c, b } };
    return null;
  }
  if (c.n !== b.n) return null;
  if (c.kind === b.kind) return { cost: 0, ev: { code: "same-number", c, b } };
  if (c.kind === "?" || b.kind === "?") return { cost: COST.inlineNumber, ev: { code: "inline-number", c, b } };
  return null;
}

/*
 * A numbered commentary level whose kind the base never uses may be skipped ("פרק ראשון" above the
 * daf headings of a Talmud commentary) — but not when the base numbers its units without kind words
 * ("(יב)" lines, bare headings): then "פסוק מ" is expected to land on such a unit, and when it does
 * not exist the match must be PARTIAL, not a quiet skip.
 */
function skipCommentary(c: PathElement, ctx: AlignContext): number | null {
  if (c.kind === "name") return ctx.baseHasNamed ? COST.skip : COST.skipNamedNoise;
  if (c.kind === "?" || ctx.baseHasUnnamed) return null;
  return ctx.baseKinds.has(c.kind) ? null : COST.skip;
}

function skipBase(b: PathElement, ctx: AlignContext): number | null {
  if (b.kind === "name") return ctx.commentaryHasNamed ? COST.skip : COST.skipNamedNoise;
  if (b.kind === "?") return null;
  return ctx.commentaryKinds.has(b.kind) ? null : COST.skip;
}

interface Cell { readonly penalty: number; readonly events: readonly AlignEvent[] }

export function align(P: readonly PathElement[], B: readonly PathElement[], ctx: AlignContext): Alignment | null {
  const n = P.length;
  const m = B.length;
  if (!n || !m) return null;
  // cheap reject: both first levels are mandatory and disagree
  if (skipCommentary(P[0]!, ctx) === null && skipBase(B[0]!, ctx) === null && !compat(P[0]!, B[0]!)) {
    // B[0] would have to align with a later P element, which forces skipping P[0] — impossible
    return null;
  }
  const memo = new Map<number, Cell | null>();
  const best = (i: number, j: number): Cell | null => {
    if (i === 0 && j === 0) return { penalty: 0, events: [] };
    const key = i * 64 + j;
    if (memo.has(key)) return memo.get(key)!;
    let out: Cell | null = null;
    const consider = (prev: Cell | null, cost: number, ev: AlignEvent) => {
      if (!prev) return;
      const p = prev.penalty + cost;
      if (!out || p < out.penalty - 1e-9) out = { penalty: p, events: [...prev.events, ev] };
    };
    if (i > 0 && j > 0) {
      const c = compat(P[i - 1]!, B[j - 1]!);
      if (c) consider(best(i - 1, j - 1), c.cost, c.ev);
    }
    if (i > 0) {
      const s = skipCommentary(P[i - 1]!, ctx);
      if (s !== null) consider(best(i - 1, j), s, { code: "skip-commentary", c: P[i - 1]! });
    }
    if (j > 0) {
      const s = skipBase(B[j - 1]!, ctx);
      if (s !== null) consider(best(i, j - 1), s, { code: "skip-base", b: B[j - 1]! });
    }
    memo.set(key, out);
    return out;
  };
  let result: Alignment | null = null;
  for (let i = 1; i <= n; i++) {
    const c = compat(P[i - 1]!, B[m - 1]!);
    if (!c) continue;
    const before = best(i - 1, m - 1);
    if (!before) continue;
    let penalty = before.penalty + c.cost;
    const events = [...before.events, c.ev];
    let missing = 0;
    for (let k = i; k < n; k++) {
      const s = skipCommentary(P[k]!, ctx);
      if (s !== null && missing === 0) {
        penalty += s;
        events.push({ code: "skip-commentary", c: P[k]! });
      } else {
        penalty += missing === 0 ? COST.firstMissing : COST.moreMissing;
        missing++;
        events.push({ code: "missing", c: P[k]! });
      }
    }
    if (!result || missing < result.missing || (missing === result.missing && penalty < result.penalty - 1e-9)) {
      result = { penalty, events, missing };
    }
  }
  return result;
}
