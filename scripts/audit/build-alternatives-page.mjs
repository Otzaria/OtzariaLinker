/*
 * docs/reviews/ux2-alternatives/index.html from its template: "{{icon:<name>}}" becomes the app's own
 * icon (src/ui/icons/icon-data.ts — Otzaria Icons, Fluent only for generic actions) as inline SVG,
 * so the page needs no network and shows the icons the app shows.
 *   node scripts/audit/build-alternatives-page.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DIR = join(ROOT, "docs", "reviews", "ux2-alternatives");
const data = readFileSync(join(ROOT, "src", "ui", "icons", "icon-data.ts"), "utf8");
const icon = (name) => {
  // one line per icon: `  name: ["viewBox", "<body as a JSON string>"],`
  const line = data.split(/\r?\n/).find((l) => l.startsWith(`  ${name}: [`));
  if (!line) throw new Error(`no icon ${name}`);
  const [viewBox, body] = JSON.parse(line.slice(line.indexOf("["), line.lastIndexOf("]") + 1));
  return `<svg class="i" viewBox="${viewBox}" aria-hidden="true">${body}</svg>`;
};
const html = readFileSync(join(DIR, "index.template.html"), "utf8").replace(/\{\{icon:(\w+)\}\}/g, (_, n) => icon(n));
writeFileSync(join(DIR, "index.html"), html, "utf8");
console.log("index.html", html.length);
