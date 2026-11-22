import { parseConnectionType } from "./connection-type";
import type { Link, LinkSide } from "./model";
import { storedForm } from "./stored-form";

/*
 * A SEMANTIC diff of two sets of links (V5 P1-9): the database's links of a book against a
 * `_links.json` of it, two versions of a links file, or the project against a file before export.
 * Not a text diff: field order, spelling of numbers and record order do not matter; what the
 * generator stores does. Every link is first oriented as Otzaria stores it (storedForm: a "source"
 * record flips into COMMENTARY…; a database link already is), books by exact TITLE (equality.ts), and
 * the two sides are paired in rounds, from the strictest relation to the loosest, each link once:
 *
 *   same       identical (when a database is compared: the same stored link and ranges — a database
 *              keeps neither heRef_2 nor the refs, and its anchors are visible offsets)
 *   range      the same stored link, a range end differs
 *   anchor     … the word anchor differs
 *   direction  … the record is written the other way round (source ↔ target, "source" ↔ "commentary")
 *   type       … the declared type differs; or the same two lines with another stored type
 *   details    … only heRef_2 / ref_1 / ref_2 differ
 *   target     the same source line and target book, another target line ("conflict")
 *   moved      the same target line and source book, another source line ("moved to another line")
 *   removed    only in A
 *   added      only in B
 *
 * Linear in the number of links (hash buckets), so 100K-link files compare in well under a second.
 * Pure; the one equality rule (equality.ts) is its "same stored link" level.
 */
export type LinkDiffKind = "same" | "range" | "anchor" | "type" | "direction" | "details" | "target" | "moved" | "removed" | "added";

export const LINK_DIFF_KINDS: readonly LinkDiffKind[] = ["same", "range", "anchor", "type", "direction", "details", "target", "moved", "removed", "added"];

export interface LinkDiffRow {
  readonly kind: LinkDiffKind;
  /** the link in A (absent: added) */
  readonly a?: Link;
  /** the link in B (absent: removed) */
  readonly b?: Link;
  /** "target"/"range": the two ranges still share a line */
  readonly overlap?: boolean;
}

export interface LinkDiff {
  readonly rows: readonly LinkDiffRow[];
  readonly counts: Readonly<Record<LinkDiffKind, number>>;
  /** a database was one of the sides: anchors and the text fields were not compared */
  readonly loose: boolean;
}

/**
 * What a row means for a reader: the six groups the comparison screen filters by. "details" is the same
 * stored link whose only difference is heRef_2 / ref_1 / ref_2 (#15): wording of the target's place, not a
 * disagreement about the link — so it is not a "conflict". Only the GROUP is separate; the row's `kind`
 * stays "details", which `mergeLinkSets` still reports as a disagreement (nothing held is overwritten).
 */
export type LinkDiffGroup = "identical" | "conflict" | "details" | "overlap" | "onlyA" | "onlyB";

export function diffGroup(r: LinkDiffRow): LinkDiffGroup {
  if (r.kind === "same") return "identical";
  if (r.kind === "removed") return "onlyA";
  if (r.kind === "added") return "onlyB";
  if (r.kind === "details") return "details";
  return r.kind === "range" || r.overlap ? "overlap" : "conflict";
}

export type DetailField = "heRef2" | "ref1" | "ref2";

/** The detail fields on which two links differ (an absent ref and an empty one are the same: nothing was written). */
export function detailDifferences(a: Link, b: Link): { field: DetailField; a: string; b: string }[] {
  const out: { field: DetailField; a: string; b: string }[] = [];
  const vals = (l: Link): Record<DetailField, string> => ({ heRef2: l.heRef2 ?? "", ref1: l.ref1 ?? "", ref2: l.ref2 ?? "" });
  const x = vals(a);
  const y = vals(b);
  for (const field of ["heRef2", "ref1", "ref2"] as const) if (x[field] !== y[field]) out.push({ field, a: x[field], b: y[field] });
  return out;
}

interface Oriented {
  readonly l: Link;
  readonly s: LinkSide;
  readonly t: LinkSide;
  /** stored connection type */
  readonly type: string;
  /** written the other way round from how it is stored */
  readonly flipped: boolean;
}

function orient(l: Link): Oriented {
  if (l.provenance === "db") return { l, s: l.source, t: l.target, type: parseConnectionType(l.declaredType).type, flipped: false };
  const f = storedForm(l);
  return { l, s: f.storedSource, t: f.storedTarget, type: f.stored, flipped: f.flipped };
}

const at = (s: LinkSide) => `${s.book.title}#${s.line}`;
const span = (s: LinkSide) => (s.end !== undefined && s.end > s.line ? s.end : s.line);
const anchorKey = (l: Link) => (l.anchor ? `${l.anchor.rawStart}-${l.anchor.rawEnd ?? ""}-${l.anchor.label ?? ""}` : "");
const detailsKey = (l: Link) => `${l.heRef2}\u0001${l.ref1 ?? ""}\u0001${l.ref2 ?? ""}`;
const typeKey = (l: Link) => l.declaredType.trim().toLowerCase();
const overlaps = (x: LinkSide, y: LinkSide) => x.line <= span(y) && y.line <= span(x);
const id = (o: Oriented) => `${at(o.s)}>${at(o.t)}:${o.type}`;
const rangeKey = (o: Oriented) => `${span(o.s)}:${span(o.t)}`;
const strict = (o: Oriented) => `${id(o)}|${rangeKey(o)}|${anchorKey(o.l)}|${typeKey(o.l)}|${o.flipped}|${detailsKey(o.l)}`;

/** Two links with the same key are the same record in every respect the diff compares ("same"). */
export const linkDiffKey = (l: Link): string => strict(orient(l));

/** The diff of B against A. `a` is "before" (the database, the old version), `b` "after". */
export function diffLinks(a: readonly Link[], b: readonly Link[]): LinkDiff {
  const loose = a.some((l) => l.provenance === "db") || b.some((l) => l.provenance === "db");
  const A = a.map(orient);
  const B = b.map(orient);
  const full = (o: Oriented) => (loose ? `${id(o)}|${rangeKey(o)}` : strict(o));
  const rows: LinkDiffRow[] = [];
  const usedA = new Uint8Array(A.length);
  const usedB = new Uint8Array(B.length);

  // one round: bucket the unpaired B by a key, then pair each unpaired A with the first B of its key
  const round = (key: (o: Oriented) => string, kind: (x: Oriented, y: Oriented) => LinkDiffKind) => {
    const buckets = new Map<string, number[]>();
    B.forEach((o, i) => {
      if (usedB[i]) return;
      const k = key(o);
      const list = buckets.get(k);
      if (list) list.push(i);
      else buckets.set(k, [i]);
    });
    A.forEach((x, i) => {
      if (usedA[i]) return;
      const list = buckets.get(key(x));
      if (!list) return;
      let j: number | undefined;
      while ((j = list.shift()) !== undefined && usedB[j]);
      if (j === undefined) return;
      const y = B[j]!;
      usedA[i] = usedB[j] = 1;
      const k = kind(x, y);
      const overlap = (k === "target" && overlaps(x.t, y.t)) || (k === "moved" && overlaps(x.s, y.s));
      rows.push({ kind: k, a: x.l, b: y.l, ...(overlap && { overlap }) });
    });
  };

  round(full, () => "same");
  round(id, (x, y) =>
    rangeKey(x) !== rangeKey(y) ? "range"
    : loose ? "same"
    : anchorKey(x.l) !== anchorKey(y.l) ? "anchor"
    : x.flipped !== y.flipped ? "direction"
    : typeKey(x.l) !== typeKey(y.l) ? "type"
    : "details",
  );
  // the same two lines, either way round: another stored type, or the record turned around
  const pair = (o: Oriented) => {
    const p = at(o.s);
    const q = at(o.t);
    return p < q ? `${p}|${q}` : `${q}|${p}`;
  };
  round(pair, (x, y) => (x.type !== y.type ? "type" : "direction"));
  round((o) => `${at(o.s)}>${o.t.book.title}:${o.type}`, () => "target");
  round((o) => `${o.s.book.title}>${at(o.t)}:${o.type}`, () => "moved");

  A.forEach((x, i) => usedA[i] || rows.push({ kind: "removed", a: x.l }));
  B.forEach((y, j) => usedB[j] || rows.push({ kind: "added", b: y.l }));
  const counts = Object.fromEntries(LINK_DIFF_KINDS.map((k) => [k, 0])) as Record<LinkDiffKind, number>;
  for (const r of rows) counts[r.kind]++;
  return { rows, counts, loose };
}

/** A source of a merge: one links file (or the project's links of the book), with the name its links keep as their origin. */
export interface MergeSource {
  readonly name: string;
  readonly links: readonly Link[];
}

export interface MergeConflict {
  readonly kind: LinkDiffKind;
  /** the link the merge already holds (the preferred source's, or an earlier source's) */
  readonly kept: Link;
  /** the other source's link, which says something else about the same place */
  readonly other: Link;
  readonly origin: string;
}

export interface LinkMerge {
  /** every link of the result, in order (the preferred source's first), each with the sources it was found in */
  readonly entries: readonly { readonly link: Link; readonly origins: readonly string[]; readonly base: boolean }[];
  /** links found again in another source (or twice in one): folded into the link already held */
  readonly duplicates: number;
  readonly conflicts: readonly MergeConflict[];
}

/**
 * Several links files of ONE book merged without loss: the preferred source is the base and every one
 * of its links is kept as it is (also its own duplicates — never dropped silently); each other source,
 * in order, is diffed against what is held so far: a "same" link only adds its origin, a new one is
 * added, and a link that says something else about a place already held (another target, type, range,
 * anchor…) is a CONFLICT — kept out unless `keepConflicts`, so nothing held is ever overwritten.
 */
export function mergeLinkSets(sources: readonly MergeSource[], preferred: number, keepConflicts = false): LinkMerge {
  const base = sources[preferred];
  type Entry = { link: Link; origins: string[]; base: boolean };
  const entries: Entry[] = (base?.links ?? []).map((link) => ({ link, origins: [base!.name], base: true }));
  const byLink = new Map<Link, Entry>(entries.map((e) => [e.link, e]));
  const conflicts: MergeConflict[] = [];
  let duplicates = 0;
  sources.forEach((src, i) => {
    if (i === preferred) return;
    // the same record twice in one source is one link (the base keeps its own duplicates: never dropped)
    const seen = new Set<string>();
    const own = src.links.filter((l) => {
      const k = linkDiffKey(l);
      if (!seen.has(k)) return seen.add(k);
      duplicates++;
      return false;
    });
    const d = diffLinks(
      entries.map((e) => e.link),
      own,
    );
    for (const r of d.rows) {
      if (r.kind === "removed") continue;
      if (r.kind === "same") {
        const e = byLink.get(r.a!)!;
        if (!e.origins.includes(src.name)) e.origins.push(src.name);
        duplicates++;
        continue;
      }
      if (r.kind !== "added") conflicts.push({ kind: r.kind, kept: r.a!, other: r.b!, origin: src.name });
      if (r.kind === "added" || keepConflicts) {
        const e = { link: r.b!, origins: [src.name], base: false };
        entries.push(e);
        byLink.set(e.link, e);
      }
    }
  });
  return { entries, duplicates, conflicts };
}
