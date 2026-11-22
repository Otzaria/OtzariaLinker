import { signal } from "@preact/signals";
import { describe, expect, it } from "vitest";
import type { CoverageSummary } from "../../../src/linking/coverage";
import type { CoverageRow } from "../../../src/state/coverage";
import { RepositoryState, type RepositoryHost } from "../../../src/state/repository";

/*
 * The repository state under the timings the dialog can produce: a count that ends after the user moved to another database or
 * another book, a count that fails, and a book whose links could not be read. Fake host and service, so each moment is chosen.
 */
const book = (sid: string, n: number) => ({ key: `${sid}:${n}`, title: `${sid}-book-${n}`, lineCount: 10 });
const source = (sid: string, n: number) => ({ info: { id: sid, label: sid, kind: "otzaria-db" }, books: Array.from({ length: n }, (_, i) => book(sid, i + 1)) });

const counts = (linked: number, unlinked: number): Omit<CoverageSummary, "ranges"> => ({
  total: 10,
  byBucket: { linked, unlinked, partial: 0, multiple: 0, "not-suitable": 0, candidate: 0, doubtful: 0 },
  suitable: linked + unlinked,
  unlinked,
  unlinkedShare: unlinked / Math.max(1, linked + unlinked),
});
const summaryOf = (unlinked: number): CoverageSummary => ({ ...counts(10 - unlinked, unlinked), ranges: [] });

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
}

function make(opts: {
  rows?: (keys: readonly string[]) => AsyncGenerator<CoverageRow>;
  summary?: (key: string) => Promise<CoverageSummary | null>;
  read?: (key: string) => Promise<unknown>;
}) {
  const sources = signal<readonly unknown[]>([source("A", 2), source("B", 1)]);
  const host = {
    sources,
    coverage: {
      rows: (keys: readonly string[]) => (opts.rows ? opts.rows(keys) : (async function* () {})()),
      summary: opts.summary ?? (async () => null),
    },
    isLibrarySource: () => false,
  } as unknown as RepositoryHost;
  const service = {
    dbLinkSummary: async (key: string) => (opts.read ? opts.read(key) : { bookKey: key, total: 1, out: 1, in: 0, byType: [], byBook: [] }),
  };
  const repo = new RepositoryState(host, service as never);
  return { repo, sources };
}

describe("repository state: counts that end late", () => {
  it("a count that ends after the user chose another database does not put the old rows (or the time) back", async () => {
    const g = gate();
    const { repo } = make({ read: async (key) => (await g.opened, { bookKey: key, total: 1, out: 1, in: 0, byType: [], byBook: [] }) });
    const run = repo.analyze();
    repo.chooseSource("B");
    g.open();
    await run;
    expect(repo.rows.value.size).toBe(0);
    expect(repo.analyzedAt.value).toBeNull();
    expect(repo.running).toBe(false);
  });

  it("stopping keeps what was counted (only discarding drops it)", async () => {
    const g = gate();
    const { repo } = make({ read: async (key) => (await g.opened, { bookKey: key, total: 1, out: 1, in: 0, byType: [], byBook: [] }) });
    const run = repo.analyze();
    repo.cancel();
    g.open();
    await run;
    expect(repo.rows.value.size).toBe(1);
    expect(repo.analyzedAt.value).not.toBeNull();
  });

  it("dropStale says whether it dropped, and the count it stopped does not write the dropped rows back", async () => {
    const g = gate();
    const { repo, sources } = make({
      rows: async function* (keys) {
        await g.opened;
        yield { key: keys[0]!, title: "t", lineCount: 10, counts: counts(5, 5), exact: false };
      },
    });
    await repo.analyze();
    expect(repo.dropStale()).toBe(false);
    const run = repo.countCoverage([...repo.rows.value.keys()]);
    sources.value = [source("C", 1)]; // another database replaced this one
    expect(repo.dropStale()).toBe(true);
    expect(repo.rows.value.size).toBe(0);
    g.open();
    await run;
    expect(repo.rows.value.size).toBe(0);
    expect(repo.analyzedAt.value).toBeNull();
  });

  it("a coverage count that ends after the source changed does not write its rows", async () => {
    const g = gate();
    const { repo } = make({
      rows: async function* (keys) {
        await g.opened;
        yield { key: keys[0]!, title: "t", lineCount: 10, counts: counts(5, 5), exact: false };
      },
    });
    await repo.analyze();
    const key = [...repo.rows.value.keys()][0]!;
    const run = repo.countCoverage([key]);
    repo.chooseSource("B");
    g.open();
    await run;
    expect(repo.rows.value.size).toBe(0);
  });
});

describe("repository state: coverage failures", () => {
  it("a coverage count that fails does not reject (the dialog does not wait for it): it sets the error and keeps what was counted", async () => {
    let first = true;
    const { repo } = make({
      rows: async function* (keys) {
        for (const k of keys) {
          if (!first) throw new Error("db gone");
          first = false;
          yield { key: k, title: "t", lineCount: 10, counts: counts(5, 5), exact: false };
        }
      },
    });
    await repo.analyze();
    const keys = [...repo.rows.value.keys()];
    await expect(repo.countCoverage(keys)).resolves.toBeUndefined();
    expect(repo.error.value).toBe("חישוב הכיסוי נכשל: db gone");
    expect(repo.rows.value.get(keys[0]!)?.coverage).toBeDefined();
    expect(repo.progress.value).toBeNull();
    // the next count clears the message
    await repo.countCoverage([]);
    expect(repo.error.value).toBeNull();
  });

  it("a book the database says has links, whose count found no linked line, is unknown, not 100% unlinked", async () => {
    const { repo } = make({
      rows: async function* (keys) {
        for (const k of keys) yield { key: k, title: "t", lineCount: 10, counts: counts(0, 10), exact: false };
      },
      read: async (key) => ({ bookKey: key, total: key.endsWith(":1") ? 4 : 0, out: 0, in: 0, byType: [], byBook: [] }),
    });
    await repo.analyze();
    await repo.countCoverage(["A:1", "A:2"]);
    const withLinks = repo.rows.value.get("A:1")!;
    expect(withLinks.coverage).toBeUndefined();
    expect(withLinks.coverageUnknown).toContain("הכיסוי לא ידוע");
    // a book that really has no links is 100% unlinked, and says so
    expect(repo.rows.value.get("A:2")!.coverage).toMatchObject({ unlinked: 10, linked: 0 });
    expect(repo.rows.value.get("A:2")!.coverageUnknown).toBeUndefined();
  });

  it("the row says whether the count is exact (headings read), as its comment promises", async () => {
    const { repo } = make({
      rows: async function* (keys) {
        for (const k of keys) yield { key: k, title: "t", lineCount: 10, counts: counts(5, 5), exact: k === "A:1" };
      },
    });
    await repo.analyze();
    await repo.countCoverage(["A:1", "A:2"]);
    expect(repo.rows.value.get("A:1")!.coverage!.exact).toBe(true);
    expect(repo.rows.value.get("A:2")!.coverage!.exact).toBe(false);
  });
});

describe("repository state: one book's coverage", () => {
  it("the slow count of book A that ends after the user moved to book B is not shown under B", async () => {
    const gA = gate();
    const { repo } = make({
      summary: async (key) => (key === "A:1" ? (await gA.opened, summaryOf(7)) : summaryOf(2)),
    });
    const slow = repo.countBookCoverage("A:1");
    repo.leaveBook(); // the details of B open
    await repo.countBookCoverage("A:2");
    expect(repo.bookCoverage.value).toMatchObject({ bookKey: "A:2", summary: { unlinked: 2 } });
    gA.open();
    await slow;
    expect(repo.bookCoverage.value).toMatchObject({ bookKey: "A:2", summary: { unlinked: 2 } });
    expect(repo.bookCoverageBusy.value).toBeNull();
  });

  it("a count that fails or finds the book closed sets the error and no coverage", async () => {
    const a = make({ summary: async () => Promise.reject(new Error("nope")) });
    await a.repo.countBookCoverage("A:1");
    expect(a.repo.error.value).toBe("חישוב הכיסוי נכשל: nope");
    expect(a.repo.bookCoverage.value).toBeNull();
    const b = make({ summary: async () => null });
    await b.repo.countBookCoverage("A:1");
    expect(b.repo.error.value).toContain("הספר לא פתוח");
    expect(b.repo.bookCoverageBusy.value).toBeNull();
  });
});
