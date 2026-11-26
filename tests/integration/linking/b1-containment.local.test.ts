import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceBook } from "../../../src/core/books";
import { runEngine, type EngineBook, type Suggestion } from "../../../src/linking/automatic";
import { linePairKey, mergeSuggestions, type MergeItem, type MergedSuggestion } from "../../../src/linking/merge";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * #41 B1 on the pair of the finding (docs/validation/V7_MATCHING_BENCHMARK.md §2.1): משנה ברורה against שולחן ערוך אורח חיים, the
 * headings and ד"ה engines run directly, merged. Twice: the base as it is, and the base WITHOUT its commentators' note markers
 * (<i data-commentator>), which is how the finding's run must have looked (about 16.5 thousand "high" in the merge). A ד"ה found inside
 * the headings' own window must never be raised from "possible" to "high" by that window's range. On `main` (9123d3f) this test
 * finds 410 such raises with the markers (3 contradict the database) and 1,424 without them (12). Runs only with a real database,
 * read-only:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/linking/b1-containment.local.test.ts
 */
const path = process.env.OTZARIA_DB;

function fileBlob(fd: number, from = 0, to = fstatSync(fd).size): Blob {
  return {
    size: to - from,
    slice: (a = 0, b = to - from) => fileBlob(fd, from + a, from + Math.min(b, to - from)),
    async arrayBuffer() {
      const buf = new Uint8Array(to - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      return buf.buffer.slice(0, n);
    },
  } as unknown as Blob;
}

describe.runIf(path)("#41 B1: no raise by containment on משנה ברורה, with or without the base's note markers (read-only)", () => {
  for (const strip of [false, true]) {
    it(strip ? "the base without its commentators' note markers" : "the base as it is", async () => {
      const fd = openSync(path!, "r");
      try {
        const reg = new SourceRegistry();
        const opened = await reg.open([{ path: "seforim.db", blob: fileBlob(fd) }]);
        const books: SourceBook[] = opened.sources.flatMap((s) => s.books);
        const c = books.find((b) => b.title === "משנה ברורה")!;
        const b = books.find((x) => x.title === "שולחן ערוך, אורח חיים")!;
        const load = async (bk: SourceBook, noMarkers: boolean): Promise<EngineBook> => ({
          book: { key: bk.key, title: bk.title, origin: bk.origin, ...(bk.isBaseBook !== undefined && { isBaseBook: bk.isBaseBook }) },
          lines: (await reg.lines(bk.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: noMarkers ? l.anchorText.replace(/<i[^>]*data-commentator[^>]*>\s*<\/i>/g, "") : l.anchorText, heading: l.heading, heRef: l.heRef })),
        });
        const C = await load(c, false);
        const B = await load(b, strip);
        const items: MergeItem[] = [];
        for (const e of ["headings", "dibur-hamatchil"] as const) for (const suggestion of runEngine(e, C, B).suggestions) items.push({ suggestion, focus: c.key });
        const links = await reg.existingLinks(c.key, 0, Number.MAX_SAFE_INTEGER);
        const db = new Set(links.map((l) => linePairKey(l)));
        const merged = mergeSuggestions(items, { reference: db, existing: (s) => (db.has(linePairKey(s)) ? "db" : null) });
        const ends = (s: Suggestion) => (s.source.book.key === c.key ? [s.source, s.target] : [s.target, s.source]);
        const width = (s: Suggestion) => {
          const x = ends(s)[1]!;
          const span = s.citedSpan ?? { line: x.line, end: x.end ?? x.line };
          return span.end - span.line + 1;
        };
        let raised = 0;
        let high = 0;
        for (const s of merged.suggestions as MergedSuggestion[]) {
          if (s.confidence === "high") high++;
          const coarse = s.members.filter((m) => m.suggestion.engine !== s.engine && width(m.suggestion) > width(s));
          const own = s.members.find((m) => m.suggestion.engine === s.engine);
          if (coarse.length && s.engines.length === 1 && own?.suggestion.confidence === "possible" && s.confidence === "high") raised++;
        }
        console.log(`B1, markers ${strip ? "removed" : "kept"}: "possible" raised to "high" by containment ${raised}; merged "high" ${high}`);
        expect(raised).toBe(0);
      } finally {
        closeSync(fd);
      }
    }, 1_800_000);
  }
});
