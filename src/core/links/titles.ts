/*
 * Book-title rules of the generator. A link file names books by title, and the generator matches
 * titles EXACTLY (no normalization) against book.title in the database. Ports of:
 *   CategoryLabels.normalize / comparable / bookTitle  — generator/common/.../ids/CategoryKeys.kt
 *   path_2 → title                                     — Generator.kt:2236-2243
 *   titleDeclaresDependencyOn, DEPENDENCY_TITLE_PREFIXES — Generator.kt:86-92, 357-371
 *   HearotCompanionMerge.isMergeableCompanionTitle     — HearotCompanionMerge.kt:24
 */

/** CategoryLabels.normalize: quote variants → ״ / ׳, whitespace collapsed. */
export function normalizeTitle(raw: string): string {
  let s = raw.trim();
  s = s.replaceAll("“", '"').replaceAll("”", '"');
  s = s.replaceAll("‘", "'").replaceAll("’", "'");
  s = s.replaceAll('"', "״");
  s = s.replaceAll("''", "״");
  s = s.replaceAll("׳׳", "״");
  s = s.replaceAll("`", "׳");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The book.title the generator gives an Otzaria library file stem (CategoryLabels.bookTitle).
 * Sefaria books keep Sefaria's own spelling — this is NOT applied to them.
 */
export function otzariaBookTitle(fileStem: string): string {
  const base = normalizeTitle(fileStem);
  return base === "תנך" || base === 'תנ"ך' ? "תנ״ך" : base;
}

/** CategoryLabels.comparable: normalized, without quote marks, without a trailing corpus suffix. */
export function comparableTitle(raw: string): string {
  const base = normalizeTitle(raw).replace(/[״"׳']/g, "").replace(/\s+/g, " ").trim();
  return base.replace(/\s+על\s+(התנ"ך|התורה|התלמוד|המשנה|תנך|תורה|תלמוד|משנה)$/i, "").trim();
}

/**
 * The title the generator derives from `path_2`: the last path component, cut at its LAST dot.
 * Folders are ignored. A title containing a dot with no extension gets cut — always write ".txt".
 */
export function titleFromPath2(path: string): string {
  const last = path.includes("\\") ? path.split("\\").at(-1)! : path.split("/").at(-1)!;
  const dot = last.lastIndexOf(".");
  return dot === -1 ? last : last.slice(0, dot);
}

/** `path_2` as OtzariaLinker writes it: the exact database title + ".txt", no folder. */
export const path2ForTitle = (dbTitle: string): string => `${dbTitle}.txt`;

/** Title of the source book of a links file: the file name without `_links.json`, verbatim. */
export function sourceTitleFromLinksFileName(fileName: string): string | null {
  const name = fileName.split(/[\\/]/).at(-1) ?? "";
  const m = /^(.*)_links\.json$/i.exec(name);
  return m ? m[1]! : null;
}

const DEPENDENCY_TITLE_PREFIXES = ["תלמוד בבלי ", "תלמוד ירושלמי ", "מסכת ", "משנה ", "ספר "];

/** A title reduced for base-book matching: comparable, without prefixes like "מסכת " or "תלמוד בבלי ". */
export function baseTitleKey(raw: string): string {
  let v = comparableTitle(raw);
  for (;;) {
    const p = DEPENDENCY_TITLE_PREFIXES.find((x) => v.startsWith(x));
    if (!p) return v;
    v = v.slice(p.length).trim();
  }
}

/** The base title a dependant title names, comparable but with its prefixes ("רש״י על מסכת ברכות" → "מסכת ברכות"), or null. */
export function declaredBaseTitle(dependantTitle: string): string | null {
  const d = comparableTitle(dependantTitle);
  const at = d.lastIndexOf(" על ");
  const declaredBase = at === -1 ? "" : d.slice(at + " על ".length).trim();
  return declaredBase || null;
}

/** The base-title key a dependant title declares ("רש״י על מסכת ברכות" → "ברכות"), or null. */
export function declaredBaseKey(dependantTitle: string): string | null {
  const t = declaredBaseTitle(dependantTitle);
  return t ? baseTitleKey(t) : null;
}

/*
 * baseTitleKey folds "משנה ברכות", "תלמוד ירושלמי ברכות" and "ברכות" into one key, so "X על ברכות"
 * finds three books. The prefix the title had is its corpus, and a dependant's title names the corpus
 * it is written on the same way: "על משנה ברכות" → the Mishnah, "על ירושלמי ברכות" → the Yerushalmi,
 * a bare "על ברכות" / "על מסכת ברכות" → the book without a corpus prefix (the Bavli). Measured on the
 * library benchmark: 391K COMMENTARY links were in pairs the planner refused as ambiguous
 * (docs/validation/LIBRARY_BENCHMARK.md §6.1).
 */
const CORPUS_PREFIXES: readonly (readonly [string, string])[] = [
  ["משנה ", "mishnah"],
  ["תלמוד ירושלמי ", "yerushalmi"],
  ["ירושלמי ", "yerushalmi"],
];

/** The corpus a title's prefix marks ("mishnah", "yerushalmi"), or "" for none. */
export function titleCorpus(raw: string): string {
  let v = comparableTitle(raw);
  for (;;) {
    const c = CORPUS_PREFIXES.find(([p]) => v.startsWith(p));
    if (c) return c[1];
    const p = DEPENDENCY_TITLE_PREFIXES.find((x) => v.startsWith(x));
    if (!p) return "";
    v = v.slice(p.length).trim();
  }
}

/*
 * A looser key, tried only when the exact key finds nothing: the same title in another spelling.
 * "שלחן ערוך אורח חיים" and "שולחן ערוך, אורח חיים" differ by a mater lectionis and a comma; a
 * trailing volume ("… חלק ו") names the same book. Letters ו/י are dropped (plene vs. defective
 * spelling), punctuation and a leading "ירושלמי " are folded. Two books that meet under this key are
 * ambiguous like any other (batch.ts), so it never picks between them.
 */
export function looseTitleKey(raw: string): string {
  let v = baseTitleKey(raw).replace(/^ירושלמי\s+/, "");
  v = v.replace(/\s+חלק\s+[א-ת]{1,3}$/u, "");
  return v.replace(/[,.:;()\-־–]/g, " ").replace(/[וי]/g, "").replace(/\s+/g, " ").trim();
}

/** True only when a dependant-style title ("X על <base>") explicitly names `baseTitle`. */
export function titleDeclaresDependencyOn(dependantTitle: string, baseTitle: string): boolean {
  const k = declaredBaseKey(dependantTitle);
  return k !== null && k === baseTitleKey(baseTitle);
}

/**
 * A "הערות על X" companion is merged inline into X when the merge plan is accepted, and then every
 * link into it is dropped silently by the generator. A safe title is e.g. "הערות ל<X>".
 */
export const isMergeableCompanionTitle = (title: string): boolean => normalizeTitle(title).startsWith("הערות על ");

/*
 * A book title becomes a file name on export ("<title>_links.json", "<title>_alt_toc.json",
 * "<title>.links.csv") and a path inside the ZIP. Titles come from databases, mapped databases and
 * projects — all untrusted — so a title that is not a plain file name ("../../x", "a/b", NUL,
 * control characters, characters Windows refuses in a file name) is never written (security review A4).
 */
const UNSAFE_FILE_CHAR = /[/\\\u0000-\u001f\u007f<>:"|?*]/;

/** Why a title cannot be a file name, in Hebrew; null when it can. */
export function unsafeFileTitle(title: string): string | null {
  if (!title.trim()) return "השם ריק";
  if (title.includes("..")) return 'יש בשם ".."';
  const bad = UNSAFE_FILE_CHAR.exec(title)?.[0];
  if (bad !== undefined) return /[\u0000-\u001f\u007f]/.test(bad) ? "יש בשם תו בקרה" : `יש בשם התו "${bad}", שאסור בשם קובץ`;
  if (/[. ]$/.test(title)) return "השם מסתיים בנקודה או ברווח, ו־Windows משמיטה אותם משם קובץ";
  return null;
}
