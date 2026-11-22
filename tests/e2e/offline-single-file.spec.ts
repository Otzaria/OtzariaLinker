import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

test("the single HTML file starts offline from file:// and its DB worker runs the SQLite reader and zstd", async ({ page }) => {
  const seen = watchPage(page);
  await page.goto(distUrl);
  await expect(page.locator("html")).toHaveAttribute("data-engine", "בדיקת sqlite · בדיקת zstd");
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 26(c): "download the tool for offline use". The control is a same-origin <a href="OtzariaLinker.html" download>,
 * shown only when the page is served over http(s) (the hosted page publishes that file next to index.html, see
 * .github/workflows/pages.yml). From file:// the user already has the file, so there is nothing to offer.
 */
test("file://: no 'download the tool' control (the user already has the file)", async ({ page }) => {
  const seen = watchPage(page);
  await page.goto(distUrl);
  await expect(page.getByRole("heading", { name: "מה תרצו לעשות?" })).toBeVisible();
  await expect(page.getByRole("link", { name: /הורדת הכלי/ })).toHaveCount(0);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("http(s): the control is a same-origin download link to OtzariaLinker.html and nothing else leaves the page", async ({ browser }) => {
  // a hosted copy simulated by routing: the only origin that answers is the fake host, everything else is aborted and counted
  const ctx = await browser.newContext({ locale: "he-IL" });
  const html = readFileSync(resolve("dist/OtzariaLinker.html"));
  const stray: string[] = [];
  const asked: string[] = [];
  await ctx.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://linker.example") {
      stray.push(url.href);
      return route.abort();
    }
    asked.push(url.pathname);
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("https://linker.example/");
  await expect(page.getByRole("heading", { name: "מה תרצו לעשות?" })).toBeVisible();
  const link = page.getByRole("link", { name: /הורדת הכלי/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "OtzariaLinker.html");
  await expect(link).toHaveAttribute("download", "OtzariaLinker.html");
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("OtzariaLinker.html");
  expect(asked.every((p) => p === "/" || p === "/OtzariaLinker.html"), asked.join(",")).toBe(true);
  expect(stray).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});
