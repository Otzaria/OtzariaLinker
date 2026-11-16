import type { Link, LinkSide } from "./model";

/*
 * The library's weekly sync (LINK_FORMATS §1.8) adds `anchor_src_hash` (sha256 of the Sefaria source
 * line), `anchor_context` (the words around the anchor) and `ref_1`/`ref_2` (the canonical Sefaria
 * place of a side) to records, and later trusts them: it rewrites line_index_N from ref_N, throws
 * "anchor_src_hash without start" (ManualLinksRefresh.kt:713-716), and relocates an anchor by its
 * context. A record whose anchor or line the user changed must not carry the old values (compatibility
 * review B2):
 *   • anchor removed, source side moved, or the source line's text changed → drop the hash and context;
 *   • anchor moved on the same line → drop the context (the hash is of the line, still true);
 *   • a side moved to another line or book while its ref stayed the same → drop that ref. The sync
 *     would otherwise move the line silently BACK to the ref; the export then asks for the new ref
 *     (sefaria/ref2-required) where the side is a Sefaria book.
 * An edition change (relink) keeps the refs: the ref names the same passage, and the sync realigns
 * the line from it.
 */
export const PIPELINE_HASH = "anchor_src_hash";
export const PIPELINE_CONTEXT = "anchor_context";

const sameSide = (a: LinkSide, b: LinkSide): boolean => a.book.title === b.book.title && a.line === b.line;

export interface StaleFields {
  link: Link;
  /** what was dropped: "anchor_src_hash", "anchor_context", "ref_1", "ref_2" */
  dropped: string[];
}

export function dropStalePipelineFields(before: Link, after: Link, opts: { keepRefs?: boolean; sourceTextChanged?: boolean } = {}): StaleFields {
  const dropped: string[] = [];
  const pass = after.passthrough;
  const moved = !sameSide(before.source, after.source);
  const anchorMoved = !!before.anchor && !!after.anchor && (before.anchor.rawStart !== after.anchor.rawStart || before.anchor.rawEnd !== after.anchor.rawEnd);
  const dropHash = !after.anchor || moved || !!opts.sourceTextChanged;
  const dropContext = dropHash || anchorMoved;
  let next: Link = after;
  if (pass && ((dropHash && Object.hasOwn(pass, PIPELINE_HASH)) || (dropContext && Object.hasOwn(pass, PIPELINE_CONTEXT)))) {
    const kept: Record<string, unknown> = {};
    for (const k of Object.keys(pass)) {
      if ((dropHash && k === PIPELINE_HASH) || (dropContext && k === PIPELINE_CONTEXT)) {
        dropped.push(k);
        continue;
      }
      Object.defineProperty(kept, k, { value: pass[k], enumerable: true, writable: true, configurable: true });
    }
    const { passthrough: _p, ...rest } = next;
    next = Object.keys(kept).length ? { ...rest, passthrough: kept } : rest;
  }
  if (!opts.keepRefs) {
    if (moved && before.ref1 !== undefined && next.ref1 === before.ref1) {
      const { ref1: _r, ...rest } = next;
      next = rest;
      dropped.push("ref_1");
    }
    if (!sameSide(before.target, after.target) && before.ref2 !== undefined && next.ref2 === before.ref2) {
      const { ref2: _r, ...rest } = next;
      next = rest;
      dropped.push("ref_2");
    }
  }
  return { link: next, dropped };
}
