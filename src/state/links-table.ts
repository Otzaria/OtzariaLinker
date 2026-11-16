import { CONNECTION_TYPES, parseConnectionType, type ConnectionType } from "../core/links/connection-type";
import type { Link, LinkStatus } from "../core/links/model";
import { CONFIDENCE_ORDER, type Confidence, type EngineId, type Suggestion } from "../linking/automatic";
import type { QaReport } from "../linking/qa";
import { suggestionIdOfLink } from "./suggestions";

/*
 * The links table (V5 task 27): every project link and every pending suggestion of the current run
 * as one list of rows, filtered and sorted without touching the DOM — pure, so a 100K-link project is
 * measured in tests (tests/unit/state/links-table.test.ts) and the view renders only the visible rows.
 */
export type RowStatus = LinkStatus | "pending";

export interface TableRow {
  /** the link id, or "s:<suggestion id>" for a pending suggestion */
  readonly key: string;
  /** the link, or for a pending suggestion the link approving it would make */
  readonly link: Link;
  readonly status: RowStatus;
  readonly type: ConnectionType;
  /** an automatic link or a suggestion: its engine, confidence and suggestion id */
  readonly engine?: EngineId;
  readonly confidence?: Confidence;
  readonly suggestion?: string;
  /** the worst problem the last quality check found */
  readonly problem?: "error" | "warning";
}

export interface TableFilter {
  readonly q?: string;
  readonly status?: RowStatus;
  readonly source?: string;
  readonly target?: string;
  readonly type?: ConnectionType;
  readonly engine?: EngineId | "manual";
  readonly confidence?: Confidence;
  readonly problem?: "error" | "warning";
  /** e.g. "only the book shown" */
  readonly where?: (l: Link) => boolean;
}

export type SortKey = "source" | "target" | "type" | "status" | "engine" | "confidence";

export function tableRows(links: readonly Link[], suggestions: readonly Suggestion[] = [], pending: (id: string) => boolean = () => false, report?: QaReport | null): TableRow[] {
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  const problems = new Map<string, "error" | "warning">();
  for (const i of report?.issues ?? []) {
    const sev = i.problem.severity;
    if (sev === "error" || (sev === "warning" && !problems.has(i.link.id))) problems.set(i.link.id, sev);
  }
  const rows: TableRow[] = links.map((link) => {
    const sid = suggestionIdOfLink(link.id);
    const s = sid === undefined ? undefined : byId.get(sid);
    const engine = s?.engine ?? (sid?.split(":")[0] as EngineId | undefined);
    const problem = problems.get(link.id);
    return { key: link.id, link, status: link.status, type: parseConnectionType(link.declaredType).type, ...(engine && { engine }), ...(s && { confidence: s.confidence }), ...(sid && { suggestion: sid }), ...(problem && { problem }) };
  });
  for (const s of suggestions)
    if (pending(s.id))
      rows.push({
        key: `s:${s.id}`,
        link: { id: `s:${s.id}`, status: "new", provenance: "auto", source: s.source, target: s.target, declaredType: s.declaredType, heRef2: s.heRef2, ...(s.anchor && { anchor: s.anchor }) },
        status: "pending",
        type: parseConnectionType(s.declaredType).type,
        engine: s.engine,
        confidence: s.confidence,
        suggestion: s.id,
      });
  return rows;
}

export function filterRows(rows: readonly TableRow[], f: TableFilter): TableRow[] {
  const q = f.q?.trim();
  return rows.filter((r) => {
    const l = r.link;
    return (
      (!f.status || r.status === f.status) &&
      (!f.source || l.source.book.title === f.source) &&
      (!f.target || l.target.book.title === f.target) &&
      (!f.type || r.type === f.type) &&
      (!f.engine || (f.engine === "manual" ? !r.engine : r.engine === f.engine)) &&
      (!f.confidence || r.confidence === f.confidence) &&
      (!f.problem || r.problem === f.problem || (f.problem === "warning" && r.problem === "error")) &&
      (!f.where || f.where(l)) &&
      (!q || l.heRef2.includes(q) || l.source.book.title.includes(q) || l.target.book.title.includes(q) || (l.ref1 ?? "").includes(q) || (l.ref2 ?? "").includes(q))
    );
  });
}

const ENGINE_ORDER: readonly EngineId[] = ["headings", "dibur-hamatchil", "footnotes", "citations", "pattern"];
const STATUS_ORDER: readonly RowStatus[] = ["pending", "new", "edited", "existing", "deleted"];

/** A new sorted array. Titles are ranked once (one Intl.Collator), so 100K rows sort by numbers. */
export function sortRows(rows: readonly TableRow[], key: SortKey, desc = false): TableRow[] {
  const titles = [...new Set(rows.flatMap((r) => [r.link.source.book.title, r.link.target.book.title]))].sort(new Intl.Collator("he").compare);
  const rank = new Map(titles.map((t, i) => [t, i]));
  const at = (r: TableRow, side: "source" | "target") => rank.get(r.link[side].book.title)! * 1e7 + r.link[side].line;
  const val: Record<SortKey, (r: TableRow) => number> = {
    source: (r) => at(r, "source"),
    target: (r) => at(r, "target"),
    type: (r) => CONNECTION_TYPES.indexOf(r.type),
    status: (r) => STATUS_ORDER.indexOf(r.status),
    engine: (r) => (r.engine ? ENGINE_ORDER.indexOf(r.engine) + 1 : 0),
    confidence: (r) => (r.confidence ? CONFIDENCE_ORDER.indexOf(r.confidence) : 9),
  };
  const v = val[key];
  const keyed = rows.map((r) => [v(r), at(r, "source"), r] as const);
  keyed.sort((a, b) => (a[0] - b[0]) * (desc ? -1 : 1) || a[1] - b[1]);
  return keyed.map((k) => k[2]);
}
