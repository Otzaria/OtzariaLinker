import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { ValidationContext } from "../../../src/core/links/validate";
import { recordToLink } from "../../../src/formats/links-json/convert";
import { planExport, zipExport } from "../../../src/formats/links-json/export";
import { parseLinksJson } from "../../../src/formats/links-json/parse";

const book = (title: string): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false });
const A = book("ספר א");
const B = book("ספר ב");
const C = book("ספר ג");
const ctx: ValidationContext = { lineCount: () => 100, line: (_b, i) => ({ exists: true, heading: i === 0 ? 1 : null, anchorLength: 50 }) };
const mk = (id: string, over: Partial<Link>): Link => ({
  id, status: "new", provenance: "user", source: { book: A, line: 3 }, target: { book: B, line: 4 }, declaredType: "reference", heRef2: "ספר ב 5", ...over,
});

const IMPORTED = JSON.stringify([
  { line_index_1: 9, heRef_2: "ב", path_2: "ספר ב.txt", line_index_2: 9, "Conection Type": "commentary" },
  { line_index_1: 2, heRef_2: "ב", path_2: "ספר ב.txt", line_index_2: 2, "Conection Type": "commentary" },
], null, 2);
const imported = parseLinksJson(IMPORTED).records.map((r, i) => recordToLink(r, i, A, () => B, `f${i}`).link);

describe("planExport", () => {
  it("plans one book with 100,000 links in linear time (the library has a 112,905-record file)", () => {
    // regression: grouping by source book copied the list for every link — 259 s for that real file
    const many = Array.from({ length: 100_000 }, (_, i) => mk(`n${i}`, { source: { book: A, line: 1 + (i % 90) }, target: { book: B, line: 1 + ((i * 7) % 90) } }));
    const t0 = performance.now();
    const plan = planExport(many, { lineCount: () => 100, line: () => undefined });
    expect(plan.files).toHaveLength(1);
    expect(plan.written).toHaveLength(100_000);
    expect(performance.now() - t0).toBeLessThan(15_000);
  }, 60_000);
  it("re-exporting an untouched imported file gives back the same bytes", () => {
    const plan = planExport(imported, ctx);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]).toMatchObject({ name: "ספר א_links.json", text: IMPORTED, isNewFile: false });
  });

  it("imported order is kept, new links follow sorted, deletions disappear", () => {
    const links = [
      { ...imported[0]!, status: "deleted" as const },
      imported[1]!,
      mk("n2", { source: { book: A, line: 7 } }),
      mk("n1", { source: { book: A, line: 5 } }),
    ];
    const plan = planExport(links, ctx);
    const recs = JSON.parse(plan.files[0]!.text) as { line_index_1: number }[];
    expect(recs.map((r) => r.line_index_1)).toEqual([2, 6, 8]);
    expect(plan.counts).toMatchObject({ new: 2, kept: 1, deleted: 1, heldBack: 0, files: 1 });
  });

  it("a link with an error is held back with its reasons — never written silently", () => {
    const plan = planExport([mk("bad", { source: { book: A, line: 0 } }), mk("ok", {})], ctx);
    expect(plan.written.map((l) => l.id)).toEqual(["ok"]);
    expect(plan.heldBack[0]!.problems.map((p) => p.code)).toContain("export/heading-line");
  });

  it("a book without an imported file is flagged as a new file (may overwrite the library's)", () => {
    const plan = planExport([mk("n", { source: { book: C, line: 2 } })], ctx);
    expect(plan.files[0]).toMatchObject({ name: "ספר ג_links.json", isNewFile: true });
  });

  it("deleting every imported link of a book writes an empty file, so the deletions reach the library", () => {
    const plan = planExport(imported.map((l) => ({ ...l, status: "deleted" as const })), ctx);
    expect(plan.files).toEqual([expect.objectContaining({ name: "ספר א_links.json", text: "[]", records: 0, isNewFile: false })]);
  });

  it("an untouched imported record with an error is kept (dropping it would delete it from the library)", () => {
    const bad = { ...imported[0]!, source: { ...imported[0]!.source, line: 0 } }; // line 0 is a heading in ctx
    const plan = planExport([bad, imported[1]!], ctx);
    expect(plan.heldBack).toEqual([]);
    expect(plan.warned.map((w) => w.link.id)).toContain(bad.id);
    expect(plan.files[0]!.records).toBe(2);
  });

  it("db links are never written", () => {
    expect(planExport([mk("d", { provenance: "db", status: "existing" })], ctx).files).toEqual([]);
  });

  it("the ZIP is deterministic and lays files out under links/", () => {
    const plan = planExport([...imported, mk("n", { source: { book: C, line: 2 } })], ctx);
    const z1 = zipExport(plan);
    expect(zipExport(plan)).toEqual(z1);
    const files = unzipSync(z1);
    expect(Object.keys(files).sort()).toEqual(["links/ספר א_links.json", "links/ספר ג_links.json"]);
    expect(strFromU8(files["links/ספר א_links.json"]!)).toBe(IMPORTED);
  });
});
