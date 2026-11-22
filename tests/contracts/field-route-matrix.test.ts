import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../src/core/links/model";
import { validateLink, type LineFacts, type ValidationContext } from "../../src/core/links/validate";

/*
 * FIELD × ROUTE, as code (docs/contracts/UPSTREAM_PRS_V6.md §4). One row per rule of a route that REALLY supports the
 * field, taken from the upstream source (cited in `from`), and what OtzariaLinker's validation says about it for the
 * two export purposes: "library" (the default: the library generator and the weekly sync read the file) and "private"
 * (Otzaria's personal import reads it). A field a route ignores (ref_1/ref_2/anchor_* in the generator and in the app)
 * has no row for that route: there is nothing to check. These rows lock what the code does today against the
 * contract; none of them is a bug reproduction, so they pass on first run.
 */
const local = (title: string): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false });
const sefaria = (title: string): BookRef => ({ key: `k:${title}`, title, origin: "sefaria", isBaseBook: true });
const A = local("ספר א");
const B = local("ספר ב");
const SEF = sefaria("בראשית");
const ctx: ValidationContext = { lineCount: () => 100, line: (): LineFacts => ({ exists: true, heading: null, anchorLength: 100 }) };

const link = (over: Partial<Link> = {}): Link => ({
  id: "x", status: "new", provenance: "user",
  source: { book: A, line: 3 }, target: { book: B, line: 4 }, declaredType: "reference", heRef2: "ספר ב ה", ...over,
});
const codes = (l: Link, purpose: "library" | "private") => validateLink(l, { ...ctx, ...(purpose === "private" && { purpose }) }).map((p) => `${p.severity}:${p.code}`);

interface Row {
  field: string;
  route: string;
  from: string;
  purpose: "library" | "private";
  link: Link;
  has?: readonly string[];
  lacks?: readonly string[];
}

const ROWS: readonly Row[] = [
  // start / end: anchors
  { field: "start", route: "generator + sync: local ↔ local", from: "SeforimLibrary #111; ManualLinksRefresh.kt:630-633", purpose: "library", link: link({ anchor: { rawStart: 5 } }), lacks: ["error:sefaria/anchor-into-sefaria", "error:sefaria/anchor-range"] },
  { field: "start", route: "generator: local source → Sefaria target", from: "ManualLinksRefresh.kt:631 (fatal), Generator.kt:2318 (flip drops it)", purpose: "library", link: link({ target: { book: SEF, line: 4 }, ref2: "Genesis 1:1", anchor: { rawStart: 5 } }), has: ["error:sefaria/anchor-into-sefaria"] },
  { field: "start", route: "sync: Sefaria source, ref_1, no anchor_src_hash", from: "ManualLinksRefresh.kt:851 (refresh fails without the hash)", purpose: "library", link: link({ source: { book: SEF, line: 3 }, ref1: "Genesis 1:1", anchor: { rawStart: 5 } }), has: ["error:sefaria/pending-anchor-hash"] },
  { field: "start + anchor_src_hash", route: "sync: Sefaria source with the hash the sync computes", from: "ManualLinksRefresh.kt:837-880; library #1373", purpose: "library", link: link({ source: { book: SEF, line: 3 }, ref1: "Genesis 1:1", anchor: { rawStart: 5 }, passthrough: { anchor_src_hash: "sha256:00" } }), lacks: ["error:sefaria/pending-anchor-hash"] },
  { field: "end (anchor)", route: "sync: any record with a Sefaria side", from: "ManualLinksRefresh.kt:627-629 (unsupported_sefaria_range)", purpose: "library", link: link({ source: { book: SEF, line: 3 }, ref1: "Genesis 1:1", anchor: { rawStart: 5, rawEnd: 9 }, passthrough: { anchor_src_hash: "sha256:00" } }), has: ["error:sefaria/anchor-range"] },
  { field: "end (anchor)", route: "generator + app: local ↔ local", from: "Generator.kt:2406; user_import_parser.dart:535-540", purpose: "private", link: link({ anchor: { rawStart: 5, rawEnd: 9 } }), lacks: ["error:sefaria/anchor-range"] },
  // ranges
  { field: "line_index_2_end", route: "sync: Sefaria target (the sync remaps only the start)", from: "ManualLinksRefresh.kt (never reads *_end)", purpose: "library", link: link({ target: { book: SEF, line: 4, end: 8 }, ref2: "Genesis 1:1" }), has: ["error:sefaria/range-side"] },
  { field: "line_index_2_end", route: "app personal import: same record is accepted", from: "user_import_parser.dart:541-546", purpose: "private", link: link({ target: { book: SEF, line: 4, end: 8 }, ref2: "Genesis 1:1" }), has: ["warning:sefaria/range-side"], lacks: ["error:sefaria/range-side"] },
  { field: "line_index_2_end", route: "generator: local ↔ local range", from: "Generator.kt:2322-2381", purpose: "library", link: link({ target: { book: B, line: 4, end: 8 } }), lacks: ["error:sefaria/range-side", "warning:sefaria/range-side"] },
  // ref_1 / ref_2
  { field: "ref_1", route: "sync: required for a Sefaria source", from: "ManualLinksRefresh.kt:659-668 (new_source_ref_required)", purpose: "library", link: link({ source: { book: SEF, line: 3 } }), has: ["error:sefaria/ref1-required"] },
  { field: "ref_2", route: "sync: required for a Sefaria target", from: "ManualLinksRefresh.kt:648-656; validate_manual_links_refs.py:288-307", purpose: "library", link: link({ target: { book: SEF, line: 4 } }), has: ["error:sefaria/ref2-required"] },
  { field: "ref_2", route: "app personal import ignores it, so a private file may omit it", from: "user_import_parser.dart (no read of ref_2)", purpose: "private", link: link({ target: { book: SEF, line: 4 } }), has: ["warning:sefaria/ref2-required"], lacks: ["error:sefaria/ref2-required"] },
  { field: "ref_2", route: "CI gate: forbidden on a local target", from: "validate_manual_links_refs.py:288-307", purpose: "library", link: link({ ref2: "Genesis 1:1" }), has: ["error:sefaria/ref2-side"] },
  { field: "ref_1 + ref_2", route: "CI gate: not both", from: "validate_manual_links_refs.py:279-280", purpose: "library", link: link({ ref1: "Genesis 1:1", ref2: "Genesis 1:2" }), has: ["error:sefaria/both-refs"] },
  // heRef_2
  { field: "heRef_2", route: "generator: required (a missing one drops the whole file)", from: "Generator.kt:2807-2836; ManualLinksJson.kt:271", purpose: "library", link: link({ heRef2: " " }), has: ["error:export/heref-missing"] },
  { field: "heRef_2", route: "app personal import: kept as targetRef", from: "user_import_parser.dart", purpose: "private", link: link({ heRef2: "" }), has: ["error:export/heref-missing"] },
  // type
  { field: '"Conection Type"', route: "generator: an unknown name is stored OTHER", from: "Link.kt:121-155", purpose: "library", link: link({ declaredType: "sifrei mitsvot" }), has: ["warning:export/unknown-type"] },
  { field: '"Conection Type"', route: "app personal import: an unknown name rejects the file", from: "user_import_parser.dart:548-553", purpose: "private", link: link({ declaredType: "sifrei mitsvot" }), has: ["error:export/unknown-type"] },
  { field: '"Conection Type": linker', route: "generator: skipped, never imported", from: "Generator.kt:2276-2281", purpose: "library", link: link({ declaredType: "linker" }), has: ["error:export/linker"] },
];

describe("field × route: what the validation says for each rule of a route that supports the field", () => {
  for (const r of ROWS) {
    it(`${r.field} — ${r.route} [${r.purpose}] (${r.from})`, () => {
      const got = codes(r.link, r.purpose);
      for (const c of r.has ?? []) expect(got, `expected ${c}`).toContain(c);
      for (const c of r.lacks ?? []) expect(got, `did not expect ${c}`).not.toContain(c);
    });
  }
});
