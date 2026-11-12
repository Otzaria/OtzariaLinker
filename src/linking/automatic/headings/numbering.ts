import { fromGematria, toGematria } from "../../../core/text/gematria";
import { normalize, stripNikud } from "../../../core/text/hebrew";
import { stripTags } from "../../../core/text/html";

/*
 * Heading text → structural elements, for the headings engine (plan stage 8.1).
 *
 * A heading such as "פרק ג", "סי' קכג", "דף ב:", "דף ב ע״א", "פרק א משנה ב", "הלכות שבת" or a bare
 * "יב" becomes one or more PathElements. Numbers follow docs/research/REUSE_MATRIX.md §5.1:
 * structural headings (with a kind word) read numerals LENIENTLY (summed: יה, ער, רחצ are accepted),
 * while a bare numeral with no kind word must look like a numeral (geresh/gershayim, Arabic digits,
 * or letters in non-increasing order), so ordinary words ("שבת" = 702) are never read as numbers.
 *
 * Ideas (not code) from the auto-linker plugin's daf/amud handling and Otzariya_Link_Maker's
 * DafTracker (both outside the Otzaria org — REUSE_MATRIX §2.7, §2.10).
 */

/** "?" = a number with no kind word (a bare heading "יב" or an inline "(יב)" marker). "name" = a named heading. */
export type ElementKind = string;

export interface PathElement {
  /** canonical kind id ("perek", "siman", "daf"…), "w:<word>" for an unknown kind word, "?" or "name" */
  readonly kind: ElementKind;
  /** the number, for numbered elements (daf: the daf number) */
  readonly n?: number;
  /** daf only: 1 = עמוד א, 2 = עמוד ב; absent = the whole daf */
  readonly amud?: 1 | 2;
  /** named elements: the comparison form of the text */
  readonly name?: string;
  /** display text, e.g. "פרק ג", "דף ב:", "(יב)" */
  readonly label: string;
}

export type NumberingMode = "lenient" | "strict";

interface KindDef {
  readonly id: string;
  /** singular Hebrew display word, used in labels and reasons ("מספר הפרק תואם") */
  readonly word: string;
  /** possessive form for reasons: "מספר ה<x>" */
  readonly the: string;
  readonly aliases: readonly string[];
}

/*
 * Aliases are matched on the token after quote unification (׳→' ״→"). Deliberately small and
 * unambiguous: "ס'" (סימן or סעיף?) and "ד'" (דף or ד = 4?) are NOT aliases.
 */
const KINDS: readonly KindDef[] = [
  { id: "perek", word: "פרק", the: "הפרק", aliases: ["פרק", "פ'", "פר'", "פרקים"] },
  { id: "pasuk", word: "פסוק", the: "הפסוק", aliases: ["פסוק", "פס'", "פסוקים"] },
  { id: "siman", word: "סימן", the: "הסימן", aliases: ["סימן", "סי'", "סימנים"] },
  { id: "seif", word: "סעיף", the: "הסעיף", aliases: ["סעיף", "סע'", "סעי'", "סעיפים"] },
  { id: "seifkatan", word: "סעיף קטן", the: "הסעיף הקטן", aliases: ['ס"ק', "סק", "סעיף קטן"] },
  { id: "daf", word: "דף", the: "הדף", aliases: ["דף", "דפים"] },
  { id: "amud", word: "עמוד", the: "העמוד", aliases: ["עמוד", "עמ'"] },
  // "הלכות שבת", "פרשת נח", "מסכת ברכות" are NAMES, not kind words: "שבת"/"נח" would read as numerals.
  { id: "halacha", word: "הלכה", the: "ההלכה", aliases: ["הלכה", 'הל"'] },
  { id: "mishna", word: "משנה", the: "המשנה", aliases: ["משנה", "משניות"] },
  { id: "parsha", word: "פרשה", the: "הפרשה", aliases: ["פרשה"] },
  { id: "chelek", word: "חלק", the: "החלק", aliases: ["חלק"] },
  { id: "os", word: "אות", the: "האות", aliases: ["אות", "אותיות"] },
  { id: "shaar", word: "שער", the: "השער", aliases: ["שער"] },
  { id: "klal", word: "כלל", the: "הכלל", aliases: ["כלל"] },
  { id: "maamar", word: "מאמר", the: "המאמר", aliases: ["מאמר"] },
  { id: "mizmor", word: "מזמור", the: "המזמור", aliases: ["מזמור"] },
  { id: "mitzva", word: "מצוה", the: "המצוה", aliases: ["מצוה", "מצווה"] },
  { id: "teshuva", word: "תשובה", the: "התשובה", aliases: ["תשובה"] },
  { id: "sefer", word: "ספר", the: "הספר", aliases: ["ספר"] },
  // the structure-reference presets of the pattern engine (pattern/presets.ts) name these too
  { id: "note", word: "הערה", the: "ההערה", aliases: ["הערה", "הערות"] },
  { id: "shoresh", word: "שורש", the: "השורש", aliases: ["שורש", "שרש"] },
  { id: "tikun", word: "תיקון", the: "התיקון", aliases: ["תיקון", "תקון"] },
  { id: "drush", word: "דרוש", the: "הדרוש", aliases: ["דרוש"] },
];

const BY_ALIAS = new Map<string, KindDef>();
for (const k of KINDS) for (const a of k.aliases) BY_ALIAS.set(a, k);
const BY_ID = new Map(KINDS.map((k) => [k.id, k] as const));

/** The kind a word names ("סי'" → siman), after quote unification; undefined for an unlisted word. */
export const kindOfWord = (word: string): string | undefined => BY_ALIAS.get(word.replace(/[׳‘’`´]/g, "'").replace(/[״“”„]/g, '"'))?.id;
/** Every listed kind id. */
export const KIND_IDS: readonly string[] = KINDS.map((k) => k.id);

/** Display word of a kind ("פרק"); "" for "?" and "name". */
export const kindWord = (kind: ElementKind): string => BY_ID.get(kind)?.word ?? (kind.startsWith("w:") ? kind.slice(2) : "");
/** "הפרק", "הסימן"… for reasons; unknown kinds fall back to "ה<word>". */
export const kindThe = (kind: ElementKind): string => BY_ID.get(kind)?.the ?? (kind.startsWith("w:") ? `ה${kind.slice(2)}` : "המספר");

const ORDINALS: Readonly<Record<string, number>> = {
  ראשון: 1, ראשונה: 1, שני: 2, שניה: 2, שנייה: 2, שלישי: 3, שלישית: 3, רביעי: 4, רביעית: 4, חמישי: 5, חמישית: 5,
  ששי: 6, שישי: 6, שישית: 6, שביעי: 7, שביעית: 7, שמיני: 8, שמינית: 8, תשיעי: 9, תשיעית: 9, עשירי: 10, עשירית: 10,
};

const LETTER_VALUE: Readonly<Record<string, number>> = {
  א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ך: 20, ל: 30, מ: 40, ם: 40,
  נ: 50, ן: 50, ס: 60, ע: 70, פ: 80, ף: 80, צ: 90, ץ: 90, ק: 100, ר: 200, ש: 300, ת: 400,
};

/** Text of a heading/line prepared for parsing: no tags, no nikud, unified quotes, maqaf/dashes → space. */
export function plainText(html: unknown): string {
  return stripNikud(stripTags(html))
    .replace(/[׳‘’`´]/g, "'")
    .replace(/[״“”„]/g, '"')
    .replace(/''/g, '"')
    .replace(/[־‐-―]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const hebrewLetterCount = (s: string): number => (s.match(/[א-ת]/g) ?? []).length;

export interface ParsedNumber {
  readonly n: number;
  /** "." / ":" written right after the numeral (amud notation in daf headings) */
  readonly trail: "" | "." | ":";
}

/**
 * One numeral token. `mode` lenient = summed letters (REUSE §5.1); strict = canonical round trip.
 * `bare` = no kind word precedes it, so it must LOOK like a numeral (quotes, digits or descending letters).
 */
export function parseNumeral(token: string, mode: NumberingMode, bare: boolean): ParsedNumber | null {
  let t = token.trim();
  let trail: "" | "." | ":" = "";
  const tm = /([.:])[,;]?$/.exec(t);
  if (tm) { trail = tm[1] as "." | ":"; t = t.slice(0, tm.index); }
  t = t.replace(/[,;]+$/, "").replace(/^[([{]+/, "").replace(/[)\]}]+$/, "");
  if (/^\d{1,4}$/.test(t)) {
    const n = parseInt(t, 10);
    return n > 0 ? { n, trail } : null;
  }
  const ord = Object.hasOwn(ORDINALS, t) ? ORDINALS[t] : undefined;
  if (ord !== undefined && !bare) return { n: ord, trail };
  const quoted = /['"]/.test(t);
  const letters = t.replace(/['"]/g, "");
  if (!letters || letters.length > 4 || !/^[א-ת]+$/.test(letters)) return null;
  // a quote may only be a final geresh ("יח'") or gershayim before the last letter ("קכ"ג")
  if (quoted && !/^[א-ת]+'$|^[א-ת]+"[א-ת]$/.test(t)) return null;
  const n = fromGematria(letters);
  if (n == null || n <= 0 || n > 2000) return null;
  if (mode === "strict" && toGematria(n) !== letters.replace(/[ךםןףץ]/g, (c) => FINAL_TO_PLAIN[c]!)) return null;
  if (bare && !quoted && !nonIncreasing(letters)) return null;
  return { n, trail };
}

const FINAL_TO_PLAIN: Readonly<Record<string, string>> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };

function nonIncreasing(letters: string): boolean {
  let prev = Infinity;
  for (const ch of letters) {
    const v = LETTER_VALUE[ch] ?? 0;
    if (v > prev) return false;
    prev = v;
  }
  return true;
}

const AMUD_RE = /^(?:ע"([אב])|ע([אב])'?|עמוד|עמ')$/;

/** Reads an amud marker starting at tokens[i]: "ע"א", "עמוד ב", "עמ' א". Returns [amud, tokens consumed]. */
function readAmud(tokens: readonly string[], i: number): [1 | 2, number] | null {
  const t = tokens[i]?.replace(/[.,:;]+$/, "");
  if (!t) return null;
  const m = AMUD_RE.exec(t);
  if (!m) return null;
  const side = m[1] ?? m[2];
  if (side) return [side === "א" ? 1 : 2, 1];
  const next = tokens[i + 1]?.replace(/[.,:;'"]+$/, "");
  if (next === "א" || next === "ב") return [next === "א" ? 1 : 2, 2];
  return null;
}

interface Parsed {
  readonly elements: PathElement[];
  /** tokens consumed by numbered elements (the rest is a subtitle, e.g. "פרק א - מאימתי") */
  readonly consumed: number;
  readonly total: number;
  /** every element came from an explicit, listed kind word */
  readonly explicit: boolean;
}

const SEPARATOR_RE = /^[-–—:,.]/;
/** a seif katan glued to its number: the quote must be there ("סק"א", "סקי"ב"), so "סקל" is a word */
const GLUED_SK_RE = /^סק(?:"([א-ת]{1,3}'?)|([א-ת]{1,2}"[א-ת]))[.,:;]?$/;

function parseTokens(text: string, mode: NumberingMode): Parsed {
  const tokens = text.split(" ");
  const out: PathElement[] = [];
  let explicit = true;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const twoWord = BY_ALIAS.get(`${tok} ${tokens[i + 1] ?? ""}`);
    const kind = twoWord ?? BY_ALIAS.get(tok.replace(/[.,:;]+$/, ""));
    const width = twoWord ? 2 : 1;
    if (kind?.id === "amud" || (!kind && AMUD_RE.test(tok.replace(/[.,:;]+$/, "")))) {
      // amud on its own: "עמוד ב", "ע"ב"
      const a = readAmud(tokens, i);
      if (!a) break;
      out.push({ kind: "amud", n: a[0], label: a[0] === 1 ? "עמוד א" : "עמוד ב" });
      i += a[1];
      continue;
    }
    // "סק"א", "סקי"ב": a seif katan glued to its number (seifKatan.ts of otzaria-link-generator @7ad8b2c, rewritten)
    const glued = kind ? null : GLUED_SK_RE.exec(tok);
    const gluedNum = glued ? parseNumeral((glued[1] ?? glued[2])!, "strict", false) : null;
    if (gluedNum) {
      out.push({ kind: "seifkatan", n: gluedNum.n, label: `ס"ק ${toGematria(gluedNum.n)}` });
      i += 1;
      continue;
    }
    const kindNum = kind && tokens[i + width] !== undefined ? parseNumeral(tokens[i + width]!, mode, false) : null;
    if (kind && kindNum) {
      const num = kindNum;
      i += width + 1;
      if (kind.id === "daf") {
        let amud: 1 | 2 | undefined = num.trail === "." ? 1 : num.trail === ":" ? 2 : undefined;
        const a = readAmud(tokens, i);
        if (a) { amud = a[0]; i += a[1]; }
        out.push(dafElement(num.n, amud));
        continue;
      }
      out.push({ kind: kind.id, n: num.n, label: `${kind.word} ${toGematria(num.n)}` });
      continue;
    }
    if (i !== 0) break;
    // first token only: an unknown kind word + a numeral that clearly is one ("שאלה ה"), or a bare numeral
    const ends = (at: number) => tokens.length === at || SEPARATOR_RE.test(tokens[at]!);
    if (tok.length >= 3 && /^[א-ת]+$/.test(tok) && tokens.length >= 2) {
      const num = parseNumeral(tokens[1]!, mode, true);
      if (num && ends(2)) {
        out.push({ kind: `w:${tok}`, n: num.n, label: `${tok} ${toGematria(num.n)}` });
        explicit = false;
        i = 2;
        continue;
      }
    }
    const num = parseNumeral(tok, mode, true);
    if (num && ends(1)) {
      out.push({ kind: "?", n: num.n, label: toGematria(num.n) });
      explicit = false;
      i = 1;
      continue;
    }
    break;
  }
  return { elements: out, consumed: i, total: tokens.length, explicit };
}

/**
 * A heading text → its elements. Never throws; an unparsable heading with Hebrew text is ONE named
 * element ("הלכות שבת", "הקדמה", "פרשת נח"); a heading with no Hebrew letters and no number gives [].
 */
export function parseHeading(html: unknown, mode: NumberingMode = "lenient"): PathElement[] {
  const text = plainText(html);
  if (!text) return [];
  const p = parseTokens(text, mode);
  if (p.elements.length) return p.elements;
  return hebrewLetterCount(text) >= 2 ? [{ kind: "name", name: normalize(text), label: text }] : [];
}

export function dafElement(n: number, amud: 1 | 2 | undefined): PathElement {
  const label = `דף ${toGematria(n)}${amud === 1 ? "." : amud === 2 ? ":" : ""}`;
  return amud === undefined ? { kind: "daf", n, label } : { kind: "daf", n, amud, label };
}

/**
 * The elements of a line that is a heading WITHOUT a tag — accepted only in the safest shape: a short
 * line made ENTIRELY of listed kind words and their numerals ("פרק ג", "דף ב ע"א", "סימן יב סעיף ג").
 */
export function untaggedHeading(html: unknown, mode: NumberingMode): PathElement[] | null {
  // a heading of at most 24 visible characters is never this long, even with tags (a cheap reject for prose lines)
  if (String(html ?? "").length > 400) return null;
  // a whole line in brackets ("(סימן ה)", "[סעיף ג]") is the same heading
  const text = plainText(html).replace(/^[([]\s*(.*?)\s*[)\]]$/, "$1");
  if (!text || text.length > 24) return null;
  const p = parseTokens(text, mode);
  return p.elements.length && p.explicit && p.consumed === p.total ? p.elements : null;
}

/** words that look like numerals in brackets but are citations: "(שם)" is never 340 (LinkerToOtzaria) */
const NOT_MARKERS = new Set(["שם", "שם'", "כו'", "וכו'", "עי'"]);

/**
 * "(יב) …" at the start of a line → the number, else null. Only round brackets (Sefaria style). There
 * is no kind word, so the numeral must LOOK like one (descending letters, gershayim or digits).
 */
export function inlineMarker(html: unknown, mode: NumberingMode): number | null {
  // only the start of the line matters; plainText of a whole long line is the cost of analyzeBook
  const m = /^\(([^()\s]{1,6})\)/.exec(plainText(String(html ?? "").slice(0, 300)));
  if (!m || NOT_MARKERS.has(m[1]!)) return null;
  const num = parseNumeral(m[1]!, mode, true);
  return num ? num.n : null;
}

