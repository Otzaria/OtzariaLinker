/*
 * The product audit's driver (docs/reviews/PRODUCT_AUDIT.md). Not a test: it is never picked up by
 * vitest or Playwright Test (it lives under scripts/). It drives the BUILT dist/OtzariaLinker.html from
 * file:// in Chrome the way a user would, counts clicks and decisions, times each scenario, records
 * every notice the app shows and any technical term visible on screen, and takes screenshots.
 *
 *   npm run build
 *   node scripts/audit/run-audit.mjs <inputs-dir> [scenario numbers…]
 *
 * Inputs: py scripts/audit/make_inputs.py <inputs-dir>.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const DIST = pathToFileURL(join(ROOT, "dist", "OtzariaLinker.html")).href;
export const SHOTS = join(ROOT, "docs", "reviews", "shots");
export const MINI_DB = join(ROOT, "tests", "fixtures", "db", "seforim-v7-mini.db");

/** Terms a regular user should not meet on screen. */
const JARGON = [
  /ref_[12]\b/, /heRef/, /line_index/, /Conection Type/, /path_2/, /\bJSON\b/i, /\bSQLite\b/i, /\bschema\b/i, /\bregex\b/i,
  /\bworker\b/i, /\bprovenance\b/i, /\bLINKER\b/, /\bCOMMENTARY\b/, /\balt_toc\b/, /\bheRef_2\b/, /\bundefined\b/, /\bNaN\b/, /\bnull\b/,
  /\bId\b/, /\bOTHER\b/, /תבנית\s+רגולרית/, /ביטוי רגולרי/,
];

export async function launch() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  return browser;
}

export class Scenario {
  constructor(browser, id, title) {
    this.browser = browser;
    this.id = id;
    this.title = title;
    this.clicks = 0;
    this.decisions = [];
    this.advanced = 0;
    this.confusions = [];
    this.repeats = [];
    this.notes = [];
    this.jargon = new Map();
    this.shots = [];
    this.errors = [];
    this.notices = [];
    this.steps = [];
    this.timings = {};
    this.verdict = "?";
  }
  async open(viewport = { width: 1440, height: 900 }) {
    this.context = await this.browser.newContext({ locale: "he-IL", viewport, acceptDownloads: true, offline: true });
    this.page = await this.context.newPage();
    this.page.on("pageerror", (e) => this.errors.push(`pageerror: ${e.message}`));
    this.page.on("console", (m) => m.type() === "error" && this.errors.push(`console: ${m.text().slice(0, 300)}`));
    // every notice that ever shows, even the ones that fade after 5 s
    await this.page.addInitScript(() => {
      window.__notices = [];
      const seen = new WeakSet();
      new MutationObserver(() => {
        for (const n of document.querySelectorAll(".notice")) if (!seen.has(n)) { seen.add(n); window.__notices.push(`[${n.className.replace("notice ", "")}] ${n.innerText.replace(/\s+/g, " ").trim()}`); }
      }).observe(document, { subtree: true, childList: true });
    });
    this.t0 = Date.now();
    await this.page.goto(DIST);
    await this.page.waitForSelector("h1, .workspace", { timeout: 30_000 });
    return this.page;
  }
  step(text) { this.steps.push({ text, shot: null }); }
  decide(text) { this.decisions.push(text); }
  confuse(text) { this.confusions.push(text); }
  repeat(text) { this.repeats.push(text); }
  note(text) { this.notes.push(text); }
  /** A user click (counted). `what` describes it in the steps list. */
  async click(locator, what) {
    this.clicks++;
    await locator.click();
    if (what) this.step(what);
  }
  /** A click that opens the system file picker; the user then picks `files` there (one more click: "Open"). */
  async pick(locator, files, what) {
    const chooser = this.page.waitForEvent("filechooser", { timeout: 15_000 });
    this.clicks++;
    await locator.click();
    const fc = await chooser;
    await fc.setFiles(files);
    this.clicks++; // choosing in the OS dialog and pressing "Open"
    if (what) this.step(what);
  }
  async type(locator, text, what) {
    this.clicks++;
    await locator.fill(text);
    if (what) this.step(what);
  }
  async key(k, what) {
    this.clicks++;
    await this.page.keyboard.press(k);
    if (what) this.step(what);
  }
  async scan(where) {
    const text = await this.page.evaluate(() => {
      const attrs = [...document.querySelectorAll("[title],[placeholder],[aria-label]")].map((e) => `${e.getAttribute("title") ?? ""} ${e.getAttribute("placeholder") ?? ""}`);
      return `${document.body.innerText}\n${attrs.join("\n")}`;
    });
    for (const re of JARGON) {
      const m = text.match(new RegExp(`.{0,40}${re.source}.{0,40}`, re.flags.replace("g", "")));
      if (m && !this.jargon.has(re.source)) this.jargon.set(re.source, `${where}: «${m[0].replace(/\s+/g, " ").trim()}»`);
    }
  }
  async shot(name, opts = {}) {
    mkdirSync(SHOTS, { recursive: true });
    const file = `s${String(this.id).padStart(2, "0")}-${name}.png`;
    await this.page.waitForTimeout(250);
    await this.page.screenshot({ path: join(SHOTS, file), fullPage: false, ...opts });
    this.shots.push(file);
    if (this.steps.length) this.steps.at(-1).shot ??= file;
    await this.scan(file);
    return file;
  }
  async lap(label) { this.timings[label] = Date.now() - this.t0; }
  async noticesNow() { return this.page.evaluate(() => window.__notices.slice()); }
  async close() {
    this.ms = Date.now() - this.t0;
    try { this.notices = await this.noticesNow(); } catch {}
    await this.context?.close();
  }
  toJSON() {
    return {
      id: this.id, title: this.title, verdict: this.verdict, ms: this.ms, timings: this.timings, clicks: this.clicks,
      decisions: this.decisions, advanced: this.advanced, confusions: this.confusions, repeats: this.repeats, notes: this.notes,
      jargon: Object.fromEntries(this.jargon), notices: this.notices, errors: this.errors, steps: this.steps, shots: this.shots,
    };
  }
}

export function saveResults(file, results) {
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const r of results) prev[r.id] = r.toJSON();
  writeFileSync(file, JSON.stringify(prev, null, 2), "utf8");
}
