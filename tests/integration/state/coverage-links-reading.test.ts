import { signal } from "@preact/signals";
import { describe, expect, it } from "vitest";
import { CoverageState, type CoverageHost } from "../../../src/state/coverage";

/*
 * Fix round, claim 3: the database's links of a book are read for coverage, and the read can fail. "No links", "not asked" and
 * "the read failed" are three different answers (CoverageReport.links, docs/AUTOMATION_ENGINE.md §5.8). Before, a failed read was
 * swallowed into [] and the book looked like one with no links at all.
 */
describe("the database's links: no links, unknown, and a failed read are three different answers", () => {
  /** a book of 5 lines with text, whose link read is whatever the test makes it */
  function fake(existingLinks: () => Promise<unknown[]>) {
    const book = { key: "k", title: "ספר", origin: "otzaria", lineCount: 5 } as never;
    const host = {
      linkState: signal({ links: new Map() }),
      books: signal(new Map([["k", book]])),
      lines: { count: () => 5, learnCount: async () => 5 },
      sameBook: (ref: { key: string }) => ref.key === "k",
      runTask: async (_label: string, run: (o: object) => Promise<unknown>) => {
        try {
          return await run({});
        } catch {
          return null; // what AppStore.runTask does with a throw: notify and answer null
        }
      },
      suggestions: { run: signal(null), state: signal(new Map()) },
      quality: { report: signal(null) },
    } as unknown as CoverageHost;
    const service = {
      headings: async () => [],
      lines: async () => Array.from({ length: 5 }, (_, i) => ({ index: i, text: "שורה עם אותיות", heading: null })),
      existingLinks,
    };
    return new CoverageState(host, service as never);
  }
  const dbLink = (line: number) => ({ id: `d${line}`, status: "unchanged", provenance: "db", source: { book: { key: "k", title: "ספר", origin: "otzaria" }, line }, target: { book: { key: "z", title: "בסיס", origin: "otzaria" }, line: 1 }, declaredType: "commentary", heRef2: "" });

  it("a read that FAILS is reported as failed, with the reason: never as a book with no links", async () => {
    const state = fake(async () => {
      throw new Error("disk read error");
    });
    const s = (await state.summary("k"))!;
    expect(s).not.toBeNull();
    expect(s.links).toEqual({ state: "failed", message: "disk read error" });
    // nothing is saved to the project as 'the coverage' of a book whose links could not be read
    expect(state.snapshot()).toEqual([]);
  });

  it("a read that succeeds with no rows is 'none'; with rows it is 'counted' and the lines are linked", async () => {
    expect((await fake(async () => []).summary("k"))!.links).toEqual({ state: "none" });
    const counted = (await fake(async () => [dbLink(1), dbLink(2)]).summary("k"))!;
    expect(counted.links).toEqual({ state: "counted", count: 2 });
    expect(counted.byBucket.linked).toBe(2);
  });

  it("a counted or empty read is saved as the project's coverage; a failed or unasked one is not", async () => {
    const ok = fake(async () => []);
    await ok.summary("k");
    expect(ok.snapshot()).toHaveLength(1);
    const unasked = fake(async () => []);
    await unasked.summary("k", { includeDb: false });
    expect(unasked.snapshot()).toEqual([]);
  });

  it("not asking for the database's links is 'unknown': the counts say nothing about them", async () => {
    let called = 0;
    const state = fake(async () => (called++, []));
    const s = (await state.summary("k", { includeDb: false }))!;
    expect(s.links).toEqual({ state: "unknown", why: "not-requested" });
    expect(called).toBe(0);
  });

  it("a failed read in the table: the row says failed, and a good empty read says none", async () => {
    const state = fake(async () => {
      throw new Error("boom");
    });
    const [row] = await state.table(["k"]);
    expect(row!.links).toEqual({ state: "failed", message: "boom" });
    const ok = (await fake(async () => []).table(["k"]))[0]!;
    expect(ok.links).toEqual({ state: "none" });
    const off = (await fake(async () => []).table(["k"], { includeDb: false }))[0]!;
    expect(off.links).toEqual({ state: "unknown", why: "not-requested" });
  });

  it("a cancel is not a failure: the table stops with no row", async () => {
    const ctl = new AbortController();
    const state = fake(async () => {
      ctl.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    expect(await state.table(["k"], { signal: ctl.signal })).toEqual([]);
  });
});

describe("a book of a text file has no database (#42 C14)", () => {
  it("its reading says so — not 'read from the database: none'", async () => {
    const book = { key: "t:ספר.txt", title: "ספר", origin: "otzaria", lineCount: 3 } as never;
    const host = {
      linkState: signal({ links: new Map() }),
      books: signal(new Map([["t:ספר.txt", book]])),
      sources: signal([{ info: { id: "t", kind: "text-files", label: "ספר.txt", warnings: [] }, books: [book] }]),
      lines: { count: () => 3, learnCount: async () => 3 },
      sameBook: (ref: { key: string }) => ref.key === "t:ספר.txt",
      runTask: async (_label: string, run: (o: object) => Promise<unknown>) => run({}),
      suggestions: { run: signal(null), state: signal(new Map()) },
      quality: { report: signal(null) },
    } as unknown as CoverageHost;
    const service = { headings: async () => [], lines: async () => Array.from({ length: 3 }, (_, i) => ({ index: i, text: "שורה", heading: null })), existingLinks: async () => [] };
    const s = (await new CoverageState(host, service as never).summary("t:ספר.txt"))!;
    expect(s.links).toEqual({ state: "no-database" });
    const { linksReadingText } = await import("../../../src/linking/coverage");
    expect(linksReadingText(s.links!)).not.toContain("מהמסד");
  });
});
