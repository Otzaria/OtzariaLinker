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

/** True only when a dependant-style title ("X על <base>") explicitly names `baseTitle`. */
export function titleDeclaresDependencyOn(dependantTitle: string, baseTitle: string): boolean {
  const d = comparableTitle(dependantTitle);
  const at = d.lastIndexOf(" על ");
  const declaredBase = at === -1 ? "" : d.slice(at + " על ".length);
  if (!declaredBase.trim()) return false;
  const key = (raw: string) => {
    let v = comparableTitle(raw);
    for (;;) {
      const p = DEPENDENCY_TITLE_PREFIXES.find((x) => v.startsWith(x));
      if (!p) return v;
      v = v.slice(p.length).trim();
    }
  };
  return key(declaredBase) === key(baseTitle);
}

/**
 * A "הערות על X" companion is merged inline into X when the merge plan is accepted, and then every
 * link into it is dropped silently by the generator. A safe title is e.g. "הערות ל<X>".
 */
export const isMergeableCompanionTitle = (title: string): boolean => normalizeTitle(title).startsWith("הערות על ");
