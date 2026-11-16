/*
 * Alternative table-of-contents structures (`alt_toc/<book title>_alt_toc.json`): a second division
 * of a book (parashot and aliyot, study days, topics) next to its regular heading TOC.
 *
 * The contract is the generator's, reimplemented here (AGENTS.md §2.7 — no code was copied):
 * SeforimLibrary@23f1f8f1 Generator.kt:2435 `processAltTocStructures`, :2505 `buildAltTocStructure`,
 * :2863-2878 `AltTocNodeData` / `AltTocStructureData`; the library doc "קישורים וכותרות" §6.
 *
 *   • The file is a list of `{key, title?, heTitle?, nodes:[{heTitle, line, children?}]}`; `line` is
 *     1-based and truncated to an integer; nesting depth is the level.
 *   • The file is authoritative for its book: a key it no longer declares is deleted, an empty
 *     `nodes` removes that structure, and a missing file removes all of the book's structures.
 *   • A file for a Sefaria-sourced book (source name contains "sefaria") is ignored.
 *   • A node whose line is outside the book is dropped together with its children.
 *   • Every line maps to the nearest preceding node; on a shared line the node inserted last wins
 *     (a child over its parent, a later sibling over an earlier one).
 *
 * Inside the tool a structure is a FLAT list of entries with a level (what the editor shows); the
 * nested `nodes` tree exists only at the file boundary. `line` stays 1-based, as in the file and as
 * the readers number lines, so there is no second coordinate system to convert.
 */

export interface AltTocEntry {
  readonly heTitle: string;
  /** 1-based line of the book where this node starts */
  readonly line: number;
  /** nesting depth: 0 = top level */
  readonly level: number;
}

export interface AltTocStructure {
  /** stable English id; the generator derives the structure's database id from (book, key) */
  readonly key: string;
  readonly title?: string;
  readonly heTitle?: string;
  readonly entries: readonly AltTocEntry[];
}

/** A structure as an open library database already has it — the editor's starting point. */
export interface LibraryAltTocStructure extends AltTocStructure {
  /** entries without a line (only Sefaria-built structures have them): a file cannot carry them */
  readonly skipped: number;
}

/** Where a book's structures in the project came from — decides whether an emptied list is still written. */
export type AltTocOrigin = "user" | "file" | "db";

export interface AltTocBook {
  /** the book title exactly as the generator knows it (the file name carries it) */
  readonly title: string;
  readonly origin: AltTocOrigin;
  readonly structures: readonly AltTocStructure[];
}

/** One node of the file's tree. */
export interface AltTocNode {
  heTitle: string;
  line: number;
  children?: AltTocNode[];
}

/**
 * Keys of structures that SeforimLibrary synthesizes by itself (library doc §6 "מבנים שנוצרים
 * אוטומטית"): a file must not duplicate them, and any file blocks `Chapters` inheritance.
 */
export const AUTOMATIC_KEYS: readonly string[] = ["Seifim", "Topic", "SimanNames", "Chapters"];

/** The generator treats a book as Sefaria's when its source name contains "sefaria" (Generator.kt:758-765). */
export const isSefariaSourceName = (name: string | null | undefined): boolean => !!name && /sefaria/i.test(name);

/** Flat entries → the file's nested nodes. A level jump nests under the nearest shallower entry. */
export function entriesToNodes(entries: readonly AltTocEntry[]): AltTocNode[] {
  const root: AltTocNode[] = [];
  const stack: { level: number; node: AltTocNode }[] = [];
  for (const e of entries) {
    const node: AltTocNode = { heTitle: e.heTitle, line: e.line };
    while (stack.length && stack.at(-1)!.level >= e.level) stack.pop();
    const parent = stack.at(-1)?.node;
    if (parent) (parent.children ??= []).push(node);
    else root.push(node);
    stack.push({ level: e.level, node });
  }
  return root;
}

/*
 * How deep a structure may nest. Real structures are a few levels deep (חלק ← סימן ← סעיף); a file or
 * database that nests thousands of levels made the recursive readers and JSON.stringify throw a
 * RangeError (security review A7). Deeper entries are an error and the book is not written.
 */
export const MAX_ALT_TOC_DEPTH = 64;

/** The file's nested nodes → flat entries in document order; the level is the nesting depth. Iterative. */
export function nodesToEntries(nodes: readonly AltTocNode[]): AltTocEntry[] {
  const out: AltTocEntry[] = [];
  const stack: { list: readonly AltTocNode[]; i: number; level: number }[] = [{ list: nodes, i: 0, level: 0 }];
  while (stack.length) {
    const top = stack.at(-1)!;
    const n = top.list[top.i++];
    if (!n) {
      stack.pop();
      continue;
    }
    out.push({ heTitle: n.heTitle, line: n.line, level: top.level });
    if (n.children?.length) stack.push({ list: n.children, i: 0, level: top.level + 1 });
  }
  return out;
}

/** A row of `alt_toc_entry`, with its line already turned into a 1-based number (null = no line). */
export interface AltTocRow {
  id: number;
  parentId: number | null;
  line: number | null;
  text: string;
}

/**
 * Database rows → flat entries. Siblings are ordered by row id (the order the generator inserted
 * them in almost every structure of the real database). A row without a line cannot be written to
 * a file: it is skipped and its children move up to its parent.
 */
export function rowsToEntries(rows: readonly AltTocRow[]): { entries: AltTocEntry[]; skipped: number } {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<number | null, AltTocRow[]>();
  for (const r of rows) {
    const parent = r.parentId !== null && ids.has(r.parentId) ? r.parentId : null;
    // push, not spread: 40,000 siblings took 13.6 s copied one by one (security review A8)
    const list = children.get(parent);
    if (list) list.push(r);
    else children.set(parent, [r]);
  }
  for (const list of children.values()) list.sort((a, b) => a.id - b.id);
  const entries: AltTocEntry[] = [];
  let skipped = 0;
  const seen = new Set<number>();
  // iterative: a damaged or hostile database can chain thousands of parents (security review A7)
  const stack: { list: readonly AltTocRow[]; i: number; level: number }[] = [{ list: children.get(null) ?? [], i: 0, level: 0 }];
  while (stack.length) {
    const top = stack.at(-1)!;
    const r = top.list[top.i++];
    if (!r) {
      stack.pop();
      continue;
    }
    if (seen.has(r.id)) continue; // a cycle in a damaged database
    seen.add(r.id);
    if (r.line === null) skipped++;
    else entries.push({ heTitle: r.text, line: r.line, level: top.level });
    const kids = children.get(r.id);
    if (kids) stack.push({ list: kids, i: 0, level: r.line === null ? top.level : top.level + 1 });
  }
  return { entries, skipped };
}

/* ---------------- validation ---------------- */

export type AltTocSeverity = "error" | "warning" | "info";

export interface AltTocProblem {
  code: string;
  severity: AltTocSeverity;
  message: string;
  /** index of the structure in the book's list; absent = about the whole book */
  structure?: number;
  /** index of the entry inside its structure */
  entry?: number;
}

export interface AltTocContext {
  /** number of lines of the book, when known */
  lineCount?: number;
  /** false when the generator never creates that line (0-based index); undefined = not loaded */
  lineExists?: (index: number) => boolean | undefined;
  /** the book's database source is Sefaria — the generator ignores the file */
  sefaria?: boolean;
}

/** What the generator would do with the book's structures, as problems the editor and the export show. */
export function validateAltToc(structures: readonly AltTocStructure[], ctx: AltTocContext = {}): AltTocProblem[] {
  const out: AltTocProblem[] = [];
  const add = (severity: AltTocSeverity, code: string, message: string, structure?: number, entry?: number) =>
    out.push({ code, severity, message, ...(structure !== undefined && { structure }), ...(entry !== undefined && { entry }) });

  if (ctx.sefaria && structures.length)
    add("warning", "alt-toc/sefaria-book", "הספר הזה מגיע מספריא. אוצריא מתעלמת מקובץ alt_toc של ספר ספריא, ולכן המבנים לא ייכנסו לספרייה.");

  const keys = new Map<string, number>();
  structures.forEach((s, si) => {
    const name = s.heTitle || s.key || `מבנה ${si + 1}`;
    const key = s.key.trim();
    if (!key) add("error", "alt-toc/key-missing", `למבנה "${name}" אין מפתח (key). בלי מפתח אוצריא מדלגת על המבנה.`, si);
    else {
      if (keys.has(key)) add("error", "alt-toc/key-duplicate", `המפתח "${key}" מופיע בשני מבנים. לכל מבנה בספר צריך מפתח משלו.`, si);
      keys.set(key, si);
      if (key !== s.key) add("warning", "alt-toc/key-spaces", `במפתח "${s.key}" יש רווחים בקצוות. אוצריא שומרת אותו כמו שהוא; מחקו אותם.`, si);
      if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(key))
        add("warning", "alt-toc/key-not-english", `המפתח "${key}" אינו מזהה באנגלית. המפתח הוא מזהה קבוע; כתבו אותו באותיות לועזיות, ואל תשנו אותו אחרי הפרסום.`, si);
      if (AUTOMATIC_KEYS.includes(key))
        add(
          "warning",
          "alt-toc/automatic-key",
          key === "Topic"
            ? `המפתח "Topic" שמור למבנה שאוצריא גם מציגה בתוך גוף הספר. השתמשו בו רק אם הכותרות אמורות להופיע בטקסט עצמו.`
            : `"${key}" הוא מפתח של מבנה שאוצריא יוצרת בעצמה. אל תיצרו קובץ שמשכפל אותו; כתבו מבנה כזה רק כדי לתקן את המבנה האוטומטי.`,
          si,
        );
    }
    if (!s.heTitle?.trim()) add("warning", "alt-toc/no-display-name", `למבנה "${key || name}" אין שם תצוגה בעברית (heTitle). בלשונית הכותרות של אוצריא הוא יופיע בלי שם מובן.`, si);
    if (!s.entries.length) add("warning", "alt-toc/empty", `המבנה "${name}" ריק. אוצריא מוחקת מבנה בלי צמתים, ולכן הוא לא ייכתב לקובץ.`, si);

    // the open ancestors of the current entry; each remembers the line of its last child
    type Frame = { level: number; line: number; title: string; lastChild?: number };
    const stack: Frame[] = [];
    const top: Frame = { level: -1, line: 0, title: "" };
    const deep = s.entries.findIndex((e) => e.level >= MAX_ALT_TOC_DEPTH);
    if (deep >= 0) add("error", "alt-toc/too-deep", `במבנה "${name}" יש צמתים מקוננים יותר מ־${MAX_ALT_TOC_DEPTH} רמות. מבנה כזה אינו מבנה כותרות אמיתי, והכלי לא כותב אותו; צמצמו את הקינון.`, si, deep);
    s.entries.forEach((e, ei) => {
      const where = `"${name}", צומת ${ei + 1}${e.heTitle ? ` ("${e.heTitle}")` : ""}`;
      if (!e.heTitle.trim()) add("error", "alt-toc/title-missing", `${where}: חסרה כותרת לצומת.`, si, ei);
      if (!Number.isInteger(e.level) || e.level < 0) add("error", "alt-toc/bad-level", `${where}: רמת הקינון חייבת להיות מספר שלם, 0 ומעלה.`, si, ei);
      const lineOk = Number.isInteger(e.line) && e.line >= 1;
      if (!lineOk) add("error", "alt-toc/bad-line", `${where}: מספר השורה חייב להיות מספר שלם, 1 ומעלה.`, si, ei);
      else if (ctx.lineCount !== undefined && e.line > ctx.lineCount)
        add("error", "alt-toc/line-out-of-range", `${where}: שורה ${e.line} אחרי סוף הספר (${ctx.lineCount} שורות). אוצריא משמיטה צומת כזה ואת כל הצמתים שתחתיו.`, si, ei);
      else if (ctx.lineExists?.(e.line - 1) === false)
        add("error", "alt-toc/line-not-in-db", `${where}: שורה ${e.line} היא כותרת ריקה, ואוצריא לא יוצרת אותה. הצומת יושמט עם כל מה שתחתיו.`, si, ei);

      const level = Number.isInteger(e.level) && e.level >= 0 ? e.level : 0;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      const parent = stack.at(-1);
      if (level > (parent ? parent.level + 1 : 0))
        add(
          "warning",
          "alt-toc/level-jump",
          parent
            ? `${where}: קפיצה של יותר מרמה אחת. הצומת ייכתב ישירות מתחת ל"${parent.title}".`
            : `${where}: אין מעליו צומת ברמה נמוכה יותר, ולכן הוא ייכתב כצומת עליון (רמה 0).`,
          si,
          ei,
        );
      if (lineOk && parent && e.line < parent.line)
        add("warning", "alt-toc/before-parent", `${where}: הצומת מתחיל (שורה ${e.line}) לפני הצומת שמעליו (שורה ${parent.line}).`, si, ei);
      const siblings = parent ?? top;
      if (lineOk && siblings.lastChild !== undefined && e.line < siblings.lastChild)
        add("warning", "alt-toc/out-of-order", `${where}: שורה ${e.line} קודמת לשורה של הצומת הקודם באותה רמה (${siblings.lastChild}). אוצריא מציגה את הצמתים בסדר הרשימה, אבל ממפה כל שורה לפי המיקום.`, si, ei);
      if (lineOk) siblings.lastChild = e.line;
      stack.push({ level, line: lineOk ? e.line : 0, title: e.heTitle });
    });
  });
  return out;
}

/** Structures that go into the file: an empty structure would only be deleted by the generator. */
export const writtenStructures = (structures: readonly AltTocStructure[]): AltTocStructure[] => structures.filter((s) => s.entries.length > 0);
