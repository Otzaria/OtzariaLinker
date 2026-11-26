import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { LinksFileState, ValidationContext } from "../../../src/core/links/validate";
import { EXPORT_OUTCOMES, exportOutcomeCounts, exportOutcomes, planExport, type ExportOutcome } from "../../../src/formats/links-json/export";
import { buildExportReport } from "../../../src/formats/report/export-report";
import { planSefariaCsv, sefariaCsvOmissions } from "../../../src/formats/sefaria-csv/write";

/*
 * V7 §1.9: every link the project holds gets ONE explicit export outcome — written, unchanged (a library record kept as it
 * was), merged (the same stored link as another link of the export: one link in the database), blocked (its book's whole
 * file is held), needs fixing (an error of its own), unsupported (no links file, or not the chosen format, can carry it).
 * No link is silently dropped, none has two outcomes, and the outcomes add up to the plan's own counts — for random link
 * sets, every export target and file state, and the Sefaria CSV as well as the links files.
 */
const book = (title: string, over: Partial<BookRef> = {}): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false, ...over });
const BOOKS: Record<string, BookRef> = {
  plain: book("ספר א"),
  other: book("ספר ב"),
  base: book("בראשית", { origin: "sefaria", isBaseBook: true }),
  comm: book("פירוש פלוני על בראשית", { origin: "personal" }),
  unsafe: book("../ספר"),
  unknown: book("ספר שאינו", { origin: "unknown" }),
};
const SOURCE_KEYS = ["plain", "comm", "base", "unsafe", "unknown"] as const;
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
  tgt: fc.constantFrom(...Object.keys(BOOKS)),
  line: fc.constantFrom(0, 2, 3, 9, 10, 200),
  tline: fc.constantFrom(0, 2, 5, 60),
  type: fc.constantFrom("reference", "commentary", "source", "linker", "INLINE_LINKER", "שונה"),
  heRef: fc.constantFrom("ספר 1", ""),
  ref1: fc.constantFrom(undefined, "Genesis 1:1"),
  anchor: fc.constantFrom(undefined, { rawStart: 2 }, { rawStart: 80 }),
});
type Shape = typeof shape extends fc.Arbitrary<infer T> ? T : never;
const toLink = (s: Shape, i: number): Link => ({
  id: `l${i}`,
  status: s.provenance === "file" && s.status === "new" ? "existing" : s.provenance !== "file" && s.status === "existing" ? "new" : s.status,
  provenance: s.provenance,
  source: { book: BOOKS[s.src]!, line: s.line },
  target: { book: BOOKS[s.tgt]!, line: s.tline },
  declaredType: s.type,
  heRef2: s.heRef,
  ...(s.ref1 && { ref1: s.ref1 }),
  ...(s.anchor && { anchor: s.anchor }),
  ...(s.provenance === "file" && { fileIndex: i }),
});
const fileStates = fc.dictionary(fc.constantFrom(...SOURCE_KEYS.map((k) => BOOKS[k]!.title)), fc.constantFrom<LinksFileState>("imported", "unverified", "confirmed-new", "missing"));

const count = (m: ReadonlyMap<string, ExportOutcome>, o: ExportOutcome) => [...m.values()].filter((x) => x === o).length;

describe("every link gets exactly one export outcome (V7 §1.9)", () => {
  it("property: no link is dropped or counted twice, and the outcomes add up to the plan's counts — links files and Sefaria CSV", () => {
    fc.assert(
      fc.property(fc.array(shape, { maxLength: 25 }), fc.constantFrom<"submission" | "private">("submission", "private"), fc.boolean(), fileStates, fc.boolean(), (shapes, purpose, includeErrors, files, mayHave) => {
        const links = shapes.map(toLink);
        const plan = planExport(links, ctxFor(purpose, files, mayHave), { includeErrors });
        const live = links.filter((l) => l.status !== "deleted" && l.provenance !== "db");
        const json = exportOutcomes(plan);
        expect([...json.keys()].sort()).toEqual(live.map((l) => l.id).sort());
        const c = plan.counts;
        expect(count(json, "written") + count(json, "merged") + count(json, "unchanged")).toBe(plan.written.length);
        expect(count(json, "blocked") + count(json, "needs-fix") + count(json, "unsupported")).toBe(c.heldBack);
        expect(count(json, "unchanged")).toBe(c.kept);
        expect(count(json, "written") + count(json, "merged")).toBe(c.new + c.edited);
        expect(exportOutcomeCounts(json)).toEqual(Object.fromEntries(EXPORT_OUTCOMES.map((o) => [o, count(json, o)])));
        // the Sefaria CSV: what it leaves out is listed once each, and rows + left out = what the links files write
        const omitted = sefariaCsvOmissions(plan);
        const ids = omitted.map((o) => o.link.id);
        expect(new Set(ids).size, `listed twice: ${ids}`).toBe(ids.length);
        const csv = planSefariaCsv(plan.written.filter((l) => !ids.includes(l.id)), () => undefined);
        expect(csv.reduce((n, f) => n + f.rows, 0) + omitted.length).toBe(plan.written.length);
        const asCsv = exportOutcomes(plan, ids);
        expect([...asCsv.keys()].sort()).toEqual(live.map((l) => l.id).sort());
        expect(count(asCsv, "unsupported")).toBe(count(json, "unsupported") + omitted.length);
      }),
      { numRuns: 400 },
    );
  });

  it("each outcome on a hand-made export", () => {
    const A = BOOKS.plain!;
    const B = BOOKS.other!;
    const l = (id: string, over: Partial<Link>): Link => ({ id, status: "new", provenance: "user", source: { book: A, line: 3 }, target: { book: B, line: 5 }, declaredType: "reference", heRef2: "ספר ב 6", ...over });
    const links = [
      l("written", {}),
      l("merged", { source: { book: A, line: 3 }, target: { book: B, line: 5 } }), // the same stored link as "written"
      l("unchanged", { status: "existing", provenance: "file", fileIndex: 0, source: { book: A, line: 4 } }),
      l("needs-fix", { source: { book: A, line: 6 }, heRef2: "" }),
      l("unsupported", { source: { book: A, line: 8 }, declaredType: "linker" }),
      l("blocked", { source: { book: BOOKS.unsafe!, line: 3 } }),
    ];
    const plan = planExport(links, ctxFor("submission", { [A.title]: "imported" }, false));
    expect(Object.fromEntries(exportOutcomes(plan))).toEqual({ written: "written", merged: "merged", unchanged: "unchanged", "needs-fix": "needs-fix", unsupported: "unsupported", blocked: "blocked" });
    // the report says each of them in numbers
    const report = buildExportReport({ date: "d", app: "t", format: "json", links: plan, altToc: { files: [], heldBack: [] } });
    const line = (label: string) => report.split("\n").find((x) => x.trimStart().startsWith(label));
    expect(["קישורים שנכתבו", "מהם חדשים", "מהם נשמרו כמו שהם", "מהם יאוחדו במסד עם קישור זהה", "לא ייוצאו (שגיאה)", "מהם צריכים תיקון", "מהם מחכים לקובץ של הספר", "מהם שקובץ קישורים לא יכול לשאת"].map((x) => line(x)?.split(" ").at(-1))).toEqual(["3", "2", "1", "1", "3", "1", "1", "1"]);
  });
});
