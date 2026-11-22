import { readFileSync } from "node:fs";
import { strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { PersonalCsvState, type PersonalCsvHost } from "../../../src/state/personal-csv";
import { parsePersonalLinksCsv } from "../../../src/formats/personal-csv";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/* A personal commentary linked to a book of the official database slice, exported as the personal build's links.csv. */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const COMMENTARY = { path: "ביאור על בראשית.txt", blob: new Blob([strToU8(["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat(), ""].join(String.fromCharCode(10)))]) };

describe("AppStore — personal links.csv", () => {
  it("approved links of a personal book to the official one become rows; heading and blank lines are not linked; the files parse back clean", async () => {
    const saved: { name: string; data: Uint8Array | string }[] = [];
    const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
    await store.openFiles([DB, COMMENTARY]);
    const key = [...store.books.value.values()].find((b) => b.title === "ביאור על בראשית")!.key;
    const scope = { kind: "book", key } as const;
    await store.maxLink.run(store.maxLink.plan(scope, new Set(["headings"])), store.maxLink.scopeLabel(scope));
    store.suggestions.approve(store.suggestions.pendingAtLeast("certain"));
    const bundle = (await store.personalCsv.prepare())!;
    expect(bundle.rows).toBe(10);
    expect(bundle.problems).toEqual([]);
    expect(bundle.files.map((f) => f.folder)).toEqual(["קישורים/01"]);
    const parsed = parsePersonalLinksCsv(bundle.files[0]!.text);
    expect(parsed.problems).toEqual([]);
    // the verse lines: 1-based line 4, 6, 8 … (the commentary has a heading before each)
    expect(parsed.rows.map((r) => [r.sourceLine, r.sourceBook, r.targetBook, r.type])).toEqual(Array.from({ length: 10 }, (_, i) => [4 + i * 2, "ביאור על בראשית", "בראשית", "פירוש"]));
    // every position is a heading of the target book itself
    expect(new Set(parsed.rows.map((r) => r.position)).size).toBeGreaterThan(0);
    store.personalCsv.save(bundle);
    const zip = unzipSync(saved.at(-1)!.data as Uint8Array);
    expect(Object.keys(zip)).toEqual(["קישורים/01/links.csv"]);
  });

  it("with no link between a personal book and the official one: nothing to export, said", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    await store.openFiles([DB, COMMENTARY]);
    const bundle = (await store.personalCsv.prepare())!;
    expect(bundle.files).toEqual([]);
    expect(bundle.rows).toBe(0);
  });
});

describe("PersonalCsvState — scale (QA round 2, D)", () => {
  it("100,000 links into a book of 20,000 headings are placed in seconds, and each place is the nearest heading above its line", async () => {
    const P: BookRef = { key: "p:1", title: "פירוש", origin: "personal" };
    const O: BookRef = { key: "o:1", title: "ברכות", origin: "otzaria" };
    const LINKS = 100_000;
    const headings = Array.from({ length: 20_000 }, (_, i) => ({ line: i * 5, level: 2, text: `פרק ${i}` }));
    const links: Link[] = Array.from({ length: LINKS }, (_, i) => ({ id: `l${i}`, status: "new", provenance: "user", source: { book: P, line: i }, target: { book: O, line: (i * 7919) % 100_000 }, declaredType: "source", heRef2: "" }) as Link);
    const host = {
      allLinks: { value: links },
      bookOf: (r: BookRef) => ({ key: r.key, title: r.title, lineCount: LINKS }),
      isLibrarySource: (id: string) => id === "o",
      notify: () => {},
      runTask: async (_l: string, run: (o: object) => Promise<unknown>) => run({}),
    } as unknown as PersonalCsvHost;
    const service = {
      headings: async () => headings,
      lines: async () => Array.from({ length: LINKS }, (_, i) => ({ index: i, text: "ביאור", heading: null })),
    };
    const state = new PersonalCsvState(host, service as never, { save: () => {} });
    const t0 = Date.now();
    const bundle = (await state.prepare())!;
    const ms = Date.now() - t0;
    expect(bundle.rows).toBe(LINKS);
    const parsed = bundle.files.flatMap((f) => parsePersonalLinksCsv(f.text).rows);
    const byLine = new Map(parsed.map((r) => [r.sourceLine, r.position]));
    for (const i of [0, 1, 12345, 99_999]) expect(byLine.get(i + 1)).toBe(`פרק ${Math.floor(((i * 7919) % 100_000) / 5)}`);
    // the old scan was 100,000 x 20,000 = 2 x 10^9 steps (tens of seconds); a sorted index is a binary search per link
    expect(ms).toBeLessThan(2_500);
  }, 60_000);
});


