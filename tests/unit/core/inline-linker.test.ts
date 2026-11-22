import { describe, expect, it } from "vitest";
import { CONNECTION_TYPES, isInlineLinkerType } from "../../../src/core/links/connection-type";
import type { BookRef, Link } from "../../../src/core/links/model";
import { storedForm } from "../../../src/core/links/stored-form";
import { recordToLink } from "../../../src/formats/links-json/convert";
import { planExport } from "../../../src/formats/links-json/export";
import { parseLinksJson } from "../../../src/formats/links-json/parse";
import { validateExport, validateLink, type LineFacts, type ValidationContext } from "../../../src/core/links/validate";
import { qaAction } from "../../../src/linking/qa";

/*
 * #23, the export half. Otzaria's personal import (docs/personal_databases.md in Otzaria/otzaria, dev, commit
 * 6f71470e, issue #4308) knows a connection type the library generator does not: INLINE_LINKER, Hebrew label
 * "ציטוט בטקסט" — a citation that is clickable inside the text. It needs `start` and `end` (> start) on ONE
 * source line. The generator reads an unknown type as OTHER, and the library's `linker` records are skipped,
 * so it is valid for PRIVATE use only (LINK_FORMATS §1.12). The gate is in validateLink, which the export plan
 * and the quality check share (AGENTS §3, last row): the library purpose — the default — rejects it.
 */
const book = (title: string, extra: Partial<BookRef> = {}): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false, ...extra });
const MINE = book("ספר שלי");
const BERACHOT = book("ברכות", { origin: "sefaria", isBaseBook: true });
const ctx: ValidationContext = { lineCount: () => 10, line: (): LineFacts => ({ exists: true, heading: null, anchorLength: 100 }) };
const link = (over: Partial<Link> = {}): Link => ({
  id: "x", status: "new", provenance: "user",
  source: { book: MINE, line: 1 }, target: { book: BERACHOT, line: 2 },
  declaredType: "INLINE_LINKER", heRef2: "ברכות ב.", ref2: "Berakhot 2a:1", anchor: { rawStart: 40, rawEnd: 52 },
  ...over,
});
const errors = (l: Link, purpose?: "submission" | "private") => validateLink(l, { ...ctx, ...(purpose && { purpose }) }).filter((p) => p.severity === "error").map((p) => p.code);

describe("INLINE_LINKER is an app-only type", () => {
  it("is not in the generator's enum: CONNECTION_TYPES (its order is the database's ids) is untouched", () => {
    expect(CONNECTION_TYPES).toHaveLength(24);
    expect((CONNECTION_TYPES as readonly string[]).includes("INLINE_LINKER")).toBe(false);
    expect(CONNECTION_TYPES.at(-1)).toBe("FOOTNOTES");
  });

  it("is recognised as the app spells it: INLINE_LINKER in any case, or the Hebrew label", () => {
    for (const raw of ["INLINE_LINKER", "inline_linker", " Inline Linker ", "ציטוט בטקסט"]) expect(isInlineLinkerType(raw), raw).toBe(true);
    for (const raw of ["linker", "commentary", "", "inline", "ציטוט"]) expect(isInlineLinkerType(raw), raw).toBe(false);
  });

  it("the generator still stores it as OTHER (the library knows nothing of it)", () => {
    expect(storedForm(link())).toMatchObject({ declared: "OTHER", knownType: false, stored: "OTHER" });
  });
});

describe("the library purpose rejects it", () => {
  it("by default (no purpose) and for an explicit submission: an error, with the way out", () => {
    for (const purpose of [undefined, "submission"] as const) {
      expect(errors(link(), purpose), String(purpose)).toContain("export/inline-linker-private-only");
    }
    const p = validateLink(link(), ctx).find((x) => x.code === "export/inline-linker-private-only")!;
    expect(p.message).toContain("שימוש פרטי");
    expect(p.message).toContain("אוצריא"); // says who does not know it
  });

  it("the Hebrew label is held to the same rule", () => {
    expect(errors(link({ declaredType: "ציטוט בטקסט" }), "submission")).toContain("export/inline-linker-private-only");
  });

  it("validateExport, which the export and the quality check share, holds the file back", () => {
    const res = validateExport([link()], ctx);
    expect(res.get("x")!.some((p) => p.code === "export/inline-linker-private-only" && p.severity === "error")).toBe(true);
    expect(validateExport([link()], { ...ctx, purpose: "submission" }).get("x")!.map((p) => p.code)).toContain("export/inline-linker-private-only");
  });

  it("the quality check offers 'for private use' as the remedy, only while the purpose is the library", () => {
    const p = validateLink(link(), ctx).find((x) => x.code === "export/inline-linker-private-only")!;
    expect(qaAction(p, "submission")).toBe("private");
    expect(qaAction(p, "private")).toBeNull();
  });

  it("an imported untouched record is not made to look fine: only the private purpose lifts it", () => {
    expect(errors(link({ provenance: "file", status: "existing" }), "submission")).toContain("export/inline-linker-private-only");
  });
});

describe("the private purpose accepts it, with the app's own rules", () => {
  it("a citation of a Sefaria book with an anchor over several words is valid for private use", () => {
    expect(errors(link(), "private")).toEqual([]);
    // the library's Sefaria rules about anchors do not apply: the offsets are in the user's own source line
    const codes = validateLink(link(), { ...ctx, purpose: "private" }).map((p) => p.code);
    for (const c of ["export/unknown-type", "sefaria/anchor-range", "sefaria/anchor-into-sefaria", "sefaria/pending-anchor-hash", "export/inline-linker-private-only"]) expect(codes).not.toContain(c);
  });

  it("needs start and an end after it (the app: 'ציטוט בטקסט דורש start ו-end גדול ממנו')", () => {
    expect(errors(link({ anchor: undefined }), "private")).toContain("export/inline-linker-anchor");
    expect(errors(link({ anchor: { rawStart: 40 } }), "private")).toContain("export/inline-linker-anchor");
    expect(errors(link({ anchor: { rawStart: 40, rawEnd: 40 } }), "private")).toContain("export/inline-linker-anchor");
    expect(errors(link({ anchor: { rawStart: 40, rawEnd: 39 } }), "private")).toContain("export/inline-linker-anchor");
  });

  it("the citation comes from ONE source line ('מקור הציטוט בטקסט חייב להיות בשורה אחת')", () => {
    expect(errors(link({ source: { book: MINE, line: 1, end: 3 } }), "private")).toContain("export/inline-linker-source-range");
    expect(errors(link({ source: { book: MINE, line: 1, end: 1 } }), "private")).toEqual([]);
  });

  it("the gate is the declared type only: the same link as an ordinary reference keeps every library rule", () => {
    const ref = link({ declaredType: "reference" });
    expect(errors(ref, "submission")).toContain("sefaria/anchor-range");
    expect(errors(ref, "private")).toContain("sefaria/anchor-range"); // an anchor on a Sefaria side stays an error in every purpose
  });
});

/*
 * The record of the app's documentation, verbatim (Otzaria/otzaria docs/personal_databases.md @ dev, "ציטוט בגוף
 * הטקסט בקובץ <ספר>_links.json", commit 6f71470e). It imports, keeps its type string and its start/end, is written
 * back unchanged for private use, and the library purpose holds it back.
 */
describe("the documented record, through the file format and the export plan", () => {
  const DOC = JSON.stringify([{ line_index_1: 12, start: 40, end: 52, path_2: "ברכות.txt", line_index_2: 87, heRef_2: "ברכות ב.", "Conection Type": "INLINE_LINKER" }], null, 2);
  const mine = book("ספר שלי");
  const imported = () => parseLinksJson(DOC).records.map((r, i) => recordToLink(r, i, mine, () => BERACHOT, `f${i}`).link);

  it("parses with its type string and anchor", () => {
    const [l] = imported();
    expect(l).toMatchObject({ declaredType: "INLINE_LINKER", source: { line: 11 }, target: { line: 86 }, anchor: { rawStart: 40, rawEnd: 52 } });
  });

  it("an untouched private re-export is byte-identical; the library export of the same file holds it, and writes nothing for it", () => {
    const ok = planExport(imported(), { ...ctx, purpose: "private", lineCount: () => 1000 });
    expect(ok.files.map((f) => f.text)).toEqual([DOC]);
    const lib = planExport(imported(), { ...ctx, lineCount: () => 1000 });
    expect(lib.heldBack.flatMap((h) => h.problems.map((p) => p.code))).toContain("export/inline-linker-private-only");
    // an untouched imported record is normally written as it was; this error is about the whole file, so it holds it
    expect(lib.files).toEqual([]);
  });

  it("a NEW inline citation is written for private use, held back for the library", () => {
    const fresh = link({ provenance: "user", status: "new", heRef2: "ברכות ב." });
    const priv = planExport([fresh], { ...ctx, purpose: "private", lineCount: () => 1000 });
    expect(priv.heldBack).toEqual([]);
    expect(JSON.parse(priv.files[0]!.text)).toEqual([expect.objectContaining({ "Conection Type": "INLINE_LINKER", start: 40, end: 52, line_index_1: 2, ref_2: "Berakhot 2a:1" })]);
    const lib = planExport([fresh], { ...ctx, lineCount: () => 1000 });
    expect(lib.files).toEqual([]);
    expect(lib.heldBack[0]!.problems.map((p) => p.code)).toContain("export/inline-linker-private-only");
  });
});

/*
 * QA: the library gate must be as wide as the app's own reading of the type. Otzaria's LinkTypes.normalize
 * (lib/models/link_types.dart, dev) trims, upper-cases and turns every run of whitespace or '-' into '_', so
 * "inline-linker", "INLINE-LINKER", a tab or a non-breaking space all mean INLINE_LINKER there. Any spelling that
 * means it is held for the library; for private use only the two documented spellings are written (the rest is an
 * unknown type, which the app's import may reject as a whole).
 */
describe("every spelling of INLINE_LINKER is held for the library", () => {
  const NBSP = String.fromCharCode(0xa0);
  const SPELLINGS = ["inline-linker", "INLINE-LINKER", "Inline Linker", "inline\tlinker", `inline${NBSP}linker`, " inline  linker ", "inline--linker", "InlineLinker", "ציטוט  בטקסט", `ציטוט${NBSP}בטקסט`, "ציטוט\tבטקסט"];
  for (const raw of SPELLINGS) {
    it(JSON.stringify(raw), () => {
      expect(isInlineLinkerType(raw)).toBe(true);
      expect(errors(link({ declaredType: raw }), "submission")).toContain("export/inline-linker-private-only");
      expect(errors(link({ declaredType: raw }))).toContain("export/inline-linker-private-only");
      // private use: written only in the documented spellings; any other is an unknown type (an error for private use)
      expect(errors(link({ declaredType: raw }), "private")).toContain("export/unknown-type");
    });
  }
  it("a type that only contains the words is not one", () => {
    for (const raw of ["inline", "linker", "inline linker x", "not inline linker", "ציטוט"]) expect(isInlineLinkerType(raw), raw).toBe(false);
  });
});
