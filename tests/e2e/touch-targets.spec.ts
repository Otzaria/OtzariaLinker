import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * #42 C27 (V7 §3.20): on a touch screen the small controls were 17-22px (marks-btn 20x20, the book list's side
 * buttons 22, a details summary 21, the "advanced" link 17) and at 360px the main buttons 34. With a coarse pointer
 * every control that a finger operates is at least 44px high.
 */
test.skip(({ browserName }) => browserName === "firefox", "isMobile/hasTouch emulation is Chromium's");
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

const BOOK = (title: string, lines: string[]) => ({ name: `${title}.txt`, mimeType: "text/plain", buffer: Buffer.from([`<h1>${title}</h1>`, ...lines].join("\n"), "utf8") });

test("with a finger, the small controls are at least 44px high", async ({ page }) => {
  const seen = watchPage(page);
  await page.goto(distUrl);
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([BOOK("ספר", ["שורה אחת", "שורה שתיים"]), BOOK("פירוש על ספר", ["פירוש"])]);
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __linker: { sources: { value: unknown[] } } }).__linker.sources.value.length), { timeout: 30_000 }).toBe(1);
  await page.waitForTimeout(500);
  const small = await page.evaluate(() => {
    const sel = ".marks-btn, .book-list .side-btn, .adv-link, details > summary, .btn, .icon-btn";
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ what: `${el.className || el.tagName} "${(el.textContent ?? "").trim().slice(0, 20)}"`, h: el.getBoundingClientRect().height }))
      .filter((x) => x.h > 0 && x.h < 43.5);
  });
  expect(small).toEqual([]);
  expect(seen.errors).toEqual([]);
});
