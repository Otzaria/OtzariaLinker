import { CONFIDENCE_ORDER, type Suggestion } from "./types";

/*
 * Orders for the suggestions list (issue 8). Pure and deterministic: every comparison ends at the suggestion's
 * position in the input, i.e. the engine's own order (book order), so equal keys never reshuffle between renders.
 * The list the engine returned is never changed: `run.result.suggestions` is what merge, rejection keys and the
 * stored runs read; only the view is ordered.
 */
export type SuggestionSort = "book" | "worst" | "best" | "type" | "engine" | "target" | "state";

export const SUGGESTION_SORTS: readonly { id: SuggestionSort; label: string }[] = [
  { id: "book", label: "לפי הסדר בספר" },
  { id: "worst", label: "מהחלשה לחזקה" },
  { id: "best", label: "מהחזקה לחלשה" },
  { id: "type", label: "לפי סוג הקשר" },
  { id: "engine", label: "לפי שיטה" },
  { id: "target", label: "לפי ספר היעד" },
  { id: "state", label: "לפי מצב ההחלטה" },
];

const rank = (s: Suggestion): number => CONFIDENCE_ORDER.indexOf(s.confidence);
const text = (a: string, b: string): number => a.localeCompare(b, "he");

/**
 * `stateRank` gives a suggestion's decision state as a number (0 = pending first); the state lives in the state
 * layer, so the caller supplies it. Without it "state" keeps the book order.
 */
export function sortSuggestions(list: readonly Suggestion[], order: SuggestionSort, stateRank?: (s: Suggestion) => number): readonly Suggestion[] {
  if (order === "book") return list;
  const cmp: Record<Exclude<SuggestionSort, "book">, (a: Suggestion, b: Suggestion) => number> = {
    // the weakest level first (ambiguous, possible, …), the lower score first inside a level
    worst: (a, b) => rank(b) - rank(a) || a.score - b.score,
    best: (a, b) => rank(a) - rank(b) || b.score - a.score,
    type: (a, b) => text(a.declaredType, b.declaredType),
    engine: (a, b) => text(a.engine, b.engine),
    target: (a, b) => text(a.target.book.title, b.target.book.title) || a.target.line - b.target.line,
    state: (a, b) => (stateRank ? stateRank(a) - stateRank(b) : 0),
  };
  const f = cmp[order];
  return list
    .map((s, i) => [s, i] as const)
    .sort(([a, i], [b, j]) => f(a, b) || i - j)
    .map(([s]) => s);
}
