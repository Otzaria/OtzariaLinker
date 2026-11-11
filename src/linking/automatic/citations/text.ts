/*
 * Tokens of one line of book HTML for CITATION detection, each with RAW offsets into the untouched
 * line (the string the generator counts anchor offsets on). Unlike matching/hebrew-tokens.ts this
 * keeps what a citation is made of besides words: digits, brackets, commas, colons and the "." / ":"
 * glued to a daf number ("כג." / "כג:"), and whether a quote mark sits inside a word (כ"ג, ב"ק) or at
 * its end (ג', הל').
 *
 * Rules shared with the generator and with hebrew-tokens:
 *   • tags are zero-width; only line-breaking tags separate tokens. A "<" with no ">" hides the rest
 *     of the line (HtmlCharCounter), so nothing after it can be anchored;
 *   • nikud and cantillation are dropped; maqaf, paseq and sof pasuq separate words;
 *   • `&quot;`/`&#39;` are quote marks, `&nbsp;` is a space, any other entity separates.
 * Offsets are UTF-16 code units, like the generator's.
 */

export type TokKind = "word" | "digits" | "punct";

export interface Tok {
  readonly kind: TokKind;
  /** word: Hebrew letters only (final forms kept); digits: the digits; punct: the character */
  readonly text: string;
  /** word: letters with final forms unified, for comparison */
  readonly key: string;
  /** word: gershayim (or '') between letters — an acronym or a numeral (ב"ק, כ"ג) */
  readonly gershayim: boolean;
  /** word: index in `text` of the letter AFTER the gershayim, or -1 */
  readonly gershayimAt: number;
  /** word: ends with a geresh (ג', הל', ישעי') */
  readonly geresh: boolean;
  readonly rawStart: number;
  /** exclusive; for a word with a final geresh, past the geresh */
  readonly rawEnd: number;
  /** no white space (and no separating tag) between the previous token and this one */
  readonly glued: boolean;
}

const FINALS: Readonly<Record<string, string>> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
export const unifyFinals = (s: string): string => s.replace(/[ךםןףץ]/g, (c) => FINALS[c]!);

/** line-breaking tags, and the markers/bodies of notes (sup, sub, a merged footnote): they end a word */
const BREAK_TAGS = /^(?:\/?(?:br|p|div|h[1-6]|li|ul|ol|tr|td|th|table|hr|blockquote|sup|sub)\b|i\s[^>]*class="footnote)/i;
const isLetter = (c: string) => c >= "א" && c <= "ת";
const isSeparatorMark = (c: string) => c === "־" || c === "׀" || c === "׃" || c === "׆";
const isMark = (c: string) => c >= "֑" && c <= "ׇ" && !isSeparatorMark(c);
const DOUBLE_Q = new Set(['"', "״", "“", "”", "″", "‟", "„"]);
const SINGLE_Q = new Set(["'", "׳", "‘", "’", "´", "`"]);
const PUNCT = new Set(["(", ")", "[", "]", "{", "}", ",", ".", ":", ";", "-", "–", "—", "/"]);
const SPACE_ENTITIES = new Set(["nbsp", "ensp", "emsp", "thinsp", "#160", "#xa0"]);

/** Tokenizes one line (the anchor text). Pure. */
export function citationTokens(html: unknown): Tok[] {
  const s = String(html ?? "");
  const out: Tok[] = [];
  let glued = false;
  // current word
  let text = "";
  let start = -1;
  let end = -1;
  let gAt = -1;
  /** a quote right after letters: 1 = geresh, 2 = gershayim, with its raw end */
  let pending = null as { kind: 1 | 2; rawEnd: number } | null;
  let wordGlued = false;
  let digits = "";
  let dStart = -1;
  let dEnd = -1;
  let digitsGlued = false;

  const pushWord = () => {
    if (start < 0 || !text) return reset();
    const geresh = pending?.kind === 1;
    // a trailing gershayim (rare: "ב"" at a line end) is a closing quote, not part of the word
    out.push({ kind: "word", text, key: unifyFinals(text), gershayim: gAt > 0, gershayimAt: gAt, geresh, rawStart: start, rawEnd: geresh ? pending!.rawEnd : end, glued: wordGlued });
    glued = true;
    reset();
  };
  const reset = () => {
    text = "";
    start = -1;
    end = -1;
    gAt = -1;
    pending = null;
  };
  const pushDigits = () => {
    if (dStart < 0) return;
    out.push({ kind: "digits", text: digits, key: digits, gershayim: false, gershayimAt: -1, geresh: false, rawStart: dStart, rawEnd: dEnd, glued: digitsGlued });
    glued = true;
    digits = "";
    dStart = -1;
  };
  const flush = () => {
    pushWord();
    pushDigits();
  };
  const space = () => {
    flush();
    glued = false;
  };
  const quote = (kind: 1 | 2, rawEnd: number) => {
    if (start < 0) {
      // an opening quote (or one after digits) separates but is not a space
      pushDigits();
      return;
    }
    pending = pending ? { kind: 2, rawEnd } : { kind, rawEnd };
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<") {
      const close = s.indexOf(">", i + 1);
      if (close < 0) break; // the generator hides the rest of the line
      if (BREAK_TAGS.test(s.slice(i + 1, close))) space();
      i = close;
      continue;
    }
    if (c === "&") {
      const semi = s.indexOf(";", i + 1);
      if (semi > i && semi - i < 10) {
        const ent = s.slice(i + 1, semi).toLowerCase();
        if (ent === "quot") quote(2, semi + 1);
        else if (ent === "#39" || ent === "apos") quote(1, semi + 1);
        else if (SPACE_ENTITIES.has(ent)) space();
        else space();
        i = semi;
        continue;
      }
      space();
      continue;
    }
    if (isLetter(c)) {
      pushDigits();
      if (start < 0) {
        start = i;
        wordGlued = glued;
      } else if (pending) {
        if (pending.kind === 1) {
          // "ר'יוחנן": a geresh between letters ends the word (pushWord keeps the geresh on it)
          pushWord();
          start = i;
          wordGlued = true;
        } else if (gAt < 0) gAt = text.length;
        pending = null;
      }
      text += c;
      end = i + 1;
      continue;
    }
    if (isMark(c)) {
      if (start >= 0 && !pending) end = i + 1;
      continue;
    }
    if (DOUBLE_Q.has(c)) {
      quote(2, i + 1);
      continue;
    }
    if (SINGLE_Q.has(c)) {
      quote(1, i + 1);
      continue;
    }
    if (c >= "0" && c <= "9") {
      pushWord();
      if (dStart < 0) {
        dStart = i;
        digitsGlued = glued;
      }
      digits += c;
      dEnd = i + 1;
      continue;
    }
    if (PUNCT.has(c)) {
      flush();
      out.push({ kind: "punct", text: c === "–" || c === "—" ? "-" : c, key: c, gershayim: false, gershayimAt: -1, geresh: false, rawStart: i, rawEnd: i + 1, glued });
      glued = true;
      continue;
    }
    // white space, maqaf, sof pasuq, any other character: a separator
    space();
  }
  flush();
  return out;
}

/** The word as written, with its quote marks normalised to ASCII (ב"ק, ג', הל'). */
export function wordShape(t: Tok): string {
  if (t.kind !== "word") return t.text;
  let s = t.gershayimAt > 0 ? `${t.text.slice(0, t.gershayimAt)}"${t.text.slice(t.gershayimAt)}` : t.text;
  if (t.geresh) s += "'";
  return s;
}

/** At least two Hebrew letters in the line's visible text (the generator's and LinkerToOtzaria's skip rule). */
export function hasHebrewText(tokens: readonly Tok[]): boolean {
  let n = 0;
  for (const t of tokens) if (t.kind === "word" && (n += t.text.length) >= 2) return true;
  return false;
}
