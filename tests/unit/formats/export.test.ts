import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { ValidationContext } from "../../../src/core/links/validate";
import { recordToLink } from "../../../src/formats/links-json/convert";
import { planExport, zipExport } from "../../../src/formats/links-json/export";
import { parseLinksJson } from "../../../src/formats/links-json/parse";
import { addChanges, commit, deleteChange, editChange, emptyLinkState, restoreChange } from "../../../src/state/history";
import fc from "fast-check";

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

/*
 * Review C1: a book's exported file REPLACES the library's file, so a library record that is not in it
 * is deleted from the library. The plan may leave one out only when the user deleted it, or when the
 * whole file is held back.
 */
describe("an export never drops a library record silently (review C1)", () => {
  // the first record has no heRef_2: an error (export/heref-missing), as old library records have
  const WITH_ERROR = JSON.stringify([
    { line_index_1: 9, heRef_2: "", path_2: "ספר ב.txt", line_index_2: 9, "Conection Type": "commentary" },
    { line_index_1: 2, heRef_2: "ב", path_2: "ספר ב.txt", line_index_2: 2, "Conection Type": "commentary" },
  ], null, 2);
  const library = () => parseLinksJson(WITH_ERROR).records.map((r, i) => recordToLink(r, i, A, () => B, `f${i}`).link);
  const start = () => commit(emptyLinkState(), "ייבוא", addChanges(library()));

  /** library records the plan's files leave out although the user did not delete them and their file is written */
  function dropped(plan: ReturnType<typeof planExport>, links: readonly Link[]): string[] {
    const writtenFiles = new Set(plan.files.map((f) => f.sourceTitle));
    const written = new Set(plan.written.map((l) => l.id));
    return links.filter((l) => l.provenance === "file" && l.status !== "deleted" && writtenFiles.has(l.source.book.title) && !written.has(l.id)).map((l) => l.id);
  }

  it("delete then restore of an untouched record with an error: both records are written", () => {
    let s = start();
    expect(planExport([...s.links.values()], ctx).files[0]!.records).toBe(2);
    s = commit(s, "מחיקה", [deleteChange(s, "f0")!]);
    s = commit(s, "שחזור", [restoreChange(s, "f0")!]);
    const plan = planExport([...s.links.values()], ctx);
    expect(plan.files[0]!.records).toBe(2);
    expect(plan.counts.kept).toBe(2);
    expect(plan.files[0]!.text).toBe(WITH_ERROR);
  });

  it("\"changing\" the type to the type it has: both records are written", () => {
    let s = start();
    s = commit(s, "שינוי סוג", [editChange(s, "f0", { declaredType: "commentary" }), editChange(s, "f1", { declaredType: "commentary" })].filter((c) => !!c));
    const plan = planExport([...s.links.values()], ctx);
    expect(plan.files[0]!.records).toBe(2);
    expect(plan.counts.kept).toBe(2);
  });

  it("an edited library record with an error holds its whole file, with a reason — never a file without it", () => {
    let s = start();
    s = commit(s, "שינוי סוג", [editChange(s, "f0", { declaredType: "reference" })!]);
    const plan = planExport([...s.links.values()], ctx);
    expect(plan.files).toEqual([]);
    expect(plan.heldBack.map((h) => h.link.id).sort()).toEqual(["f0", "f1"]);
    const f1 = plan.heldBack.find((h) => h.link.id === "f1")!;
    expect(f1.problems.some((p) => p.code === "export/file-held" && p.message.includes("תימחק"))).toBe(true);
    // one rule for the export and the quality check: expert mode holds the file too, until the record is fixed
    expect(planExport([...s.links.values()], ctx, { includeErrors: true }).files).toEqual([]);
    s = commit(s, "תיקון", [editChange(s, "f0", { heRef2: "ספר ב 9" })!]);
    expect(planExport([...s.links.values()], ctx).files[0]!.records).toBe(2);
  });

  it("property: whatever the user does to library records, the plan never leaves one out of a written file", () => {
    type Op = ["del" | "restore" | "type" | "heRef" | "same", number, boolean];
    const op = fc.tuple(fc.constantFrom<Op[0]>("del", "restore", "type", "heRef", "same"), fc.integer({ min: 0, max: 1 }), fc.boolean());
    fc.assert(
      fc.property(fc.array(op, { maxLength: 12 }), fc.boolean(), fc.constantFrom<"submission" | "private">("submission", "private"), fc.boolean(), (ops, includeErrors, purpose, withNew) => {
        let s = start();
        for (const [kind, i, flag] of ops) {
          const id = `f${i}`;
          const c =
            kind === "del" ? deleteChange(s, id)
            : kind === "restore" ? restoreChange(s, id)
            : kind === "type" ? editChange(s, id, { declaredType: flag ? "reference" : "commentary" })
            : kind === "heRef" ? editChange(s, id, { heRef2: flag ? "" : "ספר ב 3" })
            : editChange(s, id, { source: s.links.get(id)!.source });
          if (c) s = commit(s, kind, [c]);
        }
        const links = [...s.links.values(), ...(withNew ? [mk("n", { source: { book: A, line: 5 } })] : [])];
        const plan = planExport(links, { ...ctx, purpose }, { includeErrors });
        expect(dropped(plan, links)).toEqual([]);
      }),
    );
  });
});

describe("titles that are not plain file names (security review A4)", () => {
  const evil = ["../../../.github/workflows/x", "..\\..\\Startup\\y", "a\\b", "a/b", "x\u0000y", "x\u0001", "a:b", "..", "ספר."];
  it("unsafeFileTitle names the reason; real titles pass", async () => {
    const { unsafeFileTitle } = await import("../../../src/core/links/titles");
    for (const t of evil) expect(unsafeFileTitle(t), t).not.toBeNull();
    for (const t of ["ספר א", "המאיר לארץ על ארצות החיים", "שו״ת חתם סופר", "Genesis"]) expect(unsafeFileTitle(t), t).toBeNull();
  });

  it("a link whose source title is unsafe is held back — also an untouched import and in expert mode", () => {
    for (const title of evil) {
      const S = book(title);
      const plan = planExport([mk("n", { source: { book: S, line: 3 } }), { ...imported[0]!, source: { ...imported[0]!.source, book: S } }], ctx, { includeErrors: true });
      expect(plan.files, title).toEqual([]);
      expect(plan.heldBack.map((h) => h.problems.some((p) => p.code === "export/unsafe-title")), title).toEqual([true, true]);
    }
  });

  it("zipBundle refuses a path that leaves the folder or repeats", async () => {
    const { zipBundle } = await import("../../../src/formats/links-json/export");
    for (const path of ["links/../../x.json", "/abs.json", "C:/x.json", "links\\x.json", "links//x.json", "a/./b", "x\u0000.json"])
      expect(() => zipBundle([{ path, text: "" }]), path).toThrow(/נתיב לא בטוח/);
    expect(() => zipBundle([{ path: "a.json", text: "" }, { path: "a.json", text: "" }])).toThrow(/אותו נתיב/);
    expect(Object.keys(unzipSync(zipBundle([{ path: "links/ספר א_links.json", text: "[]" }, { path: "_report.txt", text: "" }])))).toEqual(["links/ספר א_links.json", "_report.txt"]);
  });

  it("an alt_toc book with an unsafe title is held back", async () => {
    const { planAltTocExport } = await import("../../../src/formats/alt-toc/export");
    const plan = planAltTocExport([{ title: "../x", origin: "user", structures: [{ key: "k", entries: [{ heTitle: "a", line: 1, level: 0 }] }] } as never], () => ({ lineCount: () => 10, line: () => ({ exists: true, heading: null }) }) as never);
    expect(plan.files).toEqual([]);
    expect(plan.heldBack[0]!.problems[0]!.code).toBe("export/unsafe-title");
  });
});

describe('private use: a "source" link goes into its base\'s file as "commentary"', () => {
  // Otzaria's personal import does not reverse "source" (user_content_importer.dart:806-860), so in the
  // commentary's file it would show as "מקור", never among the base's commentators (validate.ts PRIVATE_TO_BASE)
  const BASE = { ...book("בראשית"), origin: "sefaria" as const, isBaseBook: true };
  const COMM = { ...book("פירוש פלוני על בראשית"), origin: "personal" as const };
  const src = (over: Partial<Link> = {}) =>
    mk("s", { source: { book: COMM, line: 3, end: 5 }, target: { book: BASE, line: 7 }, declaredType: "source", heRef2: "בראשית א, ה", ref2: "Genesis 1:5", ...over });
  const priv: ValidationContext = { ...ctx, purpose: "private" };

  it("is written base → commentary, in the base's file, with the ranges and refs on their own sides", () => {
    const plan = planExport([src()], priv);
    expect(plan.files.map((f) => f.name)).toEqual(["בראשית_links.json"]);
    expect(plan.files[0]!.movedIn).toEqual([{ from: "פירוש פלוני על בראשית", records: 1 }]);
    expect(plan.counts.movedToBase).toBe(1);
    expect(JSON.parse(plan.files[0]!.text)).toEqual([
      { line_index_1: 8, line_index_2: 4, line_index_2_end: 6, heRef_2: "פירוש פלוני על בראשית 4", path_2: "פירוש פלוני על בראשית.txt", "Conection Type": "commentary", ref_1: "Genesis 1:5" },
    ]);
    // the plan lists the user's link as it is (the builder, the report and CSV speak of it)
    expect(plan.written[0]!.declaredType).toBe("source");
    expect(plan.warned[0]?.problems.map((p) => p.code) ?? []).not.toContain("export/private-source-kept");
  });

  it("the anchor on the commentary's words is not carried (a record's anchor is on its source line), as in the library", () => {
    const local = { ...BASE, origin: "otzaria" as const };
    const plan = planExport([src({ target: { book: local, line: 7 }, ref2: undefined, anchor: { rawStart: 2, rawEnd: 6 } })], priv);
    const [rec] = JSON.parse(plan.files[0]!.text) as Record<string, unknown>[];
    expect(rec).not.toHaveProperty("start");
    expect(plan.warned[0]!.problems.map((p) => p.code)).toContain("export/anchor-dropped-flip");
  });

  it("joins the base's own new links in one file, and an imported commentary file that loses all its records is written empty", () => {
    const own = mk("b", { source: { book: BASE, line: 2 }, target: { book: C, line: 2 } });
    const fromFile = { ...src(), id: "f", status: "existing" as const, provenance: "file" as const, fileIndex: 0, keyOrder: ["line_index_1"] };
    const plan = planExport([own, fromFile], priv);
    expect(plan.files.map((f) => [f.name, f.records])).toEqual([["בראשית_links.json", 2], ["פירוש פלוני על בראשית_links.json", 0]]);
  });

  it("the library export is unchanged: the record stays in the commentary's file as \"source\"", () => {
    const plan = planExport([src()], ctx);
    expect(plan.files.map((f) => f.name)).toEqual(["פירוש פלוני על בראשית_links.json"]);
    expect(JSON.parse(plan.files[0]!.text)[0]["Conection Type"]).toBe("source");
    expect(plan.counts.movedToBase).toBe(0);
    expect(plan.files[0]!.movedIn).toBeUndefined();
  });

  it("other types are not moved", () => {
    const plan = planExport([src({ declaredType: "reference" })], priv);
    expect(plan.files.map((f) => f.name)).toEqual(["פירוש פלוני על בראשית_links.json"]);
  });

  it("when the base's file cannot be written, the record stays \"source\" in the commentary's file, with a plain warning", () => {
    const unsafe = { ...BASE, title: "../בראשית" };
    const plan = planExport([src({ target: { book: unsafe, line: 7 } })], priv);
    expect(plan.files.map((f) => f.name)).toEqual(["פירוש פלוני על בראשית_links.json"]);
    const kept = plan.warned[0]!.problems.find((p) => p.code === "export/private-source-kept")!;
    expect(kept.severity).toBe("warning");
    expect(kept.message).toContain('בפאנל הקישורים כ"מקור"');
    expect(kept.message).not.toMatch(/Conection|_links\.json/);
    expect(kept.detail).toContain('"source"');
    // a held base file: the same
    const held = planExport([src(), mk("h", { source: { book: BASE, line: 2 }, target: { book: C, line: 2 }, provenance: "db-copy" })], { ...priv, linksFile: (t) => (t === "בראשית" ? "missing" : "confirmed-new") });
    expect(held.files.map((f) => f.name)).toEqual(["פירוש פלוני על בראשית_links.json"]);
    expect(held.warned.flatMap((w) => w.problems.map((p) => p.code))).toContain("export/private-source-kept");
  });
});
