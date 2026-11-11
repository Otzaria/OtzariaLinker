import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { foldQuery, matchLine } from "../../../src/core/text/find";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";
import type { BookSource } from "../../../src/sources/book-source";
import { SourceRegistry } from "../../../src/sources/registry";
import { searchJob } from "../../../src/workers/search-job";

/*
 * In-book search as the worker runs it, on the real schema-7 slice (tests/fixtures/db) and on text
 * files. The fixture holds real lines of each book (with their real line indexes), not whole books.
 */
const DB_BYTES = new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
let reg: SourceRegistry;
const key = (title: string) => books.find((b) => b.title === title)!.key;
let books: { key: string; title: string }[] = [];

beforeAll(async () => {
  reg = new SourceRegistry();
  const res = await reg.open([{ path: "seforim.db", blob: new Blob([DB_BYTES]) }]);
  books = res.sources[0]!.books;
});

describe("searchJob on a real Otzaria database (schema 7, zstd)", () => {
  it("finds words typed without nikud in a pointed, cantillated text — line index, snippet and count", async () => {
    const r = await searchJob(reg, key("בראשית"), "ברא אלהים");
    expect(r.truncated).toBe(false);
    expect(r.hits[0]).toMatchObject({ line: 2, count: 1 });
    const h = r.hits[0]!;
    const m = h.snippet.slice(h.start, h.end);
    expect(foldQuery(m)).toBe("ברא אלהים");
    expect(m.startsWith("ב")).toBe(true);
    expect(m.endsWith("ים")).toBe(true);
    expect(r.scanned).toBe(133); // every line of the book in the slice
  });

  it("hits are in line order and agree with matching every line one by one", async () => {
    const all = await reg.lines(key("רש\"י על בראשית"), 0, Number.MAX_SAFE_INTEGER);
    const q = foldQuery("אלהים");
    const expected = all.flatMap((l) => (matchLine(l.anchorText, q, l.index) ? [l.index] : []));
    const r = await searchJob(reg, key("רש\"י על בראשית"), "אלהים");
    expect(expected.length).toBeGreaterThan(5);
    expect(r.hits.map((h) => h.line)).toEqual(expected);
  });

  it("quote variants: וי\"א finds lines written וי״א, and the reverse", async () => {
    const a = await searchJob(reg, key("ארצות החיים"), 'וי"א');
    const b = await searchJob(reg, key("ארצות החיים"), "וי״א");
    expect(a.hits.map((h) => h.line)).toContain(322);
    expect(a.hits.map((h) => h.line)).toEqual(b.hits.map((h) => h.line));
  });

  it("searches the text the reader shows: footnote bodies of schema 7 are in it, tag names are not", async () => {
    const note = await searchJob(reg, key("בראשית"), "בספרי ספרד ואשכנז");
    expect(note.hits.map((h) => h.line)).toEqual([97]);
    expect((await searchJob(reg, key("בראשית"), "footnote")).hits).toEqual([]);
    expect((await searchJob(reg, key("בראשית"), "big")).hits).toEqual([]);
  });

  it("keeps the real line numbers of a sparse book (not positions in the result)", async () => {
    const r = await searchJob(reg, key("משנה ברורה"), "להרבות");
    expect(r.hits.map((h) => h.line)).toEqual([18118]);
  });

  it("caps the hits and says there are more", async () => {
    const r = await searchJob(reg, key("בראשית"), "את", { limit: 3 });
    expect(r.hits).toHaveLength(3);
    expect(r.truncated).toBe(true);
    const full = await searchJob(reg, key("בראשית"), "את");
    expect(full.hits.length).toBeGreaterThan(3);
    expect(full.hits.slice(0, 3)).toEqual(r.hits);
  });

  it("a query shorter than two letters is not searched", async () => {
    expect(await searchJob(reg, key("בראשית"), " א ")).toEqual({ query: " א ", hits: [], scanned: 0, truncated: false });
  });

  it("reports progress in lines, and stops when cancelled", async () => {
    const seen: [number, number][] = [];
    await searchJob(reg, key("בראשית"), "אלהים", {}, { progress: (d, n) => seen.push([d, n]) });
    expect(seen.at(-1)).toEqual([133, 133]);
    const ac = new AbortController();
    ac.abort();
    await expect(searchJob(reg, key("בראשית"), "אלהים", {}, { signal: ac.signal })).rejects.toThrow();
  });

  it("a closed source is an error the user can read", async () => {
    const r2 = new SourceRegistry();
    const res = await r2.open([{ path: "seforim.db", blob: new Blob([DB_BYTES]) }]);
    const k = res.sources[0]!.books[0]!.key;
    r2.close(res.sources[0]!.info.id);
    await expect(searchJob(r2, k, "בראשית")).rejects.toThrow("נסגר");
  });
});

describe("the reader's whole-book chunks", () => {
  it("lineChunks walks the index once and yields exactly lines(), in order", async () => {
    const reader = await OtzariaDbReader.open(bytesSource(DB_BYTES));
    const whole = await reader.lines(3695);
    const chunks: number[][] = [];
    for await (const c of reader.lineChunks(3695, 50)) {
      expect(c.total).toBe(whole.length);
      chunks.push(c.lines.map((l) => l.index));
    }
    expect(chunks.length).toBe(Math.ceil(whole.length / 50));
    expect(chunks.flat()).toEqual(whole.map((l) => l.index));
  });
});

describe("searchJob on text files", () => {
  const text = ["<h1>פירוש על בראשית</h1>", "בְּרֵאשִׁית - פירוש <b>ראשון</b>", "ויאמר - פירוש שני", ...Array.from({ length: 1200 }, (_, i) => `שורה ${i} ${i % 400 === 7 ? "מחט בערימה" : "תבן"}`)].join("\r\n");

  it("finds lines in a text book, across chunks, with the generator's line numbers", async () => {
    const r = new SourceRegistry();
    const res = await r.open([{ path: "פירוש על בראשית.txt", blob: new Blob([strToU8(text)]) }]);
    const k = res.sources[0]!.books[0]!.key;
    expect((await searchJob(r, k, "בראשית פירוש")).hits.map((h) => h.line)).toEqual([1]);
    expect((await searchJob(r, k, "פירוש ראשון")).hits.map((h) => h.line)).toEqual([1]); // across a <b> tag
    const needle = await searchJob(r, k, "מחט בערימה");
    expect(needle.hits.map((h) => h.line)).toEqual([10, 410, 810]);
    expect(needle.scanned).toBe(1203);
  });

  it("a source without scan() is paged through lines()", async () => {
    const r = new SourceRegistry();
    const res = await r.open([{ path: "x.txt", blob: new Blob([strToU8(text)]) }]);
    const k = res.sources[0]!.books[0]!.key;
    // hide scan(): the registry falls back to lines(from, to) pages
    const src = (r as unknown as { sources: Map<string, BookSource> }).sources.get(res.sources[0]!.info.id)!;
    const calls: number[] = [];
    const lines = src.lines.bind(src);
    Object.assign(src, { scan: undefined, lines: (b: string, f?: number, t?: number) => (calls.push(f ?? 0), lines(b, f, t)) });
    expect((await searchJob(r, k, "מחט בערימה")).hits.map((h) => h.line)).toEqual([10, 410, 810]);
    expect(calls).toEqual([0, 500, 1000]);
  });
});

describe("speed on the fixture", () => {
  it("searches every book of the slice", async () => {
    const t0 = performance.now();
    let lines = 0;
    for (const b of books) lines += (await searchJob(reg, b.key, "אמר")).scanned;
    const ms = performance.now() - t0;
    console.info(`search: ${lines} lines in ${ms.toFixed(1)}ms (${((lines / ms) * 1000).toFixed(0)} lines/s)`);
    expect(lines).toBe(701);
  });
});
