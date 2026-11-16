/*
 * Before/after screenshots of the seven screens whose design alternative the owner chose
 * (docs/reviews/UX_AUDIT_V5.md, "Owner choices implemented"). Not a test. Every screen in light and
 * dark, at 1440×900, 1024×768 and 820×1180; the window is opened at 1440 and made narrower after the
 * books are open — the case the audit found (a fresh open below 1200px already starts on a preset).
 *
 *   npm run build
 *   node scripts/audit/ux-v5-owner.mjs <inputs-dir> <before|after>
 *   py -I scripts/audit/to_webp.py docs/reviews/ux3-shots .bench/ux-v5-owner/<label>/*.png
 *
 * Inputs: make_inputs.py (s7) and <in>/b200 (the first 200 commentaries of s9), as ux-v5.mjs.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, MINI_DB } from "./harness.mjs";

const [IN, LABEL] = process.argv.slice(2);
if (!IN || !LABEL) throw new Error("usage: node scripts/audit/ux-v5-owner.mjs <inputs-dir> <before|after>");
const OUT = join(import.meta.dirname, "..", "..", ".bench", "ux-v5-owner", LABEL);
mkdirSync(OUT, { recursive: true });
const DIST = new URL("../../dist/OtzariaLinker.html", import.meta.url).href;
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 820, height: 1180 },
];
const THEMES = ["light", "dark"];
const wait = (p, ms) => p.waitForTimeout(ms);
const HIDE_NOTICES = ".notices { visibility: hidden !important; }";

async function shot(p, name, opts = {}) {
  await wait(p, 300);
  await p.screenshot({ path: join(OUT, `${name}.png`), ...opts });
  console.log(`  ${name}`);
}

const browser = await launch();
try {
  // ---- the workspace with a commentary, its base and its links file (notices, layout, table, a link) ----
  for (const size of SIZES)
    for (const theme of THEMES) {
      const tag = `${size.width}-${theme}`;
      const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 }, colorScheme: theme, offline: true });
      const p = await ctx.newPage();
      await p.goto(DIST);
      await p.waitForSelector("h1");
      const ch = p.waitForEvent("filechooser");
      await p.getByRole("button", { name: "קבצים", exact: true }).click();
      await (await ch).setFiles([
        join(IN, "s7", "books", "בראשית.txt"),
        join(IN, "s7", "books", "ביאור חדש על בראשית.txt"),
        join(IN, "s7", "links", "ביאור חדש על בראשית_links.json"),
      ]);
      await p.locator(".source-row").first().waitFor({ timeout: 30_000 });
      await p.setViewportSize(size);
      await wait(p, 700);
      await shot(p, `notices-${tag}`);
      const hide = await p.addStyleTag({ content: HIDE_NOTICES });
      await shot(p, `ws-${tag}`);
      await p.getByRole("tab", { name: /קישורים/ }).first().click();
      await wait(p, 500);
      await shot(p, `rows-${tag}`);
      await p.locator(".vlist .link-item").first().click();
      await wait(p, 1500);
      // after: the count next to the picked source line opens that line's links
      const count = p.locator(".reader.source .ln.picked .marks button").first();
      if (await count.count()) await count.click();
      await shot(p, `rel-${tag}`);
      await hide.evaluate((e) => e.remove());
      await ctx.close();
    }

  // ---- 200 commentaries in the guided flow: the run, then the suggestions and the app bar in the workspace ----
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 }, offline: true });
  const q = await ctx.newPage();
  await q.goto(DIST);
  await q.waitForSelector("h1");
  await q.locator(".task-card", { hasText: "תיקייה מול אוצריא" }).click();
  const g = q.locator("main.guided");
  const c1 = q.waitForEvent("filechooser");
  await g.getByRole("button", { name: "הספרים: תיקייה" }).click();
  await (await c1).setFiles(join(IN, "b200"));
  await g.getByRole("list", { name: "נבחרו" }).waitFor({ timeout: 120_000 });
  const next = g.locator(".guided-foot").getByRole("button", { name: /^הבא/ });
  await next.click();
  await wait(q, 500);
  await next.click();
  const c2 = q.waitForEvent("filechooser");
  await g.getByRole("button", { name: "מסד אוצריא: מסד נתונים" }).click();
  await (await c2).setFiles([MINI_DB]);
  await g.getByText("כל ספרי הבסיס נמצאו.").waitFor({ timeout: 60_000 });
  await next.click();
  await wait(q, 1000);
  await q.addStyleTag({ content: HIDE_NOTICES });
  await g.getByRole("button", { name: "הפעלה" }).click();
  await q.getByRole("button", { name: /^השהיה/ }).first().waitFor({ timeout: 20_000 });
  await wait(q, 1500);
  const all = async (name, opts) => {
    for (const size of SIZES)
      for (const theme of THEMES) {
        await q.setViewportSize(size);
        await q.emulateMedia({ colorScheme: theme });
        await shot(q, `${name}-${size.width}-${theme}`, typeof opts === "function" ? opts(size) : opts);
      }
    await q.setViewportSize(SIZES[0]);
    await q.emulateMedia({ colorScheme: "light" });
  };
  await all("run");
  await g.getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$/ }).waitFor({ timeout: 600_000 });
  await g.getByRole("button", { name: "פתיחה בסביבת העבודה" }).click();
  await wait(q, 1200);
  await q.getByRole("tab", { name: /הצעות/ }).click();
  await wait(q, 1200);
  await all("sug");
  await all("bar", (size) => ({ clip: { x: 0, y: 0, width: size.width, height: 140 } }));
  await ctx.close();
} finally {
  await browser.close();
}
