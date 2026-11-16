import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/* Security review #2/#6: a corrupt database must fail with a message, and the app must keep working. */
test("a database with a b-tree cycle is refused with a message, and the next file still opens", async ({ page }) => {
  const seen = watchPage(page);
  await page.goto(distUrl);
  const pick = async (name: string, buffer: Buffer) => {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "קבצים", exact: true }).click();
    await (await chooser).setFiles([{ name, mimeType: "application/octet-stream", buffer }]);
  };
  await pick("cycle.db", readFileSync(resolve("tests/fixtures/db/hostile/cycle.db")));
  await expect(page.locator(".notice")).toContainText("לא נפתח", { timeout: 15_000 });
  await pick("ספר.txt", Buffer.from("שורה אחת\nשורה שתיים"));
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 15_000 });
  expect(seen.errors).toEqual([]);
});

test("many notices at once: the newest three are shown, the rest fold into 'N more' (audit F16)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".drop-strip").getByRole("button", { name: "קבצים", exact: true }).click();
  // five broken links files: five error notices, which stay until closed
  await (await chooser).setFiles(["א", "ב", "ג", "ד", "ה"].map((t) => ({ name: `${t}_links.json`, mimeType: "application/json", buffer: Buffer.from(`[{"line_index_1": 1, "path_2": "x.txt"`) })));
  await expect(page.locator(".notice.error")).toHaveCount(3);
  await page.getByRole("button", { name: "עוד 2 הודעות" }).click();
  await expect(page.locator(".notice.error")).toHaveCount(5);
  await page.getByRole("button", { name: "רק ההודעות האחרונות" }).click();
  await expect(page.locator(".notice.error")).toHaveCount(3);
});

/*
 * Review C3: cancelling a long engine used to restart the worker (the engine read the cancel only after
 * it ended, and the watchdog replaced it after 4 s), closing every open source. Now the engine runs in
 * slices: the reader is served while it runs, and a cancel stops it without a restart.
 * A generated pair of 20,000 lines takes dibur-hamatchil ~30 s (Node).
 */
test("a long engine: the reader is answered while it runs, and a cancel stops it without restarting the worker (review C3)", async ({ page }) => {
  test.setTimeout(120_000);
  const seen = watchPage(page);
  await page.goto(distUrl);
  const LETTERS = "אבגדהוזחטיכלמנסעפצקרשת";
  const word = (n: number) => {
    let s = "";
    for (let k = 0; k < 4; k++, n = Math.floor(n / LETTERS.length)) s += LETTERS[n % LETTERS.length];
    return s;
  };
  const base: string[] = ["<h1>בסיס</h1>"];
  const comm: string[] = ["<h1>פירוש על בסיס</h1>"];
  for (let i = 0; i < 20_000; i++) {
    if (i % 50 === 0) for (const b of [base, comm]) b.push(`<h2>פרק ${word(200_000 + i / 50)}</h2>`);
    const w = [0, 1, 2, 3, 4, 5].map((k) => word(6 * i + k));
    base.push(w.join(" "));
    comm.push(`<b>${w[0]} ${w[1]} ${w[2]}.</b> פירוש`);
  }
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "בסיס.txt", mimeType: "text/plain", buffer: Buffer.from(base.join("\n")) },
    { name: "פירוש על בסיס.txt", mimeType: "text/plain", buffer: Buffer.from(comm.join("\n")) },
  ]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 15_000 });

  const r = await page.evaluate(async () => {
    type Store = {
      books: { value: Map<string, { key: string; title: string }> };
      sources: { value: unknown[] };
      task: { value: { cancel(): void; done: number } | null };
      notices: { value: { text: string }[] };
      suggestions: { runEngine(e: string, s: string, t: string): Promise<boolean> };
      lines: { load(k: string, f: number, t: number): Promise<void>; peek(k: string, i: number): { text: string } | undefined };
    };
    const store = (globalThis as unknown as { __linker: Store }).__linker;
    const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
    const c = key("פירוש על בסיס");
    const b = key("בסיס");
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const run = store.suggestions.runEngine("dibur-hamatchil", c, b);
    // the engine is running once it reports progress
    for (let i = 0; i < 200 && !(store.task.value && store.task.value.done > 0); i++) await sleep(50);
    const running = !!store.task.value && store.task.value.done > 0;
    // a page of lines far into the book, while the engine runs
    const t0 = performance.now();
    await store.lines.load(b, 15_000, 15_010);
    const linesMs = performance.now() - t0;
    store.task.value?.cancel();
    const ran = await run;
    await sleep(6_000); // longer than the watchdog's 4 s
    return {
      running,
      linesMs,
      ran,
      line: store.lines.peek(b, 15_005)?.text ?? null,
      sources: store.sources.value.length,
      restarted: store.notices.value.some((n) => n.text.includes("הופעל מחדש")),
    };
  });
  expect(r.running).toBe(true);
  expect(r.linesMs).toBeLessThan(2_000);
  expect(r.ran).toBe(false); // cancelled
  expect(r.line).not.toBeNull();
  expect(r.restarted).toBe(false);
  expect(r.sources).toBe(1);
  expect(seen.errors).toEqual([]);
});
