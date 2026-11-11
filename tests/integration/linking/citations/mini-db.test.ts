import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import type { SourceBook } from "../../../../src/sources/book-source";
import { SourceRegistry } from "../../../../src/sources/registry";
import { citationsJob } from "../../../../src/workers/citations-job";
import { goldOf, judge } from "./measure";

/*
 * The citations engine through the worker job, on the real slice of seforim.db (tests/fixtures/db,
 * scripts/fixtures/make_mini_db.py). The slice keeps the lines of בראשית that its LINKER links point
 * to, so those are the ground truth: every LINKER link from these books into בראשית must be found,
 * and nothing it suggests may contradict the database.
 */
describe("citations engine on the real database slice (seforim-v7-mini.db)", () => {
  let registry: SourceRegistry;
  let books: SourceBook[];
  beforeAll(async () => {
    registry = new SourceRegistry();
    const opened = await registry.open([{ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) }]);
    books = opened.sources[0]!.books;
  });
  const refOf = (title: string): BookRef => {
    const b = books.find((x) => x.title === title)!;
    return { key: b.key, title: b.title, origin: b.origin };
  };
  const run = async (title: string) => {
    const src = refOf(title);
    const result = await citationsJob(registry, src, {}, {});
    const gold = goldOf(await registry.existingLinks(src.key, 0, Number.MAX_SAFE_INTEGER), src.key);
    return { result, gold, ...judge(result.suggestions, gold) };
  };

  it('רש"י על בראשית: every LINKER link into בראשית is found, and every suggestion is one of them', async () => {
    const { result, judged, found, gold } = await run('רש"י על בראשית');
    const linker = gold.filter((g) => g.type === "linker" && g.bookTitle === "בראשית");
    expect(linker.length).toBe(8);
    expect(linker.every((g) => found.has(g))).toBe(true);
    expect(judged.every((j) => j.verdict === "correct")).toBe(true);
    expect(result.suggestions.every((s) => s.declaredType === "reference" && s.anchor === undefined)).toBe(true);
  });

  it("הלכות גדולות כתובות (an Otzaria book) → בראשית (a Sefaria book): the verses, without anchors", async () => {
    const { result, judged } = await run("הלכות גדולות כתובות");
    const byLine = new Map(judged.map((j) => [j.s.source.line, j]));
    expect(byLine.get(66)).toMatchObject({ verdict: "correct", exact: true });
    expect(byLine.get(66)!.s.heRef2).toBe("בראשית, א, כח");
    expect(byLine.get(66)!.s.confidence).toBe("certain");
    expect(byLine.get(125)).toMatchObject({ verdict: "correct", exact: true });
    expect(judged.some((j) => j.verdict === "wrong")).toBe(false);
    expect(result.suggestions.some((s) => s.anchor)).toBe(false);
    expect(result.notes.map((n) => n.code)).toContain("citations/anchors-sefaria");
    // "(שם י:)" refers to a daf of כתובות, not to the last verse cited: never a suggestion into בראשית
    expect(result.suggestions.filter((s) => s.source.line >= 82 && s.source.line <= 101)).toEqual([]);
  });

  it("the same input gives the same suggestions (ids are deterministic)", async () => {
    const a = (await run("הלכות גדולות כתובות")).result.suggestions.map((s) => s.id);
    const b = (await run("הלכות גדולות כתובות")).result.suggestions.map((s) => s.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});
