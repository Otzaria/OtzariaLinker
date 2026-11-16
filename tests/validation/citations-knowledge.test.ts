import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SourceRegistry } from "../../src/sources/registry";
import { AliasIndex, CitationScanner, NamedUnitIndex, type CatalogBook } from "../../src/linking/automatic/citations";
import { RAMBAM_TOPIC_NAMES } from "../../src/linking/automatic/citations/knowledge";
import { DB, fileBlob, fingerprint } from "./env";

/*
 * The citations engine's knowledge (src/linking/automatic/citations/knowledge/, made by scripts/citations/knowledge.py)
 * against the real database: every name points to a book the database has, and the scanner reads it so.
 *   OTZARIA_DB=… npx vitest run --config vitest.validation.config.ts tests/validation/citations-knowledge.test.ts
 * KNOWLEDGE_PHRASES=<phrases.json> KNOWLEDGE_READINGS=<out.json>: also writes what the scanner reads for each mined phrase
 * (the input of `knowledge.py rambam-select`).
 */
describe.runIf(DB)("citations knowledge vs the real seforim.db (read-only)", () => {
  const before = DB ? fingerprint(DB) : "";
  let aliases: AliasIndex;
  let titles: Set<string>;
  beforeAll(async () => {
    const registry = new SourceRegistry();
    await registry.open([{ path: "seforim.db", blob: await fileBlob(DB!) }]);
    const catalog: CatalogBook[] = (await registry.citationCatalog()).map(({ book, aliases }) => ({ book: { key: book.key, title: book.title, origin: book.origin }, aliases }));
    aliases = AliasIndex.build(catalog);
    titles = new Set(catalog.map((c) => c.book.title));
  }, 300_000);
  afterAll(() => expect(fingerprint(DB!)).toBe(before));

  const read = (line: string): string | null => {
    const sc = new CitationScanner(aliases, "src", {}, "ספר", NamedUnitIndex.build([]));
    sc.scanLine(0, line, null);
    return sc.citations[0]?.candidates.map((x) => x.book.title).join(" | ") ?? null;
  };

  it("every Rambam topic name is a topic of the database, and is read as it after a word for hilchot and after רמב\"ם", () => {
    const wrong: string[] = [];
    for (const n of RAMBAM_TOPIC_NAMES) {
      const title = `משנה תורה, הלכות ${n.topic}`;
      expect(titles.has(title), title).toBe(true);
      for (const line of [`עיין פ"א מהל' ${n.written} ה"א ושם`, `עיין רמב"ם פ"א מ${n.written} ה"א ושם`]) {
        const got = read(line);
        if (got !== title) wrong.push(`${line} → ${got}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it.runIf(process.env.KNOWLEDGE_PHRASES)("what the scanner reads for each mined phrase", () => {
    const phrases = JSON.parse(readFileSync(process.env.KNOWLEDGE_PHRASES!, "utf8")) as Record<string, unknown>;
    const out: Record<string, { hil: string | null; rambam: string | null }> = {};
    for (const p of Object.keys(phrases)) out[p] = { hil: read(`עיין פ"א מהל' ${p} ה"א ושם`), rambam: read(`עיין רמב"ם פ"א מ${p} ה"א ושם`) };
    writeFileSync(process.env.KNOWLEDGE_READINGS!, JSON.stringify(out));
  });
});
