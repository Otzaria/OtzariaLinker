import { fromGematria, toGematria } from "../../../core/text/gematria";

/*
 * Numbers in structure references ("סימן קכ"ג", "ס"ק ב'", "דף 5", "פרק ראשון"), for the pattern
 * engine. A reference is read in running text, so a numeral must be CANONICAL: the letters must be
 * exactly how the number is written (קכג, not גכק; טו/טז, with יה/יו accepted as the old spellings),
 * which keeps words like "זה" (12, written יב) or "בו" from turning into numbers after a kind word
 * ("סעיף זה"). The validation is the canonical round trip of the auto-linker plugin and of
 * otzaria-link-generator's seifKatan.ts, reimplemented (REUSE_MATRIX §2.10, §10).
 *
 * Canonical numerals that are also everyday words ("לא", "שם", "עד") are accepted but flagged
 * AMBIGUOUS, unless they carry a geresh or gershayim ("ל"א"): the engine then never calls the link
 * certain (auto-linker's AMBIGUOUS_NUMBER_WORDS, LinkerToOtzaria's "שם" ≠ 340, widened).
 */

export interface RefNumber {
  readonly n: number;
  /** written with a geresh/gershayim, or in digits */
  readonly marked: boolean;
  /** a canonical numeral that is also a common word, written without a quote */
  readonly ambiguous: boolean;
}

/** the regex source of a numeral token, as the placeholders of a pattern template expand it */
export const NUMERAL_SOURCE = "\\d{1,4}(?!\\d)|[א-ת]{1,5}(?:[\"״][א-ת])?['׳]?(?![א-ת\"״])";

const FINAL_TO_PLAIN: Readonly<Record<string, string>> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };

/** canonical numerals that are everyday words — read only with care */
export const AMBIGUOUS_NUMERALS: ReadonlySet<string> = new Set(["לא", "לו", "לה", "מה", "עד", "עז", "נא", "נו", "כה", "רב", "רע", "שם", "יד", "תם", "קם", "שב", "כו"]);

const ORDINALS: Readonly<Record<string, number>> = {
  ראשון: 1, ראשונה: 1, שני: 2, שניה: 2, שנייה: 2, שלישי: 3, שלישית: 3, רביעי: 4, רביעית: 4, חמישי: 5, חמישית: 5,
  ששי: 6, שישי: 6, שישית: 6, שביעי: 7, שביעית: 7, שמיני: 8, שמינית: 8, תשיעי: 9, תשיעית: 9, עשירי: 10, עשירית: 10,
};

/** the spellings a canonical numeral may have: the canonical one, and יה/יו for 15/16 */
function spellingOk(plain: string, n: number): boolean {
  if (toGematria(n) === plain) return true;
  const rest = n % 100;
  if (rest !== 15 && rest !== 16) return false;
  return toGematria(n - rest) + (rest === 15 ? "יה" : "יו") === plain || (n === rest && (plain === "יה" || plain === "יו"));
}

/**
 * One numeral token → its number, or null. Digits (1–9999); Hebrew numerals of up to five letters in
 * canonical spelling, with a final geresh ("יב'") or gershayim before the last letter ("קכ"ג"); and,
 * when `ordinals`, the ordinal words ראשון…עשירי ("פרק שני").
 */
export function parseRefNumeral(token: string, ordinals = true): RefNumber | null {
  const t = token.trim().replace(/^[([{]+|[)\]},;.:]+$/g, "").replace(/[׳‘’`´]/g, "'").replace(/[״“”„]/g, '"').replace(/''/g, '"');
  if (/^\d{1,4}$/.test(t)) {
    const n = parseInt(t, 10);
    return n > 0 ? { n, marked: true, ambiguous: false } : null;
  }
  const ord = Object.hasOwn(ORDINALS, t) ? ORDINALS[t] : undefined;
  if (ord !== undefined) return ordinals ? { n: ord, marked: true, ambiguous: false } : null;
  if (!/^[א-ת]{1,5}'?$|^[א-ת]{1,4}"[א-ת]$/.test(t)) return null;
  const letters = t.replace(/['"]/g, "");
  const plain = letters.replace(/[ךםןףץ]/g, (c) => FINAL_TO_PLAIN[c]!);
  // a final letter is only written last ("תם", "קך" are not numerals of "כ" in the middle)
  if (/[ךםןףץ]./.test(letters)) return null;
  const n = fromGematria(plain);
  if (n === null || n <= 0 || !spellingOk(plain, n)) return null;
  const marked = t !== letters;
  // "שם" is "ibid", never 340, unless written ש"מ (LinkerToOtzaria's guard)
  if (!marked && letters === "שם") return null;
  return { n, marked, ambiguous: !marked && AMBIGUOUS_NUMERALS.has(letters) };
}

/** An amud marker → 1 (עמוד א) or 2 (עמוד ב): ".", ":", "ע"א", "ע"ב", "עמוד א", "ע' ב", "א", "ב'". */
export function parseAmud(token: string | undefined): 1 | 2 | null {
  if (!token) return null;
  const t = token.trim().replace(/[׳‘’`´]/g, "'").replace(/[״“”„]/g, '"');
  if (t === ".") return 1;
  if (t === ":") return 2;
  const m = /^(?:ע(?:מוד|מ'|"|'|''|)\s?)?([אב])'?[.,:;]?$/.exec(t);
  return m ? (m[1] === "א" ? 1 : 2) : null;
}
