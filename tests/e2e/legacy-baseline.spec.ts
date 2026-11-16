import { expect, test } from "@playwright/test";
import { legacyUrl, watchPage } from "./helpers";

/* The v3 tool is the regression reference for the whole rewrite (docs/audit/REGRESSION_BASELINE.md).
   Its in-file self-tests must keep passing — they document behaviour 2.0 has to match. */
test("legacy v3 self-tests: 93/93", async ({ page }) => {
  const seen = watchPage(page);
  await page.goto(legacyUrl);
  const r = await page.evaluate(() => (window as unknown as { runSelfTests(): { passed: number; total: number; results: { name: string; ok: boolean }[] } }).runSelfTests());
  expect(r.results.filter((x) => !x.ok).map((x) => x.name)).toEqual([]);
  expect(r.total).toBe(93);
  expect(seen.external).toEqual([]);
});
