import { garbledMessage, mappingProblems, ROWID, type CandidateReason, type ColumnPreview, type DbAnalysis, type DbMapping, type SchemaPreview, type TablePreview, type TextCandidate, type TextUnit } from "./db-mapping";

/*
 * The mapping wizard's guess, explained. Every text column of every table is a candidate for "the
 * text of the books"; each piece of evidence adds or removes points and is kept as a reason the
 * wizard shows ("ערכים ארוכים (ממוצע 84 תווים)", "שם הטבלה מרמז על יומן"). Evidence: how much text
 * (length, words), Hebrew share, how the values repeat, the order column, the relation to a table of
 * titles (FOREIGN KEY, name, or values), and the warning signs of a database that is not a library
 * (log/settings tables, timestamps, key/value rows, search-index storage, views over the table).
 *
 * Only a candidate with a mapping and at least BOOKS_SCORE points is proposed. When there is none,
 * the wizard says "no books in this database" and why — instead of proposing the least bad table,
 * which made a settings database open as books named "INFO" and "ERROR" (PR #5).
 *
 * Pure, and tolerant of missing statistics: a preview without them (an older build, a test) still
 * gets a guess from names and lengths.
 */
export const BOOKS_SCORE = 5;
const WEAK_SCORE = 2;
const MAX_CANDIDATES = 8;

const RX = {
  title: /^(title|name|book_?title|book_?name|sefer|heb_?title|he_?title|שם|כותרת|שם_?ספר)$/i,
  titleLoose: /title|name|שם|כותרת/i,
  id: /^(id|book_?id|_id|bid|key)$/i,
  bookRef: /^(book_?id|bookid|book|sefer_?id|work_?id|id_?book|ספר|book_?key)$/i,
  bookRefLoose: /book|sefer|work|ספר/i,
  /** "chapter_id" → a table named chapter(s) */
  anyRef: /^(.+?)_?id$/i,
  order: /^(line_?index|line_?idx|line_?no|line_?num(ber)?|index|idx|ord|order|order_?index|seq|sequence|position|pos|num|number|line|row_?num|part|part_?no|chunk|chunk_?(no|index)|page|seg|segment|סדר|מספר)$/i,
  orderLoose: /index|order|seq|pos|num|סדר/i,
  chapter: /^(chapter|chap|perek|chapter_?(no|num|number|index)|section|siman|part|פרק|סימן)$/i,
  verse: /^(verse|pasuk|passuk|halacha|halakha|seif|sentence|paragraph|para|line_?no|פסוק|הלכה|סעיף)$/i,
  text: /^(content|text|line|body|html|line_?text|txt|value|תוכן|טקסט)$/i,
  textLoose: /content|text|body|html|תוכן|טקסט/i,
  heading: /^(heading|heading_?level|level|header_?level|h_?level|toc_?level|depth)$/i,
  path: /^(path|file|file_?path|folder|dir)$/i,
  category: /^(category|category_?id|cat|categoryid|genre|section|קטגוריה)$/i,
  linkSource: /^(source|src|from|line_?id_?1|source_?line(_?id)?|from_?line(_?id)?|line1|line_?from|src_?line)$/i,
  linkTarget: /^(target|dst|to|line_?id_?2|target_?line(_?id)?|to_?line(_?id)?|line2|line_?to|dst_?line)$/i,
  linkType: /^(type|kind|connection_?type(_?id)?|link_?type|relation)$/i,
  /** tables of an application rather than a library */
  noise: /(^|_)(log|logs|setting|settings|config|configuration|prefs?|preferences|cache|sessions?|history|events?|metadata|meta|kv|properties|migrations?|android_metadata|errors?|audit|telemetry|bookmarks?|users?|accounts?)($|_)/i,
  time: /^(ts|time|timestamp|date|datetime|created(_?at)?|updated(_?at)?|modified(_?at)?|logged(_?at)?)$/i,
  eavKey: /^(attr|attribute|key|k|field|property|prop|kind|type|name)$/i,
  eavValue: /^(val|value|v|data)$/i,
  partTable: /chapter|chap|perek|section|siman|part|פרק|סימן/i,
  editionTable: /version|edition|nusach|nusah|translation|נוסח|מהדור|תרגום/i,
  /** details a library catalog keeps about a book (a row describes a book; it is not a line of one) */
  catalog: /^(authors?|author_?name|publishers?|isbn|years?|from_?year|to_?year|printing_?year|pub(lication)?_?(date|year)|places?|printing_?place|subjects?|tags|keywords|volumes?|pages|page_?count|language|lang|genre|edition|shelf|call_?number)$/i,
  /** other names of things: aliases, acronyms, search terms */
  names: /(^|_)(terms?|alias(es)?|acronyms?|synonyms?|keywords?|nicknames?|abbr|abbreviations?)($|_)/i,
  /** a table of links between books, and a column that holds a reference ("בראשית א:א"), not text */
  linkTable: /link|connection|relation|cross_?ref|קישור/i,
  refColumn: /(^|_|[a-z])(ref|reference|refs)$|^(he_?)?ref/i,
  /** a yes/no flag ("isBaseBook", "has_notes"), never a reference to another table */
  flag: /^(is|has|can|should)([A-Z_]|$)/,
  describe: /desc|description|summary|abstract|blurb|comment|remark|^notes?$|הערה|תיאור/i,
  tocTable: /^(toc|toc_?entr(y|ies)|tocentry|contents|table_?of_?contents|headings|תוכן(_?עניינים)?)$/i,
};

const TEXTUAL = new Set<ColumnPreview["kind"]>(["text", "html", "compressed"]);
const textual = (c: ColumnPreview) => TEXTUAL.has(c.kind) && !c.virtual;
const integral = (c: ColumnPreview) => c.kind === "integer" || c.rowidAlias;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const lower = (s: string) => s.toLowerCase();

/** The mapping proposed for a schema, or null (kept for callers that need only the guess). */
export function guessMapping(preview: SchemaPreview): DbMapping | null {
  return analyzeSchema(preview).guess;
}

export function analyzeSchema(p: SchemaPreview): DbAnalysis {
  const all: TextCandidate[] = [];
  const biggest = Math.max(0, ...p.tables.filter((t) => t.columns.some(textual)).map((t) => t.pages));
  const secondBiggest = p.tables.filter((t) => t.columns.some(textual) && t.pages < biggest).reduce((m, t) => Math.max(m, t.pages), 0);
  // tables other tables refer to (by FOREIGN KEY, name or values): tables of books or chapters, whose text columns describe them
  const referenced = new Map<string, string>();
  for (const t of p.tables) {
    const r = refOf(p, t, []);
    if (r && r.how !== "values" && !referenced.has(r.target.name)) referenced.set(r.target.name, t.name);
  }
  for (const t of p.tables)
    for (const c of t.columns) if (textual(c) && c.avgLength > 0) all.push(candidate(p, t, c, biggest > secondBiggest && t.pages === biggest && biggest > 1, referenced.get(t.name)));
  all.sort((a, b) => b.score - a.score || tablePages(p, b.table) - tablePages(p, a.table) || a.table.localeCompare(b.table));
  const best = all.find((c) => c.verdict === "books") ?? null;
  // the names the chosen mapping reads (book titles, chapter titles) are not candidates for the text
  const m = best?.mapping;
  const used = new Set(
    m ? [m.books && `${m.books.table}.${m.books.title}`, m.layout === "single-table" && `${m.lines.table}.${m.lines.book}`, m.via?.title && `${m.via.table}.${m.via.title}`].filter(Boolean) : [],
  );
  for (const c of all)
    if (used.has(`${c.table}.${c.column}`)) {
      c.verdict = "rejected";
      c.reasons.push({ weight: 0, text: "במיפוי שנבחר זו עמודת השמות, לא הטקסט" });
    }
  const rank = { books: 0, weak: 1, rejected: 2 } as const;
  all.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.score - a.score);
  const candidates = all.slice(0, MAX_CANDIDATES);
  return {
    candidates,
    guess: best?.mapping ?? null,
    noBooks: best === null,
    summary: best ? `מצאתי טקסט של ספרים בטבלה "${best.table}" (העמודה "${best.column}").` : noBooksSummary(p, all),
    limitations: limitationsOf(p),
  };
}

const tablePages = (p: SchemaPreview, name: string) => p.tables.find((t) => t.name === name)?.pages ?? 0;

/*
 * Other databases of Otzaria that users pick by mistake (version 3's diagnoseWrongDb, F-009): the table names
 * that give each away, and where the books database is. Checked only when no books were found.
 */
const OTZARIA_BOOKS_DB = 'מסד הספרים הוא בדרך כלל הקובץ "seforim.db" בתיקיית הספרייה של אוצריא (otzaria-library). בחרו אותו במקום הקובץ הזה.';
const WRONG_DBS: readonly { tables: readonly string[]; what: string }[] = [
  { tables: ["user_notes", "user_highlights", "user_bookmarks", "bookmarks"], what: "זהו כנראה מסד נתוני המשתמש של אוצריא (הערות, סימונים וסימניות), ולא מסד הספרים." },
  { tables: ["surface", "variant", "processed_lines", "variant_judgment"], what: "זהו כנראה מסד ניתוח טקסט (נוסחים) של אוצריא, ולא מסד הספרים." },
  { tables: ["hebrew_books", "otzar_hachochma", "db_meta"], what: "זהו כנראה מסד אינדקס או נתוני רקע, ולא מסד הספרים." },
];

function noBooksSummary(p: SchemaPreview, candidates: TextCandidate[]): string {
  const names = new Set(p.tables.map((t) => lower(t.name)));
  const wrong = WRONG_DBS.find((w) => w.tables.some((t) => names.has(t)));
  if (wrong) return `לא נמצאו ספרים במסד הזה. ${wrong.what} ${OTZARIA_BOOKS_DB}`;
  if (!p.tables.length) return "לא נמצאו ספרים במסד הזה: אין בו טבלאות שהכלי יכול לקרוא.";
  if (p.tables.every((t) => !t.samples.length)) return "לא נמצאו ספרים במסד הזה: כל הטבלאות בו ריקות.";
  if (!candidates.length) return "לא נמצאו ספרים במסד הזה: אין בו עמודות טקסט (רק מספרים, נתונים בינאריים או עמודות ריקות).";
  const weak = candidates.filter((c) => c.verdict === "weak");
  const unreadable = p.tables.some((t) => t.columns.some((c) => c.kind === "binary" && c.format));
  return `לא נמצאו ספרים במסד הזה: בדקתי ${candidates.length.toLocaleString("he")} עמודות טקסט, ואף אחת אינה נראית כמו טקסט של ספר.${
    weak.length ? ` המועמדת הקרובה ביותר היא "${weak[0]!.table}.${weak[0]!.column}"; אם אתם בטוחים שיש בה ספרים, אפשר למפות אותה ידנית.` : ""
  }${unreadable ? " יש במסד גם עמודות שהכלי אינו יכול לקרוא כטקסט (ראו למטה)." : ""}`;
}

/* ---------------- one candidate ---------------- */

function candidate(p: SchemaPreview, t: TablePreview, c: ColumnPreview, biggest: boolean, referencedBy: string | undefined): TextCandidate {
  const reasons: CandidateReason[] = [];
  const warnings: string[] = [];
  let score = 0;
  const why = (points: number, text: string) => {
    score += points;
    reasons.push({ weight: points, text });
  };

  // how much text, and what kind
  const len = c.avgLength;
  if (len >= 40) why(3, `ערכים ארוכים (ממוצע ${len.toLocaleString("he")} תווים)`);
  else if (len >= 15) why(1, `ערכים באורך בינוני (ממוצע ${len} תווים)`);
  else why(-3, `ערכים קצרים (ממוצע ${len} תווים): נראה כמו שמות, קודים או הגדרות`);
  if (c.words !== undefined) {
    if (c.words >= 4) why(2, `טקסט רציף (כ־${Math.round(c.words)} מילים בכל ערך)`);
    else if (c.words < 1.5) why(-3, "מילה אחת בכל ערך");
  }
  if (c.hebrew !== undefined) {
    if (c.hebrew >= 0.6) why(3, `${pct(c.hebrew)} מהאותיות בעברית`);
    else if (c.hebrew >= 0.2) why(1, `${pct(c.hebrew)} מהאותיות בעברית`);
    else {
      why(-2, `רק ${pct(c.hebrew)} מהאותיות בעברית`);
      warnings.push(`הטקסט בעמודה "${c.name}" כמעט אינו בעברית (${pct(c.hebrew)} מהאותיות).`);
    }
  }
  if (c.timestamps) why(-6, "הערכים הם תאריכים או שעות");
  if ((c.garbled ?? 0) > 0.2) {
    why(-8, "הטקסט אינו UTF-8 תקין (קידוד ישן שנשמר כ־TEXT), והכלי אינו יכול לשחזר אותו");
    warnings.push(garbledMessage(t.name, c.name));
  }
  if (c.encoding) why(0, `טקסט בקידוד ${c.encoding === "cp1255" ? "Windows-1255" : "UTF-16"} בתוך BLOB (הכלי מפענח אותו)`);
  if (c.compression) why(0, `טקסט דחוס (${c.compression}; הכלי פורס אותו)`);
  if (c.filled >= 6 && c.distinct / c.filled < 0.5) why(-3, `ערכים חוזרים (${c.distinct} שונים מתוך ${c.filled}): נראה כמו יומן או רשימת ערכים`);
  else if (c.filled >= 3 && c.distinct / c.filled >= 0.9) why(1, "כמעט כל הערכים שונים זה מזה");
  if (RX.text.test(c.name) || RX.textLoose.test(c.name)) why(1, `שם העמודה ("${c.name}") מתאים לטקסט`);
  else if (RX.title.test(c.name) || RX.titleLoose.test(c.name)) why(-3, `שם העמודה ("${c.name}") מתאים לשם או לכותרת, לא לטקסט`);
  if (biggest) why(1, `הטבלה הגדולה ביותר שיש בה טקסט (${t.pages.toLocaleString("he")} עמודים)`);

  // warning signs: this is an application's database, or not the place the text really lives
  if (RX.noise.test(t.name)) why(-4, `שם הטבלה ("${t.name}") מרמז על יומן, הגדרות או נתונים של תוכנה`);
  const time = t.columns.find((x) => x !== c && (x.timestamps || RX.time.test(x.name)));
  if (time) why(-1, `יש בטבלה עמודת זמן ("${time.name}")`);
  const eav = RX.eavValue.test(c.name) ? t.columns.find((x) => x !== c && textual(x) && RX.eavKey.test(x.name) && x.distinct <= Math.max(3, x.filled / 4) && identifiers(t, x)) : undefined;
  if (eav) why(-3, `טבלת "מפתח־ערך": העמודה "${eav.name}" אומרת מה כל רשומה, וכל רשומה היא תכונה ולא שורה`);
  if (t.shadowOf) {
    const v = p.virtualTables?.find((x) => x.name === t.shadowOf!.table);
    why(-3, `זו טבלה פנימית של אינדקס החיפוש "${t.shadowOf.table}" (${t.shadowOf.module})`);
    warnings.push(
      `הטקסט נלקח מהאחסון הפנימי של אינדקס החיפוש "${t.shadowOf.table}"${v?.columns.length ? `; העמודות c0, c1… הן לפי הסדר ${v.columns.join(", ")}` : ""}. בדקו בדוגמה שהספרים והשורות נכונים.`,
    );
  }
  const views = (p.views ?? []).filter((v) => v.reads.some((r) => lower(r) === lower(t.name)));
  if (views.length) why(-1, `מבט (${views.map((v) => v.name).join(", ")}) קורא מהטבלה: ייתכן שהספרים מורכבים שם, והכלי אינו קורא מבטים`);

  // a library catalog: every row describes a book (author, year, place…), its text columns are details
  if (RX.names.test(c.name)) why(-3, `שם העמודה ("${c.name}") מרמז על שמות נוספים, ראשי תיבות או מונחים, לא על טקסט`);
  if (RX.names.test(t.name)) why(-2, `שם הטבלה ("${t.name}") מרמז על שמות נוספים, ראשי תיבות או מונחים`);
  if (RX.linkTable.test(t.name)) why(-3, `שם הטבלה ("${t.name}") מרמז על טבלת קישורים בין ספרים, לא על טקסט`);
  if (RX.refColumn.test(c.name)) why(-3, `שם העמודה ("${c.name}") מרמז על מראה מקום (הפניה), לא על טקסט`);
  if (RX.describe.test(c.name)) why(-3, `שם העמודה ("${c.name}") מרמז על תיאור או הערה, לא על טקסט של ספר`);
  if (referencedBy && titleColumn(t, c.name)) why(-3, `הטבלה "${referencedBy}" מפנה לטבלה הזאת: זו כנראה טבלת ספרים או פרקים, ועמודות הטקסט שלה מתארות אותם`);
  if (RX.catalog.test(c.name)) why(-3, `שם העמודה ("${c.name}") הוא פרט של קטלוג, לא טקסט של ספר`);
  const details = t.columns.filter((x) => x !== c && RX.catalog.test(x.name));
  if (details.length >= 2) why(-3, `בטבלה עמודות של קטלוג (${details.slice(0, 4).map((x) => x.name).join(", ")}): כל רשומה מתארת ספר, ואינה שורה ממנו`);
  if (c.jsonLines !== undefined && c.jsonLines < 3) why(-2, `ערכי JSON קצרים (רשימה של כ־${Math.max(1, Math.round(c.jsonLines))} פריטים): נראה כמו פרטים, לא כמו פרקים`);

  // the structure: how rows become books and lines
  const unit = unitOf(c);
  const ownName = t.columns.find((x) => x !== c && textual(x) && RX.title.test(x.name) && x.filled >= 5 && x.distinct === x.filled);
  if (unit === "line" && ownName) why(-4, `לכל רשומה בטבלה יש שם משלה (בעמודה "${ownName.name}"): כל רשומה היא פריט — ספר או פרק — ולא שורה`);
  if (unit === "json") why(2, `JSON של טקסט (כ־${Math.round(c.jsonLines!)} שורות בכל ערך)`);
  else if (unit === "lines") why(2, `כמה שורות בכל ערך (כ־${Math.round((c.newlines ?? 0) + 1)})`);
  const built = structure(p, t, c, unit, why);
  if (!built) why(-2, "לא מצאתי עמודה שמחלקת את השורות לספרים (שם ספר, או הפניה לטבלה של שמות)");

  // never propose what cannot be opened: the mapping is checked like a manual one
  const blocking = built ? mappingProblems(p, built).find((x) => x.level === "error") : undefined;
  if (blocking) why(-5, `המיפוי שעולה מהטבלה אינו קריא: ${blocking.message}`);
  const verdict = built && !blocking && score >= BOOKS_SCORE ? "books" : score >= WEAK_SCORE ? "weak" : "rejected";
  return { table: t.name, column: c.name, score, verdict, reasons, warnings, mapping: built };
}

/** Values of a short column that look like identifiers ("title", "line_2"), not like names of books. */
function identifiers(t: TablePreview, c: ColumnPreview): boolean {
  const i = t.columns.indexOf(c);
  const vals = t.samples.map((r) => r[i] ?? "").filter(Boolean);
  return vals.length > 0 && vals.every((v) => /^[a-z][a-z0-9_.-]*$/i.test(v));
}

function unitOf(c: ColumnPreview): TextUnit {
  if ((c.jsonLines ?? 0) >= 3) return "json";
  if ((c.newlines ?? 0) >= 1) return (c.sameLength ?? 0) >= 0.5 ? "chunks" : "lines";
  return "line";
}

type Why = (points: number, text: string) => void;

/** The mapping that reads candidate column `c` of table `t` as book text, or null. */
function structure(p: SchemaPreview, t: TablePreview, c: ColumnPreview, unit: TextUnit, why: Why): DbMapping | null {
  const withUnit = (lines: DbMapping["lines"]): DbMapping["lines"] => (unit === "line" ? lines : { ...lines, unit });
  // two tables: a column of this table refers to a table of titles (directly, or through chapters/versions)
  const ref = refOf(p, t, [c.name]);
  if (ref) {
    const second = titleColumn(ref.target) && !RX.partTable.test(ref.target.name) && !RX.editionTable.test(ref.target.name) ? null : refOf(p, ref.target, [], [t.name]);
    const books = second ? second.target : ref.target;
    const title = titleColumn(books);
    if (title) {
      why(ref.how === "fk" ? 3 : 2, ref.reason);
      if (title.avgLength > 0 && title.avgLength < 6 && (title.words ?? 2) < 1.5) why(-2, `השמות בעמודה "${books.name}.${title.name}" הם מילה קצרה אחת: נראה כמו ערכים של מילון, לא שמות של ספרים`);
      const refCol = t.columns.find((x) => x.name === ref.column);
      const spread = refCol && refCol.filled >= 10 ? refCol.distinct / refCol.filled : 0;
      if (unit === "line" && spread >= 0.75)
        why(-6, `כמעט כל שורה מהראשונות שייכת ל"ספר" אחר (${refCol!.distinct} מתוך ${refCol!.filled}): נראה כמו מילון או רשימת ערכים, לא ספרים`);
      else if (unit === "line" && spread >= 0.25) why(-2, `השורות הראשונות שייכות ל־${refCol!.distinct} ספרים שונים (מתוך ${refCol!.filled}): מעט שורות לכל ספר`);
      const { order, then } = orderOf(t, [ref.column, c.name], ref.column, why);
      const heading = unit === "line" ? headingColumn(t, [ref.column, c.name, order, ...then]) : undefined;
      const path = books.columns.find((x) => RX.path.test(x.name) && textual(x));
      const category = books.columns.find((x) => RX.category.test(x.name));
      let via: DbMapping["via"];
      if (second) {
        const kind = RX.editionTable.test(ref.target.name) ? "edition" : "part";
        const viaOrder = kind === "part" ? orderColumn(ref.target, [second.column]) : null;
        const viaTitle = titleColumn(ref.target);
        via = {
          table: ref.target.name,
          id: idColumn(ref.target),
          book: second.column,
          ...(viaOrder && viaOrder !== ROWID && { order: viaOrder }),
          ...(viaTitle && { title: viaTitle.name }),
          kind,
        };
        why(1, kind === "edition" ? `כל רשומה ב־"${ref.target.name}" היא מהדורה של ספר מ־"${books.name}" (${second.reason})` : `השורות מחולקות לפרקים ב־"${ref.target.name}", והפרקים שייכים לספרים ב־"${books.name}"`);
      }
      const links = unit === "line" && !via ? linksGuess(p, [t.name, books.name]) : undefined;
      return {
        layout: "two-tables",
        books: { table: books.name, id: idColumn(books), title: title.name, ...(path && { path: path.name }), ...(category && { category: category.name }) },
        lines: withUnit({ table: t.name, book: ref.column, order, text: c.name, ...(heading && { heading }), ...(then.length && { orderThen: then }) }),
        ...(links && { links }),
        ...(via && { via }),
      };
    }
  }
  // one table: a column holds the book title — repeated on every line, or one row per book
  const named = titleColumn(t, c.name);
  const title = named ?? t.columns.find((x) => x !== c && textual(x) && !RX.catalog.test(x.name) && x.avgLength <= 120 && x.distinct < x.filled);
  if (!title) return null;
  const onePerRow = title.filled >= 3 && title.distinct === title.filled;
  if (unit !== "line" && onePerRow) why(2, `כל רשומה היא ספר שלם, ושמו בעמודה "${title.name}"`);
  else if (unit !== "line" && title.distinct < title.filled) why(1, `העמודה "${title.name}" מחזיקה את שם הספר, וכמה רשומות שייכות לאותו ספר`);
  else if (unit === "line" && onePerRow && title.filled >= 5) why(-3, `כל ערך בעמודה "${title.name}" שונה: כל רשומה תהיה ספר נפרד בן שורה אחת`);
  else why(1, `העמודה "${title.name}" מחזיקה את שם הספר${title.distinct < title.filled ? " (חוזרת בכמה שורות)" : ""}`);
  if (identifiers(t, title) && (c.hebrew ?? 0) >= 0.2) why(-2, `הערכים בעמודה "${title.name}" נראים כמו מזהים של תוכנה, לא כמו שמות של ספרים`);
  const { order, then } = orderOf(t, [title.name, c.name], title.name, why);
  const heading = unit === "line" ? headingColumn(t, [title.name, c.name, order, ...then]) : undefined;
  const path = t.columns.find((x) => RX.path.test(x.name) && textual(x) && x !== title);
  const links = unit === "line" ? linksGuess(p, [t.name]) : undefined;
  return {
    layout: "single-table",
    lines: withUnit({ table: t.name, book: title.name, order, text: c.name, ...(heading && { heading }), ...(path && { path: path.name }), ...(then.length && { orderThen: then }) }),
    ...(links && { links }),
  };
}

interface Ref {
  column: string;
  target: TablePreview;
  how: "fk" | "name" | "values";
  reason: string;
}

/**
 * A column of `t` that refers to another table: a declared FOREIGN KEY, a name ("book_id",
 * "chapter_id" → chapters), or values that are all ids of that table. Targets with titles first.
 */
function refOf(p: SchemaPreview, t: TablePreview, exclude: string[], skip: string[] = []): Ref | null {
  const others = p.tables.filter((x) => x !== t && !skip.includes(x.name) && !x.shadowOf);
  const usable = t.columns.filter(
    (c) => !exclude.includes(c.name) && !c.rowidAlias && !RX.flag.test(c.name) && !(c.ints?.length === 2 && c.ints.includes(0) && c.ints.includes(1)) && (integral(c) || (textual(c) && c.avgLength <= 64)),
  );
  const byName = (name: string) => others.find((x) => lower(x.name) === lower(name));
  for (const fk of t.foreignKeys ?? []) {
    const target = byName(fk.table);
    if (target && usable.some((c) => c.name === fk.column)) return { column: fk.column, target, how: "fk", reason: `העמודה "${fk.column}" מפנה (FOREIGN KEY) לטבלה "${target.name}"` };
  }
  const titled = others.filter((x) => titleColumn(x)).sort((a, b) => Number(/book|sefer|ספר/i.test(b.name)) - Number(/book|sefer|ספר/i.test(a.name)) || a.pages - b.pages);
  const named = usable.find((c) => RX.bookRef.test(c.name)) ?? usable.find((c) => RX.bookRefLoose.test(c.name) && integral(c));
  if (named) {
    // "bookId" → the table named "book(s)" when there is one, before any other table of titles
    const stem = RX.anyRef.exec(named.name)?.[1];
    const exact = stem ? (byName(stem) ?? byName(`${stem}s`)) : undefined;
    const target = exact && titleColumn(exact) ? exact : titled[0];
    if (target) return { column: named.name, target, how: "name", reason: `העמודה "${named.name}" נראית כמו הפניה לספר ב־"${target.name}"` };
  }
  for (const c of usable) {
    const stem = RX.anyRef.exec(c.name)?.[1];
    const target = stem ? (byName(stem) ?? byName(`${stem}s`) ?? byName(`${stem}es`)) : undefined;
    if (target) return { column: c.name, target, how: "name", reason: `העמודה "${c.name}" נראית כמו הפניה לטבלה "${target.name}"` };
  }
  for (const c of usable.filter((x) => x.ints?.length)) {
    for (const target of [...titled, ...others.filter((x) => !titled.includes(x))]) {
      const ids = new Set(target.columns.find((x) => x.rowidAlias)?.ints ?? target.rowids ?? []);
      if (ids.size && c.ints!.every((v) => ids.has(v)))
        return { column: c.name, target, how: "values", reason: `כל הערכים של "${c.name}" הם מזהים של רשומות ב־"${target.name}"` };
    }
  }
  return null;
}

function titleColumn(t: TablePreview, exclude?: string): ColumnPreview | null {
  const cands = t.columns.filter((c) => textual(c) && c.name !== exclude && c.avgLength > 0 && c.avgLength <= 200);
  return (
    cands.find((c) => RX.title.test(c.name)) ??
    cands.find((c) => RX.titleLoose.test(c.name)) ??
    // no telling name: the short text column whose values differ most (a table of names, by its values)
    (exclude === undefined ? (cands.filter((c) => c.avgLength <= 120 && c.distinct === c.filled && c.filled > 0).sort((a, b) => b.distinct - a.distinct)[0] ?? null) : null)
  );
}

function idColumn(t: TablePreview): string {
  if (t.withoutRowid) return t.primaryKey[0] ?? ROWID;
  const alias = t.columns.find((c) => c.rowidAlias);
  if (alias) return alias.name;
  return t.columns.find((c) => RX.id.test(c.name))?.name ?? ROWID;
}

function orderColumn(t: TablePreview, exclude: string[]): string {
  const cands = t.columns.filter((c) => !exclude.includes(c.name) && (integral(c) || c.kind === "real") && !c.rowidAlias);
  const hit = cands.find((c) => RX.order.test(c.name)) ?? cands.find((c) => RX.orderLoose.test(c.name));
  if (hit) return hit.name;
  if (t.withoutRowid) return t.primaryKey[1] ?? t.primaryKey[0] ?? "";
  return ROWID;
}

/**
 * The order of a book's lines: a composite key that starts with the book column ((book, chapter,
 * verse) as PRIMARY KEY or index), a chapter + verse pair by name, or one order column.
 */
function orderOf(t: TablePreview, exclude: string[], book: string, why: Why): { order: string; then: string[] } {
  const keys = [t.primaryKey, ...t.indexes.filter((ix) => ix.seekable).map((ix) => ix.columns)];
  const has = (name: string) => t.columns.some((c) => lower(c.name) === lower(name) && !exclude.includes(c.name));
  const composite = keys.find((k) => k.length >= 3 && lower(k[0]!) === lower(book) && k.slice(1).every(has));
  if (composite) {
    const [order, ...then] = composite.slice(1);
    why(1, `מפתח מורכב: סדר השורות לפי "${order}" ואז ${then.map((x) => `"${x}"`).join(", ")}`);
    return { order: order!, then };
  }
  const chapter = t.columns.find((c) => !exclude.includes(c.name) && integral(c) && !c.rowidAlias && RX.chapter.test(c.name));
  const verse = t.columns.find((c) => !exclude.includes(c.name) && c !== chapter && integral(c) && !c.rowidAlias && RX.verse.test(c.name));
  if (chapter && verse) {
    why(1, `סדר השורות לפי "${chapter.name}" ואז "${verse.name}"`);
    return { order: chapter.name, then: [verse.name] };
  }
  const order = orderColumn(t, exclude);
  if (order && order !== ROWID) why(1, `סדר השורות לפי העמודה "${order}"`);
  else if (order === ROWID) why(0, "אין עמודת סדר: השורות לפי סדר הרשומות במסד");
  return { order, then: [] };
}

function headingColumn(t: TablePreview, exclude: string[]): string | undefined {
  return t.columns.find((c) => !exclude.includes(c.name) && integral(c) && RX.heading.test(c.name))?.name;
}

function linksGuess(preview: SchemaPreview, skip: string[]): DbMapping["links"] {
  for (const t of preview.tables) {
    if (skip.includes(t.name) || !/link|connection|relation|קישור/i.test(t.name)) continue;
    const ints = t.columns.filter(integral);
    const source = ints.find((c) => RX.linkSource.test(c.name));
    const target = ints.find((c) => RX.linkTarget.test(c.name));
    if (!source || !target) continue;
    const type = t.columns.find((c) => c !== source && c !== target && RX.linkType.test(c.name));
    return { table: t.name, source: source.name, target: target.name, ...(type && { type: type.name }) };
  }
  return undefined;
}

/* ---------------- what the tool cannot read here ---------------- */

function limitationsOf(p: SchemaPreview): string[] {
  const out: string[] = [];
  const views = p.views ?? [];
  if (views.length) {
    const reads = [...new Set(views.flatMap((v) => v.reads))];
    out.push(
      `במסד ${views.length.toLocaleString("he")} מבטים (VIEW): ${list(views.map((v) => v.name))}. הכלי קורא את הקובץ ישירות ואינו מריץ SQL, ולכן אינו קורא מבטים. אם הספרים מורכבים במבט, מפו ידנית את הטבלאות שהוא קורא מהן${reads.length ? ` (${list(reads)})` : ""} — אם המבט רק בוחר עמודות ושורות; מבט שמחשב או מצרף ערכים אי אפשר לשחזר.`,
    );
  }
  for (const v of p.virtualTables ?? []) {
    const fts = /^fts\d$/.test(v.module);
    const stored = p.tables.find((t) => lower(t.name) === lower(`${v.name}_content`));
    if (fts && v.content === "none") out.push(`"${v.name}" הוא אינדקס חיפוש (${v.module}) בלי תוכן (content=''): הקובץ שומר רק את אינדקס המילים, לא את הטקסט, ולכן אי אפשר לשחזר ממנו ספרים.`);
    else if (fts && v.content === "external") out.push(`"${v.name}" הוא אינדקס חיפוש (${v.module}) שהטקסט שלו נמצא בטבלה אחרת; הכלי אינו קורא את האינדקס, מפו את הטבלה שהוא מצביע עליה.`);
    else if (fts && stored)
      out.push(`"${v.name}" הוא אינדקס חיפוש (${v.module}): טבלה וירטואלית שהכלי אינו קורא. הטקסט שלה שמור בטבלה הפנימית "${stored.name}"${v.columns.length ? ` (העמודות c0, c1… הן ${v.columns.join(", ")})` : ""}, ואותה אפשר למפות.`);
    else out.push(`"${v.name}" היא טבלה וירטואלית (${v.module || "מודול לא ידוע"}). הכלי קורא רק טבלאות רגילות, ואינו קורא אותה.`);
  }
  for (const t of p.tables) {
    for (const c of t.columns) if ((c.garbled ?? 0) > 0.2) out.push(garbledMessage(t.name, c.name));
    for (const c of t.columns) if (c.kind === "binary" && c.format) out.push(`העמודה "${t.name}.${c.name}" מכילה ${c.format}; הכלי אינו קורא אותה כטקסט.`);
    if (RX.tocTable.test(t.name) && t.samples.length) out.push(`טבלת תוכן העניינים "${t.name}" אינה נקראת: כותרות מזוהות רק לפי <h1>–<h6> בטקסט, או לפי עמודת רמת כותרת בטבלת השורות.`);
  }
  return out;
}

const list = (xs: string[]) => (xs.length > 5 ? `${xs.slice(0, 5).join(", ")}…` : xs.join(", "));
