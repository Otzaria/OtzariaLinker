import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../../src/core/links/model";
import { personalLinkRows, type PersonalExportContext } from "../../../../src/formats/personal-csv";

/*
 * V7 §1.9 for the personal library's links.csv: every link the export is given is either written (one row or more for its
 * personal line or lines; a row another link already wrote counts as written) or skipped once, with its code and a reason.
 * None falls between, none is both.
 */
const book = (title: string, origin: BookRef["origin"]): BookRef => ({ key: title, title, origin });
const BOOKS = [book("פירוש אישי", "personal"), book("עוד אישי", "personal"), book("ברכות", "otzaria"), book("שבת", "otzaria")];
const ctx: PersonalExportContext = {
  isPersonal: (b) => b.origin === "personal",
  isOfficial: (b) => b.origin === "otzaria",
  contentLine: (_b, line) => line % 4 !== 0,
  positionOf: (s) => (s.book.title === "ברכות" ? `דף ${s.line}` : null),
  lineCount: () => 30,
};

const shape = fc.record({
  s: fc.integer({ min: 0, max: 3 }),
  t: fc.integer({ min: 0, max: 3 }),
  line: fc.integer({ min: 0, max: 35 }),
  end: fc.option(fc.integer({ min: 0, max: 6 }), { nil: undefined }),
  tline: fc.integer({ min: 0, max: 12 }),
  type: fc.constantFrom("commentary", "source", "targum", "reference", " Commentary "),
  status: fc.constantFrom<Link["status"]>("new", "edited", "existing", "deleted"),
});

describe("personal links.csv: every link is written or skipped with a reason (V7 §1.9)", () => {
  it("property: no link falls between, none is both", () => {
    fc.assert(
      fc.property(fc.array(shape, { maxLength: 20 }), (shapes) => {
        const links: Link[] = shapes.map((x, i) => ({
          id: `l${i}`,
          status: x.status,
          provenance: "user",
          source: { book: BOOKS[x.s]!, line: x.line, ...(x.end !== undefined && { end: x.line + x.end }) },
          target: { book: BOOKS[x.t]!, line: x.tline },
          declaredType: x.type,
          heRef2: "",
        }));
        const { rows, skipped } = personalLinkRows(links, ctx);
        const ids = skipped.map((s) => s.link.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const s of skipped) expect(s.text, s.code).toMatch(/[א-ת]/);
        for (const l of links.filter((x) => !ids.includes(x.id))) {
          // written: a row for the personal side's line, to the official side's book
          const mine = ctx.isPersonal(l.source.book) ? l.source : l.target;
          const other = mine === l.source ? l.target : l.source;
          const lines = new Set(rows.filter((r) => r.sourceBook === mine.book.title && r.targetBook === other.book.title).map((r) => r.sourceLine - 1));
          let found = false;
          for (let line = mine.line; line <= (mine.end ?? mine.line); line++) found ||= lines.has(line);
          expect(found, l.id).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });
});
