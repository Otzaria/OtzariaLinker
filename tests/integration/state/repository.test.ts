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
    expect(Object.keys(arzot).sort()).toEqual(["ends", "flags", "in", "key", "lineCount", "out", "related", "title", "top", "total", "typesOut"]);
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

describe("a database that was replaced", () => {
  it("rows and picks of books this database does not have are dropped, the others are kept", async () => {
    const { repo, key } = await opened();
    await repo.analyze();
    const real = key("ארצות החיים");
    const row = repo.rows.value.get(real)!;
    repo.rows.value = new Map([...repo.rows.value, ["gone:1", { ...row, key: "gone:1", title: "ספר שנסגר" }]]);
    repo.setPickedBooks([real, "gone:1"]);
    repo.dropStale();
    expect(repo.rows.value.has("gone:1")).toBe(false);
    expect(repo.rows.value.has(real)).toBe(true);
    expect([...repo.pickedBooks.value]).toEqual([real]);
    expect(repo.analyzedAt.value).not.toBeNull();
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

/*
 * Pre-merge audit of every action of the repository screen (PR 3 fix round): none of them touches the open project. The links,
 * the rejections, the undo history, the revision (so "unsaved changes" and the autosave) and a flow an earlier session left are
 * exactly as they were. The only thing the screen writes into the project is a book's coverage snapshot, on the explicit button,
 * for that book alone. The one replacement the screen can cause — "complete links" starting a NEW guided flow — is behind a
 * confirmation in the dialog (e2e: repository.spec.ts), and starts nothing by itself.
 */
describe("the repository screen never changes the open project", () => {
  it("analyze, stop and resume, coverage of many and of one book, suggest pairs, pick: the project is untouched", async () => {
    const { store, repo, key } = await opened();
    // the project has a link of the user, one undo step, a rejection, and a flow left by an earlier session
    const before = [...store.books.value.values()].find((b) => b.title === "המאיר לארץ על ארצות החיים")!;
    const base = [...store.books.value.values()].find((b) => b.title === "ארצות החיים")!;
    await store.lines.load(before.key, 0, 5);
    await store.lines.load(base.key, 0, 5);
    store.pickLine("source", before.key, 1);
    store.pickLine("target", base.key, 1);
    expect(store.createFromDraft()).toBeTruthy();
    store.guided.saved.value = { v: 1, step: "plan", sources: [], purpose: "submission", links: 1, done: false, savedAt: 1 } as never;
    const state = store.linkState.value;
    const saved = store.guided.saved.value;
    const project = JSON.parse(store.projectText());

    const run = repo.analyze();
    repo.cancel();
    await run;
    await repo.analyze();
    await repo.countCoverage([key("ארצות החיים")]);
    await repo.countBookCoverage(key("ארצות החיים"));
    await repo.suggest();
    repo.setPickedBooks([key("ארצות החיים")]);
    repo.togglePickedPair(repo.suggestions.value!.proposals[0]!);
    repo.leaveBook();
    repo.dropStale();

    // the same state object: no link, rejection, undo step or revision was added, removed or replaced
    expect(store.linkState.value).toBe(state);
    expect(store.guided.saved.value).toBe(saved);
    expect(store.guided.active.value).toBe(false);
    expect(store.suggestions.run.value).toBeNull();
    // the project as saved differs only by the explicit coverage snapshot of the one book
    const after = JSON.parse(store.projectText());
    const { coverage: c0, savedAt: _a0, ...rest0 } = project;
    const { coverage: c1, savedAt: _a1, ...rest1 } = after;
    expect(rest1).toEqual(rest0);
    expect(c0 ?? []).toEqual([]);
    expect((c1 as { title: string }[]).map((c) => c.title)).toEqual(["ארצות החיים"]);
  });

  it("starting the guided flow from the screen keeps every link and decision of the project", async () => {
    const { store, repo, key } = await opened();
    await repo.analyze();
    repo.setPickedBooks([key("ארצות החיים")]);
    const state = store.linkState.value;
    store.guided.startForBooks(repo.chosenBooks(), []);
    expect(store.linkState.value).toBe(state);
    expect(store.guided.active.value).toBe(true);
  });
});
