import type { LineCoverage, LinksReading } from "../../linking/coverage";
import type { Provenance } from "../../core/links/model";
import type { SuggestionState } from "../../state/suggestions";

/** A book's links by where they come from (#17, V7 §3.12). `db`: null when the database's read failed or was not made; absent for a text book. */
export interface LinkOrigins {
  db?: number | null;
  imported: number;
  manual: number;
  approved: number;
  pending: number;
  rejected: number;
}

export function linkOrigins(links: readonly { provenance: Provenance; status: string }[], reading: LinksReading | undefined, states: readonly SuggestionState[]): LinkOrigins {
  const o: LinkOrigins = { imported: 0, manual: 0, approved: 0, pending: 0, rejected: 0 };
  if (reading?.state === "counted") o.db = reading.count;
  else if (reading?.state === "none") o.db = 0;
  else if (reading?.state !== "no-database") o.db = null;
  for (const l of links) {
    if (l.status === "deleted" || l.provenance === "db") continue;
    if (l.provenance === "file" || l.provenance === "import") o.imported++;
    else if (l.provenance === "auto") o.approved++;
    else o.manual++;
  }
  for (const s of states) if (s === "pending" || s === "rejected") o[s]++;
  return o;
}

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
