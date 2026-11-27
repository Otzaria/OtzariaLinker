import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { linkMatchIndex, matchIndexOf } from "../../../src/core/links/equality";
import type { Link } from "../../../src/core/links/model";
import { validateExport } from "../../../src/core/links/validate";
import type { BookSource } from "../../../src/sources/book-source";
import { SourceRegistry } from "../../../src/sources/registry";
import { addChanges, commit } from "../../../src/state/history";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V7 round 2 item 11 (docs/reviews/V7_PERFORMANCE.md §10): the quality check and the export read the database links at their links'
 * lines one worker call per run of consecutive lines, each returning every Link there (V7 §4.9: ~100 ms a link on seforim.db). The
 * worker's existingMatchIndexes reads every run of a book at once and sends back only the identities. Proven here to give exactly
 * what the run-by-run read gives, on the real slice of the official database (a `link` table: the one-pass read) and on a personal
 * database (external_link: the run-by-run read in the worker), and that the check gives the same problems either way.
 */
const SEFORIM = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });
const PDC = () => ({ path: "pdc.db", blob: new Blob([readFileSync("tests/fixtures/db/pdc-personal-mini.db")]) });

function rng(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("existingMatchIndexes: the match index of many runs in one call, the same as run by run", () => {
  for (const [name, file] of [
    ["the official database's slice (link table)", SEFORIM],
    ["a personal database (external_link)", PDC],
  ] as const)
    it(name, async () => {
      const reg = new SourceRegistry();
      const opened = await reg.open([file()]);
      const src = opened.sources[0]!;
      const r = rng(7);
      let compared = 0;
      let nonEmpty = 0;
      for (const b of src.books) {
        const n = (await reg.lines(b.key, 0, Number.MAX_SAFE_INTEGER)).length;
        if (!n) continue;
        // runs of every shape: single lines, long runs, the whole book, past its end, overlapping, an empty book range
        const runs: [number, number][] = [[0, n - 1], [n, n + 5], [Math.max(0, n - 3), n + 2]];
        for (let k = 0; k < 12; k++) {
          const from = Math.floor(r() * n);
          runs.push([from, Math.min(n - 1, from + Math.floor(r() * 4) * Math.floor(r() * 30))]);
        }
        runs.push([runs[4]![0], runs[4]![1]]);
        const got = await reg.existingMatchIndexes(b.key, runs);
        expect(got).toHaveLength(runs.length);
        for (let i = 0; i < runs.length; i++) {
          const want = linkMatchIndex(await reg.existingLinks(b.key, runs[i]![0], runs[i]![1]));
          const have = matchIndexOf(got[i]!);
          expect(sorted(have.links), `${b.title} ${runs[i]}`).toEqual(sorted(want.links));
          expect(sorted(have.pairs), `${b.title} ${runs[i]}`).toEqual(sorted(want.pairs));
          compared++;
          if (want.pairs.size) nonEmpty++;
        }
      }
      // the comparison is not vacuous: many runs, and runs that hold links
      expect(compared).toBeGreaterThan(40);
      expect(nonEmpty).toBeGreaterThan(10);
      // which path ran: the one-pass read for a `link` table, run by run for external_link
      const source = (reg as unknown as { of(key: string): BookSource }).of(src.books[0]!.key);
      expect(await source.existingMatchIndexes?.(src.books[0]!.key, [[0, 3]])).toEqual(file === SEFORIM ? expect.any(Array) : null);
    });
});

/** the real service, counting the database reads the check makes; optionally without the batched operation (the old path) */
function counted(batched: boolean) {
  const calls = { existingLinks: 0, existingMatchIndexes: 0 };
  const base = registryService(new SourceRegistry());
  const service: BooksService = {
    ...base,
    existingLinks: (...a) => (calls.existingLinks++, base.existingLinks(...a)),
    existingMatchIndexes: batched ? (...a) => (calls.existingMatchIndexes++, base.existingMatchIndexes!(...a)) : undefined,
  };
  if (!batched) delete service.existingMatchIndexes;
  return { service, calls };
}

describe("the check reads the database links of a book in one call, with the same result (V7 round 2 item 11)", () => {
  it("project links on many lines of the slice: the same problems, one batched call per book instead of a call per run", async () => {
    const results: { calls: { existingLinks: number; existingMatchIndexes: number }; problems: string[]; quality: string[]; books: number }[] = [];
    for (const batched of [false, true]) {
      const { service, calls } = counted(batched);
      const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
      await store.openFiles([SEFORIM()]);
      const src = store.sources.value[0]!;
      const ber = src.books.find((b) => b.title === "בראשית")!;
      // the database's own links of בראשית, copied into the project (some "already in the database"), shifted (not), every 3rd line
      const db = await service.existingLinks(ber.key, 0, 400);
      expect(db.length).toBeGreaterThan(50);
      const copies: Link[] = db.slice(0, 120).map((l, i) => ({
        ...l,
        id: `u:${i}`,
        status: "new",
        provenance: "user",
        ...(i % 3 === 0 && { target: { ...l.target, line: l.target.line + 1 } }),
      }));
      store.linkState.value = commit(store.linkState.value, "test", addChanges(copies));
      calls.existingLinks = 0;
      calls.existingMatchIndexes = 0;
      expect(await store.loadLinkLines("בודק")).toBe(true);
      const problems = validateExport(store.allLinks.value, store.validation());
      const flat = [...problems].flatMap(([id, ps]) => ps.map((p) => `${id} ${p.code}`)).sort();
      const quality = ((await store.quality.run())?.issues ?? []).map((i) => `${i.link.id} ${i.problem.code}`).sort();
      results.push({ calls: { ...calls }, problems: flat, quality, books: new Set(copies.flatMap((l) => [l.source.book.key, l.target.book.key])).size });
    }
    const [old, now] = results as [(typeof results)[0], (typeof results)[0]];
    expect(now.problems).toEqual(old.problems);
    expect(now.quality).toEqual(old.quality);
    // not vacuous: the copies are found in the database ("export/in-db…": the same link, or the same lines of another type), the
    // shifted ones are not
    const inDb = old.problems.filter((p) => p.includes(" export/in-db"));
    expect(inDb.length).toBeGreaterThan(40);
    expect(inDb.length).toBeLessThan(120);
    // the old path: a call per run of lines; the batched one: a call per book, and no Link crosses
    expect(old.calls.existingLinks).toBeGreaterThan(5);
    expect(now.calls.existingLinks).toBe(0);
    expect(now.calls.existingMatchIndexes).toBeLessThanOrEqual(now.books);
    expect(now.calls.existingMatchIndexes).toBeLessThan(old.calls.existingLinks);
  });
});

/*
 * V7 round 2 review, finding 11: the one-pass read (DbSource.existingMatchIndexes, DbLinksReader.atLinesBare) took no signal, so a
 * cancelled check went on reading the line indexes, the link rows and the line rows of every run to the end — the cancel was seen only
 * by the next book. It now stops between its reads. Watched on the database file the reads go through.
 */
describe("a cancel stops the batched read between its reads", () => {
  type Reads = Record<"seekIndexMany" | "getMany", (...a: unknown[]) => Promise<unknown>>;
  async function opened() {
    const reg = new SourceRegistry();
    const src = (await reg.open([SEFORIM()])).sources[0]!;
    const ber = src.books.find((b) => b.title === "בראשית")!;
    const source = (reg as unknown as { of(key: string): BookSource }).of(ber.key);
    const file = (source as unknown as { links: { file: Reads } }).links.file;
    return { reg, key: ber.key, file };
  }
  const RUNS: [number, number][] = [
    [0, 40],
    [60, 90],
    [200, 230],
  ];

  it("cancelled after the first index read: nothing more is read, and the call fails as cancelled", async () => {
    const { reg, key, file } = await opened();
    const ac = new AbortController();
    const after: string[] = [];
    for (const name of ["seekIndexMany", "getMany"] as const) {
      const real = file[name].bind(file);
      file[name] = async (...a: unknown[]) => {
        if (ac.signal.aborted) after.push(name);
        const r = await real(...a);
        if (name === "seekIndexMany") ac.abort();
        return r;
      };
    }
    await expect(reg.existingMatchIndexes(key, RUNS, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(after).toEqual([]);
  });

  it("cancelled before: no read at all; never cancelled: the same result as without a signal", async () => {
    const { reg, key, file } = await opened();
    const want = await reg.existingMatchIndexes(key, RUNS);
    expect(want.some((m) => m.pairs.length > 0)).toBe(true);
    expect(await reg.existingMatchIndexes(key, RUNS, new AbortController().signal)).toEqual(want);
    let reads = 0;
    for (const name of ["seekIndexMany", "getMany"] as const) {
      const real = file[name].bind(file);
      file[name] = (...a: unknown[]) => (reads++, real(...a));
    }
    await expect(reg.existingMatchIndexes(key, RUNS, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(0);
  });
});
