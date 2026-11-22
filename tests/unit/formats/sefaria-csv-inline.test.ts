import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { planSefariaCsv, sefariaCsvOmissions } from "../../../src/formats/sefaria-csv/write";

/*
 * INLINE_LINKER ('ציטוט בטקסט') is a type of Otzaria's personal import (LINK_FORMATS §1.12). A Sefaria CSV has no
 * such type and no start/end: a private export in that format must not carry it as a type string, and must not
 * drop it silently either — it is listed among what the CSV leaves out.
 */
const book = (title: string): BookRef => ({ key: `k:${title}`, title, origin: "otzaria" });
const mk = (id: string, declaredType: string): Link => ({
  id, status: "new", provenance: "user", source: { book: book("ספר שלי"), line: 1 }, target: { book: book("ספר יעד"), line: 2 },
  declaredType, heRef2: "ספר יעד ב", anchor: { rawStart: 1, rawEnd: 5 },
});

describe("Sefaria CSV and INLINE_LINKER", () => {
  it("is left out of the CSV rows and named among the omissions", () => {
    const written = [mk("a", "reference"), mk("b", "INLINE_LINKER"), mk("c", "ציטוט בטקסט")];
    const files = planSefariaCsv(written, () => undefined);
    expect(files.map((f) => f.rows)).toEqual([1]);
    expect(files[0]!.text).not.toMatch(/INLINE_LINKER|ציטוט בטקסט/);
    const omitted = sefariaCsvOmissions({ warned: [], written });
    expect(omitted.map((o) => o.link.id)).toEqual(["b", "c"]);
    expect(omitted[0]!.problems[0]).toMatchObject({ code: "csv/omitted", severity: "error" });
  });
});
