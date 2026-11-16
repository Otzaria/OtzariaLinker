/*
 * Screenshots of the design alternatives of the V5 UX audit (docs/reviews/ux2-alternatives/index.html).
 * Not a test. Each alternative is the REAL built app in the state the audit found, with a few CSS
 * rules or a DOM touch injected to show the proposal — nothing here changes the app's source. A
 * proposal the owner picks is then built properly, with tests.
 *
 *   npm run build
 *   node scripts/audit/ux-v5-alternatives.mjs <inputs-dir>     # inputs: see ux-v5.mjs
 *
 * Writes PNGs to .bench/ux-v5-alt/ ; py scripts/audit/to_webp.py turns them into the page's images.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, MINI_DB } from "./harness.mjs";

const IN = process.argv[2];
if (!IN) throw new Error("usage: node scripts/audit/ux-v5-alternatives.mjs <inputs-dir>");
const OUT = join(import.meta.dirname, "..", "..", ".bench", "ux-v5-alt");
mkdirSync(OUT, { recursive: true });
const DIST = new URL("../../dist/OtzariaLinker.html", import.meta.url).href;
const wait = (p, ms) => p.waitForTimeout(ms);

/** One alternative: injected CSS (and an optional DOM touch), a screenshot, then everything taken out again. */
async function alt(p, name, css = "", dom) {
  const tag = await p.addStyleTag({ content: css || "/* before */" });
  // the DOM touch returns its own undo, kept in the page (a function does not cross evaluate)
  if (dom) await p.evaluate(`window.__altUndo = (${dom.toString()})()`);
  await wait(p, 350);
  await p.screenshot({ path: join(OUT, `${name}.png`) });
  await tag.evaluate((e) => e.remove());
  if (dom) await p.evaluate(() => (window.__altUndo?.(), (window.__altUndo = undefined)));
  await wait(p, 150);
  console.log(`  ${name}`);
}

const browser = await launch();
try {
  // opened wide, then the window is made narrower: a fresh open below 1200px starts on the preset
  // "two texts and a side panel" (state/preferences.ts); a window narrowed later keeps four columns
  const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 }, offline: true });
  const p = await ctx.newPage();
  await p.goto(DIST);
  await p.waitForSelector("h1");
  await p.setViewportSize({ width: 1024, height: 768 });

  // ---- the links of a commentary with its books, a links file of the library (task d) ----
  const ch = p.waitForEvent("filechooser");
  await p.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await ch).setFiles([
    join(IN, "s7", "books", "בראשית.txt"),
    join(IN, "s7", "books", "ביאור חדש על בראשית.txt"),
    join(IN, "s7", "links", "ביאור חדש על בראשית_links.json"),
  ]);
  await p.locator(".source-row").first().waitFor({ timeout: 30_000 }).catch(async (e) => { await p.screenshot({ path: join(OUT, "fail.png") }); throw e; });
  await wait(p, 800);
  await p.getByRole("tab", { name: /קישורים/ }).first().click();
  await wait(p, 600);

  // 6. notices: they are on screen now (opened books, loaded links)
  await alt(p, "notices-before");
  await alt(
    p,
    "notices-a",
    `.notice { grid-template-columns: auto 1fr auto; padding: 6px 10px; }
     .notice > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
     .notice details { display: none; }
     .notices > .notice:not(:last-child) { display: none; }
     .notices { width: min(520px, calc(100vw - 32px)); }`,
    () => {
      const n = document.querySelectorAll(".notices > .notice").length;
      const more = document.querySelector(".notices-more");
      if (more) (more.dataset.altHidden = "1"), (more.hidden = true);
      const b = document.createElement("button");
      b.className = "btn text notices-more";
      b.dataset.alt = "1";
      b.textContent = `עוד ${n - 1} הודעות`;
      document.querySelector(".notices")?.prepend(b);
      return () => (document.querySelectorAll("[data-alt]").forEach((e) => e.remove()), more && ((more.hidden = false), more.removeAttribute("data-alt-hidden")));
    },
  );
  await alt(
    p,
    "notices-b",
    `.notices > .notice:not(.error), .notices-more { display: none; }`,
    () => {
      const bar = document.querySelector(".app-bar");
      const help = bar?.querySelector('[aria-label="עזרה"]');
      const count = document.querySelectorAll(".notices > .notice").length;
      const pill = document.createElement("button");
      pill.className = "btn tonal";
      pill.dataset.alt = "1";
      pill.style.cssText = "min-height:30px;padding:2px 10px;gap:6px";
      pill.innerHTML = `${document.querySelector(".notice .icon")?.outerHTML ?? ""}<span>${count} הודעות</span>`;
      help?.before(pill);
      return () => document.querySelectorAll("[data-alt]").forEach((e) => e.remove());
    },
  );
  // the rest without notices over them
  await p.evaluate(() => document.querySelectorAll(".notice .icon-btn").forEach((b) => b.click()));
  await p.addStyleTag({ content: ".notices { display: none !important; }" });

  // 1. the workspace at 1024×768: four columns
  await alt(p, "ws1024-before");
  // A: below 1200px the app opens on the preset "two texts and a side panel" (the books are a tab)
  await p.getByRole("button", { name: "פריסת סביבת העבודה" }).click();
  await p.getByRole("menuitemradio", { name: "שני טקסטים וחלונית צד" }).or(p.getByRole("menuitem", { name: "שני טקסטים וחלונית צד" })).first().click();
  await wait(p, 500);
  await alt(p, "ws1024-a");
  await p.getByRole("button", { name: "פריסת סביבת העבודה" }).click();
  await p.getByRole("menuitemradio", { name: "ארבעה טורים" }).or(p.getByRole("menuitem", { name: "ארבעה טורים" })).first().click();
  await wait(p, 500);
  // B: four columns, the sources as a rail of icons (a click opens it over the reader)
  await alt(
    p,
    "ws1024-b",
    `.workspace { grid-template-columns: 48px 8px minmax(160px, 1fr) 8px minmax(160px, 1fr) 8px minmax(300px, 0.9fr) !important; }
     .sources-panel .panel-body > *, .sources-panel .panel-head h2, .sources-panel .panel-head .grip, .sources-panel .panel-head .icon-btn { display: none !important; }
     .sources-panel .panel-head { justify-content: center; padding-inline: 0; }`,
    () => {
      const body = document.querySelector(".sources-panel .panel-body");
      const icons = [...document.querySelectorAll(".sources-panel .source-row > .icon")].map((i) => i.outerHTML);
      const rail = document.createElement("div");
      rail.dataset.alt = "1";
      rail.style.cssText = "display:grid;gap:14px;justify-items:center;padding-top:12px;color:var(--primary)";
      rail.innerHTML = icons.map((i) => `<div style="display:grid;place-items:center;width:36px;height:36px;border-radius:8px;background:var(--surface-container)">${i}</div>`).join("") + `<div style="display:grid;place-items:center;width:36px;height:36px;border-radius:8px;border:1px dashed var(--outline)">+</div>`;
      const head = document.querySelector(".sources-panel .panel-head");
      const hi = head?.querySelector("h2 .icon")?.cloneNode(true);
      if (hi) (hi.dataset.alt = "1"), head.append(hi);
      body?.append(rail);
      return () => document.querySelectorAll("[data-alt]").forEach((e) => e.remove());
    },
  );

  // 3 & 5 at 1440: the links table and a link shown on both texts
  await p.setViewportSize({ width: 1440, height: 900 });
  await wait(p, 500);
  await p.locator(".vlist .link-item").first().click();
  await wait(p, 1500);
  await alt(p, "rel-after");
  await alt(p, "rows-before", "", () => {
    document.querySelector(".side-panel")?.scrollIntoView();
    return () => {};
  });
  // rows A: two lines, the source over the target, the type with the target
  await alt(
    p,
    "rows-a",
    `.vlist .link-item .ends { flex-wrap: wrap !important; row-gap: 2px; overflow: visible !important; }
     .vlist .link-item { align-content: center; }
     .vlist .link-item .ends > .end { flex-basis: calc(100% - 70px); }
     .vlist .link-item .ends > .icon { display: none; }
     .vlist .link-item .ends > .end:last-of-type::before { content: "←"; color: var(--on-surface-variant); }
     .vlist .link-item .ends > .end:last-of-type { margin-inline-start: 22px; }
     .vlist .link-item > .muted { display: none; }`,
  );
  // rows B: a wider side panel (the links tab takes 40%), one row per link as a table
  await alt(
    p,
    "rows-b",
    `.workspace { grid-template-columns: minmax(160px, 0.8fr) 8px minmax(160px, 1.2fr) 8px minmax(160px, 1.2fr) 8px minmax(420px, 1.6fr) !important; }
     .vlist .link-item { grid-template-columns: 1fr auto; }
     .vlist .link-item .ends > .end .t { max-width: 12em; }
     .vlist .link-item > .muted { grid-column: 1; }`,
  );
  // relation A: a line's marks open the list of its links, each with the other line's opening words
  await alt(p, "rel-a", "", () => {
    const mark = document.querySelector(".reader.source .ln.picked .mark") ?? document.querySelector(".reader.source .mark");
    const tgt = document.querySelector(".reader.target .ln.picked .tx")?.textContent?.trim().slice(0, 48) ?? "";
    const no = document.querySelector(".reader.target .ln.picked .no")?.textContent ?? "";
    const title = document.querySelector(".reader.target .panel-head h2")?.textContent ?? "";
    if (!mark) return () => {};
    const r = mark.getBoundingClientRect();
    const pop = document.createElement("div");
    pop.dataset.alt = "1";
    pop.style.cssText = `position:fixed;top:${r.bottom + 6}px;left:${Math.max(8, r.left - 10)}px;z-index:40;width:300px;padding:8px 10px;border-radius:12px;background:var(--surface-container-high);box-shadow:var(--elev-3);border:1px solid var(--outline-variant);font:var(--fs-sm) var(--font-ui);display:grid;gap:6px`;
    pop.innerHTML = `<b>הקישורים של השורה (1)</b><div style="display:grid;gap:2px;padding:6px 8px;border-radius:8px;background:color-mix(in srgb,var(--tertiary-container) 70%,transparent)"><span><b>${title} ${no}</b> · פירוש</span><span style="font-family:var(--font-book)">${tgt}…</span></div><span class="muted">לחיצה: מעבר לשורה · Ctrl+לחיצה: עריכה</span>`;
    mark.style.outline = "2px solid var(--primary)";
    document.body.append(pop);
    return () => (document.querySelectorAll("[data-alt]").forEach((e) => e.remove()), (mark.style.outline = ""));
  });
  // relation B: the pair is drawn as one: same number badge on both ends, a band across the gap
  await alt(
    p,
    "rel-b",
    `.ln.picked { box-shadow: inset 0 0 0 2px var(--primary); border-radius: 6px; }
     .reader.target .ln.picked { box-shadow: inset 0 0 0 2px var(--tertiary); }`,
    () => {
      const src = document.querySelector(".reader.source .ln.picked");
      const tgt = document.querySelector(".reader.target .ln.picked");
      if (!src || !tgt) return () => {};
      const a = src.getBoundingClientRect();
      const b = tgt.getBoundingClientRect();
      const band = document.createElement("div");
      band.dataset.alt = "1";
      const x1 = b.right, x2 = a.left;
      band.style.cssText = `position:fixed;z-index:30;pointer-events:none;left:${x1}px;width:${Math.max(0, x2 - x1)}px;top:${Math.min(a.top, b.top) + 10}px;height:${Math.abs(a.top - b.top) + 8}px;`;
      band.innerHTML = `<svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100"><path d="M100 ${a.top < b.top ? 4 : 96} C 50 ${a.top < b.top ? 4 : 96}, 50 ${a.top < b.top ? 96 : 4}, 0 ${a.top < b.top ? 96 : 4}" stroke="var(--primary)" stroke-width="3" fill="none" vector-effect="non-scaling-stroke" stroke-dasharray="6 4"/></svg>`;
      document.body.append(band);
      return () => document.querySelectorAll("[data-alt]").forEach((e) => e.remove());
    },
  );

  // 7. the app bar at 820×1180
  await p.setViewportSize({ width: 820, height: 1180 });
  await wait(p, 600);
  await alt(p, "bar820-before");
  await alt(p, "bar820-a", `.app-bar .brand-name { display: none; } .app-bar .sep { display: none; }`);
  await alt(
    p,
    "bar820-b",
    `.app-bar .brand-name { display: none; }`,
    () => {
      const bar = document.querySelector(".app-bar");
      const hide = [...bar.querySelectorAll('[aria-label="ביטול הפעולה האחרונה"], [aria-label="ביצוע חוזר"], .history-menu, .sep')];
      const layout = bar.querySelector('[aria-label="פריסת סביבת העבודה"]')?.closest(".menu");
      if (layout) hide.push(layout);
      for (const e of hide) (e.dataset.altHidden = "1"), (e.style.display = "none");
      const more = document.createElement("button");
      more.className = "icon-btn";
      more.dataset.alt = "1";
      more.innerHTML = '<span style="font-size:22px;line-height:1;font-weight:700">⋮</span>';
      more.title = "עוד: ביטול, ביצוע חוזר, רשימת הפעולות, פריסה";
      bar.querySelector(".brand")?.after(more);
      return () => (document.querySelectorAll("[data-alt]").forEach((e) => e.remove()), hide.forEach((e) => (e.style.display = "", e.removeAttribute("data-alt-hidden"))));
    },
  );
  await ctx.close();

  // ---- 200 commentaries in the guided flow (task c): the run, then the suggestions in the workspace ----
  const ctx2 = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 }, offline: true });
  const q = await ctx2.newPage();
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
  await g.getByRole("button", { name: "הפעלה" }).click();
  await q.getByRole("button", { name: /^השהיה/ }).first().waitFor({ timeout: 20_000 });
  await wait(q, 2500);
  await q.addStyleTag({ content: ".notices { display: none !important; }" });
  // 4. the run: three progress bars (app bar, the step's card, the job)
  await alt(q, "run-before");
  await alt(
    q,
    "run-a",
    `main.guided .guided-card.info > b, main.guided .guided-card.info > progress, main.guided .guided-card.info > span { display: none; }
     main.guided .guided-card.info { padding: 0; border: 0; background: none; }
     :root:has(main.guided) .app-bar .task { display: none; }`,
  );
  await alt(
    q,
    "run-b",
    `main.guided .ml-job > [role=status], main.guided .ml-job > progress, main.guided .ml-job-counts, main.guided .ml-job details { display: none; }
     main.guided .ml-job { border: 0; padding: 0; margin: 0; }
     :root:has(main.guided) .app-bar .task { display: none; }`,
    () => {
      const card = document.querySelector("main.guided .guided-card.info");
      const d = document.createElement("details");
      d.dataset.alt = "1";
      d.className = "held";
      d.innerHTML = "<summary>פרטים: לפי שיטה ולפי ספר</summary>";
      card?.append(d);
      return () => document.querySelectorAll("[data-alt]").forEach((e) => e.remove());
    },
  );
  await g.getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$/ }).waitFor({ timeout: 600_000 });
  await g.getByRole("button", { name: "פתיחה בסביבת העבודה" }).click();
  await wait(q, 1200);
  await q.getByRole("tab", { name: /הצעות/ }).click();
  await wait(q, 1200);
  // 2. the suggestions after max-link: four summaries before the first suggestion
  await alt(q, "sug-before");
  await alt(
    q,
    "sug-a",
    `.side-panel .ml-job, .side-panel .ml-report, .side-panel .problems { display: none; }`,
    () => {
      const head = document.querySelector(".side-panel .sug-head .grow");
      const line = document.createElement("div");
      line.dataset.alt = "1";
      line.style.cssText = "margin-top:4px;font-size:var(--fs-sm)";
      line.innerHTML = `<span class="muted">200 ספרים · הסתיים · </span><a href="#" style="color:var(--primary)">דוח העבודה ▸</a>`;
      head?.append(line);
      return () => document.querySelectorAll("[data-alt]").forEach((e) => e.remove());
    },
  );
  await alt(
    q,
    "sug-b",
    `.workspace { grid-template-columns: minmax(0, 0.55fr) 8px minmax(160px, 1fr) 8px minmax(160px, 1fr) 8px minmax(480px, 1.6fr) !important; }
     .side-panel .ml-job, .side-panel .ml-report, .side-panel .problems { display: none; }`,
  );
  await ctx2.close();
} finally {
  await browser.close();
}
