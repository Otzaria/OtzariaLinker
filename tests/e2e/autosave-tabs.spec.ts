import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * #41 B17 (V7 §1.2) with real tabs, real IndexedDB and real Web Locks: two windows of the tool each keep
 * their own autosave; when one closes, the next window to start is offered what it left — and a window
 * that is still open keeps its own work.
 */
async function tabWith(context: BrowserContext, title: string, links: number): Promise<Page> {
  const page = await context.newPage();
  watchPage(page);
  await page.goto(distUrl);
  // the app started (its self-check ran) and the autosave runs (src/app/autosave-window.ts takes a moment) before anything is opened
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.engine ?? null)).not.toBeNull();
  await page.waitForTimeout(500);
  await page.evaluate(
    async ([title, n]) => {
      const records = Array.from({ length: n as number }, (_, i) => ({ line_index_1: i + 2, heRef_2: "בראשית א", path_2: "בראשית.txt", line_index_2: i + 3, "Conection Type": "commentary" }));
      const store = (globalThis as unknown as { __linker: { openFiles(f: { path: string; blob: Blob }[]): Promise<void> } }).__linker;
      await store.openFiles([{ path: `${title}_links.json`, blob: new Blob([JSON.stringify(records)]) }]);
    },
    [title, links] as const,
  );
  return page;
}

const savedCounts = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const req = indexedDB.open("otzaria-linker", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const store = req.result.transaction("kv", "readonly").objectStore("kv");
          const keys = store.getAllKeys();
          keys.onsuccess = () => {
            const own = (keys.result as string[]).filter((k) => k.startsWith("autosave:v1:w:"));
            Promise.all(own.map((k) => new Promise<number>((r) => { const g = store.get(k); g.onsuccess = () => r((JSON.parse(g.result as string) as { links: unknown[] }).links.length); })))
              .then((n) => (req.result.close(), resolve(n.sort((a, b) => a - b))), reject);
          };
        };
      }),
  );

test("two tabs keep their own autosave; a closed tab's work is offered to the next one (B17)", async ({ context }) => {
  const a = await tabWith(context, "פירוש א", 5);
  const b = await tabWith(context, "פירוש ב", 4);
  // before V7 both wrote "autosave:v1", and the last one won
  await expect.poll(() => savedCounts(b), { timeout: 15_000 }).toEqual([4, 5]);

  await a.close();
  // the browser releases a closed tab's lock a moment later (Chrome tears the page down asynchronously). A window that
  // starts before that sees A as open and leaves its key alone — offered at a later start, not lost — so wait for it here
  const windowLocks = () => b.evaluate(async () => ((await (navigator as unknown as { locks: { query(): Promise<{ held: { name: string }[] }> } }).locks.query()).held ?? []).filter((l) => l.name.startsWith("otzaria-linker:window:")).length);
  await expect.poll(windowLocks, { timeout: 15_000 }).toBe(1);
  const c = await context.newPage();
  await c.goto(distUrl);
  const offer = c.locator(".recovery", { hasText: "עבודה שלא נשמרה" });
  await expect(offer).toContainText("5 קישורים");
  await offer.getByRole("button", { name: "שחזור" }).click();
  await expect.poll(() => c.evaluate(() => (globalThis as unknown as { __linker: { allLinks: { value: unknown[] } } }).__linker.allLinks.value.length)).toBe(5);
  // B is still open: its work stays its own, under its key
  await expect.poll(() => savedCounts(b), { timeout: 15_000 }).toEqual([4, 5]);
  expect(await b.evaluate(() => (globalThis as unknown as { __linker: { allLinks: { value: unknown[] } } }).__linker.allLinks.value.length)).toBe(4);
});
