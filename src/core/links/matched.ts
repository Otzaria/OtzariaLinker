import type { Link, LinkMatched, LinkSide, RawAnchor } from "./model";

/*
 * What an EDITED link keeps of its matched words (issue #11). The spans are offsets into the line each side had when the
 * engine measured it, so a side whose book or line the user changed (or, on the source side, whose anchor the user re-cut,
 * since the source span is the anchor's) names other words now and is dropped; the other side stays.
 */
const sameEnd = (a: LinkSide, b: LinkSide) => a.book.title === b.book.title && a.line === b.line;
const sameAnchor = (a: RawAnchor | undefined, b: RawAnchor | undefined) => a?.rawStart === b?.rawStart && a?.rawEnd === b?.rawEnd;

export function matchedAfterEdit(before: Link, source: LinkSide, target: LinkSide, anchor: RawAnchor | undefined): LinkMatched | undefined {
  const m = before.matched;
  if (!m) return undefined;
  const keepSource = m.source && sameEnd(before.source, source) && sameAnchor(before.anchor, anchor) ? m.source : undefined;
  const keepTarget = m.target && sameEnd(before.target, target) ? m.target : undefined;
  return keepSource || keepTarget ? { ...(keepSource && { source: keepSource }), ...(keepTarget && { target: keepTarget }) } : undefined;
}
