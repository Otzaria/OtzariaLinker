/*
 * The v7 live-test extras (docs/reviews/V7_LIVE_OTZARIA_TESTS.md): the cases the stage-20 bundle
 * (bundle.ts) has no record for — both ranges in one link, several anchors on one line, INLINE_LINKER,
 * a target book the app does not have, the personal CSV and an alt-TOC file. Written by the tool's own
 * code (planExport, personalLinkRows/writePersonalLinksCsv, planAltTocExport) with the store's
 * "private use" validation context, like bundle.ts. Pure and deterministic.
 *
 * Run: node scripts/live-test/make-v7-extra.mjs <out-dir>
 *
 * Two files are NOT the tool's output, and say so in manifest.json: `invalid-line/` (a line past the
 * end of the target; the tool refuses to write it, so its own record is edited) and `corrupt/` (the
 * tool's file cut in the middle) — both test what the APP does with a bad file.
 */
import type { BookRef, Link, LinkSide } from "../../src/core/links/model";
import type { AltTocBook } from "../../src/core/alt-toc/model";
import type { ValidationContext } from "../../src/core/links/validate";
import { validateExport } from "../../src/core/links/validate";
import { headingLevel, stripTags } from "../../src/core/text/html";
import { rawOffsetFromVisible, visibleUnits } from "../../src/core/text/offsets";
import { planAltTocExport } from "../../src/formats/alt-toc/export";
import { planExport } from "../../src/formats/links-json/export";
import { personalLinkRows, writePersonalLinksCsv } from "../../src/formats/personal-csv/write";
import { GENESIS, validationContext as bundleContext } from "./bundle";

export const EXTRA_DIR = "בדיקת מקשר 2";
export const X_SRC = "בדיקת מקשר 2 - מקור";
export const X_TGT = "בדיקת מקשר 2 - יעד";
/** a title no library has (LIVE-17) */
export const X_MISSING = "בדיקת מקשר 2 - ספר שאינו קיים";

const BOOKS: Readonly<Record<string, readonly string[]>> = {
  [X_SRC]: [
    `<h1>${X_SRC}</h1>`,
    "[א-2] תחילת טווח המקור (שורות 2 עד 3) שמפנה אל טווח ביעד.",
    "[א-3] סוף טווח המקור.",
    "[א-4] בשורה הזו שני עוגנים: על שמעון ועל לוי.",
    "[א-5] ציטוט בטקסט: המילים בראשית ברא מסומנות כקישור.",
    "[א-6] שורה שמפנה אל ספר שאינו קיים בספרייה.",
    "[א-7] שורה שמפנה אל מיקום שאינו קיים ביעד.",
    "[א-8] שורה שנכתבת בקובץ CSV אישי כפירוש על בראשית.",
  ],
  [X_TGT]: [
    `<h1>${X_TGT}</h1>`,
    "<h2>חלק ראשון</h2>",
    "[י-3] פירוש על שמעון שבשורה 4 בספר המקור.",
    "[י-4] פירוש על לוי שבשורה 4 בספר המקור.",
    "[י-5] תחילת טווח היעד (שורות 5 עד 6).",
    "<h2>חלק שני</h2>",
    "[י-7] סוף טווח היעד: שורה 7 (אחרי כותרת).",
    "[י-8] סוף ספר היעד.",
  ],
};

function ref(title: string): BookRef {
  if (title === GENESIS.title) return { key: "db:official:1", title, origin: "sefaria", isBaseBook: true };
  return { key: `txt:${title}.txt`, title, origin: "otzaria" };
}
const side = (title: string, line1: number, end1?: number): LinkSide => ({ book: ref(title), line: line1 - 1, ...(end1 !== undefined && { end: end1 - 1 }) });

function anchorOn(title: string, line1: number, word: string): { rawStart: number; rawEnd: number } {
  const html = BOOKS[title]![line1 - 1]!;
  const visible = visibleUnits(html).map((u) => html.slice(u.start, u.end)).join("");
  const v = visible.indexOf(word);
  if (v < 0 || visible.indexOf(word, v + 1) >= 0) throw new Error(`"${word}" must occur once in ${title}:${line1}`);
  return { rawStart: rawOffsetFromVisible(html, v), rawEnd: rawOffsetFromVisible(html, v + word.length) };
}

let seq = 0;
const mk = (id: string, l: Omit<Link, "id" | "status" | "provenance">): Link => ({ id: `v7x-${String(++seq).padStart(2, "0")}-${id}`, status: "new", provenance: "user", ...l });

/** The bundle's context (Genesis facts, private use), with this folder's books added. */
function context(): ValidationContext {
  const base = bundleContext();
  const lines = (b: BookRef) => BOOKS[b.title];
  return {
    ...base,
    lineCount: (b) => lines(b)?.length ?? base.lineCount(b),
    line: (b, i) => {
      const text = lines(b)?.[i];
      if (text === undefined) return base.line(b, i);
      const heading = headingLevel(text);
      return { exists: !(heading !== null && !stripTags(text).trim()), heading, anchorLength: text.length, hasNotes: false };
    },
  };
}

export interface ExtraFile {
  path: string;
  text: string;
}

export function buildV7Extra(): { files: ExtraFile[]; manifest: Record<string, unknown> } {
  seq = 0;
  const ctx = context();
  const shimon = anchorOn(X_SRC, 4, "שמעון");
  const levi = anchorOn(X_SRC, 4, "לוי");
  const inline = anchorOn(X_SRC, 5, "בראשית ברא");

  const main = [
    // LIVE-08: a range on both sides
    mk("E1-both-ranges", { source: side(X_SRC, 2, 3), target: side(X_TGT, 5, 7), declaredType: "reference", heRef2: `${X_TGT} חלק ראשון` }),
    // LIVE-10: two anchors on one line, to two commentary lines
    mk("E2-anchor-shimon", { source: side(X_SRC, 4), target: side(X_TGT, 3), declaredType: "commentary", heRef2: `${X_TGT} חלק ראשון`, anchor: { rawStart: shimon.rawStart, rawEnd: shimon.rawEnd } }),
    mk("E3-anchor-levi", { source: side(X_SRC, 4), target: side(X_TGT, 4), declaredType: "commentary", heRef2: `${X_TGT} חלק ראשון`, anchor: { rawStart: levi.rawStart, rawEnd: levi.rawEnd } }),
  ];
  const inlineLinks = [
    // LIVE-16: INLINE_LINKER (private use only; the tool warns that it depends on the Otzaria version)
    mk("E4-inline-linker", { source: side(X_SRC, 5), target: side(GENESIS.title, 3), declaredType: "INLINE_LINKER", heRef2: GENESIS.heRefs[2]!, anchor: { rawStart: inline.rawStart, rawEnd: inline.rawEnd } }),
  ];
  const missing = [
    // LIVE-17: a target the app's libraries do not have
    mk("E5-missing-target", { source: side(X_SRC, 6), target: side(X_MISSING, 2), declaredType: "reference", heRef2: `${X_MISSING} 2` }),
  ];
  const valid7 = [mk("E6-valid-line", { source: side(X_SRC, 7), target: side(X_TGT, 8), declaredType: "reference", heRef2: `${X_TGT} חלק שני` })];

  const plans = {
    main: planExport(main, ctx),
    inline: planExport(inlineLinks, ctx),
    missing: planExport(missing, ctx),
    valid7: planExport(valid7, ctx),
  };
  const tool = (links: Link[]) => Object.fromEntries([...validateExport(links, ctx)].map(([id, ps]) => [id, ps.map((p) => `${p.severity}:${p.code}`)]));

  // LIVE-18: the tool writes line 8 (the last); the app gets 40 — the tool would refuse that (validate: past the end)
  const invalidRefused = validateExport([{ ...valid7[0]!, target: side(X_TGT, 40) }], ctx);
  const validText = plans.valid7.files[0]?.text ?? "";
  const invalidText = validText.replace(/"line_index_2":\s*8(\.0)?/, '"line_index_2": 40');
  // LIVE-30: the tool's own file cut in the middle
  const mainText = plans.main.files[0]?.text ?? "";
  const corruptText = mainText.slice(0, Math.floor(mainText.length / 2));

  // LIVE-24: the personal CSV (personal book → official book, by heading)
  // a commentary link runs from the base (official) to the commentary (the personal line), as the file reads it
  const csvLink = mk("E7-personal-csv", { source: side(GENESIS.title, 3), target: side(X_SRC, 8), declaredType: "commentary", heRef2: `${X_SRC} 8` });
  const csv = personalLinkRows([csvLink], {
    isPersonal: (b) => b.key.startsWith("txt:"),
    isOfficial: (b) => b.title === GENESIS.title,
    contentLine: (b, line) => {
      const t = BOOKS[b.title]?.[line];
      return t !== undefined && headingLevel(t) === null && stripTags(t).trim() !== "";
    },
    positionOf: (s) => (s.book.title === GENESIS.title && s.line >= 1 && s.line <= 32 ? "פרק א" : null),
    lineCount: (b) => BOOKS[b.title]?.length,
  });
  const csvFiles = writePersonalLinksCsv(csv.rows).files;

  // LIVE-25: an alt-TOC ("כותרות חלופיות") file for the target book
  const altToc: AltTocBook[] = [
    { title: X_TGT, origin: "user", structures: [{ key: "LinkerTest", heTitle: "חלוקה לבדיקה", entries: [{ heTitle: "חלוקה א", line: 3, level: 0 }, { heTitle: "חלוקה ב", line: 7, level: 0 }] }] },
  ];
  const altPlan = planAltTocExport(altToc, (t) => ({ lineCount: BOOKS[t]?.length, lineExists: (i) => BOOKS[t]?.[i] !== undefined }));

  const files: ExtraFile[] = [
    ...Object.entries(BOOKS).map(([title, lines]) => ({ path: `${EXTRA_DIR}/${title}.txt`, text: lines.join("\n") })),
    ...plans.main.files.map((f) => ({ path: `${EXTRA_DIR}/${f.name}`, text: f.text })),
    ...plans.inline.files.map((f) => ({ path: `inline/${f.name}`, text: f.text })),
    ...plans.missing.files.map((f) => ({ path: `missing/${f.name}`, text: f.text })),
    ...plans.valid7.files.map((f) => ({ path: `valid-line/${f.name}`, text: f.text })),
    ...(invalidText ? [{ path: `invalid-line/${X_SRC}_links.json`, text: invalidText }] : []),
    ...(corruptText ? [{ path: `corrupt/${X_SRC}_links.json`, text: corruptText }] : []),
    ...csvFiles.map((f) => ({ path: `csv/${f.name}`, text: f.text })),
    ...altPlan.files.map((f) => ({ path: `alt-toc/${f.name}`, text: f.text })),
  ];
  const manifest = {
    format: "otzaria-linker-v7-live-extra",
    version: 1,
    written: Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, { files: p.files.map((f) => f.name), written: p.written.length, heldBack: p.heldBack.length }])),
    tool: { ...tool(main), ...tool(inlineLinks), ...tool(missing), ...tool(valid7) },
    invalidLineToolSays: [...invalidRefused.values()].flat().map((p) => `${p.severity}:${p.code}`),
    handEdited: { "invalid-line/": "line_index_2 8 → 40 in the tool's file (the tool refuses 40)", "corrupt/": "the tool's main file cut at half its length" },
    csv: { rows: csv.rows.length, skipped: csv.skipped.map((s) => s.code) },
    altToc: { files: altPlan.files.map((f) => f.name), heldBack: altPlan.heldBack.length },
  };
  files.push({ path: "manifest.json", text: `${JSON.stringify(manifest, null, 2)}\n` });
  return { files, manifest };
}
