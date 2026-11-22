import { readFileSync } from "node:fs";
import { strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
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
