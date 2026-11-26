import type { Link, LinkMatched, LinkSide } from "../core/links/model";
import { recordsOf, type Suggestion } from "./automatic";
import { linePairKey } from "./merge";

/*
 * What approving a suggestion writes: its link(s), the one rule for the app (state/suggestions.ts) and for a host
 * without the app (headless/core.ts, the CLI, a plugin). Kept here, in `linking`, so both use the same code: a second
 * copy would drift (ids, the heRef fallback, the matched words a record keeps).
 */

/**
 * The id of the link a suggestion's record is approved as: "auto:<suggestion id>" for its target line, and
 * "auto:<suggestion id>~L<line>" for each further line of a span written a line at a time on a Sefaria side
 * (Suggestion.spanLines). suggestionIdOfLink reads the suggestion back from either.
 */
export function recordLinkId(s: Pick<Suggestion, "id" | "target">, line: number): string {
  return line === s.target.line ? `auto:${s.id}` : `auto:${s.id}~L${line}`;
}

/** The suggestion an "auto:" link was approved from (recordLinkId), or undefined for any other link. */
export function suggestionIdOfLink(linkId: string): string | undefined {
  return linkId.startsWith("auto:") ? linkId.slice(5).replace(/~L\d+$/, "") : undefined;
}

/**
 * The links approving a suggestion makes: one per record (recordsOf). A span written a line at a time skips the records
 * whose two lines are already linked (`existing`, line-pair keys of merge.ts linePairKey); a single record is always written
 * (the caller decides whether the suggestion "exists" before approving it).
 */
export function suggestionLinks(s: Suggestion, existing: ReadonlySet<string> = new Set()): Link[] {
  const records = recordsOf(s);
  return records
    .map((r): Link => {
      const at = recordAt(s, r.line);
      return {
        id: recordLinkId(s, r.line),
        status: "new",
        provenance: "auto",
        source: at.source,
        target: at.target,
        declaredType: s.declaredType,
        // every engine's reference, never blank (B3): the target's title and line otherwise
        heRef2: r.heRef2.trim() ? r.heRef2 : `${at.target.book.title} ${at.target.line + 1}`,
        ...(s.anchor && { anchor: s.anchor }),
        ...matchedOf(s, at),
      };
    })
    .filter((l) => records.length === 1 || !existing.has(linePairKey(l)));
}

/**
 * The matched words an approved record keeps (issue #11). The spans are offsets in the line of the suggestion's own `source`
 * and `target`: a record written on another line of a span (spanLines) keeps only the side whose line is still the one the
 * engine measured.
 */
function matchedOf(s: Suggestion, at: { source: LinkSide; target: LinkSide }): { matched?: LinkMatched } {
  const m = s.matched;
  const source = at.source.line === s.source.line ? m?.source : undefined;
  const target = at.target.line === s.target.line ? m?.target : undefined;
  return source || target ? { matched: { ...(source && { source: { rawStart: source.rawStart, rawEnd: source.rawEnd } }), ...(target && { target: { rawStart: target.rawStart, rawEnd: target.rawEnd } }) } } : {};
}

/** One record of a suggestion: the suggestion with its target moved to that line (recordsOf). */
export function recordAt(s: Suggestion, line: number): { source: LinkSide; target: LinkSide } {
  return line === s.target.line ? s : { source: s.source, target: { book: s.target.book, line } };
}
