import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "../../e2e/helpers";

/*
 * The repository analysis on a REAL large personal database (v52: 1.74 GB, 3,372 books), through the file chooser of the built
 * single file in Chrome, offline from file://. Measures what the reviewer asked for and nothing else: how long the page is
 * blocked (long tasks of 50 ms and more, and the longest gap between two animation frames), how the main thread's JS heap
 * grows, how long things take, that "stop" stops, that the analysis continues from where it was stopped, that switching the
 * database in the middle cancels the old scan (no rows of the old database under the new one), the coverage of 200 books,
 * and the title fit of three pairs of the biggest books the pair finder proposes.
 *
 * The database is only READ, by path (nothing is copied into memory or into the repository). Aggregate numbers only: book
 * titles and text are never printed or written. Skipped without V52_DB.
 *   npm run build && V52_DB=C:/path/otzarya-unofficial-books-52.db npx playwright test --config playwright.validation.config.ts repository-real-v52
 *
 * What it cannot see: the memory of the database worker (a separate heap; performance.memory is the page's), and the browser
 * process's memory; a person's perception of "frozen" (it measures main-thread blocking, which is what freezes a page).
 */
const DB = process.env.V52_DB;
test.skip(!DB, "needs V52_DB");
test.use({ launchOptions: { args: ["--enable-precise-memory-info"] } });

interface Probe {
  long: number[];
  maxFrameGap: number;
  heap: [number, number][];
}

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const m = { long: [] as number[], maxFrameGap: 0, heap: [] as [number, number][] };
    (globalThis as unknown as { __m: typeof m }).__m = m;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) m.long.push(e.duration);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      /* no long task API */
    }
    let last = performance.now();
    const frame = () => {
      const now = performance.now();
      if (now - last > m.maxFrameGap) m.maxFrameGap = now - last;
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    setInterval(() => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      if (mem) m.heap.push([Math.round(performance.now()), mem.usedJSHeapSize]);
    }, 500);
  });
}

/** resets the counters, returns a function that reads what happened since */
async function window_(page: Page) {
  await page.evaluate(() => {
    const m = (globalThis as unknown as { __m: Probe }).__m;
    m.long.length = 0;
    m.maxFrameGap = 0;
    m.heap.length = 0;
  });
  const t0 = Date.now();
  return async () => {
    const m = await page.evaluate(() => (globalThis as unknown as { __m: Probe }).__m);
    const heaps = m.heap.map((h) => h[1]);
    const mb = (b: number) => Math.round(b / 1048576);
    return {
      ms: Date.now() - t0,
      longTasks: m.long.length,
      longestTaskMs: Math.round(Math.max(0, ...m.long)),
      totalLongMs: Math.round(m.long.reduce((a, b) => a + b, 0)),
      maxFrameGapMs: Math.round(m.maxFrameGap),
      heapStartMB: heaps.length ? mb(heaps[0]!) : null,
      heapPeakMB: heaps.length ? mb(Math.max(...heaps)) : null,
      heapEndMB: heaps.length ? mb(heaps.at(-1)!) : null,
    };
  };
}

const repo = <T>(page: Page, fn: string): Promise<T> => page.evaluate((f) => new Function("repo", "store", `return (${f})`)((globalThis as unknown as { __linker: { repository: unknown } }).__linker.repository, (globalThis as unknown as { __linker: unknown }).__linker) as T, fn);

test("v52 in the built tool: analysis, stop, resume, switching the database, coverage, title fit", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const seen = watchPage(page);
  const out: Record<string, unknown> = { dbBytes: statSync(DB!).size };
  await installProbe(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);

  // 1. open: the real database by path, then a small second one (for the switch test), both read-only
  const small = "tests/fixtures/db/seforim-v7-mini.db";
  let w = await window_(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles(DB!);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 180_000 });
  out.open = await w();

  // 2. the repository screen; nothing is read until asked
  await page.evaluate(() => (location.hash = "#/repository"));
  const dlg = page.locator("dialog.repository");
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  out.books = await repo<number>(page, "repo.books.value.length");
  expect(await repo<number>(page, "repo.rows.value.size")).toBe(0);

  // 3. stop: start, wait for some books, press the real button, see it stop and keep what it had
  w = await window_(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect.poll(() => repo<number>(page, "repo.rows.value.size"), { timeout: 120_000 }).toBeGreaterThanOrEqual(300);
  const stopAt = Date.now();
  await dlg.getByRole("button", { name: "עצירה" }).click();
  await expect(dlg.getByRole("button", { name: /המשך הניתוח/ })).toBeVisible({ timeout: 60_000 });
  const stopMs = Date.now() - stopAt;
  const keptAtStop = await repo<number>(page, "repo.rows.value.size");
  await page.waitForTimeout(2000);
  const keptLater = await repo<number>(page, "repo.rows.value.size");
  out.stop = { stopMs, countedAtStop: keptAtStop, countedTwoSecondsLater: keptLater, progressCleared: await repo<boolean>(page, "repo.progress.value === null") };
  expect(keptLater, "the count kept going after stop").toBe(keptAtStop);
  expect(keptAtStop).toBeGreaterThanOrEqual(300);
  out.firstPart = await w();

  // 4. resume: continues with the books not yet counted and finishes
  w = await window_(page);
  await dlg.getByRole("button", { name: /המשך הניתוח/ }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 20 * 60_000 });
  out.resume = await w();
  out.totals = await repo<unknown>(page, "(({ books, counted, links, noLinks }) => ({ books, counted, links, noLinks }))(repo.totals.value)");
  expect(await repo<number>(page, "repo.rows.value.size")).toBe(out.books as number);

  // 5. the list stays usable on 3,372 rows: search and sort answer
  w = await window_(page);
  await dlg.getByLabel("סדר הרשימה").selectOption("links-desc");
  await expect(dlg.locator(".repo-book").first()).toContainText("קישורים");
  await dlg.getByLabel("חיפוש ספר").fill("א");
  await dlg.getByLabel("חיפוש ספר").fill("");
  out.listInteraction = await w();

  // 6. coverage of 200 books (the dialog's own button)
  w = await window_(page);
  await dlg.getByLabel("אילו ספרים להציג").selectOption("all");
  await dlg.getByRole("button", { name: "חישוב כיסוי לספרים שברשימה" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל/)).toBeVisible({ timeout: 10 * 60_000 });
  await expect.poll(() => repo<number>(page, "[...repo.rows.value.values()].filter((r) => r.coverage).length"), { timeout: 10 * 60_000 }).toBeGreaterThan(0);
  out.coverage200 = { ...(await w()), booksWithCoverage: await repo<number>(page, "[...repo.rows.value.values()].filter((r) => r.coverage || r.coverageUnknown).length") };

  // 7. title fit of the three biggest proposed pairs, through the guided plan's pair rows
  await dlg.getByRole("button", { name: "הצעת זוגות לפי השמות" }).click();
  await dlg.getByLabel("גם ספרים שכבר מקושרים").check();
  await expect.poll(() => repo<number>(page, "repo.suggestions.value?.proposals.length ?? 0"), { timeout: 120_000 }).toBeGreaterThan(0);
  const pairInfo = await repo<{ n: number; lines: number[] }>(
    page,
    `(() => {
      const size = (k) => store.books.value.get(k)?.lineCount ?? 0;
      const ps = repo.suggestions.value.proposals.filter((p) => p.dependant.key && p.base.key).map((p) => ({ p, s: size(p.dependant.key) + size(p.base.key) })).sort((a, b) => b.s - a.s).slice(0, 3);
      for (const { p } of ps) repo.togglePickedPair(p);
      return { n: repo.suggestions.value.proposals.length, lines: ps.map((x) => x.s) };
    })()`,
  );
  out.pairs = { proposed: pairInfo.n, pairLinesPicked: pairInfo.lines };
  await dlg.getByRole("button", { name: "השלמת קישורים לנבחרים" }).click();
  await expect(page).toHaveURL(/#\/guided\/books$/, { timeout: 60_000 });
  const main = page.locator("main.guided");
  w = await window_(page);
  await main.locator(".guided-foot").getByRole("button", { name: /^הבא/ }).click();
  await expect(page).toHaveURL(/#\/guided\/plan$/, { timeout: 120_000 });
  const pairs = main.locator("details.guided-pairs");
  await pairs.locator("summary").click();
  await expect(pairs.locator(".pair-row").first()).toBeVisible({ timeout: 120_000 });
  // every pair row has its verdict (the fit is computed in a worker, whole books read)
  await expect.poll(async () => (await pairs.locator(".pair-fit .fit-badge").count()) >= 3, { timeout: 15 * 60_000, intervals: [1000] }).toBe(true);
  out.titleFit3 = { ...(await w()), pairRows: await pairs.locator(".pair-row").count() };

  // 8. switching the database in the middle of a scan: the old scan is cancelled, nothing of it appears under the new one
  // a second, small database is opened next to it (read-only too), from the workspace's "add" menu
  await page.evaluate(() => ((globalThis as unknown as { __linker: { screen: { value: string } } }).__linker.screen.value = "workspace"));
  await page.getByRole("button", { name: "הוספת קובץ או מסד" }).click();
  const second = page.waitForEvent("filechooser");
  await page.locator(".add-options").getByRole("button", { name: /^מסד נתונים/ }).click();
  await (await second).setFiles(small);
  await expect.poll(() => repo<number>(page, "repo.repositories.value.length"), { timeout: 60_000 }).toBe(2);
  await page.evaluate(() => (location.hash = "#/repository"));
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  const sources = await repo<{ id: string; books: number }[]>(page, "repo.repositories.value.map((s) => ({ id: s.info.id, books: s.books.length }))");
  out.sourcesOpen = sources.map((s) => s.books);
  expect(sources.length).toBe(2);
  const big = sources.find((s) => s.books > 1000)!;
  const mini = sources.find((s) => s.books <= 1000)!;
  // start the big one again from scratch and switch away while it runs (the select is disabled while busy in the UI; the state call is what a late event would make)
  await repo<void>(page, `repo.chooseSource(${JSON.stringify(big.id)})`);
  await repo<void>(page, "void repo.analyze(true)");
  await expect.poll(() => repo<number>(page, "repo.rows.value.size"), { timeout: 120_000 }).toBeGreaterThan(50);
  expect(await dlg.getByLabel("המסד לניתוח").isDisabled(), "the database select is disabled during a run").toBe(true);
  const switchAt = Date.now();
  await repo<void>(page, `repo.chooseSource(${JSON.stringify(mini.id)})`);
  const afterSwitch = await repo<{ rows: number; progress: boolean; analyzedAt: boolean; picked: number }>(page, "({ rows: repo.rows.value.size, progress: repo.progress.value !== null, analyzedAt: repo.analyzedAt.value !== null, picked: repo.pickedBooks.value.size })");
  // wait: the cancelled scan must not write rows back; then count the small database
  await page.waitForTimeout(5000);
  const stray = await repo<{ rows: number; foreign: number; running: boolean }>(
    page,
    `(() => { const keys = new Set(repo.books.value.map((b) => b.key)); const rows = [...repo.rows.value.keys()]; return { rows: rows.length, foreign: rows.filter((k) => !keys.has(k)).length, running: repo.running }; })()`,
  );
  out.switchMidRun = { switchedAfterMs: Date.now() - switchAt, ...afterSwitch, afterFiveSeconds: stray };
  expect(afterSwitch.rows, "rows of the old database right after the switch").toBe(0);
  expect(stray.foreign, "rows of books the new database does not have").toBe(0);
  expect(stray.running).toBe(false);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  const finalForeign = await repo<number>(page, "(() => { const keys = new Set(repo.books.value.map((b) => b.key)); return [...repo.rows.value.keys()].filter((k) => !keys.has(k)).length; })()");
  expect(finalForeign).toBe(0);

  out.errors = seen.errors.length;
  out.externalRequests = seen.external.length;
  if (process.env.VALIDATION_OUT) {
    mkdirSync(process.env.VALIDATION_OUT, { recursive: true });
    writeFileSync(join(process.env.VALIDATION_OUT, "repository-real-v52.json"), JSON.stringify(out, null, 2));
  }
  console.info("V52_RESULT " + JSON.stringify(out));
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
