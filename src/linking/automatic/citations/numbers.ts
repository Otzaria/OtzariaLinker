import { toGematria } from "../../../core/text/gematria";
import { unifyFinals, type Tok } from "./text";

/*
 * Numerals inside a citation. STRICT, as REUSE_MATRIX §5.1 decides for references in prose: a Hebrew
 * numeral must be written canonically (the letters toGematria would write, ט"ו/ט"ז for 15/16), so
 * ordinary words are not read as numbers ("שבת" is never 702, "יה" is never 15). LinkerToOtzaria and
 * the auto-linker plugin take the same position (ideas only, REUSE_MATRIX §2.3, §2.10).
 *
 * Canonical numerals that are ALSO everyday words (לא, של, שם, פה…) are flagged `common`: a citation
 * may still use them ("בראשית לא, ה"), but never on their own as the only evidence of a location.
 */

export type NumeralForm = "digits" | "gershayim" | "geresh" | "bare";

export interface Numeral {
  readonly n: number;
  readonly form: NumeralForm;
  /** a bare numeral that is also a common word ("לא", "של", "פה") */
  readonly common: boolean;
}

/** Highest number read in a citation (SA חושן משפט has 427 simanim; nothing cited needs more than 999). */
export const MAX_NUMERAL = 999;

/*
 * Canonical numerals that are everyday words. Built by hand from the canonical forms of 1..499 (every
 * two-letter canonical numeral was checked; longer ones are rarely words). "שם" (340) is here too:
 * LinkerToOtzaria's rule "שם is never 340".
 */
const COMMON_WORDS = new Set(
  ["לא", "לב", "לד", "לה", "לו", "מה", "מו", "מט", "נא", "נד", "נו", "נח", "סב", "עד", "עז", "פה", "פז", "צד", "צו", "יד", "כב", "כד", "כה", "כו",
   "קח", "קל", "קם", "קנ", "רב", "רם", "רע", "רצ", "שא", "שב", "שד", "של", "שם", "שנ", "שח", "תו", "תל", "תם", "תנ"].map(unifyFinals),
);

/** The canonical letters of n with final forms unified ("טו", "טז" for 15, 16). */
const canonical = (n: number): string => toGematria(n);

/** Hebrew letters → number when they are a canonical numeral, else null. */
export function strictValue(letters: string): number | null {
  const key = unifyFinals(letters);
  if (!key || key.length > 5 || !/^[א-ת]+$/.test(key)) return null;
  let n = 0;
  for (const ch of key) n += VALUE[ch] ?? NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_NUMERAL) return null;
  return canonical(n) === key ? n : null;
}

const VALUE: Readonly<Record<string, number>> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90, ק: 100, ר: 200, ש: 300, ת: 400,
};

/**
 * One token as a numeral. A gershayim must sit before the LAST letter (כ"ג, קכ"ג) and a geresh at the
 * end (ג', יח'); anything else (ב"ק, א"ר) is an acronym, not a number.
 */
export function numeralOf(t: Tok | undefined): Numeral | null {
  if (!t) return null;
  if (t.kind === "digits") {
    const n = t.text.length <= 3 ? parseInt(t.text, 10) : NaN;
    return n > 0 && n <= MAX_NUMERAL ? { n, form: "digits", common: false } : null;
  }
  if (t.kind !== "word") return null;
  if (t.gershayim && (t.gershayimAt !== t.text.length - 1 || t.geresh)) return null;
  const n = strictValue(t.text);
  if (n === null) return null;
  const form: NumeralForm = t.gershayim ? "gershayim" : t.geresh ? "geresh" : "bare";
  // "ה'" is far more often the divine name than 5
  return { n, form, common: (form === "bare" && COMMON_WORDS.has(t.key)) || (form === "geresh" && t.key === "ה") };
}

/** A numeral written as one (quote marks or digits) — never an ordinary word. */
export const isMarkedNumeral = (x: Numeral): boolean => x.form !== "bare";
