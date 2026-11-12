import { describe, expect, it } from "vitest";
import { storedForm } from "../../../src/core/links/stored-form";
import type { BookRef } from "../../../src/core/links/model";
import type { Suggestion } from "../../../src/linking/automatic";
import { mergeSuggestions } from "../../../src/linking/merge";

/*
 * Compatibility review B4 (the reviewer's case): headings says "source" (stored base → commentary,
 * COMMENTARY), citations says "reference" on the very same two lines with a higher confidence. The
 * merged record used to be the citation's — REFERENCE, which Otzaria shows in the links panel, not the
 * commentators panel.
 */
const comm: BookRef = { key: "db:1:10", title: "פירוש על ספר", origin: "otzaria", isBaseBook: false };
const base: BookRef = { key: "db:1:20", title: "ספר", origin: "otzaria", isBaseBook: false };
const mk = (o: Partial<Suggestion> & Pick<Suggestion, "id" | "engine" | "declaredType" | "confidence">): Suggestion =>
  ({ reasons: [], rules: [], alternatives: [], warnings: [], score: 0.95, heRef2: "x", source: { book: comm, line: 5 }, target: { book: base, line: 7 }, ...o }) as Suggestion;
const headings = mk({ id: "h1", engine: "headings", declaredType: "source", confidence: "high" });
const citation = mk({ id: "citations:db:1:10:5@3-12>db:1:20:7", engine: "citations", anchor: { rawStart: 3, rawEnd: 12 }, declaredType: "reference", confidence: "certain", score: 1 });

describe("the merged record of a structural and a single-book engine on the same lines", () => {
  for (const conf of ["high", "possible", "certain"] as const)
    it(`is the structural engine's (headings ${conf}, citations certain)`, () => {
      const r = mergeSuggestions([{ suggestion: { ...headings, confidence: conf }, focus: comm.key }, { suggestion: citation, focus: comm.key }]);
      expect(r.suggestions).toHaveLength(1);
      const s = r.suggestions[0]!;
      expect([s.engine, s.declaredType]).toEqual(["headings", "source"]);
      expect(storedForm(s).stored).toBe("COMMENTARY");
      expect(s.engines).toEqual(expect.arrayContaining(["headings", "citations"]));
    });

  it("citations alone still give their own record", () => {
    const r = mergeSuggestions([{ suggestion: citation, focus: comm.key }]);
    expect(r.suggestions[0]!.declaredType).toBe("reference");
  });
});
