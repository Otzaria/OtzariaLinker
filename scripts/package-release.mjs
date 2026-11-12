// Post-build: turns dist/index.html into the release artifacts and verifies they are offline-safe.
//   dist/OtzariaLinker.html            ← fixed name; .../releases/latest/download/OtzariaLinker.html
//   dist/OtzariaLinker-<version>.html  ← same bytes, versioned name
//   dist/SHA256SUMS
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const html = readFileSync("dist/index.html", "utf8");

// Offline guard: nothing in the shipped page may load from the network.
const forbidden = [
  [/<script\b[^>]*\bsrc\s*=\s*["']?(?!data:|blob:)/i, "<script src> to an external file"],
  [/<link\b[^>]*\bhref\s*=\s*["']?https?:/i, "<link href> to the network"],
  [/@import\s+(url\()?["']?https?:/i, "CSS @import from the network"],
  [/url\(\s*["']?https?:/i, "CSS url() from the network"],
  [/\bimportScripts\s*\(/, "importScripts (a classic worker must not load scripts)"],
  // network APIs in the code itself (AGENTS.md §2.1). A bare call only: our own methods named fetch
  // (this.fetch, x.fetch) are fine.
  [/(?<![\w.$])fetch\s*\(/, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bsendBeacon\b/, "navigator.sendBeacon"],
];
const problems = forbidden.filter(([re]) => re.test(html)).map(([, what]) => what);
if (problems.length) {
  console.error("Offline guard failed:\n  " + problems.join("\n  "));
  process.exit(1);
}

const versioned = `OtzariaLinker-${pkg.version}.html`;
copyFileSync("dist/index.html", "dist/OtzariaLinker.html");
copyFileSync("dist/index.html", `dist/${versioned}`);
const sha = createHash("sha256").update(readFileSync("dist/OtzariaLinker.html")).digest("hex");
writeFileSync("dist/SHA256SUMS", `${sha}  OtzariaLinker.html\n${sha}  ${versioned}\n`);
const bytes = readFileSync("dist/OtzariaLinker.html").length;
// size budget: the file is opened by double-click on ordinary machines; growth must be a decision
const BUDGET = 1.5 * 1024 * 1024;
if (bytes > BUDGET) {
  console.error(`Size budget exceeded: ${bytes} bytes > ${BUDGET}. Raise BUDGET in scripts/package-release.mjs only on purpose.`);
  process.exit(1);
}
console.log(`OtzariaLinker.html  ${(bytes / 1024).toFixed(0)} KB (${bytes} bytes)  sha256 ${sha}`);
