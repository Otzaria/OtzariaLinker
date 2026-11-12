/* The product audit's scenarios. See harness.mjs for how to run. One worker, one browser. */
import { join } from "node:path";
import { launch, Scenario, saveResults, MINI_DB, OUT } from "./harness.mjs";
import * as S from "./scenarios.mjs";

const IN = process.argv[2];
if (!IN) throw new Error("usage: node scripts/audit/run-audit.mjs <inputs-dir> [scenario numbers…]");
const only = process.argv.slice(3).map(Number);
const RESULTS = join(OUT, "audit-results.json");

const browser = await launch();
const ctx = { IN, MINI_DB };
try {
  for (const [n, fn] of Object.entries(S)) {
    const id = Number(n.replace(/\D/g, ""));
    if (only.length && !only.includes(id)) continue;
    const s = new Scenario(browser, id, fn.title ?? n);
    const t = Date.now();
    try {
      await fn(s, ctx);
    } catch (e) {
      s.errors.push(`script: ${String(e.message ?? e).split("\n")[0]}`);
      try { await s.shot("failure"); } catch {}
      if (s.verdict === "?") s.verdict = "script failed";
    } finally {
      await s.close();
    }
    console.log(`#${id} ${s.verdict} ${Date.now() - t} ms, ${s.clicks} clicks, errors: ${s.errors.length}`);
    saveResults(RESULTS, [s]);
  }
} finally {
  await browser.close();
}
