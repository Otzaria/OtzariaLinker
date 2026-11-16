/*
 * The batch measurement (V5 P1-8): a folder of hundreds or a thousand text books, max-linked in the
 * BUILT single file in Chrome, the way a user runs it. Not a test (it lives under scripts/, so neither
 * vitest nor Playwright Test picks it up). It reports wall time, peak memory — the whole browser
 * (working set and private bytes of every Chrome process of the run), the page's heap and the worker's
 * heap — and the main thread's long tasks; with --interrupt it also pauses, reloads the tab in the
 * middle, resumes, cancels and runs the rest, timing each.
 *
 *   py -I scripts/bench/make_batch_books.py .bench/batch/b1000 1000 --bases
 *   npm run build
 *   node scripts/bench/batch-scale.mjs .bench/batch/b1000 [--html <file>] [--db <seforim.db>] [--interrupt] [--headed]
 *
 * --html measures another build (e.g. a copy of an earlier dist). --db opens a database next to the
 * folder (the bases from the Otzaria database; opened read only, never copied). Output: a JSON summary
 * on stdout and progress on stderr. Delete the generated folders afterwards.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const folder = resolve(args[0] ?? "");
const html = pathToFileURL(resolve(opt("--html") ?? join(ROOT, "dist", "OtzariaLinker.html"))).href;
const db = opt("--db");
const interrupt = args.includes("--interrupt");
const log = (...a) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const T0 = Date.now();

/** Every second: the working set and private bytes of all the Chrome processes of this profile (Windows). */
function sampleProcesses(profile) {
  const ps = `
$p = '${profile.replace(/'/g, "''")}'
while ($true) {
  $all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$p*" }
  $ws = ($all | Measure-Object WorkingSetSize -Sum).Sum
  $pv = ($all | Measure-Object PrivatePageCount -Sum).Sum
  [Console]::Out.WriteLine("$ws $pv $($all.Count)")
  Start-Sleep -Milliseconds 1000
}`;
  const child = spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "ignore"] });
  const s = { peakWs: 0, peakPrivate: 0, processes: 0, samples: 0 };
  child.stdout.on("data", (d) => {
    for (const line of String(d).trim().split(/\r?\n/)) {
      const [ws, pv, n] = line.split(" ").map(Number);
      if (!ws) continue;
      s.samples++;
      s.peakWs = Math.max(s.peakWs, ws);
      s.peakPrivate = Math.max(s.peakPrivate, pv);
      s.processes = Math.max(s.processes, n);
    }
  });
  return { stats: s, stop: () => child.kill() };
}

const MB = (b) => Math.round(b / 1048576);

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "ol-batch-"));
  const procs = sampleProcesses(profile);
  const context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: !args.includes("--headed"), locale: "he-IL", viewport: { width: 1440, height: 900 }, offline: true });
  const page = context.pages()[0] ?? (await context.newPage());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window;
    w.__long = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push(Math.round(e.duration));
    }).observe({ type: "longtask", buffered: true });
  });

  // heaps: the page's and the worker's (CDP Runtime.getHeapUsage; the worker through a non-flat target session), every second
  const heap = { page: 0, worker: 0 };
  const cdp = await context.newCDPSession(page);
  const workers = new Set();
  const waiting = new Map();
  let seq = 0;
  cdp.on("Target.attachedToTarget", (e) => e.targetInfo.type === "worker" && workers.add(e.sessionId));
  cdp.on("Target.detachedFromTarget", (e) => workers.delete(e.sessionId));
  cdp.on("Target.receivedMessageFromTarget", (e) => {
    const m = JSON.parse(e.message);
    waiting.get(m.id)?.(m.result);
    waiting.delete(m.id);
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  const inWorker = (sessionId, method) =>
    new Promise((res) => {
      const id = ++seq;
      waiting.set(id, res);
      setTimeout(() => (waiting.delete(id), res(null)), 2000);
      void cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method }) }).catch(() => res(null));
    });
  let sampling = true;
  const heapLoop = (async () => {
    while (sampling) {
      try {
        const h = await cdp.send("Runtime.getHeapUsage");
        heap.page = Math.max(heap.page, h.usedSize);
      } catch {}
      for (const sid of workers) {
        const h = await inWorker(sid, "Runtime.getHeapUsage");
        if (h?.usedSize) heap.worker = Math.max(heap.worker, h.usedSize);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  const result = { folder, html, db: db ?? null, interrupt };
  await page.goto(html);

  // open the folder (and the database) from the home screen
  let t = Date.now();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "תיקייה", exact: true }).click();
  await (await chooser).setFiles(folder);
  await page.locator(".source-row").first().waitFor({ timeout: 300_000 });
  if (db) {
    const c2 = page.waitForEvent("filechooser");
    // the home screen's source buttons (the workspace keeps them folded in the sources tab)
    await page.evaluate(() => (window.__linker.screen.value = "home"));
    await page.getByRole("button", { name: "מסד נתונים", exact: true }).first().click();
    await (await c2).setFiles(resolve(db));
    await page.locator(".source-row").nth(1).waitFor({ timeout: 300_000 });
  }
  result.openMs = Date.now() - t;
  const books = await page.evaluate(() => window.__linker.books.value.size);
  log(`opened ${books} books in ${result.openMs} ms`);

  // the max-link form on the folder
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  const status = page.getByRole("status").filter({ hasText: "ספרים נבחרו" });
  t = Date.now();
  await status.waitFor({ timeout: 300_000 });
  result.planMs = Date.now() - t;
  result.plan = (await status.textContent())?.trim();
  log(`plan: ${result.plan} (${result.planMs} ms)`);

  const runButton = page.getByRole("button", { name: "הפעלת קישור מרבי" });
  const report = page.locator("details.ml-report");
  const jobDone = () => page.evaluate(() => window.__linker.maxLink.job?.value?.state ?? null).catch(() => null);
  t = Date.now();
  await runButton.click();
  const timings = {};
  if (interrupt) {
    const progress = () => page.evaluate(() => {
      const j = window.__linker.maxLink.job?.value;
      return j ? j.books.filter((b) => b.status !== "pending" && b.status !== "running").length / j.books.length : -1;
    });
    const waitFor = async (f) => {
      while ((await progress()) < f) await page.waitForTimeout(250);
    };
    await waitFor(0.25);
    let p = Date.now();
    await page.getByRole("button", { name: "השהיה" }).click();
    await page.getByRole("button", { name: "המשך" }).first().waitFor({ timeout: 120_000 });
    timings.pauseMs = Date.now() - p;
    timings.pausedAt = await progress();
    log(`paused at ${(timings.pausedAt * 100).toFixed(0)}% in ${timings.pauseMs} ms`);
    p = Date.now();
    await page.getByRole("button", { name: "המשך" }).first().click();
    await waitFor(0.5);
    timings.resumeToHalfMs = Date.now() - p;
    // reload in the middle of the run: the job is kept, the books must be chosen again
    p = Date.now();
    await page.reload();
    const c3 = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "תיקייה", exact: true }).click();
    await (await c3).setFiles(folder);
    await page.locator(".source-row").first().waitFor({ timeout: 300_000 });
    timings.reopenMs = Date.now() - p;
    await page.getByRole("tab", { name: /הצעות/ }).click();
    const resume = page.getByRole("button", { name: /^המשך/ }).first();
    await resume.waitFor({ timeout: 120_000 });
    timings.afterReload = await progress();
    log(`reloaded at ${(timings.afterReload * 100).toFixed(0)}% kept; reopen ${timings.reopenMs} ms`);
    p = Date.now();
    await resume.click();
    // the kept results read back and the finished books' fingerprints checked, until the next book is done
    while ((await progress()) <= timings.afterReload) await page.waitForTimeout(100);
    timings.restoreToNextBookMs = Date.now() - p;
    log(`first book after the reload done ${timings.restoreToNextBookMs} ms after "continue"`);
    await waitFor(0.75);
    // cancel: the finished books stay
    await page.getByRole("button", { name: "עצירה" }).click();
    await page.getByRole("button", { name: /^המשך/ }).first().waitFor({ timeout: 120_000 });
    timings.cancelledAt = await progress();
    log(`cancelled at ${(timings.cancelledAt * 100).toFixed(0)}%`);
    await page.getByRole("button", { name: /^המשך/ }).first().click();
  }
  await report.waitFor({ timeout: 3_600_000 });
  while (interrupt && (await jobDone()) === "running") await page.waitForTimeout(250);
  result.runMs = Date.now() - t;
  result.interruptions = interrupt ? timings : undefined;
  result.reportTiles = await report.locator(".ml-tiles").innerText().catch(() => "");
  result.suggestions = await page.evaluate(() => window.__linker.suggestions.run.value?.result.suggestions.length ?? 0);
  result.job = await page.evaluate(() => {
    const j = window.__linker.maxLink.job?.value;
    if (!j) return null;
    const by = {};
    for (const b of j.books) by[b.status] = (by[b.status] ?? 0) + 1;
    return by;
  });
  log(`run done in ${result.runMs} ms: ${result.suggestions} suggestions`);
  // what the page keeps in the browser (the autosave and the job's record and results)
  await page.waitForTimeout(1500);
  result.storageMB = await page.evaluate(async () => Math.round(((await navigator.storage.estimate()).usage ?? 0) / 1048576));

  sampling = false;
  await heapLoop;
  const long = await page.evaluate(() => window.__long);
  long.sort((a, b) => b - a);
  result.longTasks = { count: long.length, totalMs: long.reduce((a, b) => a + b, 0), maxMs: long[0] ?? 0, top5: long.slice(0, 5), over200: long.filter((x) => x > 200).length };
  result.memory = { peakWorkingSetMB: MB(procs.stats.peakWs), peakPrivateMB: MB(procs.stats.peakPrivate), processes: procs.stats.processes, pageHeapMB: MB(heap.page), workerHeapMB: MB(heap.worker) };
  result.errors = errors;
  procs.stop();
  await context.close();
  rmSync(profile, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
