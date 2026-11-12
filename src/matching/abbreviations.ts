/*
 * Known abbreviations of rabbinic Hebrew and Aramaic, with what they stand for — one shared table for
 * every engine that compares a quotation with its source (the ד"ה engine through token-match.ts; the
 * citations engine may look a word up with `expansionsOf`).
 *
 * Most abbreviations need no table: token-match.ts bridges an acronym WRITTEN with gershayim to the
 * words its letters begin (ת"ר ↔ תנו רבנן, also with a glued prefix: וא"ר ↔ ואמר רבי), and a word
 * ending in a geresh to any word it begins (אפי' ↔ אפילו). The table adds what letters alone cannot
 * say:
 *   • the same abbreviation written WITHOUT its quote marks — "אעפ", "מנהמ" in an OCR'd or retyped
 *     text, which the generic bridge never expands (an unmarked short word is a word: link-generator
 *     BUG-07) — only for the forms listed here, none of which is a Hebrew word of its own;
 *   • the expansions an acronym is known to have, so a reader (and a test) can see them.
 * Every entry is written as a reader writes it; keys are search keys (hebrew-tokens.ts: final letters
 * unified, quote marks dropped). Sources: the lists of the owner's scripts (build_artzot_hachaim_links.py
 * `normalize_expanded`, dibur_matcher.py `ABBREVIATION_EXPANSIONS`, lemma_head_match.py `ABBREV` —
 * otzaria-library, organization code) and common usage; no third-party table.
 */
import { searchKey, type HebToken } from "./hebrew-tokens";

export interface Abbreviation {
  /** as written ('אע"פ') */
  readonly written: string;
  /** what it stands for, one or more readings ("אף על פי") */
  readonly expansions: readonly string[];
  /** also recognized without its quote mark ("אעפ") — only for forms that are no word of their own */
  readonly unmarked?: boolean;
}

export const ABBREVIATIONS: readonly Abbreviation[] = [
  { written: 'אע"פ', expansions: ["אף על פי"], unmarked: true },
  { written: 'אעפ"כ', expansions: ["אף על פי כן"], unmarked: true },
  { written: 'אע"ג', expansions: ["אף על גב"], unmarked: true },
  { written: 'ואע"פ', expansions: ["ואף על פי"], unmarked: true },
  { written: 'ואע"ג', expansions: ["ואף על גב"], unmarked: true },
  { written: 'עכ"פ', expansions: ["על כל פנים"], unmarked: true },
  { written: 'מ"מ', expansions: ["מכל מקום"] },
  { written: 'א"כ', expansions: ["אם כן"] },
  { written: 'דא"כ', expansions: ["דאם כן"], unmarked: true },
  { written: 'ע"כ', expansions: ["על כן", "עד כאן", "על כרחך"] },
  { written: 'וע"כ', expansions: ["ועל כן"] },
  { written: 'ע"פ', expansions: ["על פי"] },
  { written: 'ה"נ', expansions: ["הכא נמי", "הכי נמי"] },
  { written: 'ה"מ', expansions: ["הני מילי"] },
  { written: 'מנה"מ', expansions: ["מנא הני מילי"], unmarked: true },
  { written: 'מנ"ל', expansions: ["מנא לן"], unmarked: true },
  { written: 'קמ"ל', expansions: ["קא משמע לן"], unmarked: true },
  { written: 'מ"ט', expansions: ["מאי טעמא"] },
  { written: 'ש"מ', expansions: ["שמע מינה"] },
  { written: 'ת"ש', expansions: ["תא שמע"] },
  { written: 'ת"ר', expansions: ["תנו רבנן"] },
  { written: 'תנ"ה', expansions: ["תניא נמי הכי"] },
  { written: 'ת"ק', expansions: ["תנא קמא"] },
  { written: 'ת"ל', expansions: ["תלמוד לומר"] },
  { written: 'א"ר', expansions: ["אמר רבי", "אמר רב"] },
  { written: 'וא"ת', expansions: ["ואם תאמר"] },
  { written: 'וי"ל', expansions: ["ויש לומר"] },
  { written: 'ר"ל', expansions: ["ריש לקיש", "רוצה לומר"] },
  { written: 'ריב"ל', expansions: ["רבי יהושע בן לוי"] },
  { written: 'רשב"י', expansions: ["רבי שמעון בן יוחאי"] },
  { written: 'רשב"ג', expansions: ["רבן שמעון בן גמליאל"] },
  { written: 'ב"ש', expansions: ["בית שמאי"] },
  { written: 'ב"ה', expansions: ["בית הלל"] },
  { written: 'ב"ד', expansions: ["בית דין"] },
  { written: 'ק"ו', expansions: ["קל וחומר"] },
  { written: 'ג"ש', expansions: ["גזירה שוה"] },
  { written: 'כדא"פ', expansions: ["כדי אכילת פרס"], unmarked: true },
  { written: 'ט"י', expansions: ["טבול יום"] },
  { written: 'הקב"ה', expansions: ["הקדוש ברוך הוא"], unmarked: true },
  { written: 'ע"ז', expansions: ["עבודה זרה"] },
  { written: 'ס"ת', expansions: ["ספר תורה"] },
  { written: 'ד"ת', expansions: ["דברי תורה"] },
  { written: 'ע"ה', expansions: ["עם הארץ"] },
  { written: 'י"א', expansions: ["יש אומרים"] },
  { written: 'וי"א', expansions: ["ויש אומרים"] },
  { written: "אפי'", expansions: ["אפילו"] },
  { written: "פי'", expansions: ["פירוש"] },
  { written: "מתני'", expansions: ["מתניתין"] },
  { written: "גמ'", expansions: ["גמרא"] },
];

interface Indexed {
  readonly abbr: Abbreviation;
  /** each expansion as search keys */
  readonly words: readonly (readonly string[])[];
}

const byKey = new Map<string, Indexed>();
const unmarkedKeys = new Set<string>();
for (const a of ABBREVIATIONS) {
  const key = searchKey(a.written);
  byKey.set(key, { abbr: a, words: a.expansions.map((e) => searchKey(e).split(" ")) });
  if (a.unmarked) unmarkedKeys.add(key);
}

/** The table entry of a word as written, or null. A word without quote marks qualifies only for `unmarked` forms. */
export function abbreviationOf(t: Pick<HebToken, "key" | "acronym" | "truncated">): Abbreviation | null {
  const hit = byKey.get(t.key);
  if (!hit) return null;
  return t.acronym || t.truncated || unmarkedKeys.has(t.key) ? hit.abbr : null;
}

/** What a word stands for, each reading as search keys (empty when it is not a known abbreviation). */
export function expansionsOf(t: Pick<HebToken, "key" | "acronym" | "truncated">): readonly (readonly string[])[] {
  return abbreviationOf(t) ? byKey.get(t.key)!.words : [];
}

/** Search keys of the unmarked forms the table knows (token-match.ts uses them to bound its search). */
export const UNMARKED_ABBREVIATIONS: ReadonlySet<string> = unmarkedKeys;
