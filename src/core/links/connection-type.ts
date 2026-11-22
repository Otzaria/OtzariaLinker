/*
 * Connection types — the generator's enum (SeforimLibrary@23f1f8f1 core/.../models/Link.kt).
 * ORDER MATTERS: connection_type.id in the database = ordinal + 1, and new values are appended.
 */
export const CONNECTION_TYPES = [
  "COMMENTARY", "SUPER_COMMENTARY", "TARGUM", "REFERENCE", "SOURCE", "MIDRASH", "QUOTATION",
  "MESORAT_HASHAS", "EIN_MISHPAT", "DIBUR_HAMATCHIL", "PARSHANUT", "MISHNAH_IN_TALMUD", "RELATED",
  "OTHER", "LINKER", "SIFREI_MITZVOT", "ESSAY", "ALLUSION", "LITURGY", "ELUCIDATION", "EXPLICATION",
  "LAW", "SUMMARY", "FOOTNOTES",
] as const;

export type ConnectionType = (typeof CONNECTION_TYPES)[number];

/*
 * INLINE_LINKER — "ציטוט בטקסט": a connection type of OTZARIA'S PERSONAL IMPORT only (Otzaria/otzaria, docs/personal_databases.md,
 * commit 6f71470e, issue #4308), a citation clickable inside the text. It is NOT in the generator's enum above:
 * appending it there would give it a database id (index + 1) that the generator may give to another type later,
 * and the library generator reads it as an unknown type, OTHER. So it is a declared string of a private-use file,
 * accepted by validateLink only when the export purpose is "private" (LINK_FORMATS §1.12).
 */
export const INLINE_LINKER_TYPE = "INLINE_LINKER";
export const INLINE_LINKER_LABEL = "ציטוט בטקסט";

/**
 * Which Otzaria builds know INLINE_LINKER, as measured on `checkedOn` with `gh api repos/Otzaria/otzaria`: the commit is an
 * ancestor of `dev` and of no published release (the newest, 0.9.98.3+809, is 2,582 commits behind it, and its
 * user_import_parser.dart has no INLINE_LINKER). `supportedFrom` is the first PUBLISHED release that has it, null until one
 * does: set it when a release ships it (and say so in LINK_FORMATS §1.12). Nothing in the tool promises support in every version.
 */
export const INLINE_LINKER_SUPPORT = {
  commit: "6f71470e",
  commitDate: "2026-11-20",
  checkedOn: "2026-11-22",
  latestStable: "0.9.98.3+809",
  latestStableDate: "2026-11-02",
  supportedFrom: null as string | null,
} as const;

/** The one sentence for the user: this type depends on the Otzaria version (the export warning, the engine option, the notes). */
export function inlineLinkerVersionNote(): string {
  const s = INLINE_LINKER_SUPPORT;
  return s.supportedFrom
    ? `ציטוט בטקסט תלוי בגרסת אוצריא: הוא נתמך מגרסה ${s.supportedFrom} (בדיקה מ־${s.checkedOn}). בגרסה ישנה יותר הייבוא האישי ידחה אותו כסוג קישור לא מוכר.`
    : `ציטוט בטקסט תלוי בגרסת אוצריא: נכון ל־${s.checkedOn} הוא קיים רק בענף dev של אוצריא (commit ${s.commit}, ${s.commitDate}) ועדיין לא בגרסה שפורסמה. הגרסה היציבה האחרונה שנבדקה, ${s.latestStable} (${s.latestStableDate}), לא מכירה אותו, והייבוא האישי שלה ידחה אותו כסוג קישור לא מוכר.`;
}

/**
 * Whether a declared type means INLINE_LINKER in ANY spelling the app would read — the gate of the library
 * purpose is this wide on purpose. The app (Otzaria/otzaria lib/models/link_types.dart, `LinkTypes.normalize`)
 * trims, upper-cases and turns every run of whitespace or "-" into "_", so "inline-linker", "INLINE-LINKER",
 * "inline<tab>linker" and a non-breaking space all mean it; the Hebrew label is matched after a trim
 * (user_import_parser.dart). Beyond that, "InlineLinker" and a label with doubled spaces are held too: nothing that
 * is meant as this private type may reach a library file.
 */
export function isInlineLinkerType(raw: unknown): boolean {
  const s = String(raw ?? "").trim();
  if (s.replace(/\s+/g, " ") === INLINE_LINKER_LABEL) return true;
  return /^inline_*linker$/i.test(s.replace(/[\s-]+/g, "_"));
}

/** The two spellings the app's documentation gives; the private export accepts only these. */
export const isDocumentedInlineLinker = (raw: unknown): boolean => {
  const s = String(raw ?? "").trim();
  return s === INLINE_LINKER_TYPE || s === INLINE_LINKER_LABEL;
};

/** connection_type.id in the database. */
export const connectionTypeId = (t: ConnectionType): number => CONNECTION_TYPES.indexOf(t) + 1;

export function connectionTypeFromId(id: number): ConnectionType | null {
  return CONNECTION_TYPES[id - 1] ?? null;
}

const KNOWN: Readonly<Record<string, ConnectionType>> = {
  commentary: "COMMENTARY",
  super_commentary: "SUPER_COMMENTARY", supercommentary: "SUPER_COMMENTARY",
  targum: "TARGUM",
  reference: "REFERENCE",
  source: "SOURCE",
  midrash: "MIDRASH",
  quotation: "QUOTATION", quotation_auto: "QUOTATION", quotation_auto_tanakh: "QUOTATION",
  mesorat_hashas: "MESORAT_HASHAS",
  ein_mishpat: "EIN_MISHPAT", "ein_mishpat_/_ner_mitsvah": "EIN_MISHPAT", "ein_mishpat_/_ner_mitzvah": "EIN_MISHPAT",
  dibur_hamatchil: "DIBUR_HAMATCHIL",
  parshanut: "PARSHANUT",
  mishnah_in_talmud: "MISHNAH_IN_TALMUD",
  related: "RELATED", related_passage: "RELATED",
  linker: "LINKER",
  sifrei_mitzvot: "SIFREI_MITZVOT", // only with a z — "sifrei_mitsvot" is unknown → OTHER
  essay: "ESSAY",
  allusion: "ALLUSION",
  liturgy: "LITURGY",
  ellucidation: "ELUCIDATION", elucidation: "ELUCIDATION",
  explication: "EXPLICATION",
  law: "LAW",
  summary: "SUMMARY",
  footnotes: "FOOTNOTES", footnote: "FOOTNOTES",
  "": "OTHER", none: "OTHER", other: "OTHER",
};

/**
 * Port of `ConnectionType.fromKnownStringOrNull` / `fromString`: trim, lower-case, every space →
 * underscore (only spaces; "-" is not normalized). Unknown → OTHER with `known: false`.
 */
export function parseConnectionType(raw: unknown): { type: ConnectionType; known: boolean } {
  const key = String(raw ?? "").trim().toLowerCase().replaceAll(" ", "_");
  const t = Object.hasOwn(KNOWN, key) ? KNOWN[key] : undefined;
  return t ? { type: t, known: true } : { type: "OTHER", known: false };
}

/** The value OtzariaLinker writes to "Conection Type" (lower-case with underscores, as the library uses). */
export const canonicalTypeString = (t: ConnectionType): string => t.toLowerCase();

/** Generator: types it orients base → dependant (Link.kt SOURCE_VIEW_TYPES). Drives flip/downgrade. */
export const SOURCE_VIEW_TYPES: ReadonlySet<ConnectionType> = new Set<ConnectionType>([
  "COMMENTARY", "SUPER_COMMENTARY", "TARGUM", "MIDRASH", "PARSHANUT", "DIBUR_HAMATCHIL",
  "EIN_MISHPAT", "ELUCIDATION", "FOOTNOTES",
]);

/**
 * App: dependent-text types shown in the commentary panel (otzaria lib/models/link_types.dart
 * dependentTextTypes). Note the two sets differ: the app counts EXPLICATION and not EIN_MISHPAT.
 */
export const APP_DEPENDENT_TYPES: ReadonlySet<ConnectionType> = new Set<ConnectionType>([
  "COMMENTARY", "SUPER_COMMENTARY", "TARGUM", "MIDRASH", "PARSHANUT", "DIBUR_HAMATCHIL",
  "ELUCIDATION", "EXPLICATION", "FOOTNOTES",
]);

export type AppPanel = "commentaries" | "links" | "links-one-way";

/** Where the app shows a STORED link (docs/contracts/OTZARIA_COMPATIBILITY.md §1). */
export function appPanelOf(stored: ConnectionType): AppPanel {
  if (stored === "LINKER") return "links-one-way";
  return APP_DEPENDENT_TYPES.has(stored) ? "commentaries" : "links";
}

/** Types a user may choose when authoring a link file. LINKER is skipped by the generator; SOURCE is a direction. */
export const AUTHORABLE_TYPES: readonly ConnectionType[] = CONNECTION_TYPES.filter((t) => t !== "LINKER");

export const TYPE_LABELS: Readonly<Record<ConnectionType, { he: string; hint: string }>> = {
  COMMENTARY: { he: "פירוש", hint: "מפרש על הטקסט" },
  SUPER_COMMENTARY: { he: "פירוש על פירוש", hint: 'ביאור על מפרש אחר (למשל ביאור על רש"י)' },
  TARGUM: { he: "תרגום", hint: "תרגום אונקלוס, יונתן וכד'" },
  REFERENCE: { he: "הפניה", hint: "הפניה כללית למקור אחר" },
  SOURCE: { he: "מקור", hint: "הקובץ שייך לספר התלוי, והיעד הוא ספר הבסיס שלו (נשמר כפירוש בכיוון ההפוך)" },
  MIDRASH: { he: "מדרש", hint: 'מדרשי חז"ל על הפסוק' },
  QUOTATION: { he: "ציטוט", hint: "הטקסט מצטט את היעד" },
  MESORAT_HASHAS: { he: 'מסורת הש"ס', hint: 'הפניות מסורת הש"ס' },
  EIN_MISHPAT: { he: "עין משפט", hint: "עין משפט נר מצוה" },
  DIBUR_HAMATCHIL: { he: "דיבור המתחיל", hint: 'קישור לפי ד"ה' },
  PARSHANUT: { he: "פרשנות", hint: "פרשנות כללית" },
  MISHNAH_IN_TALMUD: { he: "משנה בתלמוד", hint: "משנה שמוטבעת בגמרא" },
  RELATED: { he: "קשור", hint: "קשר כללי, לא ישיר" },
  OTHER: { he: "אחר", hint: "לא מסווג" },
  LINKER: { he: "קישור אוטומטי", hint: "קישורים שאוצריא מזהה לבד בכל בנייה של המסד; אי אפשר לכתוב אותם בקובץ קישורים" },
  SIFREI_MITZVOT: { he: "ספרי מצוות", hint: "ספר המצוות וכד'" },
  ESSAY: { he: "מאמר", hint: "מאמר / חיבור עצמאי" },
  ALLUSION: { he: "רמז", hint: "רמז / הרמזה" },
  LITURGY: { he: "תפילה ופיוט", hint: "תפילה ופיוט" },
  ELUCIDATION: { he: "ביאור נרחב", hint: 'ביאור מורחב (כמו "עין איה")' },
  EXPLICATION: { he: "ביאור", hint: "ביאור / פרשנות" },
  LAW: { he: "הלכה", hint: "פסיקה הלכתית" },
  SUMMARY: { he: "סיכום", hint: "סיכום של היעד" },
  FOOTNOTES: { he: "הערות שוליים", hint: "הערות על הטקסט, מוצגות כמפרש עם סימון במספר ההערה" },
};
