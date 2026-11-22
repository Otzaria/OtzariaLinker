import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { diffLinks } from "../../../src/core/links/link-diff";
import type { ValidationContext } from "../../../src/core/links/validate";
import { sefariaCsv } from "../../../src/formats/sefaria-csv/write";
import { linkDiffCsv } from "../../../src/formats/report/link-diff-report";
import { jobCsv, type JobRecord } from "../../../src/linking/batch-job";
import { reportCsv, type MaxLinkReport } from "../../../src/linking/maxlink-report";
import { qaCsv, runQa } from "../../../src/linking/qa";

/*
 * QA round 2, D: a title, a heRef or a reason that begins with = + - @ (or a tab / CR) is a formula when a human
 * opens the report in Excel. Every HUMAN-oriented CSV neutralises such a cell with a leading apostrophe.
 * The byte-contract CSV (Sefaria links.csv) is not touched by that. (Quoting a lone CR there was asked for, but the
 * existing v3 byte-parity test sefaria-csv.test.ts pins it unquoted, so it stays as v3 wrote it.)
 */
const EVIL = ["=HYPERLINK(\"http://x\",\"y\")", "+cmd|' /C calc'!A0", "-2+3", "@SUM(1)", "\t=1", "\r=1"];
const bad = (title: string): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false });
const cells = (csv: string) => csv.split("\r\n").join("\n");

describe("human CSV reports neutralise formula cells", () => {
  it("the link comparison report", () => {
    for (const e of EVIL) {
      const l: Link = { id: "a", status: "existing", provenance: "file", source: { book: bad(e), line: 1 }, target: { book: bad("בסיס"), line: 2 }, declaredType: "commentary", heRef2: e };
      const csv = cells(linkDiffCsv(diffLinks([l], []), "א", "ב"));
      expect(csv, e).toContain(`"'${e.replace(/"/g, '""')}"`);
      expect(csv, e).not.toContain(`,"${e.replace(/"/g, '""')}"`);
    }
  });
  it("the per-book job report", () => {
    for (const e of EVIL) {
      const job = { books: [{ title: e, status: "failed", why: e, engines: {}, suggestions: 0, ms: 0 }] } as unknown as JobRecord;
      expect(cells(jobCsv(job)), e).toContain(`"'${e.replace(/"/g, '""')}"`);
    }
  });
  it("the max-link report", () => {
    const zero = { steps: 0, links: 0, certain: 0, review: 0, approved: 0, rejected: 0, existing: 0, duplicates: 0, agreements: 0, conflicts: 0, errors: 0 };
    for (const e of EVIL) {
      const rep = { overall: { ...zero, booksChecked: 0, booksIdentified: 0 }, perBook: [{ ...zero, key: "k", label: e, note: e }], perEngine: [] } as unknown as MaxLinkReport;
      expect(cells(reportCsv(rep)), e).toContain(`"'${e.replace(/"/g, '""')}"`);
    }
  });
  it("the QA report", () => {
    const ctx: ValidationContext = { lineCount: () => 10, line: () => ({ exists: true, heading: null, anchorLength: 20 }) };
    for (const e of EVIL) {
      const l: Link = { id: "a", status: "new", provenance: "user", source: { book: bad(e), line: 2 }, target: { book: bad("בסיס"), line: 3 }, declaredType: "commantary", heRef2: e };
      expect(cells(qaCsv(runQa([l], ctx))), e).toContain(`"'${e.replace(/"/g, '""')}"`);
    }
  });
});

describe("the Sefaria links.csv is a byte contract", () => {
  it("is not neutralised (a leading = stays) and a lone CR stays unquoted, as v3 wrote it", () => {
    expect(sefariaCsv([{ citation1: "=A", citation2: "x\ry", type: "commentary" }])).toBe("Citation 1,Citation 2,Conection Type\n=A,x\ry,commentary");
  });
});
