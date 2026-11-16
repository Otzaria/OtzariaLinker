import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { Suggestion } from "../../../src/linking/automatic";
import type { QaReport } from "../../../src/linking/qa";
import { filterRows, sortRows, tableRows } from "../../../src/state/links-table";

/*
 * The links table's rows, filters and sort (V5 task 27) — pure, so their cost at 100K links is
 * measured here; the view renders only the rows in view (links-panel.tsx VirtualList).
 */
const book = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
const BOOKS = [book("s1:1", "ארצות החיים"), book("s1:2", "המאיר לארץ על ארצות החיים"), book("s1:3", "ארץ יהודה על ארצות החיים"), book("s1:4", "בראשית")];
const link = (i: number, over: Partial<Link> = {}): Link => ({
  id: `l${i}`,
  status: (["new", "existing", "edited", "deleted"] as const)[i % 4],
  provenance: "file",
  source: { book: BOOKS[i % 2]!, line: (i * 7919) % 50_000 },
  target: { book: BOOKS[2 + (i % 2)]!, line: i % 3000 },
  declaredType: i % 3 ? "commentary" : "reference",
  heRef2: `מקום ${i}`,
  ...over,
});
const sug = (i: number): Suggestion => ({ id: `headings:a:${i}>b:${i}`, engine: "headings", source: { book: BOOKS[0]!, line: i }, target: { book: BOOKS[1]!, line: i }, declaredType: "commentary", heRef2: `ה ${i}`, score: 0.9, confidence: i % 2 ? "certain" : "possible", reasons: [], rules: [], alternatives: [], warnings: [] });

describe("links table rows", () => {
  it("project links, approved automatic links and pending suggestions, with engine, confidence and problems", () => {
    const s = [sug(1), sug(2)];
    const links = [link(0), link(1, { id: `auto:${s[0]!.id}`, provenance: "auto" })];
    const report = { issues: [{ link: links[0]!, category: "format", problem: { code: "x", severity: "warning", message: "" } }, { link: links[0]!, category: "format", problem: { code: "y", severity: "error", message: "" } }] } as unknown as QaReport;
    const rows = tableRows(links, s, (id) => id === s[1]!.id, report);
    expect(rows.map((r) => [r.key, r.status, r.engine, r.confidence, r.problem])).toEqual([
      ["l0", "new", undefined, undefined, "error"],
      [`auto:${s[0]!.id}`, "existing", "headings", "certain", undefined],
      [`s:${s[1]!.id}`, "pending", "headings", "possible", undefined],
    ]);
    expect(filterRows(rows, { engine: "manual" }).map((r) => r.key)).toEqual(["l0"]);
    expect(filterRows(rows, { problem: "warning" }).map((r) => r.key)).toEqual(["l0"]);
    expect(filterRows(rows, { status: "pending", confidence: "possible" })).toHaveLength(1);
    expect(sortRows(rows, "status").map((r) => r.status)).toEqual(["pending", "new", "existing"]);
  });

  it("100K links: rows, a filter and a sort, measured", () => {
    const N = 100_000;
    const links = Array.from({ length: N }, (_, i) => link(i));
    const t0 = performance.now();
    const rows = tableRows(links);
    const t1 = performance.now();
    const f = filterRows(rows, { q: "ארץ", type: "COMMENTARY", status: "existing" });
    const t2 = performance.now();
    const sorted = sortRows(rows, "source");
    const t3 = performance.now();
    const byTarget = sortRows(f, "target", true);
    const t4 = performance.now();
    console.log(`links table, ${N} links: rows ${(t1 - t0).toFixed(0)} ms, filter ${(t2 - t1).toFixed(0)} ms, sort by source ${(t3 - t2).toFixed(0)} ms, filter+sort result (${f.length}) by target ${(t4 - t3).toFixed(0)} ms`);
    expect(f.every((r) => r.status === "existing" && r.type === "COMMENTARY")).toBe(true);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!.link.source;
      const b = sorted[i]!.link.source;
      expect(a.book.title.localeCompare(b.book.title, "he") < 0 || (a.book.title === b.book.title && a.line <= b.line)).toBe(true);
    }
    expect(byTarget[0]!.link.target.book.title).toBe("בראשית");
    expect(t4 - t0).toBeLessThan(5000);
  });
});
