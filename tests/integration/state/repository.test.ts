import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { isSuspicious, type RepoRow } from "../../../src/state/repository";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * The repository analysis (V6 3.9) on the real schema-7 slice: counted one book at a time, stoppable and continued, small rows,
 * a coverage count for the books asked for, pairs proposed from the books and nothing chosen by itself.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };

async function opened() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
  await store.openFiles([DB]);
  return { store, repo: store.repository, key: (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key };
}

describe("repository analysis", () => {
  it("nothing is read until asked; then every book is counted, with small rows and totals that agree", async () => {
    const { repo, key } = await opened();
    expect(repo.rows.value.size).toBe(0);
    expect(repo.totals.value.counted).toBe(0);
    expect(repo.books.value.length).toBeGreaterThan(3);
    await repo.analyze();
    const t = repo.totals.value;
    expect(t.counted).toBe(t.books);
    expect(repo.progress.value).toBeNull();
    expect(repo.analyzedAt.value).not.toBeNull();
    // a book's row: counts only
    const arzot = repo.rows.value.get(key("ארצות החיים"))!;
    expect(arzot).toMatchObject({ total: 6, out: 6, in: 0 });
    expect(Object.keys(arzot).sort()).toEqual(["ends", "flags", "in", "key", "lineCount", "out", "title", "top", "total", "typesOut"]);
    // each link is counted once, at its source. (The slice has links whose target book is not in it: they are never "incoming" here.)
    const rows = [...repo.rows.value.values()];
    expect(t.links).toBe(rows.reduce((n, r) => n + r.out, 0));
    expect(rows.reduce((n, r) => n + r.in, 0)).toBeLessThanOrEqual(t.links);
    expect(t.noLinks).toBe(rows.filter((r) => r.total === 0).length);
    expect(t.byType.reduce((n, [, c]) => n + c, 0)).toBe(t.links);
    expect(Object.values(t.ends).reduce((n, c) => n + c, 0)).toBe(t.links);
  });

  it("stopped at once it keeps what it had, and a second call continues with the books not yet counted", async () => {
    const { repo } = await opened();
    const run = repo.analyze();
    repo.cancel();
    await run;
    const first = repo.rows.value.size;
    expect(repo.running).toBe(false);
    expect(first).toBeLessThan(repo.books.value.length);
    await repo.analyze();
    expect(repo.rows.value.size).toBe(repo.books.value.length);
  });

  it("the coverage of the books asked for is counted, and only theirs", async () => {
    const { repo, key } = await opened();
    await repo.analyze();
    await repo.countCoverage([key("ארצות החיים")]);
    const withCoverage = [...repo.rows.value.values()].filter((r) => r.coverage);
    expect(withCoverage.map((r) => r.title)).toEqual(["ארצות החיים"]);
    const c = withCoverage[0]!.coverage!;
    expect(c.suitable).toBeGreaterThan(0);
    expect(c.linked + c.partial + c.multiple + c.unlinked).toBe(c.suitable);
  });

  it("pairs are proposed from the books with reasons, and choosing one only fills the list the flow is started from", async () => {
    const { store, repo, key } = await opened();
    await repo.analyze();
    await repo.suggest();
    const s = repo.suggestions.value!;
    expect(s.proposals.length).toBeGreaterThan(0);
    const p = s.proposals.find((x) => x.dependant.title === "המאיר לארץ על ארצות החיים")!;
    expect(p.base.title).toBe("ארצות החיים");
    expect(p.reasons.length).toBeGreaterThan(0);
    expect(p.requiresReview).toBe(true);
    expect(repo.pickedPairs.value.size).toBe(0);
    repo.togglePickedPair(p);
    expect(repo.chosenBooks()).toEqual([key("המאיר לארץ על ארצות החיים")]);
    // nothing ran and no flow started by itself
    expect(store.guided.active.value).toBe(false);
    expect(store.suggestions.run.value).toBeNull();
    repo.togglePickedPair(p);
    expect(repo.chosenBooks()).toEqual([]);
  });
});

describe("suspicious books", () => {
  const row = (total: number, flags: number): RepoRow => ({ key: "k", title: "t", total, out: total, in: 0, typesOut: {}, ends: { same: 0, library: 0, other: 0, unresolved: 0 }, flags: flags ? [{ flag: "target-out-of-range", count: flags }] : [], top: [] });
  it("at least 5% of the links flagged and at least 3 of them", () => {
    expect(isSuspicious(row(100, 5))).toBe(true);
    expect(isSuspicious(row(100, 4))).toBe(false);
    expect(isSuspicious(row(10, 2))).toBe(false);
    expect(isSuspicious(row(0, 0))).toBe(false);
  });
});
