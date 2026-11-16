import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbLinkOrigin } from "../../../src/core/links/db-links";
import { linkMatchIndex, matchLink } from "../../../src/core/links/equality";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";
import { DbBookSource } from "../../../src/sources/db/db-source";
import type { LinkListing } from "../../../src/sources/db/link-listing";
import type { Link } from "../../../src/core/links/model";

/*
 * Listing a book's database links (stage 10) against the full seforim.db, with timings. Runs only
 * with a real database, opened read-only ("r") and never written:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/database/db-links-real-db.local.test.ts
 * The numbers printed here are the ones quoted in docs/contracts/LINK_FORMATS.md §4.5.
 */
const path = process.env.OTZARIA_DB;
const fd = path ? openSync(path, "r") : -1;
const source: ByteSource | null = path
  ? {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        return buf.subarray(0, readSync(fd, buf, 0, length, offset));
      },
    }
  : null;
afterAll(() => {
  if (path) closeSync(fd);
});

describe.runIf(path)("database links of a book, on the real seforim.db (read-only)", () => {
  let src: DbBookSource;
  const keyOf = async (title: string) => (await src.books()).find((b) => b.title === title && b.sourceName === "Sefaria")!.key;
  beforeAll(async () => {
    src = await DbBookSource.open("s1", "seforim.db", source!);
  }, 120_000);

  for (const [title, minLinks] of [["בראשית", 200_000], ["ברכות", 100_000], ["משנה ברורה", 40_000]] as const) {
    it(`${title}: summary from the book indexes, a filtered page, counts that add up`, async () => {
      const key = await keyOf(title);
      const pages0 = (src as unknown as { reader: { file: { pagesRead: number } } }).reader.file.pagesRead;
      const t0 = performance.now();
      const listing = (await src.linkListing(key)) as LinkListing;
      const tSummary = performance.now() - t0;
      const pages = (src as unknown as { reader: { file: { pagesRead: number } } }).reader.file.pagesRead - pages0;
      expect(typeof listing).toBe("object");
      const books = new Map((await src.books()).map((b) => [b.key, b]));
      const sum = listing.summary((k) => ({ title: books.get(k)?.title ?? k, origin: books.get(k)?.origin ?? "unknown" }));
      expect(sum.method).toBe("index");
      expect(sum.total).toBeGreaterThan(minLinks);
      expect(sum.out + sum.in).toBe(sum.total);
      expect(sum.byType.reduce((n, t) => n + t.out + t.in, 0)).toBe(sum.total);
      expect(sum.byBook.reduce((n, b) => n + b.out + b.in, 0)).toBe(sum.total);

      const t1 = performance.now();
      const page = await listing.page({ offset: 0, limit: 200 });
      const tPage = performance.now() - t1;
      expect(page.total).toBe(sum.total);
      expect(page.links).toHaveLength(200);
      // in the book's line order
      const own = page.links.map((l) => (l.source.book.key === key ? l.source.line : l.target.line));
      expect(own).toEqual([...own].sort((a, b) => a - b));

      const top = sum.byBook[0]!;
      const t2 = performance.now();
      const filtered = await listing.page({ offset: 0, limit: 100, otherBookKey: top.bookKey, dir: top.out >= top.in ? "out" : "in" });
      const tFiltered = performance.now() - t2;
      expect(filtered.total).toBe(Math.max(top.out, top.in));
      for (const l of filtered.links) expect([l.source.book.key, l.target.book.key]).toContain(top.bookKey);

      const origins: Record<string, number> = {};
      for (const l of page.links) origins[dbLinkOrigin(l)] = (origins[dbLinkOrigin(l)] ?? 0) + 1;
      // the shared equality rule finds every listed link in an index of the same links
      const ix = linkMatchIndex(page.links);
      expect(page.links.every((l) => matchLink(l, ix) === "same-link")).toBe(true);

      console.log(
        `${title}: ${sum.total.toLocaleString()} links (${sum.out.toLocaleString()} out, ${sum.in.toLocaleString()} in), ${sum.byBook.length} other books, ${sum.byType.length} types — ` +
          `summary ${tSummary.toFixed(0)} ms (${pages.toLocaleString()} pages of ${src.capabilities.columns.size ? "16 KiB" : "?"}), first page ${tPage.toFixed(0)} ms, filtered page ${tFiltered.toFixed(0)} ms; ` +
          `top other book ${top.title} (${top.out}/${top.in}); origins on page 1: ${JSON.stringify(origins)}`,
      );
      // the cached listing answers again without reading the database
      const t3 = performance.now();
      expect(await src.linkListing(key)).toBe(listing);
      expect(performance.now() - t3).toBeLessThan(50);
    }, 300_000);
  }
});

/*
 * Which database links can be turned back into the library's records? With the library clone too
 * (OTZARIA_LIBRARY=<otzaria-library>), every record of a sample of links files is matched to its
 * database link by the shared equality rule, copied back with adoptDbLink, and compared with the
 * original record. The table printed here is LINK_FORMATS.md §4.5. Slow: ~30 min for 46k records
 * (every 2nd file of the managed links_roots, ≤250 records each) — run it when the rule changes.
 */
const library = process.env.OTZARIA_LIBRARY;

describe.runIf(path && library)("database links back to library records (read-only)", () => {
  it("a sample of library links files: found in the database, and reproduced", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { parseLinksJson } = await import("../../../src/formats/links-json/parse");
    const { recordToLink } = await import("../../../src/formats/links-json/convert");
    const { sourceTitleFromLinksFileName } = await import("../../../src/core/links/titles");
    const { storedForm } = await import("../../../src/core/links/stored-form");
    const { storedLinkIdentity } = await import("../../../src/core/links/equality");
    const { adoptDbLink } = await import("../../../src/core/links/from-db");
    const { canonicalTypeString, parseConnectionType } = await import("../../../src/core/links/connection-type");

    const src = await DbBookSource.open("s1", "seforim.db", source!);
    const books = await src.books();
    const byTitle = new Map<string, (typeof books)[number]>();
    for (const b of books) if (!byTitle.has(b.title) || b.sourceName === "Sefaria") byTitle.set(b.title, b);
    const refOf = (t: string) => {
      const b = byTitle.get(t);
      return b ? { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) } : null;
    };

    // the links folders the library's weekly sync manages ([L] manual_links_sync.json, links_roots
    // with expected_state "present") — the ones the build reads — and a deterministic sample of files
    const roots = (JSON.parse(readFileSync(join(library!, "manual_links_sync.json"), "utf8")) as { links_roots: { path: string; expected_state: string }[] }).links_roots;
    const files: string[] = [];
    for (const r of roots.filter((x) => x.expected_state === "present")) {
      const dir = join(library!, r.path);
      if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) for (const f of readdirSync(dir)) if (f.endsWith("_links.json")) files.push(join(dir, f));
    }
    files.sort();
    const sample = files.filter((_, i) => i % 2 === 0 || /ארצות החיים_links|משנה ברורה_links/.test(files[i]!));
    const PER_FILE = 250;

    const t: Record<string, number> = {};
    const bump = (k: string, n = 1) => (t[k] = (t[k] ?? 0) + n);
    const chunks = new Map<string, Map<string, Link>>();
    const linesCache = new Map<string, Awaited<ReturnType<typeof src.lines>>>();
    const lineOf = async (key: string, i: number) => {
      const c = `${key}#${Math.floor(i / 200)}`;
      if (!linesCache.has(c)) linesCache.set(c, await src.lines(key, Math.floor(i / 200) * 200, Math.floor(i / 200) * 200 + 199));
      return linesCache.get(c)!.find((l) => l.index === i);
    };
    const t0 = performance.now();
    for (const file of sample) {
      const title = sourceTitleFromLinksFileName(file.split(/[\/]/).at(-1)!)!;
      const sourceRef = refOf(title);
      const parsed = parseLinksJson(readFileSync(file, "utf8"));
      bump("files");
      for (const [i, rec] of parsed.records.slice(0, PER_FILE).entries()) {
        bump("records");
        if (!sourceRef) { bump("book not in the database"); continue; }
        const { link } = recordToLink(rec, i, sourceRef, refOf, `f:${i}`);
        if (link.target.book.origin === "unknown") { bump("book not in the database"); continue; }
        const f = storedForm(link);
        if (f.skipped) { bump(`never stored: ${f.skipped}`); continue; }
        const id = storedLinkIdentity(link)!;
        const ss = f.storedSource;
        const ck = `${ss.book.key}#${Math.floor(ss.line / 200)}`;
        if (!chunks.has(ck)) {
          const m = new Map<string, Link>();
          for (const l of await src.existingLinks(ss.book.key, Math.floor(ss.line / 200) * 200, Math.floor(ss.line / 200) * 200 + 199)) m.set(storedLinkIdentity(l)!, l);
          chunks.set(ck, m);
        }
        const db = chunks.get(ck)!.get(id);
        if (!db) { bump("no such link in the database"); continue; }
        bump("found in the database");
        for (const e of [db.source, db.target]) await lineOf(e.book.key, e.line);
        const ctx = (withFile: boolean) => ({
          line: (b: { key: string }, i: number) => {
            const l = linesCache.get(`${b.key}#${Math.floor(i / 200)}`)?.find((x) => x.index === i);
            return l ? { anchorText: l.anchorText, heRef: l.heRef } : undefined;
          },
          hasLinksFile: (x: string) => withFile && x === title,
        });
        for (const withFile of [false, true]) {
          const r = adoptDbLink(db, "c", ctx(withFile));
          const p = withFile ? "with file: " : "no file: ";
          if (!r.link) { bump(`${p}not reproducible (${r.problems[0]?.code})`); continue; }
          if (storedLinkIdentity(r.link) !== id) bump(`${p}BUG: identity differs`);
          const sameFile = r.link.source.book.title === title;
          const sameEnds = sameFile && r.link.source.line === link.source.line && r.link.target.line === link.target.line && r.link.source.end === link.source.end && r.link.target.end === link.target.end;
          const sameType = r.link.declaredType === link.declaredType;
          const sameTypeNormalized = canonicalTypeString(parseConnectionType(r.link.declaredType).type) === canonicalTypeString(parseConnectionType(link.declaredType).type);
          const sameAnchor = (r.link.anchor?.rawStart ?? null) === (f.flipped ? null : (link.anchor?.rawStart ?? null)) && (r.link.anchor?.rawEnd ?? null) === (f.flipped ? null : (link.anchor?.rawEnd ?? null));
          bump(`${p}same file`, +sameFile);
          bump(`${p}same file+lines+ranges`, +sameEnds);
          bump(`${p}same type string`, +(sameEnds && sameType));
          bump(`${p}same type after normalizing`, +(sameEnds && sameTypeNormalized));
          bump(`${p}same anchor (raw)`, +(sameEnds && sameAnchor));
          bump(`${p}same heRef_2`, +(sameEnds && r.link.heRef2 === link.heRef2));
          bump(`${p}identical record (but heRef_2)`, +(sameEnds && sameType && sameAnchor));
          if (!(sameEnds && sameType && sameAnchor)) bump(`${p}differs, declared "${link.declaredType}"${f.flipped ? " (flipped)" : ""} → "${r.link.declaredType}"${sameFile ? "" : " in the other book's file"}`);
          bump(`${p}chosen: ${storedForm(r.link).flipped ? (r.link.declaredType === "source" ? "dependant's file, \"source\"" : "dependant's file, flipped type") : "stored direction"}`);
        }
      }
    }
    console.log(`library reproducibility, ${sample.length} files (≤${PER_FILE} records each), ${((performance.now() - t0) / 1000).toFixed(1)} s:\n` + Object.entries(t).map(([k, v]) => `  ${k}: ${v.toLocaleString()}`).join("\n"));
    expect(t["found in the database"]).toBeGreaterThan(1000);
    expect(t["no file: BUG: identity differs"] ?? 0).toBe(0);
    expect(t["with file: BUG: identity differs"] ?? 0).toBe(0);
    // with the file loaded, a found record goes back to its own file
    expect(t["with file: same file"]! / t["found in the database"]!).toBeGreaterThan(0.99);
  }, 1_800_000);
});
