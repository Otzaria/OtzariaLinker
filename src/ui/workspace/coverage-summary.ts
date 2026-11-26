import type { LineCoverage } from "../../linking/coverage";

/** What the coverage summary sentence needs of a book's coverage (linking/coverage.ts CoverageCounts and its ranges). */
export interface CoverageSummaryInput {
  readonly byBucket: Readonly<Record<LineCoverage, number>>;
  readonly suitable: number;
  readonly unlinked: number;
  readonly unlinkedShare: number;
  readonly ranges: readonly unknown[];
}

const n = (x: number) => x.toLocaleString("he");

/**
 * The one sentence over the coverage counts (coverage-panel.tsx). A line that only a PENDING suggestion points at
 * ("candidate") has no link: it is named apart, never counted with the linked ones (#41 B14 — after "approve all
 * certain" the screen said every line was linked while two had only a pending suggestion).
 */
export function coverageSummary(c: CoverageSummaryInput): string {
  if (c.suitable === 0) return "אין בספר שורות תוכן.";
  const waiting = c.byBucket.candidate;
  const pending = waiting === 0 ? "" : waiting === 1 ? "שורה אחת" : `${n(waiting)} שורות`;
  if (c.unlinked === 0 && waiting === 0)
    return c.suitable === 1 ? "שורת התוכן היחידה של הספר מקושרת או מכוסה בטווח." : `כל ${n(c.suitable)} שורות התוכן של הספר מקושרות או מכוסות בטווח.`;
  if (c.unlinked === 0) return `אין שורה בלי קישור או הצעה, אבל ${pending} עדיין רק עם הצעה ממתינה שלא אושרה — היא אינה קישור עד שתאשרו אותה.`;
  const rest = waiting ? ` ועוד ${pending === "שורה אחת" ? "שורה אחת נוספת" : `${pending} נוספות`} רק עם הצעה ממתינה שלא אושרה.` : "";
  return `${n(c.unlinked)} מתוך ${n(c.suitable)} שורות תוכן (${Math.round(c.unlinkedShare * 100)}%) עדיין בלי קישור, ${c.ranges.length === 1 ? "בקטע אחד" : `ב־${n(c.ranges.length)} קטעים`}.${rest}`;
}
