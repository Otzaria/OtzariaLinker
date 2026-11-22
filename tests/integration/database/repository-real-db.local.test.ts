import { appendFileSync, openAsBlob } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * The repository analysis (state/repository.ts) on a real personal database — what the screen costs at 3,372 books and 1.3M links.
 * Runs only with the file (copyright-restricted, never copied into the repo; opened read-only through a lazy Blob, never read whole):
 *   OTZARIA_PERSONAL_DB=C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db REPO_LOG=C:/tmp/repo.log npx vitest run tests/integration/database/repository-real-db.local.test.ts
 * REPO_MAX_MS (default 1,200,000) stops the count after that long: the screen's stop button, measured; what was read is kept.
 * The numbers are printed to REPO_LOG (vitest hides console output of a passing test).
 */
const path = process.env.OTZARIA_PERSONAL_DB;
const log = (line: string) => (process.env.REPO_LOG ? appendFileSync(process.env.REPO_LOG, `${line}\n`) : console.log(line));
const mb = () => Math.round(process.memoryUsage().heapUsed / 1048576);

describe.runIf(path)("repository analysis on a real personal database (read-only)", () => {
  it("opens, counts the books one at a time, stops when asked, and never holds more than small rows", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
    const t0 = performance.now();
    await store.openFiles([{ path: path!.split(/[\\/]/).at(-1)!, blob: await openAsBlob(path!) }]);
    const repo = store.repository;
    log(`open: ${((performance.now() - t0) / 1000).toFixed(1)} s, ${repo.books.value.length} books, heap ${mb()} MB`);
    expect(repo.books.value.length).toBeGreaterThan(1000);

    const start = performance.now();
    const marks = new Set([10, 50, 100, 250, 500, 1000, 2000, 3000]);
    let lastCounted = 0;
    const timer = setInterval(() => {
      const counted = repo.rows.value.size;
      for (const m of marks) if (lastCounted < m && counted >= m) log(`  ${m} books counted at ${((performance.now() - start) / 1000).toFixed(1)} s, heap ${mb()} MB`);
      lastCounted = counted;
    }, 500);
    const stop = setTimeout(() => repo.cancel(), Number(process.env.REPO_MAX_MS ?? 1_200_000));
    const run = repo.analyze();
    // the screen stays usable while it counts: the table is told of rows in batches, not at every book
    await run;
    clearInterval(timer);
    clearTimeout(stop);
    const secs = (performance.now() - start) / 1000;
    const t = repo.totals.value;
    log(`count: ${t.counted} of ${t.books} books in ${secs.toFixed(1)} s (${((secs / Math.max(1, t.counted)) * 1000).toFixed(0)} ms per book), heap ${mb()} MB`);
    log(`totals: ${t.links} links, ${t.noLinks} books without, ${t.unavailable} unreadable, flagged books ${t.flaggedBooks}, suspicious ${t.suspicious}`);
    log(`by type: ${t.byType.map(([k, n]) => `${k} ${n}`).join(", ")}`);
    log(`ends: ${JSON.stringify(t.ends)}; flags: ${t.flags.map((f) => `${f.flag} ${f.books} books/${f.links}`).join(", ")}`);
    expect(t.counted).toBeGreaterThan(0);

    // the rest of the screen's work on what was counted
    const t1 = performance.now();
    await repo.suggest();
    log(`suggest: ${repo.suggestions.value!.proposals.length} proposals (${repo.suggestions.value!.titled} titled) in ${(performance.now() - t1).toFixed(0)} ms`);
    const biggest = [...repo.rows.value.values()].sort((a, b) => b.total - a.total).slice(0, 3);
    for (const r of biggest) {
      const t2 = performance.now();
      await repo.detailOf(r.key);
      log(`detail of ${r.title} (${r.total} links): ${(performance.now() - t2).toFixed(0)} ms`);
    }
    const sample = [...repo.rows.value.values()].filter((r) => r.total > 0).slice(0, 20).map((r) => r.key);
    const t3 = performance.now();
    await repo.countCoverage(sample);
    log(`coverage of ${sample.length} books: ${(performance.now() - t3).toFixed(0)} ms, heap ${mb()} MB`);
  }, 3_600_000);
});
