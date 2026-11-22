import type { BookRef } from "../../core/links/model";
import { titleGateAdvice, type TitleFitReport, type TitleFitVerdict } from "../../linking/title-fit";

/** the verdicts are kept per pair of BOOKS (a same-titled book from another source is another pair) */
export const fitKey = (p: { dependant: BookRef; base: BookRef }): string => `${p.dependant.key}>${p.base.key}`;

/** a few pairs are checked at once; a long list is checked a pair at a time, on request */
export const MAX_AUTO = 12;

/**
 * The pairs the plan's screen checks by itself (titleFit reads two whole books per pair): only a short list, never a notes book,
 * and never a pair that has an answer already — including the answer "could not be checked" (null): that one stays until the user
 * asks again with the button, instead of being read again on every change of the plan.
 */
export function pairsToAutoCheck<P extends { dependant: BookRef; base: BookRef; notes: boolean }>(pairs: readonly P[], fits: Readonly<Record<string, unknown>>): P[] {
  if (!pairs.length || pairs.length > MAX_AUTO) return [];
  return pairs.filter((p) => !p.notes && !(fitKey(p) in fits));
}

/** the badge of a title-check verdict: its words and its CSS class (four states: PR 2's linking/title-fit.ts) */
export function fitBadge(verdict: TitleFitVerdict): { text: string; cls: string } {
  const text: Record<TitleFitVerdict, string> = {
    fit: "הכותרות מתאימות",
    partial: "הכותרות מתאימות חלקית",
    undecided: "הבדיקה לא הכריעה אם הכותרות מתאימות",
    unfit: "הכותרות לא מתאימות",
  };
  return { text: text[verdict], cls: `fit-${verdict}` };
}

/**
 * What to tell a user who NAMED the headings method for a pair the check doubts. The check ADVISES (titleGateAdvice): only the two rulings
 * it can back ("no titles", "other titles", with the search complete) say the links would land in the wrong place; every other doubt
 * (undecided, partial, unfit by sparse titles or a cut-short search) is a pair the method runs on anyway, with the reason. Null: no doubt.
 */
export function forcedHeadingsWarning(report: TitleFitReport): string | null {
  const advice = titleGateAdvice(report);
  if (report.verdict === "fit") return null;
  if (advice.action === "skip") return "הכותרות של הפירוש אינן של ספר הבסיס, ושיטת הכותרות תקשר שורות למקום שגוי. בחרתם בה במפורש, ולכן היא תרוץ בלי הבדיקה. בדקו את ההצעות שלה בקפידה.";
  return `הבדיקה מפקפקת בשיטת הכותרות לזוג הזה${report.verdict === "undecided" ? " ולא הכריעה" : ""}: ${advice.why} בחרתם בה במפורש, ולכן היא תרוץ; בדקו את ההצעות שלה בקפידה.`;
}
