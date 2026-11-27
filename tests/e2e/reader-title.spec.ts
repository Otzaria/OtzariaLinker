import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * #40 A2 / #24 (V7 §3.4): with several sources open, a reader's head shows the book's source as a badge — with the
 * source's name when another source has the same title. A long book name next to a long database name collapsed to a
 * strip of 10px at 1280 (38px at 1440): the letters stacked one under the other and nobody could tell which book was
 * open. The name must stay readable at every common width, and the full name stays reachable (hover and the name button).
 */
const DB = readFileSync("tests/fixtures/db/seforim-v7-mini.db").toString("base64");
const TITLE = "המאיר לארץ על ארצות החיים";

for (const width of [360, 390, 768, 820, 1024, 1280, 1366, 1440, 1920])
  test(`the book name stays readable next to a long source badge at ${width}px`, async ({ page }) => {
    const seen = watchPage(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(distUrl);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.engine ?? null)).not.toBeNull();
    await page.evaluate(
      async ([dbB64, title]) => {
        const bytes = Uint8Array.from(atob(dbB64), (c) => c.charCodeAt(0));
        const store = (globalThis as unknown as { __linker: { openFiles(f: { path: string; blob: Blob }[]): Promise<void>; books: { value: Map<string, { key: string; title: string }> }; showBook(side: string, key: string): void } }).__linker;
        await store.openFiles([{ path: "otzarya-unofficial-books-52-with-a-long-file-name.db", blob: new Blob([bytes]) }]);
        await store.openFiles([{ path: `ספרייה אישית עם שם ארוך מאוד של תיקייה/${title}.txt`, blob: new Blob([`<h1>${title}</h1>\nשורה`]) }]);
        const book = [...store.books.value.values()].find((b) => b.title === title && !b.key.includes("/"))!;
        store.showBook("source", book.key);
      },
      [DB, TITLE] as const,
    );
    const head = page.locator('.panel-head[data-panel="source"]');
    const name = head.locator(".title-btn");
    await expect(name).toBeVisible();
    await expect(head.locator(".src-badge")).toBeVisible();
    const box = (await name.boundingBox())!;
    // at least a few letters a line: before V7 it was 10px wide at 1280
    expect(box.width, `name width at ${width}`).toBeGreaterThanOrEqual(80);
    // the full name on hover, and in the strip the name button opens (touch has no hover)
    await expect(head.locator("h2.book-title")).toHaveAttribute("title", TITLE);
    await name.click();
    await expect(page.locator(".book-info .bi-title")).toContainText(TITLE);
    expect(seen.errors).toEqual([]);
  });
