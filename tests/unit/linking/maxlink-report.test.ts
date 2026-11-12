import { describe, expect, it } from "vitest";
import type { BookRef, LinkSide } from "../../../src/core/links/model";
import type { Confidence, EngineId, Suggestion } from "../../../src/linking/automatic";
import { buildReport, reportCsv, type MaxLinkRunInfo } from "../../../src/linking/maxlink-report";
import { mergeSuggestions } from "../../../src/linking/merge";

const C: BookRef = { key: "t:1", title: "ביאור על בראשית", origin: "otzaria" };
const B: BookRef = { key: "d:1", title: "בראשית", origin: "otzaria" };
const X: BookRef = { key: "t:9", title: "חידושים", origin: "otzaria" };
const side = (book: BookRef, line: number): LinkSide => ({ book, line });
const sg = (engine: EngineId, c: number, b: number, confidence: Confidence): Suggestion => ({
  id: `${engine}:${c}>${b}`, engine, source: side(C, c), target: side(B, b), declaredType: "source", heRef2: "", score: 0.9, confidence, reasons: [], rules: [], alternatives: [], warnings: [],
});

describe("buildReport", () => {
  const items = [sg("headings", 1, 1, "certain"), sg("dibur-hamatchil", 1, 1, "high"), sg("headings", 2, 2, "certain"), sg("headings", 3, 3, "possible"), sg("dibur-hamatchil", 3, 5, "high"), sg("headings", 4, 4, "certain")].map((suggestion) => ({ suggestion, focus: C.key }));
  const merged = mergeSuggestions(items);
  const info: MaxLinkRunInfo = {
    scope: "המקור",
    books: [{ book: C, decisions: [], steps: 2 }, { book: X, decisions: [], steps: 0, skipped: "אין לו ספר בסיס" }],
    identified: 1,
    steps: [
      { id: "h", kind: "pair", engine: "headings", source: C, target: B, raw: 4, unmatched: 0, ms: 5, notes: [] },
      { id: "d", kind: "pair", engine: "dibur-hamatchil", source: C, target: B, raw: 2, unmatched: 0, ms: 5, notes: [] },
      { id: "f", kind: "pair", engine: "footnotes", source: X, target: B, raw: 0, unmatched: 0, ms: 1, error: "הקובץ פגום", notes: [] },
    ],
    stats: merged.stats,
    ms: 11,
  };
  const ids = merged.suggestions.map((s) => s.id);
  const state = new Map([[ids[1]!, "approved" as const], [ids[2]!, "rejected" as const], [ids[4]!, "exists" as const]]);
  const rep = buildReport(info, merged.suggestions, (id) => state.get(id));

  it("counts overall, with the live states", () => {
    expect(rep.overall).toMatchObject({ booksChecked: 2, booksIdentified: 1, steps: 3, links: 5, approved: 1, rejected: 1, existing: 1, duplicates: 1, agreements: 1, conflicts: 2, errors: 1 });
    // line 1 (agreement → certain), line 2 certain + approved, line 3 two conflicting (ambiguous): one rejected,
    // one left for review; line 4 certain but already in the library
    expect(rep.overall.certain).toBe(2);
    expect(rep.overall.review).toBe(1);
  });

  it("per book and per engine, with the reasons", () => {
    const c = rep.perBook.find((r) => r.key === C.key)!;
    expect(c).toMatchObject({ steps: 2, links: 5, errors: 0 });
    expect(rep.perBook.find((r) => r.key === X.key)).toMatchObject({ errors: 1, note: "הקובץ פגום" });
    const h = rep.perEngine.find((r) => r.key === "headings")!;
    expect(h).toMatchObject({ steps: 1, links: 4, agreements: 1 });
    expect(rep.perEngine.find((r) => r.key === "footnotes")).toMatchObject({ errors: 1, links: 0 });
  });

  it("CSV: BOM, CRLF, a header and one line per level", () => {
    const csv = reportCsv(rep);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toContain('"ספר / שיטה"');
    expect(lines).toHaveLength(1 + 1 + rep.perBook.length + rep.perEngine.length);
    expect(lines[1]).toContain('"כולל"');
  });
});
