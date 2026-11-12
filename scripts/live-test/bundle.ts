/*
 * The test bundle for stage 20 — checking OtzariaLinker's output INSIDE the Otzaria app
 * (docs/LIVE_TESTING.md). Pure and deterministic: the same code gives the same bytes, with no clock.
 *
 * Every `_links.json` here is written by the tool's own code: the links are `Link` objects as the
 * builder makes them (status "new", provenance "user"), anchors are converted with the generator
 * port (core/text/offsets.ts), the anchor label goes into heRef_2 as the tool writes it
 * (core/text/anchor-label.ts), Sefaria refs come from the database heRef (core/links/sefaria-ref.ts),
 * and the files come out of planExport (formats/links-json/export.ts) with the same validation
 * context the store builds (AppStore.validation()), for "private use". The content update (check 15)
 * moves the links with the tool's own edition diff and relink planner (matching/line-diff.ts,
 * linking/relink.ts).
 *
 * The books are tiny .txt files that go into an Otzaria personal-books folder. Their titles start
 * with "בדיקת מקשר" — no book in seforim.db v37 has such a title (a title in both libraries makes
 * the app reject the file as ambiguous: user_link_ref_resolver.dart:156-158 on Otzaria upstream/dev).
 *
 * Run: node scripts/live-test/make-bundle.mjs [out-dir]   (tests: tests/integration/live-test/)
 */
import type { BookRef, Link, LinkSide } from "../../src/core/links/model";
import { isSefariaOwned } from "../../src/core/links/sefaria-titles";
import { sefariaRefFromHeRef } from "../../src/core/links/sefaria-ref";
import { validateExport, type LineFacts, type Problem, type ValidationContext } from "../../src/core/links/validate";
import { withAnchorLabel } from "../../src/core/text/anchor-label";
import { headingLevel, stripTags } from "../../src/core/text/html";
import { rawOffsetFromVisible, visibleUnits } from "../../src/core/text/offsets";
import { planExport, type ExportPlan } from "../../src/formats/links-json/export";
import { planRelink } from "../../src/linking/relink";
import { diffLines } from "../../src/matching/line-diff";
import { splitBookLines } from "../../src/sources/text/text-source";

/* ------------------------------------------------------------------ books */

/** The folder the tester adds in Otzaria; its name becomes the category under "ספרים אישיים". */
export const BOOKS_DIR = "בדיקת מקשר";

export const BASE = "בדיקת מקשר - ספר בסיס";
export const COMMENTARY = "בדיקת מקשר - פירוש";
/** Starts with "הערות" (numbered-note popups) but NOT "הערות על " — the generator merges such a book away. */
export const NOTES = "הערות לבדיקת מקשר";
export const CITING = "בדיקת מקשר - ספר מצטט";
export const ON_GENESIS = "בדיקת מקשר - פירוש על בראשית";

/** The bracketed tag at the start of a line is its number in the ORIGINAL edition, for the tester. */
const BOOKS: Readonly<Record<string, readonly string[]>> = {
  [BASE]: [
    `<h1>${BASE}</h1>`,
    "<h2>פרק א</h2>",
    "[ב-3] שורת בסיס לפירוש רגיל, בלי עוגן.",
    "[ב-4] <b>פתיחה מודגשת</b> ואחריה המילה המסומנת יעקב, שעליה עוגן טווח.",
    "[ב-5] <i>מילה נטויה</i> וכאן יופיע סמן אות לפני המילה רחל.",
    "[ב-6] בשורה הזו יש סימן הערה (1) באמצע המשפט.",
    "[ב-7] שורה שמפנה לטווח של שלוש שורות בספר המצטט.",
    "[ב-8] שורה שהפירוש מצביע אליה כמקור.",
    "[ב-9] שורה שטווח מהספר המצטט מפנה אליה.",
    "<h2>פרק ב</h2>",
    "[ב-11] שורה אחרי כותרת: היעד של הפניה מהספר המצטט.",
    "[ב-12] סוף ספר הבסיס.",
  ],
  [COMMENTARY]: [
    `<h1>${COMMENTARY}</h1>`,
    "<h2>פרק א</h2>",
    "[פ-3] פירוש על שורה 3 בספר הבסיס.",
    "[פ-4] פירוש על המילה יעקב שבשורה 4 בספר הבסיס.",
    "[פ-5] פירוש על הסמן שלפני המילה רחל בשורה 5 בספר הבסיס.",
    '[פ-6] הפירוש הזה מצביע אל מקורו, שורה 8 בספר הבסיס (סוג "מקור").',
  ],
  [NOTES]: [
    `<h1>${NOTES}</h1>`,
    // the note line OPENS with the same marker the base line prints (numbered_note_markers.dart:24-27)
    "(1) זו ההערה של הסימן (1) שבשורה 6 בספר הבסיס.",
  ],
  [CITING]: [
    `<h1>${CITING}</h1>`,
    "[מ-2] פתיחה.",
    "[מ-3] תחילת טווח היעד (שורות 3 עד 5).",
    "[מ-4] אמצע טווח היעד.",
    "[מ-5] סוף טווח היעד.",
    "[מ-6] שורה מחוץ לטווח: כאן לא אמור להופיע הקישור.",
    "[מ-7] תחילת טווח המקור (שורות 7 עד 8).",
    "[מ-8] סוף טווח המקור.",
    "[מ-9] הפניה לשורה 11 בספר הבסיס.",
    "[מ-10] הפניה לבראשית א, א (ספר של ספריא בספרייה הרשמית).",
  ],
  [ON_GENESIS]: [
    `<h1>${ON_GENESIS}</h1>`,
    '[ס-2] פירוש על בראשית א, ב (נכתב בקובץ הזה, בסוג "פירוש").',
    '[ס-3] פירוש על בראשית א, ג (נכתב בקובץ הזה, בסוג "מקור").',
    "[ס-4] פירוש על בראשית א, ד (נכתב בקובץ בראשית_links.json).",
  ],
};

/** A line inserted after the title in the new edition of the base book (check 15). */
export const UPDATE_INSERTED_LINE = "[ב-חדש] שורה שנוספה בעדכון התוכן. כל השורות שאחריה זזו בשורה אחת.";

/**
 * The official Sefaria book, as seforim.db v37 has it (db_version 37, schema 7). Verified against
 * the real slice tests/fixtures/db/seforim-v7-mini.db by tests/integration/live-test/bundle.test.ts,
 * and against the full database by bundle-real-db.local.test.ts.
 */
export const GENESIS = {
  title: "בראשית",
  totalLines: 1584,
  isBaseBook: true,
  /** 0-based lineIndex → line.heRef */
  heRefs: { 2: "בראשית, א, א", 3: "בראשית, א, ב", 4: "בראשית, א, ג", 5: "בראשית, א, ד" } as Readonly<Record<number, string>>,
} as const;

/* ------------------------------------------------------------------ references */

/** BookRef as the tool gives it: a .txt file is an Otzaria-style book (TextFilesSource), the DB book is Sefaria's. */
function ref(title: string, edition = ""): BookRef {
  if (title === GENESIS.title) return { key: "db:official:1", title, origin: "sefaria", isBaseBook: true };
  return { key: `txt:${title}.txt${edition}`, title, origin: "otzaria" };
}

const side = (title: string, line1: number, end1?: number): LinkSide => ({
  book: ref(title),
  line: line1 - 1,
  ...(end1 !== undefined && { end: end1 - 1 }),
});

/** heRef_2 the way the builder fills it when the user leaves it empty (AppStore.autoHeRef). */
function autoHeRef(title: string, line1: number): string {
  if (title === GENESIS.title) return GENESIS.heRefs[line1 - 1]!;
  const lines = BOOKS[title]!;
  const trail: string[] = [];
  let level = 7;
  for (let i = line1 - 1; i >= 0 && level > 1; i--) {
    const h = headingLevel(lines[i]);
    if (h !== null && h < level) {
      const text = stripTags(lines[i]).trim();
      if (text && text !== title) trail.unshift(text);
      level = h;
    }
  }
  return trail.length ? `${title} ${trail.join(", ")}` : `${title} ${line1}`;
}

/** Raw offsets of `word` in a line, from its VISIBLE position — what the builder does when a word is clicked. */
function anchorOn(title: string, line1: number, word: string): { rawStart: number; rawEnd: number; visibleStart: number } {
  const html = BOOKS[title]![line1 - 1]!;
  const visible = visibleUnits(html).map((u) => html.slice(u.start, u.end)).join("");
  const v = visible.indexOf(word);
  if (v < 0 || visible.indexOf(word, v + 1) >= 0) throw new Error(`"${word}" must occur once in ${title}:${line1}`);
  return { rawStart: rawOffsetFromVisible(html, v), rawEnd: rawOffsetFromVisible(html, v + word.length), visibleStart: v };
}

/* ------------------------------------------------------------------ cases */

export interface LiveCase {
  /** L1… — the id the checks in docs/LIVE_TESTING.md refer to */
  id: string;
  /** the plan's checks (1–15) this case serves */
  checks: number[];
  /** what the record is, in Hebrew */
  what: string;
  link: Link;
}

let seq = 0;
function link(id: string, checks: number[], what: string, l: Omit<Link, "id" | "status" | "provenance">): LiveCase {
  seq++;
  return { id, checks, what, link: { id: `live-${String(seq).padStart(2, "0")}-${id}`, status: "new", provenance: "user", ...l } };
}

function cases(): LiveCase[] {
  seq = 0;
  const a2 = anchorOn(BASE, 4, "יעקב");
  const a3 = anchorOn(BASE, 5, "רחל");
  const g = (line1: number) => side(GENESIS.title, line1);
  const sef = (line1: number) => sefariaRefFromHeRef(GENESIS.heRefs[line1 - 1]) ?? undefined;
  return [
    link("L1", [3, 4, 10], "פירוש, שורה לשורה, בין שני ספרים אישיים (מקובץ ספר הבסיס)", {
      source: side(BASE, 3), target: side(COMMENTARY, 3), declaredType: "commentary", heRef2: autoHeRef(COMMENTARY, 3),
    }),
    link("L2", [8, 10], 'פירוש עם עוגן טווח על המילה "יעקב" (start ו־end, אחרי תג <b>)', {
      source: side(BASE, 4), target: side(COMMENTARY, 4), declaredType: "commentary", heRef2: autoHeRef(COMMENTARY, 4),
      anchor: { rawStart: a2.rawStart, rawEnd: a2.rawEnd },
    }),
    link("L3", [8, 10], 'פירוש עם עוגן נקודה לפני המילה "רחל" ותווית "א" (start בלבד, " אות א" ב־heRef_2)', {
      source: side(BASE, 5), target: side(COMMENTARY, 5), declaredType: "commentary", heRef2: withAnchorLabel(autoHeRef(COMMENTARY, 5), "א"),
      anchor: { rawStart: a3.rawStart, label: "א" },
    }),
    link("L4", [10], "הערת שוליים: הסימן (1) בספר הבסיס אל ספר ההערות (footnotes)", {
      source: side(BASE, 6), target: side(NOTES, 2), declaredType: "footnotes", heRef2: autoHeRef(NOTES, 2),
    }),
    link("L5", [4, 5, 6, 9], "הפניה משורה אחת אל טווח של שלוש שורות ביעד (line_index_2_end)", {
      source: side(BASE, 7), target: side(CITING, 3, 5), declaredType: "reference", heRef2: autoHeRef(CITING, 3),
    }),
    link("L6", [9], "הפניה מטווח של שתי שורות במקור (line_index_1_end) אל שורה אחת", {
      source: side(CITING, 7, 8), target: side(BASE, 9), declaredType: "reference", heRef2: autoHeRef(BASE, 9),
    }),
    link("L7", [5, 6, 7], "הפניה אל שורה שאחרי כותרת: בדיקת השורה המדויקת", {
      source: side(CITING, 9), target: side(BASE, 11), declaredType: "reference", heRef2: autoHeRef(BASE, 11),
    }),
    link("L8", [7, 12, 14], "הפניה מספר אישי אל בראשית א, א בספרייה הרשמית (ספר ספריא)", {
      source: side(CITING, 10), target: g(3), declaredType: "reference", heRef2: autoHeRef(GENESIS.title, 3),
      ...(sef(3) && { ref2: sef(3) }),
    }),
    link("L9", [11], 'מפירוש אל ספר הבסיס בסוג "מקור" (source), מקובץ הפירוש', {
      source: side(COMMENTARY, 6), target: side(BASE, 8), declaredType: "source", heRef2: autoHeRef(BASE, 8),
    }),
    link("L10", [10, 12, 14], 'פירוש אישי אל בראשית א, ב בסוג "פירוש" (commentary), מקובץ הפירוש', {
      source: side(ON_GENESIS, 2), target: g(4), declaredType: "commentary", heRef2: autoHeRef(GENESIS.title, 4),
      ...(sef(4) && { ref2: sef(4) }),
    }),
    link("L11", [11, 12, 14], 'פירוש אישי אל בראשית א, ג בסוג "מקור" (source), מקובץ הפירוש', {
      source: side(ON_GENESIS, 3), target: g(5), declaredType: "source", heRef2: autoHeRef(GENESIS.title, 5),
      ...(sef(5) && { ref2: sef(5) }),
    }),
    link("L12", [10, 12, 14], "מבראשית א, ד בספרייה הרשמית אל הפירוש האישי (קובץ בראשית_links.json בתיקייה האישית)", {
      source: g(6), target: side(ON_GENESIS, 4), declaredType: "commentary", heRef2: autoHeRef(ON_GENESIS, 4),
      ...(sef(6) && { ref1: sef(6) }),
    }),
  ];
}

/** A record of a type the generator does not know (it stores OTHER) — the app's import rejects the whole file. */
function negativeCases(): LiveCase[] {
  return [
    link("N1a", [], "רשומה תקינה באותו קובץ (הפניה)", {
      source: side(NOTES, 2), target: side(BASE, 12), declaredType: "reference", heRef2: autoHeRef(BASE, 12),
    }),
    link("N1b", [], 'רשומה בסוג שאוצריא לא מכירה ("commentry", שגיאת כתיב)', {
      source: side(NOTES, 2), target: side(BASE, 3), declaredType: "commentry", heRef2: autoHeRef(BASE, 3),
    }),
  ];
}

/* ------------------------------------------------------------------ validation context */

/** The store's ValidationContext (AppStore.validation()) for these books, purpose "private use". */
export function validationContext(books: Readonly<Record<string, readonly string[]>> = BOOKS): ValidationContext {
  const lines = (b: BookRef) => books[b.title];
  return {
    lineCount: (b) => (b.title === GENESIS.title ? GENESIS.totalLines : lines(b)?.length),
    line: (b, i): LineFacts | undefined => {
      const text = lines(b)?.[i];
      if (text === undefined) return undefined; // the Sefaria book's lines are not loaded: "not verified"
      const heading = headingLevel(text);
      return { exists: !(heading !== null && !stripTags(text).trim()), heading, anchorLength: text.length, hasNotes: false };
    },
    // the bundle's books are new; for בראשית the tester confirms in the export dialog that the
    // personal folder holds no file of it (DbLinksState.confirmNewFile) — it is not the library's file
    linksFile: () => "confirmed-new",
    libraryMayHaveFile: (title) => title === GENESIS.title,
    sefariaOwned: (b) => isSefariaOwned(b),
    purpose: "private",
  };
}

/* ------------------------------------------------------------------ bundle */

export interface BundleFile {
  /** path inside the bundle folder, with "/" */
  path: string;
  text: string;
}

export interface CaseReport {
  id: string;
  checks: number[];
  what: string;
  file: string;
  /** 1-based position of the record in its file */
  record: number;
  from: string;
  to: string;
  type: string;
  anchor?: { rawStart: number; rawEnd?: number; label?: string };
  /** what the tool's validation says, for the record (codes and severity) */
  tool: { code: string; severity: Problem["severity"] }[];
}

export interface LiveTestBundle {
  files: BundleFile[];
  cases: CaseReport[];
  /** the plans, for the tests */
  plans: { main: ExportPlan; update: ExportPlan; negative: ExportPlan };
  /** case id → where it lands after the content update (check 15) */
  relinked: Record<string, string>;
}

const where = (s: LinkSide) => `${s.book.title}:${s.line + 1}${s.end !== undefined && s.end > s.line ? `-${s.end + 1}` : ""}`;

function reportCases(list: readonly LiveCase[], plan: ExportPlan, ctx: ValidationContext, dir: string): CaseReport[] {
  const problems = validateExport(list.map((c) => c.link), ctx);
  return list.map((c) => {
    const l = c.link;
    const file = plan.files.find((f) => f.sourceTitle === l.source.book.title)!;
    const records = JSON.parse(file.text) as Record<string, unknown>[];
    const record =
      records.findIndex(
        (r) =>
          r.line_index_1 === l.source.line + 1 &&
          r.line_index_2 === l.target.line + 1 &&
          r.path_2 === `${l.target.book.title}.txt` &&
          r["Conection Type"] === l.declaredType &&
          r.start === l.anchor?.rawStart,
      ) + 1;
    return {
      id: c.id,
      checks: c.checks,
      what: c.what,
      file: `${dir}/${file.name}`,
      record,
      from: where(l.source),
      to: where(l.target),
      type: l.declaredType,
      ...(l.anchor && { anchor: { ...l.anchor } }),
      tool: (problems.get(l.id) ?? []).map((p) => ({ code: p.code, severity: p.severity })),
    };
  });
}

const bookText = (lines: readonly string[]) => lines.join("\n"); // no trailing newline: no extra empty line

export function buildLiveTestBundle(): LiveTestBundle {
  const ctx = validationContext();
  const main = cases();
  const mainPlan = planExport(main.map((c) => c.link), ctx);

  // check 15: a new edition of the base book with one line inserted after its title
  const oldLines = BOOKS[BASE]!;
  const newLines = [oldLines[0]!, UPDATE_INSERTED_LINE, ...oldLines.slice(1)];
  const updatedBooks = { ...BOOKS, [BASE]: newLines };
  const mapping = diffLines(oldLines, newLines);
  const relink = planRelink({
    links: main.map((c) => c.link),
    oldBook: ref(BASE),
    newBook: ref(BASE), // same title and key: the folder keeps one file, edited in place
    mapping,
    oldLine: (i) => oldLines[i],
    newLine: (i) => newLines[i],
    isOld: (b) => b.title === BASE,
  });
  const movedById = new Map(relink.items.map((i) => [i.link.id, i.moved ?? i.link]));
  const updatePlan = planExport(main.map((c) => movedById.get(c.link.id) ?? c.link), validationContext(updatedBooks));
  const relinked: Record<string, string> = {};
  for (const c of main) {
    const m = movedById.get(c.link.id);
    if (m && (m.source.line !== c.link.source.line || m.target.line !== c.link.target.line)) relinked[c.id] = `${where(m.source)} → ${where(m.target)}`;
  }

  const negative = negativeCases();
  // For private use the tool now STOPS this file (export/unknown-type is an error there, because the
  // app rejects the whole file). The case exists to show the app doing that, so the file is written
  // with the submission rules, where the type is only a warning (the generator stores OTHER).
  const negativeCtx: ValidationContext = { ...ctx, purpose: "submission" };
  const negativePlan = planExport(negative.map((c) => c.link), negativeCtx);

  const files: BundleFile[] = [
    ...Object.entries(BOOKS).map(([title, lines]) => ({ path: `${BOOKS_DIR}/${title}.txt`, text: bookText(lines) })),
    ...mainPlan.files.map((f) => ({ path: `${BOOKS_DIR}/${f.name}`, text: f.text })),
    { path: `update/${BASE}.txt`, text: bookText(newLines) },
    // only the files the move changed: the others stay as they are in BOOKS_DIR
    ...updatePlan.files
      .filter((f) => mainPlan.files.find((m) => m.name === f.name)?.text !== f.text)
      .map((f) => ({ path: `update/${f.name}`, text: f.text })),
    ...negativePlan.files.map((f) => ({ path: `negative/${f.name}`, text: f.text })),
  ];

  const report = [...reportCases(main, mainPlan, ctx, BOOKS_DIR), ...reportCases(negative, negativePlan, negativeCtx, "negative")];
  files.push({ path: "manifest.json", text: `${JSON.stringify({ format: "otzaria-linker-live-test", version: 1, cases: report, relinked }, null, 2)}\n` });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, cases: report, plans: { main: mainPlan, update: updatePlan, negative: negativePlan }, relinked };
}

/** The lines of a bundle book as both the tool and the app split them (TextFilesSource / `split('\n')`). */
export const bundleBookLines = (text: string): string[] => splitBookLines(text);
export const BUNDLE_BOOKS = BOOKS;
