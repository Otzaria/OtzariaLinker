import type { LinkSide } from "../../../../src/core/links/model";
import type { EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

export interface Measured {
  /** commentary lines that have a commentary link in the database */
  gold: number;
  /** certain + high suggestions on gold lines that hit a linked base line */
  correct: number;
  /** certain + high suggestions on gold lines that miss every linked base line */
  wrong: number;
  /** certain + high suggestions on lines the database does not link (cannot be judged) */
  unjudged: number;
  precision: number;
  recall: number;
  /** per confidence: [right, wrong, unjudged] */
  byConfidence: Record<string, [number, number, number]>;
  misses: string[];
}

/**
 * Precision/recall of the "certain" and "high" suggestions against the existing links:
 * `gold` maps a commentary line to the base lines the database links it to. A suggestion is right
 * when its base side (line or range) covers one of them.
 */
export function measure(
  res: EngineResult,
  gold: ReadonlyMap<number, ReadonlySet<number>>,
  commentaryLine: (s: Suggestion) => number,
  baseSide: (s: Suggestion) => LinkSide,
): Measured {
  let correct = 0;
  let wrong = 0;
  let unjudged = 0;
  const byConfidence: Record<string, [number, number, number]> = {};
  const hit = new Set<number>();
  const misses: string[] = [];
  for (const s of res.suggestions) {
    const c = commentaryLine(s);
    const b = baseSide(s);
    const g = gold.get(c);
    const e = (byConfidence[s.confidence] ??= [0, 0, 0]);
    const ok = g ? [...g].some((x) => x >= b.line && x <= (b.end ?? b.line)) : null;
    if (ok === true) e[0]++;
    else if (ok === false) e[1]++;
    else e[2]++;
    const strong = s.confidence === "certain" || s.confidence === "high";
    if (strong) {
      if (ok === true) {
        correct++;
        hit.add(c);
      } else if (ok === false) wrong++;
      else unjudged++;
    }
    if (ok !== true) misses.push(`${ok === false ? "WRONG" : "NOGOLD"} ${s.confidence} ${s.score} c${c} -> b${b.line}${b.end ? `-${b.end}` : ""} gold=${g ? [...g].join(",") : "-"} ${s.rules.join(",")}`);
  }
  for (const u of res.unmatched) if (gold.has(u.line)) misses.push(`UNMATCHED c${u.line} gold=${[...gold.get(u.line)!].join(",")} ${u.reasons.map((x) => x.code).join(",")} | ${u.reasons[0]?.text ?? ""}`);
  return {
    gold: gold.size,
    correct,
    wrong,
    unjudged,
    precision: correct + wrong ? correct / (correct + wrong) : 1,
    recall: gold.size ? hit.size / gold.size : 1,
    byConfidence,
    misses,
  };
}
