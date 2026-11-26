// Prints every skipped test file of a Vitest run, and why it was skipped; fails when a skip is not explained.
//
//   npx vitest run --reporter=default --reporter=json --outputFile=reports/unit.json tests/unit
//   node scripts/ci/skipped-tests.mjs reports/unit.json [reports/integration.json ...]
//
// Why (V7 §4.19): the tests that need a large local database (*.local.test.ts, tests/validation/) skip themselves when
// their OTZARIA_* variable is not set (describe.runIf). That is right on a CI runner that has no database, but a skip must
// never hide a failure, so:
//   - each skipped file is listed with the data variables it reads and which of them are not set (log + job summary);
//   - a *.local.test.ts file that was skipped although ALL its data variables are set fails the step (its gate is broken);
//     a tests/validation file in that state is a warning (some also wait for VALIDATION_OUT or a cache folder);
//   - a skipped file that is not data-gated and has no explicit skip in its source (.skip, .todo, skipIf, runIf) fails.
// The script reads only the JSON reports and the test sources; it changes nothing.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error("usage: node scripts/ci/skipped-tests.mjs <vitest-report.json> [...]");
  process.exit(2);
}

const SKIPPED = new Set(["skipped", "pending", "todo", "disabled"]);
const rel = (p) => relative(process.cwd(), p).split(sep).join("/");
const isLocal = (file) => /\.local\.test\.ts$/.test(file);
const isValidation = (file) => /(^|\/)tests\/validation\//.test(file);
const DATA_VAR = /process\.env\.((?:OTZARIA|V52)_[A-Z0-9_]+)/g;
// tests/validation/env.ts reads the variables once and exports them under these names
const ENV_HELPER = { DB: "OTZARIA_DB", LIBRARY: "OTZARIA_LIBRARY", EXTRA_DBS: "OTZARIA_EXTRA_DBS" };
const EXPLICIT_SKIP = /\.(skip|todo|skipIf|runIf)\s*\(/;

/** The data variables a test file reads, directly or through tests/validation/env.ts. */
function dataVars(source) {
  const vars = new Set([...source.matchAll(DATA_VAR)].map((m) => m[1]));
  const helper = /import\s*\{([^}]*)\}\s*from\s*["']\.\/env["']/.exec(source);
  if (helper) for (const name of helper[1].split(",").map((s) => s.trim())) if (ENV_HELPER[name]) vars.add(ENV_HELPER[name]);
  return [...vars].sort();
}

const rows = [];
const errors = [];
const warnings = [];
let files = 0;
let ran = 0;
let skippedTests = 0;

for (const report of reports) {
  if (!existsSync(report)) {
    errors.push(`${report}: no report (did the test step run?)`);
    continue;
  }
  const json = JSON.parse(readFileSync(report, "utf8"));
  for (const f of json.testResults ?? []) {
    files++;
    const results = f.assertionResults ?? [];
    const skipped = results.filter((a) => SKIPPED.has(a.status)).length;
    ran += results.length - skipped;
    if (skipped === 0) continue;
    skippedTests += skipped;
    const file = rel(resolve(f.name));
    const source = existsSync(f.name) ? readFileSync(f.name, "utf8") : "";
    const vars = dataVars(source);
    const missing = vars.filter((v) => !process.env[v]);
    let reason;
    if ((isLocal(file) || isValidation(file)) && vars.length) {
      const set = vars.filter((v) => !missing.includes(v));
      reason = missing.length
        ? `needs local data: ${missing.join(", ")} not set${set.length ? ` (set: ${set.join(", ")})` : ""}`
        : `skipped although ${vars.join(", ")} ${vars.length > 1 ? "are" : "is"} set`;
      const problem = `${file}: ${skipped} test(s) skipped although its data variables are set — its gate does not match its data`;
      if (!missing.length) (isLocal(file) ? errors : warnings).push(problem);
    } else if (EXPLICIT_SKIP.test(source)) {
      reason = "skipped by the test itself (.skip / .todo / skipIf / runIf in the file)";
    } else {
      reason = "no explanation in the file";
      errors.push(`${file}: ${skipped} test(s) skipped with no data gate and no explicit skip in the source`);
    }
    rows.push({ file, skipped, of: results.length, reason });
  }
}

rows.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
const lines = [
  `Test files: ${files}. Tests run: ${ran}. Tests skipped: ${skippedTests} in ${rows.length} file(s).`,
  ...rows.map((r) => `SKIPPED ${String(r.skipped).padStart(3)}/${String(r.of).padEnd(3)} ${r.file} — ${r.reason}`),
];
console.log(lines.join("\n"));

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    `### Skipped tests (${reports.map((r) => rel(resolve(r))).join(", ")})`,
    "",
    `${files} test files, ${ran} tests run, ${skippedTests} skipped in ${rows.length} file(s). The local-data tests need a`,
    "database that a hosted runner does not have; they run in the manual “Heavy tests” workflow (heavy.yml, docs/TESTING.md §4).",
    "",
    ...(rows.length ? ["| file | skipped | why |", "|---|---|---|", ...rows.map((r) => `| \`${r.file}\` | ${r.skipped}/${r.of} | ${r.reason} |`)] : ["No test was skipped."]),
    ...(errors.length ? ["", "**Unexplained skips:**", ...errors.map((e) => `- ${e}`)] : []),
    ...(warnings.length ? ["", "**Check:**", ...warnings.map((e) => `- ${e}`)] : []),
    "",
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n"));
}

// a GitHub annotation, so the warning is seen on the run page and not only in the log
for (const w of warnings) console.log(`::warning::${w}`);
if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n  ${errors.join("\n  ")}`);
  process.exit(1);
}
