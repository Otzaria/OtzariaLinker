/*
 * `<book>_links.json` records as the generator decodes them (docs/contracts/LINK_FORMATS.md §1.2).
 * File coordinates are 1-based; the conversion to the 0-based model happens only in convert.ts.
 */
export const CONNECTION_TYPE_KEY = "Conection Type"; // one "n" — the generator ignores "Connection Type"
export const DOUBLE_N_KEY = "Connection Type";

export interface LinksRecord {
  line_index_1: number;
  line_index_2: number;
  heRef_2: string;
  path_2: string;
  connectionType: string;
  line_index_1_end?: number;
  line_index_2_end?: number;
  start?: number;
  end?: number;
  ref_1?: string;
  ref_2?: string;
  /** anchor_src_hash, anchor_context and any unknown key, verbatim */
  extras: Record<string, unknown>;
  /** `"Conection Type": null` in the file (the generator reads it as "", i.e. OTHER) */
  typeNull?: boolean;
  /** key order as it appeared in the file */
  keyOrder: string[];
}

/**
 * Canonical key order — the order the library itself uses (surveyed over its 1,019 live files,
 * otzaria-library@17eb3cc5): the pipeline's insertion order puts ref_1/anchor_* right after
 * line_index_1, ref_2/start after line_index_2, and the type last.
 */
export const CANONICAL_ORDER: readonly string[] = [
  "line_index_1", "line_index_1_end", "ref_1", "anchor_src_hash", "anchor_context",
  "heRef_2", "path_2", "line_index_2", "line_index_2_end", "ref_2", "start", "end", CONNECTION_TYPE_KEY,
];

/** Keys with a typed field in LinksRecord. Everything else — including the pipeline's
 *  anchor_src_hash and anchor_context — goes to `extras` and is written back verbatim. */
export const KNOWN_KEYS: ReadonlySet<string> = new Set(
  CANONICAL_ORDER.filter((k) => k !== "anchor_src_hash" && k !== "anchor_context"),
);
