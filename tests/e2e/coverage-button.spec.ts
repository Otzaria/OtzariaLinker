import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * #41 B26: "כיסוי הספר" in the suggestions panel led to the "בדיקה" tab with the coverage section folded — the user had to
 * find it and open it. It now opens the section and brings it into view.
 */
const DB = readFileSync("tests/fixtures/db/seforim-v7-mini.db").toString("base64");
const heb = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const BIUR = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...heb.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join("\n");

test("'כיסוי הספר' opens the coverage section, in view", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.engine ?? null)).not.toBeNull();
  await page.evaluate(
    async ([b64, biur]) => {
      const s = (globalThis as unknown as { __linker: any }).__linker;
      await s.openFiles([{ path: "seforim.db", blob: new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]) }]);
      await s.openFiles([{ path: "ביאור על בראשית.txt", blob: new Blob([biur]) }]);
      const key = (t: string) => [...s.books.value.values()].find((b: { title: string }) => b.title === t).key;
      await s.suggestions.runEngine("headings", key("ביאור על בראשית"), key("בראשית"));
      s.sideTab.value = "suggestions";
    },
    [DB, BIUR] as const,
  );
  await page.getByRole("button", { name: "כיסוי הספר" }).click();
  const section = page.locator("details.coverage");
  await expect(section).toHaveAttribute("open", "");
  await expect(section).toBeInViewport();
  expect(seen.errors).toEqual([]);
});
