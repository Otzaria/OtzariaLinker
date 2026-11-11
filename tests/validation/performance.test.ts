import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceBook } from "../../src/core/books";
import type { BookRef, Link } from "../../src/core/links/model";
import type { LineFacts, ValidationContext } from "../../src/core/links/validate";
import { planExport, zipExport } from "../../src/formats/links-json/export";
import { SourceRegistry } from "../../src/sources/registry";
import { engineJob } from "../../src/workers/engine-job";
import { searchJob } from "../../src/workers/search-job";
import { DB, fileBlob, fingerprint, ms, record } from "./env";

/*
 * Check 7 — timings and memory on the real seforim.db, through the same calls the worker makes
 * (SourceRegistry, searchJob, engineJob, planExport). Node on a local disk; the browser path is
 * check 8 (tests/validation/browser). Compared with docs/DEVELOPER_GUIDE.md §4.
 *
 *   OTZARIA_DB=… npx vitest run --config vitest.validation.config.ts tests/validation/performance.test.ts
 */
const MB = (n: number) => Math.round(n / 1024 / 1024);
const mem = () => ({ rssMB: MB(process.memoryUsage().rss), heapMB: MB(process.memoryUsage().heapUsed) });

describe.runIf(DB)("check 7: performance on the real database", () => {
  const before = DB ? fingerprint(DB) : "";
  const results: Record<string, unknown>[] = [];
  let registry: SourceRegistry;
  let books: SourceBook[];
  const step = async <T>(name: string, baseline: string | null, f: () => Promise<T>, info?: (r: T) => unknown): Promise<T> => {
    globalThis.gc?.();
    const t0 = performance.now();
    const r = await f();
    results.push({ step: name, ms: ms(t0), ...mem(), ...(baseline && { baseline }), ...(info && { info: info(r) }) });
    return r;
  };
  const book = (title: string) => books.find((b) => b.title === title)!;
  const ref = (b: SourceBook): BookRef => ({ key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) });

  beforeAll(async () => {
    registry = new SourceRegistry();
    const r = await step("open + list books", "53ms (DEVELOPER_GUIDE §4)", async () => registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }]), (r) => `${r.sources[0]!.books.length} books`);
    books = r.sources[0]!.books;
  });
  afterAll(() => {
    record("performance", results);
    console.info(JSON.stringify(results, null, 1));
    expect(fingerprint(DB!)).toBe(before);
  });

  it("books, links, search", async () => {
    await step("first screen (200 lines) of the largest book", null, () => registry.lines(book("דור המלקטים על אורח חיים").key, 0, 199), (l) => `${l.length} lines`);
    await step("all lines of בראשית", "61ms", () => registry.lines(book("בראשית").key, 0, Number.MAX_SAFE_INTEGER), (l) => `${l.length} lines`);
    await step("all lines of משנה ברורה", "567ms", () => registry.lines(book("משנה ברורה").key, 0, Number.MAX_SAFE_INTEGER), (l) => `${l.length} lines`);
    await step("all lines of שער הציון (notes)", "590ms", () => registry.lines(book("שער הציון").key, 0, Number.MAX_SAFE_INTEGER), (l) => `${l.length} lines`);
    await step("all lines of the largest book", null, () => registry.lines(book("דור המלקטים על אורח חיים").key, 0, Number.MAX_SAFE_INTEGER), (l) => `${l.length} lines, ${MB(l.reduce((n, x) => n + x.text.length * 2, 0))} MB of text`);
    await step("existing links of all of בראשית", "1.1s for 26,959 links", () => registry.existingLinks(book("בראשית").key, 0, Number.MAX_SAFE_INTEGER), (l) => `${l.length} links`);
    await step("search משנה ברורה for 'שבת'", "251ms", () => searchJob(registry, book("משנה ברורה").key, "שבת"), (r) => `${r.hits.length} hits, ${r.scanned} lines scanned, truncated ${r.truncated}`);
    await step("search שער הציון for 'שבת'", "170–250ms", () => searchJob(registry, book("שער הציון").key, "שבת"), (r) => `${r.hits.length} hits, ${r.scanned} lines scanned`);
    await step("search the largest book for a rare word", null, () => searchJob(registry, book("דור המלקטים על אורח חיים").key, "אנטיוכוס"), (r) => `${r.hits.length} hits, ${r.scanned} lines scanned`);
  });

  it("engines on large pairs, and export", async () => {
    const hd = await step("headings: משנה ברורה → שולחן ערוך, אורח חיים", null, () => engineJob(registry, "headings", ref(book("משנה ברורה")), ref(book("שולחן ערוך, אורח חיים")), {}, {}), (r) => `${r.suggestions.length} suggestions`);
    const dh = await step('dibur-hamatchil: רש"י על ברכות → ברכות', null, () => engineJob(registry, "dibur-hamatchil", ref(book('רש"י על ברכות')), ref(book("ברכות")), {}, {}), (r) => `${r.suggestions.length} suggestions`);
    await step("dibur-hamatchil: שער הציון → משנה ברורה", null, () => engineJob(registry, "dibur-hamatchil", ref(book("שער הציון")), ref(book("משנה ברורה")), {}, {}), (r) => `${r.suggestions.length} suggestions`);
    const fn = books.find((b) => b.title.startsWith("הערות באותיות על"));
    if (fn) {
      const main = books.find((b) => b.title === fn.title.replace(/^הערות באותיות על /, ""));
      if (main) await step(`footnotes: ${main.title} → ${fn.title}`, null, () => engineJob(registry, "footnotes", ref(main), ref(fn), {}, {}), (r) => `${r.suggestions.length} suggestions`);
    }
    // the largest suggestion list as approved links, then the export plan and the ZIP the user downloads;
    // includeErrors, so every link is written (Sefaria↔Sefaria pairs would otherwise all be held back)
    const links: Link[] = (hd.suggestions.length >= dh.suggestions.length ? hd : dh).suggestions.map((s, i) => ({ id: `auto:${i}`, status: "new", provenance: "auto", source: s.source, target: s.target, declaredType: s.declaredType, heRef2: s.heRef2, ...(s.anchor && { anchor: s.anchor }) }));
    const ctx: ValidationContext = { lineCount: (b) => books.find((x) => x.key === b.key)?.lineCount, line: (): LineFacts | undefined => undefined };
    const plan = await step(`export plan of ${links.length} links`, null, async () => planExport(links, ctx, { includeErrors: true }), (p) => `${p.files.length} files, ${p.counts.new} new, ${p.counts.heldBack} held back`);
    await step("ZIP of the export", null, async () => zipExport(plan), (z) => `${Math.round(z.length / 1024)} KB`);
  });
});
