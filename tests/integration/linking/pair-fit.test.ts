import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import type { PlanStep } from "../../../src/linking/plan";
import { pairFit } from "../../../src/linking/pair-fit";
import type { SourceBook } from "../../../src/sources/book-source";
import { SourceRegistry } from "../../../src/sources/registry";
import { maxlinkJob } from "../../../src/workers/maxlink-job";

/*
 * #42 C10 on the real database slice (tests/fixtures/db/seforim-v7-mini.db): the ד"ה engine had no pair check, and unrelated pairs of
 * the official database got 5–32 "high" suggestions each. Here: רש"י על בראשית against its base, and against ארצות החיים (no relation
 * at all), through the max-link job as the planner would run a pair it discovered by itself (via "corpus").
 */
describe("the pair check of the ד\"ה method (#42 C10)", () => {
  let registry: SourceRegistry;
  let books: SourceBook[];
  beforeAll(async () => {
    registry = new SourceRegistry();
    const opened = await registry.open([{ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) }]);
    books = opened.sources[0]!.books;
  });
  const ref = (title: string): BookRef => {
    const b = books.find((x) => x.title === title)!;
    return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) };
  };
  const step = (c: string, b: string, via: "corpus" | "title" | "user"): Extract<PlanStep, { kind: "pair" }> => ({
    id: `t:${c}>${b}`,
    kind: "pair",
    engine: "dibur-hamatchil",
    source: ref(c),
    target: ref(b),
    relation: { kind: "commentary", dependant: ref(c), base: ref(b), via, caveats: [] },
    why: "test",
  });
  const strong = (s: { confidence: string }) => s.confidence === "certain" || s.confidence === "high";

  it('an unrelated pair the planner found by itself gives nothing "high" or "certain", and says why', async () => {
    const res = await maxlinkJob(registry, [step('רש"י על בראשית', "ארצות החיים", "corpus")], {}, {});
    const it0 = res.items[0]!;
    expect(it0.result!.suggestions.filter(strong)).toEqual([]);
    expect(it0.pairFit?.verdict).not.toBe("suitable");
    expect(it0.result!.notes.some((n) => n.code === "pair-fit/skipped" || n.code === "pair-fit/undecided")).toBe(true);
  });

  it("the user may still run it: the suggestions are kept for review, with the reasons", async () => {
    const res = await maxlinkJob(registry, [step('רש"י על בראשית', "ארצות החיים", "user")], {}, {});
    const r = res.items[0]!.result!;
    expect(r.suggestions.filter(strong)).toEqual([]);
    expect(r.notes.some((n) => n.code === "pair-fit/skipped")).toBe(false);
    for (const s of r.suggestions) if (s.rules.includes("pair-fit/forced")) expect(s.warnings.some((w) => w.code === "pair-fit/forced")).toBe(true);
    // the same through the job option (the state's flag for a pair it did not name)
    const opt = await maxlinkJob(registry, [step('רש"י על בראשית', "ארצות החיים", "corpus")], { forcedPairs: [`${ref('רש"י על בראשית').key}>${ref("ארצות החיים").key}`] }, {});
    expect(opt.items[0]!.result!.notes.some((n) => n.code === "pair-fit/skipped")).toBe(false);
  });

  it("the commentary on its base is suitable, and keeps every suggestion as it was", async () => {
    const res = await maxlinkJob(registry, [step('רש"י על בראשית', "בראשית", "title")], {}, {});
    const it0 = res.items[0]!;
    expect(it0.pairFit?.verdict).toBe("suitable");
    expect(it0.result!.suggestions.filter(strong).length).toBeGreaterThan(100);
    expect(it0.result!.suggestions.some((s) => s.rules.some((r) => r.startsWith("pair-fit/")))).toBe(false);
  });

  it("headings that differ never reject a pair: a commentary with no headings at all is judged by its words", () => {
    // רש"י's lines in the slice have no headings; the title declares the base, and the words agree
    const fit = pairFit({ commentary: ref('רש"י על בראשית'), base: ref("בראשית"), dh: null });
    expect(fit.verdict).toBe("suitable");
    expect(fit.reasons.map((r) => r.code)).toContain("pair-fit/declared");
    // two editions of one work are not a commentary pair
    expect(pairFit({ commentary: { key: "a", title: "בראשית", origin: "personal" }, base: ref("בראשית"), dh: null }).verdict).toBe("unsuitable");
  });
});
