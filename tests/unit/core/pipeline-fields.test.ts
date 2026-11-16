import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { dropStalePipelineFields } from "../../../src/core/links/pipeline-fields";
import { validateLink } from "../../../src/core/links/validate";
import { linkToRecord } from "../../../src/formats/links-json/convert";
import { serializeLinksJson } from "../../../src/formats/links-json/serialize";
import { planRelink } from "../../../src/linking/relink";

/*
 * Compatibility review B2. A real shape: a Mishnah Berurah record the weekly sync enriched with ref_1,
 * anchor_src_hash and anchor_context (LINK_FORMATS §1.8). After the user removes the anchor or moves a
 * line, the record must not carry the sync's old values.
 */
const MB: BookRef = { key: "db:1:3860", title: "משנה ברורה", origin: "sefaria", isBaseBook: false };
const SH: BookRef = { key: "db:1:9", title: "שער הציון", origin: "otzaria" };
const synced: Link = {
  id: "a", status: "existing", provenance: "file",
  source: { book: MB, line: 4 }, target: { book: SH, line: 2 },
  declaredType: "commentary", heRef2: "שער הציון א", ref1: "Mishnah Berurah,  1:1",
  anchor: { rawStart: 7 },
  passthrough: { anchor_src_hash: "sha256:abc", anchor_context: { before: "x", after: "y" }, note: "kept" },
  keyOrder: ["line_index_1", "ref_1", "anchor_src_hash", "anchor_context", "heRef_2", "path_2", "line_index_2", "start", "Conection Type", "note"],
};

describe("the weekly sync's fields of an edited record", () => {
  it("anchor removed: hash and context go — the sync throws 'anchor_src_hash without start'", () => {
    const { anchor: _a, ...noAnchor } = synced;
    const r = dropStalePipelineFields(synced, { ...noAnchor, status: "edited" });
    expect(r.dropped).toEqual(["anchor_src_hash", "anchor_context"]);
    expect(r.link.passthrough).toEqual({ note: "kept" });
    const text = serializeLinksJson([linkToRecord(r.link)]);
    expect(text).not.toContain("anchor_src_hash");
    expect(text).toContain('"ref_1": "Mishnah Berurah,  1:1"'); // the line did not move
  });

  it("anchor moved on the same line: only the context goes (the hash is of the line)", () => {
    const r = dropStalePipelineFields(synced, { ...synced, anchor: { rawStart: 12 } });
    expect(r.dropped).toEqual(["anchor_context"]);
    expect(r.link.passthrough).toEqual({ anchor_src_hash: "sha256:abc", note: "kept" });
  });

  it("source line moved: hash, context and the unchanged ref_1 go; the export then asks for what is missing", () => {
    const r = dropStalePipelineFields(synced, { ...synced, source: { book: MB, line: 9 } });
    expect(r.dropped).toEqual(["anchor_src_hash", "anchor_context", "ref_1"]);
    expect(r.link.ref1).toBeUndefined();
    const codes = validateLink(r.link, { lineCount: () => 100, line: () => ({ exists: true, heading: null, anchorLength: 40 }) }).map((p) => p.code);
    expect(codes).toContain("sefaria/ref1-required");
    // a ref the user typed for the new line stays
    expect(dropStalePipelineFields(synced, { ...synced, source: { book: MB, line: 9 }, ref1: "Mishnah Berurah,  1:2" }).link.ref1).toBe("Mishnah Berurah,  1:2");
  });

  it("target line moved: an unchanged ref_2 goes", () => {
    const t: Link = { ...synced, source: { book: SH, line: 1 }, target: { book: MB, line: 4 }, ref2: "Mishnah Berurah,  1:1", passthrough: {} };
    const { ref1: _r, ...noRef1 } = t;
    expect(dropStalePipelineFields(noRef1, { ...noRef1, target: { book: MB, line: 5 } }).link.ref2).toBeUndefined();
  });

  it("an edition change keeps the refs and drops the anchor fields when the source line's text changed", () => {
    const old = { ...MB, key: "old" };
    const neu = { ...MB, key: "new" };
    const link = { ...synced, source: { book: old, line: 4 } };
    const plan = planRelink({
      links: [link],
      oldBook: old,
      newBook: neu,
      mapping: { to: Int32Array.from([0, 1, 2, 3, 5, 6]), fate: ["same", "same", "same", "same", "changed", "same"] },
      oldLine: () => "שלום עולם ומלואו",
      newLine: () => "שלום עולם ומלואו כולו",
      isOld: (r) => r.key === "old",
    });
    const moved = plan.items[0]!.moved!;
    expect(moved.ref1).toBe("Mishnah Berurah,  1:1");
    expect(moved.passthrough).toEqual({ note: "kept" });
  });
});
