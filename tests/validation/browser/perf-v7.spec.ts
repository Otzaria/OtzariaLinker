import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "../../e2e/helpers";
import { syntheticLinksFile, SYNTH_SOURCE } from "../../support/synthetic-links";

/*
 * V7 §4.12 measurements in the BUILT single file, offline from file://, in the installed Chrome (docs/reviews/V7_PERFORMANCE.md):
 * how long the main thread is blocked (long tasks of 50 ms and more, PerformanceObserver "longtask") and how its JS heap grows
 * while it
 *   - imports a links file of 235,000 synthetic records (#42 C5),
 *   - autosaves a project of 100,000 links after one edit (#42 C5),
 *   - with OTZARIA_DB: opens the library database, reads the first screen of בראשית, reads all of its links, counts the coverage
 *     of 200 books and stops a coverage count (#42 C7, C8).
 * The database is only READ, by path. Aggregate numbers only. Runs only when asked:
 *   npm run build && PERF_V7=1 [OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db] [PERF_URL=other.html] [VALIDATION_OUT=dir] \
 *     npx playwright test --config playwright.validation.config.ts perf-v7
 * What it cannot see: the worker's heap (performance.memory is the page's), and work the worker does (it never blocks the page).
 */
const ON = !!process.env.PERF_V7;
const DB = process.env.OTZARIA_DB;
const URL = process.env.PERF_URL ? pathToFileURL(resolve(process.env.PERF_URL)).href : distUrl;
test.use({ launchOptions: { args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] } });

interface Probe {
  long: number[];
  starts: number[];
  heap: number[];
}

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const m = { long: [] as number[], starts: [] as number[], heap: [] as number[] };
    (globalThis as unknown as { __m: typeof m }).__m = m;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) (m.long.push(e.duration), m.starts.push(e.startTime));
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* no long task API */
    }
    setInterval(() => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      if (mem) m.heap.push(mem.usedJSHeapSize);
    }, 50);
  });
}

/** resets the counters (after a GC when the page can ask for one), returns a function that reads what happened since */
async function window_(page: Page) {
  const base = await page.evaluate(() => {
    (globalThis as unknown as { gc?: () => void }).gc?.();
    const m = (globalThis as unknown as { __m: Probe }).__m;
    m.long.length = 0;
    m.starts.length = 0;
    m.heap.length = 0;
    return (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
  });
  const t0 = Date.now();
  return async () => {
    const m = await page.evaluate(() => (globalThis as unknown as { __m: Probe }).__m);
    const mb = (b: number) => Math.round(b / 1048576);
    return {
      ms: Date.now() - t0,
      longTasks: m.long.length,
      longestTaskMs: Math.round(Math.max(0, ...m.long)),
      totalLongMs: Math.round(m.long.reduce((a, b) => a + b, 0)),
      heapStartMB: mb(base),
      heapPeakAboveStartMB: m.heap.length ? mb(Math.max(...m.heap) - base) : null,
    };
  };
}

const store = <T>(page: Page, fn: string): Promise<T> => page.evaluate((f) => new Function("store", `return (async () => (${f}))()`)((globalThis as unknown as { __linker: unknown }).__linker) as Promise<T>, fn);

/** with PERF_PROFILE=dir: a CPU profile of the page's main thread while `run` runs (for finding what blocks; unminified builds) */
async function profiled<T>(page: Page, name: string, run: () => Promise<T>): Promise<T> {
  if (!process.env.PERF_PROFILE) return run();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  const value = await run();
  const { profile } = await cdp.send("Profiler.stop");
  mkdirSync(process.env.PERF_PROFILE, { recursive: true });
  writeFileSync(join(process.env.PERF_PROFILE, `${name}.cpuprofile`), JSON.stringify(profile));
  return value;
}

function report(name: string, out: unknown) {
  console.info(`PERF_V7 ${name} ${JSON.stringify(out)}`);
  if (process.env.VALIDATION_OUT) {
    mkdirSync(process.env.VALIDATION_OUT, { recursive: true });
    writeFileSync(join(process.env.VALIDATION_OUT, `perf-v7-${name}.json`), JSON.stringify(out, null, 2));
  }
}

/**
 * The slice's database and the given files, by PATH: a file handed over as a buffer is rebuilt inside the page by Playwright
 * (base64 decoding on the main thread, seconds for 40 MB), which would be measured as if it were the tool's work.
 */
async function openMini(page: Page, files: string[] = []) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([resolve("tests/fixtures/db/seforim-v7-mini.db"), ...files]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 120_000 });
}

test.describe("V7 performance", () => {
  test.skip(!ON, "needs PERF_V7");

  test("import of 235,000 records (C5)", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const seen = watchPage(page);
    await installProbe(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(URL);
    const file = test.info().outputPath(`${SYNTH_SOURCE}_links.json`);
    writeFileSync(file, syntheticLinksFile(235_000));
    // the links file with the (small) database of its books, in one pick, as a user drops them
    const w = await window_(page);
    await profiled(page, "import", async () => {
      await openMini(page, [file]);
      await expect.poll(() => store<number>(page, "store.allLinks.value.length"), { timeout: 5 * 60_000, intervals: [200] }).toBe(235_000);
      // what the page does right after the links arrive (lists, counts) is part of the import
      await page.waitForTimeout(1500);
    });
    const out = { fileMB: +(statSync(file).size / 1048576).toFixed(1), ...(await w()) };
    report("import", out);
    expect(seen.external).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  test("autosave of 100,000 links after one edit (C5)", async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const seen = watchPage(page);
    await installProbe(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(URL);
    const file = test.info().outputPath(`${SYNTH_SOURCE}_links.json`);
    writeFileSync(file, syntheticLinksFile(100_000));
    await openMini(page, [file]);
    await expect.poll(() => store<number>(page, "store.allLinks.value.length"), { timeout: 5 * 60_000 }).toBe(100_000);
    await expect.poll(() => store<string>(page, "store.autosave.value"), { timeout: 5 * 60_000 }).toBe("saved");
    const size = await store<number>(page, "store.projectText().length");
    const reps: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const w = await window_(page);
      // the edit's own work (lists re-drawn) comes first; the autosave starts 1.5 s later: told apart by when each long task began
      const editAt = await profiled(page, `autosave${i}`, async () => {
        const at = await store<number>(page, `(store.deleteLinks([store.allLinks.value[${i}].id]), performance.now())`);
        await expect.poll(() => store<string>(page, "store.autosave.value"), { timeout: 60_000, intervals: [50] }).toBe("saved");
        await page.waitForTimeout(500);
        return at;
      });
      const m = await page.evaluate(() => (globalThis as unknown as { __m: Probe }).__m);
      const save = m.long.filter((_, k) => m.starts[k]! >= editAt + 1000);
      reps.push({ ...(await w()), autosaveLongTasks: save.length, autosaveLongestMs: Math.round(Math.max(0, ...save)), autosaveTotalMs: Math.round(save.reduce((a, b) => a + b, 0)) });
    }
    const direct = await store<number[]>(page, "[0, 1, 2].map(() => { const t = performance.now(); store.projectText(); return Math.round(performance.now() - t); })");
    report("autosave", { projectChars: size, reps, projectTextMs: direct });
    expect(seen.errors).toEqual([]);
  });

  test("seforim.db: open, first screen, links of בראשית, coverage of 200 books, stop (C7, C8)", async ({ page }) => {
    test.skip(!DB, "needs OTZARIA_DB");
    test.setTimeout(60 * 60_000);
    const seen = watchPage(page);
    await installProbe(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(URL);
    const out: Record<string, unknown> = {};
    let w = await window_(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "קבצים", exact: true }).click();
    await (await chooser).setFiles(DB!);
    await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 300_000 });
    out.open = await w();
    report("db", out);
    const key = await store<string>(page, `[...store.books.value.values()].find((b) => b.title === "בראשית" && /sefaria/i.test(b.sourceName ?? ""))?.key ?? [...store.books.value.values()].find((b) => b.title === "בראשית").key`);

    w = await window_(page);
    const firstScreen = await store<number>(page, `store.service.lines(${JSON.stringify(key)}, 0, 199).then((l) => l.length)`);
    out.firstScreen = { lines: firstScreen, ...(await w()) };

    w = await window_(page);
    const links = await store<number>(page, `store.service.existingLinks(${JSON.stringify(key)}, 0, Number.MAX_SAFE_INTEGER).then((l) => l.length)`);
    out.linksOfBereshit = { links, ...(await w()) };
    report("db", out);
    // the compact read the coverage uses since #42 C8 (absent in older builds)
    if (await store<boolean>(page, "typeof store.service.coverageEnds === 'function'")) {
      w = await window_(page);
      const ends = await store<number>(page, `store.service.coverageEnds(${JSON.stringify(key)}).then((e) => e.links)`);
      out.coverageEndsOfBereshit = { links: ends, ...(await w()) };
      report("db", out);
    }

    w = await window_(page);
    const one = await store<unknown>(page, `store.coverage.table([${JSON.stringify(key)}]).then((r) => r.map((x) => x.counts.total))`);
    out.coverageOfBereshit = { rows: one, ...(await w()) };
    report("db", out);

    // 200 books spread over the database: every 40th book that has a length, in the database's order
    const keys = await store<string[]>(page, "[...store.books.value.values()].filter((b) => (b.lineCount ?? 0) > 0).filter((_, i) => i % 40 === 0).slice(0, 200).map((b) => b.key)");
    w = await window_(page);
    const rows = await store<number>(page, `store.coverage.table(${JSON.stringify(keys)}).then((r) => r.length)`);
    out.coverage200 = { books: keys.length, rows, ...(await w()) };
    report("db", out);

    // stop: a count of the 200 books, stopped after two seconds; how long until it has stopped
    const stop = await store<{ stopMs: number; rows: number; workerFreeMs: number }>(
      page,
      `(async () => {
        const ctl = new AbortController();
        const keys = ${JSON.stringify(keys)};
        let rows = 0;
        const run = (async () => { for await (const _ of store.coverage.rows(keys, { signal: ctl.signal })) rows++; })();
        await new Promise((r) => setTimeout(r, 2000));
        const t = performance.now();
        ctl.abort();
        await run.catch(() => {});
        const stopMs = Math.round(performance.now() - t);
        // and when is the worker free again? a small read waits behind whatever the stopped read still does
        const t2 = performance.now();
        await store.service.lines(keys[1], 0, 9);
        return { stopMs, rows, workerFreeMs: Math.round(performance.now() - t2) };
      })()`,
    );
    out.stop = stop;
    out.errors = seen.errors.length;
    out.external = seen.external.length;
    report("db", out);
    expect(seen.external).toEqual([]);
  });
});
