import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { LinksFileState, ValidationContext } from "../../../src/core/links/validate";
import { exportAccounting, planExport } from "../../../src/formats/links-json/export";
import { parseLinksJson } from "../../../src/formats/links-json/parse";
import { buildExportReport } from "../../../src/formats/report/export-report";
import { planSefariaCsv, sefariaCsvOmissions } from "../../../src/formats/sefaria-csv/write";
import { runQa } from "../../../src/linking/qa";

/*
 * V5 P0-5: every link the project holds is written, or held back with a reason the user sees — and the
 * quality check holds back exactly the same links. Many link shapes × every export target (library,
 * private use, expert mode) × the states a book's library file can be in.
 */
const book = (title: string, over: Partial<BookRef> = {}): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false, ...over });
const BOOKS: Record<string, BookRef> = {
  plain: book("ספר א"),
  other: book("ספר ב"),
  base: book("בראשית", { origin: "sefaria", isBaseBook: true }),
  comm: book("פירוש פלוני על בראשית", { origin: "personal" }),
  unsafe: book("../ספר"),
  unknown: book("ספר שאינו", { origin: "unknown" }),
  companion: book("הערות על ספר א"),
  quoted: book('שו"ת פלוני'),
};
const SOURCE_KEYS = ["plain", "comm", "base", "unsafe", "unknown"] as const;
const TARGET_KEYS = Object.keys(BOOKS);

/** lines: 0 is a heading, 1 an empty heading the generator never creates, 2.. text; 60 lines a book */
const LINES = 60;
const ctxFor = (purpose: "submission" | "private", files: Record<string, LinksFileState>, mayHave: boolean): ValidationContext => ({
  lineCount: (b) => (b.origin === "unknown" ? undefined : LINES),
  line: (b, i) => (b.origin === "unknown" || i >= LINES ? undefined : { exists: i !== 1, heading: i <= 1 ? 1 : null, anchorLength: 40, hasNotes: i === 7 }),
  linksFile: (t) => files[t] ?? "missing",
  libraryMayHaveFile: () => mayHave,
  sefariaOwned: (b) => b.origin === "sefaria",
  purpose,
  existing: (l) => (l.source.line === 9 ? "same-link" : l.source.line === 10 ? "same-lines" : null),
});

const shape = fc.record({
  provenance: fc.constantFrom<Link["provenance"]>("file", "user", "auto", "import", "db-copy", "db"),
  status: fc.constantFrom<Link["status"]>("new", "edited", "existing", "deleted"),
  src: fc.constantFrom(...SOURCE_KEYS),
  tgt: fc.constantFrom(...TARGET_KEYS),
  line: fc.constantFrom(0, 1, 2, 3, 7, 9, 10, 59, 60, 200),
  tline: fc.constantFrom(0, 2, 5, 60),
  srcEnd: fc.constantFrom(undefined, 2, 4, 70),
  tgtEnd: fc.constantFrom(undefined, 5, 8, 0),
  type: fc.constantFrom("reference", "commentary", "source", "targum", "linker", "שונה", ""),
  heRef: fc.constantFrom("ספר 1", "", " "),
  ref1: fc.constantFrom(undefined, "Genesis 1:1"),
  ref2: fc.constantFrom(undefined, "Genesis 1:2"),
  anchor: fc.constantFrom(undefined, { rawStart: 2 }, { rawStart: 2, rawEnd: 6 }, { rawStart: 80 }, { rawStart: 5, rawEnd: 3 }),
});
type Shape = typeof shape extends fc.Arbitrary<infer T> ? T : never;

const toLink = (s: Shape, i: number): Link => ({
  id: `l${i}`,
  // a deleted link remembers what it was; a library record is "existing" or "edited"
  status: s.provenance === "file" && s.status === "new" ? "existing" : s.provenance !== "file" && s.status === "existing" ? "new" : s.status,
  provenance: s.provenance,
  source: { book: BOOKS[s.src]!, line: s.line, ...(s.srcEnd !== undefined && { end: s.srcEnd }) },
  target: { book: BOOKS[s.tgt]!, line: s.tline, ...(s.tgtEnd !== undefined && { end: s.tgtEnd }) },
  declaredType: s.type,
  heRef2: s.heRef,
  ...(s.ref1 && { ref1: s.ref1 }),
  ...(s.ref2 && { ref2: s.ref2 }),
  ...(s.anchor && { anchor: s.anchor }),
  ...(s.provenance === "file" && { fileIndex: i }),
});

const fileStates = fc.dictionary(fc.constantFrom(...SOURCE_KEYS.map((k) => BOOKS[k]!.title)), fc.constantFrom<LinksFileState>("imported", "unverified", "confirmed-new", "missing"));

/** every written link is a record of exactly one written file — read back from the files' text */
function recordsInFiles(plan: ReturnType<typeof planExport>): number {
  let n = 0;
  for (const f of plan.files) {
    const parsed = parseLinksJson(f.text);
    expect(parsed.records.length, f.name).toBe(f.records);
    n += parsed.records.length;
  }
  return n;
}

const sorted = (ids: readonly string[]) => [...ids].sort();

describe("export accounting: approved = written + held back with a reason (V5 P0-5)", () => {
  it("property: any mix of links, for every target and file state, adds up — and QA blocks the same links", () => {
    fc.assert(
      fc.property(
        fc.array(shape, { maxLength: 25 }),
        fc.constantFrom<"submission" | "private">("submission", "private"),
        fc.boolean(),
        fileStates,
        fc.boolean(),
        (shapes, purpose, includeErrors, files, mayHave) => {
          const links = shapes.map(toLink);
          const ctx = ctxFor(purpose, files, mayHave);
          const plan = planExport(links, ctx, { includeErrors });
          // planExport throws on a broken account; and the account is checked here on its own too
          expect(exportAccounting(links, plan)).toEqual([]);
          const live = links.filter((l) => l.status !== "deleted" && l.provenance !== "db");
          expect(sorted([...plan.written, ...plan.heldBack.map((h) => h.link)].map((l) => l.id))).toEqual(sorted(live.map((l) => l.id)));
          expect(recordsInFiles(plan)).toBe(plan.written.length);
          for (const h of [...plan.heldBack, ...plan.heldDeletions]) {
            const errors = h.problems.filter((p) => p.severity === "error");
            expect(errors.length, h.link.id).toBeGreaterThan(0);
            for (const e of errors) expect(e.message, e.code).toMatch(/[א-ת]/); // a Hebrew sentence, not a code
          }
          // the quality check (the export's default, not expert mode) blocks exactly what the dialog lists
          if (!includeErrors) {
            const qa = runQa(links, ctx);
            expect(sorted(qa.blocked)).toEqual(sorted(plan.heldBack.map((h) => h.link.id)));
            expect(sorted(qa.deletionsHeld)).toEqual(sorted(plan.heldDeletions.map((h) => h.link.id)));
            expect(qa.checked).toBe(live.length);
            // "no problems, ready to export" is never said over a blocked link or deletion
            if (plan.heldBack.length || plan.heldDeletions.length) expect(qa.bySeverity.error).toBeGreaterThan(0);
          }
          // the report names every link that is not written, each with its reason
          const report = buildExportReport({ date: "d", app: "t", format: "json", links: plan, altToc: { files: [], heldBack: [] }, purpose });
          for (const h of [...plan.heldBack, ...plan.heldDeletions]) expect(report).toContain(h.problems.find((p) => p.severity === "error")!.message);
          // Sefaria CSV: what the CSV leaves out of the written links is listed with its reason
          const omitted = sefariaCsvOmissions(plan);
          const csv = planSefariaCsv(plan.written.filter((l) => !omitted.some((o) => o.link.id === l.id)), () => undefined);
          expect(csv.reduce((n, f) => n + f.rows, 0) + omitted.length).toBe(plan.written.length);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a plan that does not add up is caught", () => {
    const links: Link[] = [toLink({ provenance: "user", status: "new", src: "plain", tgt: "other", line: 3, tline: 5, srcEnd: undefined, tgtEnd: undefined, type: "reference", heRef: "ספר 1", ref1: undefined, ref2: undefined, anchor: undefined }, 0)];
    const plan = planExport(links, ctxFor("submission", {}, false));
    expect(exportAccounting(links, plan)).toEqual([]);
    expect(exportAccounting(links, { ...plan, written: [] })).toEqual(["neither written nor held back: l0", "-1 links accounted for that the project does not hold as live", "0 links written, 1 records in the files"]);
    expect(exportAccounting(links, { ...plan, heldBack: [{ link: links[0]!, problems: [] }] })).toContain("held without a reason: l0");
  });
});

describe("deletions the export cannot deliver are said, not dropped (V5 P0-5)", () => {
  const A = BOOKS.plain!;
  const rec = (i: number, status: Link["status"]): Link => ({ id: `f${i}`, status, provenance: "file", source: { book: A, line: 3 + i }, target: { book: BOOKS.other!, line: 4 }, declaredType: "reference", heRef2: "ספר ב 5", fileIndex: i, ...(status === "deleted" && { restoreStatus: "existing" as const }) });

  it("all records of a file from a saved project deleted: no empty file replaces the library's, and the deletions wait with the reason", () => {
    const links = [rec(0, "deleted"), rec(1, "deleted")];
    const ctx = ctxFor("submission", { [A.title]: "unverified" }, false);
    const plan = planExport(links, ctx);
    // before: an empty "[]" file was written from the unverified snapshot — the library's newer records would be deleted
    expect(plan.files).toEqual([]);
    expect(plan.counts).toMatchObject({ deleted: 0, deletionsHeld: 2 });
    expect(plan.heldDeletions.map((h) => h.problems[0]!.code)).toEqual(["export/file-unverified", "export/file-unverified"]);
    expect(plan.heldDeletions[0]!.problems[0]!.message).toContain("תישאר בספרייה");
    const qa = runQa(links, ctx);
    expect(sorted(qa.deletionsHeld)).toEqual(["f0", "f1"]);
    expect(qa.issues.map((i) => i.category)).toEqual(["library-file", "library-file"]);
    // loaded from the library (or confirmed): the empty file is written, and the deletions are delivered
    const ok = planExport(links, ctxFor("submission", { [A.title]: "imported" }, false));
    expect(ok.files.map((f) => [f.name, f.text.trim()])).toEqual([[`${A.title}_links.json`, "[]"]]);
    expect(ok.counts).toMatchObject({ deleted: 2, deletionsHeld: 0 });
  });

  it("a deletion in a file held for another record's reason is held too, and counted apart from the delivered ones", () => {
    const edited = { ...rec(1, "edited"), heRef2: "" }; // an edited library record with an error holds its file (C1)
    const plan = planExport([rec(0, "deleted"), edited], ctxFor("submission", { [A.title]: "imported" }, false));
    expect(plan.files).toEqual([]);
    expect(plan.counts).toMatchObject({ deleted: 0, deletionsHeld: 1, heldBack: 1 });
    expect(plan.heldDeletions[0]!.problems[0]!).toMatchObject({ code: "export/file-held", severity: "error" });
    expect(plan.heldDeletions[0]!.problems[0]!.message).toContain("נערכה ויש בה שגיאה");
  });
});

describe("the export report and the Sefaria CSV leave nothing out silently", () => {
  it("every held-back link is in the report — not the first 200 and \"… and N more\"", () => {
    const links = Array.from({ length: 250 }, (_, i): Link => ({ id: `n${i}`, status: "new", provenance: "user", source: { book: BOOKS.plain!, line: 0 }, target: { book: BOOKS.other!, line: 2 + (i % 50) }, declaredType: "reference", heRef2: `ספר ב ${i}` }));
    const plan = planExport(links, ctxFor("submission", { [BOOKS.plain!.title]: "confirmed-new" }, false));
    expect(plan.heldBack).toHaveLength(250);
    const report = buildExportReport({ date: "d", app: "t", format: "json", links: plan, altToc: { files: [], heldBack: [] } });
    expect(report).not.toMatch(/… ועוד/);
    for (let i = 0; i < 250; i++) expect(report).toContain(`ספר ב ${i}:`);
  });

  it("an untouched library record on a heading stays in its links file, and the CSV says it is left out", () => {
    const kept: Link = { id: "f0", status: "existing", provenance: "file", source: { book: BOOKS.plain!, line: 0 }, target: { book: BOOKS.other!, line: 4 }, declaredType: "reference", heRef2: "ספר ב 5", fileIndex: 0 };
    const plan = planExport([kept], ctxFor("submission", { [BOOKS.plain!.title]: "imported" }, false));
    expect(plan.written.map((l) => l.id)).toEqual(["f0"]);
    const omitted = sefariaCsvOmissions(plan);
    expect(omitted.map((o) => [o.link.id, o.problems[0]!.code, o.problems[0]!.detail])).toEqual([["f0", "csv/omitted", "export/heading-line"]]);
    const report = buildExportReport({ date: "d", app: "t", format: "sefaria-csv", links: plan, csv: [], altToc: { files: [], heldBack: [] } });
    expect(report).toContain("קישורים שלא נכללו בקובצי ה־CSV (1)");
    expect(report).toContain("לא נכלל בקובץ ה־CSV לספריא");
  });
});
