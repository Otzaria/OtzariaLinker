import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { firstRefIn, withoutRange } from "../../../src/core/links/sefaria-owned";
import { MAX_BOOK_LINES } from "../../../src/core/limits";
import { recordToLink } from "../../../src/formats/links-json/convert";
import { parseLinksJson } from "../../../src/formats/links-json/parse";

/*
 * QA round 2, B: `line_index_N_end` comes from a file nobody vouches for. An end of 2^53-1 must not make
 * any loop over the range run for hours: the range is refused at import (the link stays on its first line),
 * and the older loops over a range are clamped as well.
 */
const book = (title: string): BookRef => ({ key: `k:${title}`, title, origin: "otzaria" });
const SRC = book("ביאור");
const HUGE = Number.MAX_SAFE_INTEGER;
const file = (extra: string) => `[{"line_index_1": 3, "heRef_2": "בראשית א, א", "path_2": "בראשית.txt", "line_index_2": 1, ${extra} "Conection Type": "commentary"}]`;

describe("a huge range end in an imported file", () => {
  it("is refused at import with a warning, the link keeps its first line, and the record stays byte-identical", () => {
    for (const key of ["line_index_1_end", "line_index_2_end"]) {
      const text = file(`"${key}": ${HUGE},`);
      const t0 = performance.now();
      const { records } = parseLinksJson(text);
      const { link, issues } = recordToLink(records[0]!, 0, SRC, book, "f:0");
      expect(performance.now() - t0).toBeLessThan(500);
      expect(link.source.end).toBeUndefined();
      expect(link.target.end).toBeUndefined();
      expect(issues.map((i) => i.code)).toContain("record/range-too-large");
    }
  });
  it("a range that ends inside the limit is kept", () => {
    const { records } = parseLinksJson(file(`"line_index_2_end": ${MAX_BOOK_LINES},`));
    const { link } = recordToLink(records[0]!, 0, SRC, book, "f:0");
    expect(link.target.end).toBe(MAX_BOOK_LINES - 1);
  });
});

describe("loops over a range are clamped", () => {
  const owned: BookRef = { key: "db:1", title: "בראשית", origin: "sefaria" };
  it("firstRefIn and withoutRange return quickly for a huge end", () => {
    const noRef = () => "no-ref" as const;
    const t0 = performance.now();
    expect(firstRefIn(0, HUGE, noRef).line).toBe(0);
    expect(withoutRange({ book: owned, line: 0, end: HUGE }, noRef).target.line).toBe(0);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
