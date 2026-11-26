import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coverageEndsOf } from "../../../src/core/links/coverage-ends";
import { coverageSummary } from "../../../src/linking/coverage";
import { SourceRegistry } from "../../../src/sources/registry";
import { registryService } from "../../support/books-service";

/*
 * #42 C8: the coverage of a book read the book's links with existingLinks() — every link as an object, with its anchors and
 * heRefs (בראשית: 5.8 s and 420 MB in the worker, and all of it copied to the page). The compact read (DbBookSource.coverageEnds,
 * from the book indexes) must give the coverage rules exactly what those Links gave: checked book by book on the real
 * schema-7 slice (tests/fixtures/db/seforim-v7-mini.db) and on a personal database read through external_link (the fallback).
 */
const files = {
  library: { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) },
  personal: { path: "pdc.db", blob: new Blob([readFileSync("tests/fixtures/db/pdc-personal-mini.db")]) },
};

describe.each(Object.entries(files))("coverageEnds == existingLinks() for the coverage rules (%s)", (_name, file) => {
  it("every book with links: the same count, and the same buckets, ranges and units", async () => {
    const registry = new SourceRegistry();
    const opened = await registry.open([file]);
    const books = opened.sources.flatMap((s) => s.books);
    let compared = 0;
    let withLinks = 0;
    for (const b of books) {
      const links = await registry.existingLinks(b.key, 0, Number.MAX_SAFE_INTEGER);
      const ends = await registry.coverageEnds(b.key);
      expect(ends.links, b.title).toBe(links.length);
      if (!links.length) continue;
      withLinks++;
      const lineCount = b.lineCount ?? Math.max(...ends.line, 0) + 1;
      const owns = (r: { key: string }) => r.key === b.key;
      const units = new Map([...ends.line].slice(0, 5).map((l) => [l, 3] as const));
      const book = { owns, lineCount, headings: new Set<number>(), units };
      expect(coverageSummary([], { ...book, ends }), b.title).toEqual(coverageSummary(links, book));
      // the compact read and the compaction of the same Links describe the same ends (in another order)
      const ref = coverageEndsOf(links, owns);
      const sorted = (e: typeof ends) => [...e.line].map((l, k) => `${l}|${e.end[k]}|${e.titles[e.placeTitle[e.place[k]!]!]}|${e.placeLine[e.place[k]!]}|${e.placeEnd[e.place[k]!]}`).sort();
      expect(sorted(ends), b.title).toEqual(sorted(ref));
      compared++;
    }
    expect(withLinks).toBeGreaterThan(0);
    expect(compared).toBe(withLinks);
  }, 120_000);
});

describe("what crosses to the page is compact (#42 C8)", () => {
  it("typed arrays and a list of titles, never a Link; the table never asks for the Links", async () => {
    const registry = new SourceRegistry();
    const service = registryService(registry);
    const opened = await service.open([files.library]);
    const b = opened.sources[0]!.books.find((x) => x.hasSourceLinks) ?? opened.sources[0]!.books[0]!;
    const ends = await service.coverageEnds!(b.key);
    for (const k of ["line", "end", "place", "placeTitle", "placeLine", "placeEnd"] as const) expect(ends[k]).toBeInstanceOf(Int32Array);
    expect(ends.titles.every((t) => typeof t === "string")).toBe(true);
    expect(Object.keys(ends).sort()).toEqual(["end", "line", "links", "place", "placeEnd", "placeLine", "placeTitle", "titles"]);
  });

  it("a cancelled read stops (the worker does not go on reading a quarter of a million links for nobody)", async () => {
    const registry = new SourceRegistry();
    const opened = await registry.open([files.library]);
    const b = opened.sources[0]!.books.find((x) => x.hasSourceLinks) ?? opened.sources[0]!.books[0]!;
    const ctl = new AbortController();
    ctl.abort();
    await expect(registry.coverageEnds(b.key, { signal: ctl.signal })).rejects.toThrow();
  });
});
