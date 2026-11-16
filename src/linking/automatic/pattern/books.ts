import { stripNikud } from "../../../core/text/hebrew";
import { kindOfWord } from "../headings/numbering";
import { parseRefNumeral } from "./numerals";

/*
 * "Is this reference about the TARGET?" A structure reference in running text often belongs to
 * another book named right before it: "הט"ז ס"ק ג", "בש"ך ס"ק ו", "שבת דף כג", "בנגעים (פרק יד
 * משנה ג)", "הח"א בכלל ז' ס"ו". Measured on מחצית השקל → מגן אברהם, these were most of the wrong
 * links. The guard looks back over a few filler words ("לעיל", "עיין", "כמ"ש") to the word that
 * names the book; when that word is a tractate, a listed book or author, or the level of a structure
 * the target does not have, and it does not name the target itself, the reference is skipped.
 *
 * The lists are facts (names of books and their usual abbreviations), written for this project;
 * the idea of looking for the book before a bare location is from the source-linkifier plugin's
 * findTitleBefore and LinkerToOtzaria's "מ"א before סי'/ס"ק is Magen Avraham" (REUSE_MATRIX §10).
 */

/** Mishnah and Bavli tractates (names and common abbreviations). */
export const TRACTATES: readonly string[] = [
  "ברכות", "פאה", "דמאי", "כלאים", "שביעית", "תרומות", "מעשרות", "מעשר שני", "מע\"ש", "חלה", "ערלה", "ביכורים", "בכורים",
  "שבת", "עירובין", "ערובין", "פסחים", "שקלים", "יומא", "סוכה", "ביצה", "ראש השנה", "ר\"ה", "תענית", "מגילה",
  "מועד קטן", "מו\"ק", "חגיגה", "יבמות", "כתובות", "נדרים", "נזיר", "סוטה", "גיטין", "קידושין", "קדושין",
  "בבא קמא", "ב\"ק", "בבא מציעא", "ב\"מ", "בבא בתרא", "ב\"ב", "סנהדרין", "מכות", "שבועות", "עדיות", "עבודה זרה", "ע\"ז",
  "אבות", "הוריות", "זבחים", "מנחות", "חולין", "בכורות", "ערכין", "תמורה", "כריתות", "מעילה", "תמיד", "מדות", "מידות", "קנים", "קינים",
  "כלים", "אהלות", "אהלים", "נגעים", "פרה", "טהרות", "מקואות", "נדה", "נידה", "מכשירין", "זבים", "טבול יום", "ידים", "ידיים", "עוקצין", "עוקצים",
];

/** Books and authors whose name (usually an acronym) introduces a reference to THEM. */
export const BOOK_WORDS: readonly string[] = [
  "ט\"ז", "ש\"ך", "ב\"י", "ב\"ח", "פמ\"ג", "א\"ר", "ח\"א", "נ\"א", "מ\"ב", "מ\"א", "מג\"א", "ע\"ת", "שע\"ת", "רמ\"א", "הגר\"א", "גר\"א",
  "באה\"ט", "בה\"ט", "ש\"ע", "שו\"ע", "טוש\"ע", "לבוש", "פר\"ח", "ח\"י", "נו\"ב", "ח\"ס", "תה\"ד", "רא\"ש", "רמב\"ם", "רמב\"ן", "רש\"י",
  "תוס'", "תוספות", "מהרש\"א", "מהרש\"ל", "ירושלמי", "תוספתא", "סמ\"ג", "סמ\"ק", "טור", "ר\"ן", "ריטב\"א", "רשב\"א", "מחה\"ש", "א\"א",
  "ט\"א", "מ\"ז", "ק\"נ", "עו\"ש", "שה\"ג", "כנה\"ג", "חו\"י", "מעדני", "פרישה", "דרישה", "סמ\"ע", "ערוה\"ש", "כה\"ח", "שולחן", "חינוך", "החינוך",
  "זוהר", "זהר", "מדרש", "ספרא", "ספרי", "מכילתא", "תנחומא", "ילקוט", "רבה", "ש\"ס",
  // the parts of the Tur and the Shulchan Aruch: "ביו"ד סימן רעו" is not אורח חיים
  "או\"ח", "יו\"ד", "אה\"ע", "אבה\"ע", "חו\"מ", "אורח חיים", "יורה דעה", "אבן העזר", "חושן משפט", "חשן משפט",
  // responsa and novellae: "רע"א בתשובותיו סימן ז", "בחידושי רע"א בסי' לב", "בשו"ת … סי'"
  "שו\"ת", "תשובת", "תשובות", "תשובותיו", "בתשובה", "חידושי", "רע\"א", "מהרי\"ל", "מהר\"ם", "ריב\"ש", "רדב\"ז", "חוו\"י",
];

/** words between a book's name and its location: "מ"א לקמן סי' צ"א", "בש"ך שם ס"ק ו" */
const FILLER = new Set([
  "לעיל", "לקמן", "להלן", "וכדלעיל", "וכדלקמן", "כדלעיל", "כדלקמן", "עיין", "ועיין", "עי'", "וע'", "ועי'", "שם", "ושם", "בסוף", "סוף", "ריש", "בריש",
  "כמ\"ש", "וכמ\"ש", "מש\"כ", "ומש\"כ", "במש\"כ", "שכ'", "כ'", "וכ'", "כתב", "וכתב", "שכתב", "הובא", "מובא", "דברי", "בדברי", "כמבואר", "המובא", "הביא", "שהביא",
]);

/** comparison form of a book name: no nikud, no quotes, no "מסכת", single spaces */
export const bookKey = (s: string): string => stripNikud(s).replace(/["'״׳]/g, "").replace(/^[ובלמ]?מסכת\s+/, "").replace(/\s+/g, " ").trim();

const TRACTATE_KEYS = new Set(TRACTATES.map(bookKey));
const BOOK_KEYS = new Set(BOOK_WORDS.map(bookKey));
const FILLER_KEYS = new Set([...FILLER].map((w) => w.replace(/[״]/g, '"').replace(/׳/g, "'")));

/** a word without one or two prefix letters ("ובש"ך" → "ש"ך") */
function withoutPrefixes(word: string): string[] {
  const out = [word];
  const m = /^([ובלמהדשכ]{1,2})(.{2,})$/.exec(word);
  if (m) {
    out.push(m[2]!);
    if (m[1]!.length === 2) out.push(word.slice(1));
  }
  return out;
}

/**
 * Does a book named in a reference ("ברכות", "בברכות", "ב"ק", "מו"ק", "מ"א") name the target? Equal
 * names, the target's last title part ("שולחן ערוך, אורח חיים" → "אורח חיים"), or an abbreviation
 * whose letters split into prefixes of the target's first words in order (ב"ק = בבא קמא, מג"א =
 * מגן אברהם, ש"ע = שולחן ערוך).
 */
export function bookMatches(named: string, title: string): boolean {
  const last = bookKey(title.split(",").pop() ?? title).replace(/^(?:תלמוד בבלי|בבלי|משנה)\s+/, "");
  const full = bookKey(title);
  const quoted = /["'״׳]/.test(named);
  for (const w of withoutPrefixes(named.trim())) {
    const n = bookKey(w);
    if (!n) continue;
    if (n === last || n === full) return true;
    if (quoted && !n.includes(" ") && (initials(n, last.split(" ")) || initials(n, full.split(" ")))) return true;
  }
  return false;
}

/** letters = prefixes of the first k (≥ 2) words, in order */
function initials(letters: string, words: readonly string[]): boolean {
  if (words.length < 2) return false;
  const go = (i: number, w: number): boolean => {
    if (i === letters.length) return w >= 2;
    if (w === words.length) return false;
    for (let len = 1; len <= words[w]!.length && i + len <= letters.length; len++)
      if (words[w]!.startsWith(letters.slice(i, i + len)) && go(i + len, w + 1)) return true;
    return false;
  };
  return go(0, 0);
}

/**
 * The other book a reference belongs to, from the text right before and right after it; undefined
 * when the reference may be the target's. `targetKinds` (the target's numbered kinds) lets "בכלל ז'
 * ס"ו" — a ס"ו under a כלל the target does not have — count as another book's.
 *   before: "הט"ז ס"ק ג", "בש"ך שם ס"ק ו", "שבת דף כג", "בנגעים (פרק יד…)", "בכלל ז' ס"ו", "דף פ"ד"
 *   after:  "פרק ו' דפסחים", "פ"ג מהלכות תרומות" (when the target is not הלכות תרומות)
 */
export function otherBook(before: string, after: string, targetTitle: string, targetKinds: ReadonlySet<string> = new Set()): string | undefined {
  return otherBefore(before, targetTitle, targetKinds) ?? otherAfter(after, targetTitle, targetKinds);
}

const tokens = (s: string): string[] => s.replace(/[()[\]{},.:;—–-]/g, " ").replace(/[״]/g, '"').replace(/׳/g, "'").trim().split(/\s+/).filter(Boolean);

function otherBefore(before: string, targetTitle: string, targetKinds: ReadonlySet<string>): string | undefined {
  const words = tokens(before);
  let i = words.length - 1;
  if (i < 0) return undefined;
  // a kind word right before: the reference is the number of something else ("דף פ"ד" read as פרק ד)
  if (withoutPrefixes(words[i]!).some((w) => kindOfWord(w))) return words[i];
  // a level of another structure right before: "בכלל ז' ס"ו"
  if (i >= 1 && targetKinds.size && parseRefNumeral(words[i]!)) {
    const kind = withoutPrefixes(words[i - 1]!).map(kindOfWord).find(Boolean);
    if (kind && kind !== "daf" && !targetKinds.has(kind)) return words[i - 1];
  }
  // Rambam: "בהל' יום טוב פ"ד", "בהלכות שבת" — another הלכות than the target's
  for (let j = Math.max(0, i - 2); j <= i; j++) {
    if (/^[ובלמד]{0,2}(?:הלכות|הל')$/.test(words[j]!) && words[j + 1] && !titleHasHilchot(targetTitle, words[j + 1]!)) return `${words[j]} ${words[j + 1]}`;
  }
  for (let steps = 0; i >= 0 && steps < 6; i--, steps++) {
    const w = words[i]!;
    if (withoutPrefixes(w).some((x) => FILLER_KEYS.has(x))) continue;
    // a tractate or a book, possibly two words ("בבא קמא", "מעשר שני") — before the numeral test,
    // since "ע"ז", "ר"ה" and "שני" are numerals too
    const two = i >= 1 ? `${words[i - 1]} ${w}` : "";
    for (const cand of [two, w]) {
      if (!cand) continue;
      for (const x of withoutPrefixes(cand)) {
        const k = bookKey(x);
        if (TRACTATE_KEYS.has(k) || BOOK_KEYS.has(k)) return bookMatches(x, targetTitle) ? undefined : x;
      }
    }
    // the location parts of the other book's own reference: "נזיר פ"ז דף כה", "שבת דף כג"
    if (steps < 4 && (parseRefNumeral(w) || /^[ובלמ]?[רס]?פ"[א-ת]{1,2}$/.test(w) || withoutPrefixes(w).some((x) => kindOfWord(x)))) continue;
    return undefined;
  }
  return undefined;
}

function otherAfter(after: string, targetTitle: string, targetKinds: ReadonlySet<string>): string | undefined {
  const words = tokens(after);
  const first = words[0];
  if (!first) return undefined;
  // "בפ"ק (דף י"ח:)": a chapter followed by its daf is the Talmud's, when the target has no dafs
  if (targetKinds.size && !targetKinds.has("daf") && /^(?:דף|ד')$/.test(first)) return "דף";
  // "דפסחים", "דבבא קמא", "מברכות"
  const m = /^[דמב](.{2,})$/.exec(first);
  if (m) {
    for (const cand of [`${m[1]} ${words[1] ?? ""}`.trim(), m[1]!]) {
      if (TRACTATE_KEYS.has(bookKey(cand)) && !bookMatches(cand, targetTitle)) return first;
    }
  }
  // "מהלכות תרומות", "מהל' שבת", "דהלכות"
  if (/^[מדב]?(?:הלכות|הל'|ה')$/.test(first) && words[1]) {
    if (!titleHasHilchot(targetTitle, words[1])) return `${first} ${words[1]}`;
  }
  // a Rambam target: "פרק ט"ו מאיסורי ביאה", "בפרק שני מלכות תעניות" name another הלכות
  if (/הלכות/.test(targetTitle) && /^מ[א-ת]{3,}$/.test(first) && !bookKey(targetTitle).split(" ").includes(first.slice(1))) return first;
  return undefined;
}

/** "הלכות <name>" is the target's own: "משנה תורה, הלכות שבת" has שבת, "משנה ברכות" has no הלכות at all */
function titleHasHilchot(title: string, name: string): boolean {
  const t = bookKey(title);
  return t.includes("הלכות") && t.split(" ").includes(bookKey(name));
}
