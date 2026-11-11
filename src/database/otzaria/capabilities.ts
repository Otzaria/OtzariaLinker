import type { SqliteFile } from "../sqlite/lazy/sqlite-file";

/*
 * What an Otzaria-family database can provide — decided by the tables and columns that EXIST, like
 * the app's DbCapabilities, because schema numbers 1–4 count patch-format versions and many DDL
 * changes landed without a bump (docs/contracts/DATABASE_SUPPORT_MATRIX.md §1, §4).
 * The declared number is used only to warn (future schema, or declared ≠ inferred).
 */
export type DbKind = "official" | "attached-personal" | "user-books" | "generic";

export interface DbCapabilities {
  kind: DbKind;
  declaredSchema: number | null;
  /** highest schema whose tell-tale tables/columns are present; null when not an Otzaria layout */
  inferredSchema: number | null;
  /** where line text lives */
  text: "line.content" | "line_content" | null;
  compressed: boolean;
  lineNotes: boolean;
  links: boolean;
  anchors: boolean;
  ranges: boolean;
  coverage: boolean;
  suppressedSides: boolean;
  externalLinks: boolean;
  userLinks: boolean;
  toc: boolean;
  altToc: boolean;
  sources: boolean;
  categories: boolean;
  /** columns of each present table, lower-cased */
  columns: ReadonlyMap<string, ReadonlySet<string>>;
  meta: Readonly<Record<string, string>>;
  warnings: { code: string; message: string }[];
}

export const READABLE_SCHEMA = 7;

export async function detectCapabilities(file: SqliteFile): Promise<DbCapabilities> {
  const schema = await file.schema();
  const columns = new Map<string, Set<string>>();
  for (const e of schema) {
    if (e.type !== "table" || !e.sql || /^\s*CREATE\s+VIRTUAL/i.test(e.sql) || e.name.startsWith("sqlite_")) continue;
    const t = await file.table(e.name);
    if (t) columns.set(e.name.toLowerCase(), new Set(t.columns.map((c) => c.name.toLowerCase())));
  }
  const has = (t: string) => columns.has(t);
  const col = (t: string, c: string) => columns.get(t)?.has(c.toLowerCase()) ?? false;

  const meta: Record<string, string> = {};
  if (has("schema_meta")) {
    const t = (await file.table("schema_meta"))!;
    for await (const r of file.scan(t)) meta[String(r.values[0])] = String(r.values[1]);
  }
  const declaredRaw = meta["db_schema_version"];
  const declaredSchema = declaredRaw !== undefined && /^\d+$/.test(declaredRaw) ? Number(declaredRaw) : null;

  const lineText = col("line", "content") ? "line.content" : has("line_content") ? "line_content" : null;
  // tables named book/line are common in any database; every Otzaria schema (0–7) also has these columns
  const isOtzaria = has("book") && has("line") && col("book", "title") && col("line", "bookId") && col("line", "lineIndex");
  let inferredSchema: number | null = null;
  if (isOtzaria) {
    if (has("line_note") || col("book", "contentHash")) inferredSchema = 7;
    else if (lineText === "line_content") inferredSchema = 6;
    else if (col("line_dh", "dhDisplay")) inferredSchema = 5;
    else if (has("line_dh") || has("line_ref")) inferredSchema = 4;
    else if (has("link_suppressed_side")) inferredSchema = 3;
    else if (has("book_base_text") || col("book", "dependenceType")) inferredSchema = 2;
    else if (has("schema_meta")) inferredSchema = 1;
    else inferredSchema = 0;
  }

  const kind: DbKind = !isOtzaria
    ? "generic"
    : has("user_link") || col("book", "isPersonal")
      ? "user-books"
      : meta["library_id"] !== undefined || has("external_link")
        ? "attached-personal"
        : "official";

  const warnings: DbCapabilities["warnings"] = [];
  if (file.header.wal)
    warnings.push({ code: "db/wal", message: "המסד במצב WAL. שינויים שעדיין לא נכתבו לקובץ הראשי (קובץ ‎-wal לידו) לא ייראו. סגרו את התוכנה שמשתמשת במסד ונסו שוב." });
  if (declaredSchema !== null && declaredSchema > READABLE_SCHEMA)
    warnings.push({ code: "db/schema-newer", message: `המסד מצהיר על סכמה ${declaredSchema}, חדשה מהגרסאות שהכלי מכיר (עד ${READABLE_SCHEMA}). הכלי יקרא מה שהוא מזהה, אבל ייתכנו נתונים שלא יוצגו.` });
  if (declaredSchema !== null && inferredSchema !== null && declaredSchema !== inferredSchema)
    warnings.push({ code: "db/schema-mismatch", message: `המסד מצהיר על סכמה ${declaredSchema}, אבל המבנה שלו מתאים לסכמה ${inferredSchema}. הקריאה מתבססת על המבנה בפועל.` });
  if (isOtzaria && !lineText)
    warnings.push({ code: "db/no-line-text", message: "במסד לא נמצא טקסט שורות (לא line.content ולא line_content). אפשר לראות את רשימת הספרים, אבל לא את התוכן." });
  if (!isOtzaria)
    warnings.push({ code: "db/generic", message: "זה אינו מסד במבנה של אוצריא (חסרות הטבלאות book/line, או העמודות book.title, line.bookId, line.lineIndex). כשפותחים אותו, הכלי מציג את הטבלאות שלו ומבקש לבחור איפה הספרים ואיפה השורות (אשף המיפוי)." });

  return {
    kind,
    declaredSchema,
    inferredSchema,
    text: lineText,
    compressed: has("zstd_dict"),
    lineNotes: has("line_note"),
    links: has("link"),
    anchors: has("link_anchor"),
    ranges: has("link_range"),
    coverage: has("link_coverage"),
    suppressedSides: has("link_suppressed_side"),
    externalLinks: has("external_link"),
    userLinks: has("user_link"),
    toc: has("tocentry"),
    altToc: has("alt_toc_structure"),
    sources: has("source") && col("book", "sourceId"),
    categories: has("category") && col("book", "categoryId"),
    columns,
    meta,
    warnings,
  };
}
