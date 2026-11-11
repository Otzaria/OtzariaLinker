import { CANONICAL_ORDER, CONNECTION_TYPE_KEY, type LinksRecord } from "./record";

/*
 * Deterministic writer. Byte rules of the library pipeline (LINK_FORMATS §1.8): no BOM, LF only,
 * no trailing blank lines. Layout = JSON.stringify(…, 2), which is what most library files use.
 * An imported record keeps its original key order (minimal diff in a library PR); a new record
 * gets the canonical order. Integers are written as integers.
 */
export function recordToObject(r: LinksRecord): Record<string, unknown> {
  const values: Record<string, unknown> = {
    line_index_1: r.line_index_1,
    line_index_1_end: r.line_index_1_end,
    ref_1: r.ref_1,
    heRef_2: r.heRef_2,
    path_2: r.path_2,
    line_index_2: r.line_index_2,
    line_index_2_end: r.line_index_2_end,
    ref_2: r.ref_2,
    start: r.start,
    end: r.end,
    [CONNECTION_TYPE_KEY]: r.connectionType,
    ...r.extras,
  };
  const present = (k: string) => values[k] !== undefined;
  const order: string[] = [];
  const seen = new Set<string>();
  const take = (k: string) => { if (!seen.has(k) && present(k)) { seen.add(k); order.push(k); } };

  if (r.keyOrder.length) {
    // original order first; a key that is new to this record is inserted at its canonical spot
    for (const k of r.keyOrder) take(k);
    for (const k of CANONICAL_ORDER) {
      if (seen.has(k) || !present(k)) continue;
      const after = CANONICAL_ORDER.slice(0, CANONICAL_ORDER.indexOf(k)).reverse().find((x) => seen.has(x));
      const at = after === undefined ? 0 : order.indexOf(after) + 1;
      order.splice(at, 0, k);
      seen.add(k);
    }
  } else {
    for (const k of CANONICAL_ORDER) take(k);
  }
  for (const k of Object.keys(r.extras)) take(k);

  const out: Record<string, unknown> = {};
  for (const k of order) out[k] = values[k];
  return out;
}

export function serializeLinksJson(records: readonly LinksRecord[]): string {
  return JSON.stringify(records.map(recordToObject), null, 2);
}
