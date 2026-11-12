/*
 * Hebrew word tokens of one line of book HTML, each with a SEARCH key and the RAW offsets of the
 * word in the line. The key is for comparison only; the offsets point back into the untouched
 * line, so whatever an engine outputs (an anchor) is a slice of the original text, never of the
 * normalized one.
 *
 * Search normalization (docs/research/REUSE_MATRIX.md §2.1, §4.1, §5.2–5.4):
 *   • tags are zero-width: `<big>בְּ</big>רֵאשִׁית` is ONE word (the generator's own inline markup
 *     sits inside words). Only line-breaking tags (br, p, div, h1–6, li, tr, td) separate words.
 *     A `<` with no `>` hides the rest of the line, exactly as the generator's countVisibleChars.
 *   • nikud and cantillation (U+0591–U+05C7) are dropped from the key — EXCEPT maqaf U+05BE,
 *     paseq U+05C0, sof pasuq U+05C3 and nun hafukha U+05C6, which SEPARATE words. (The
 *     link-generator deleted the maqaf with the nikud, so "כל־האדם" became "כלהאדם".)
 *   • final letters are unified with their regular forms (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ).
 *   • quote marks: gershayim inside a word marks an acronym (ת"ר) and a trailing geresh a
 *     truncation (ר׳, מתני׳); both are kept as FLAGS, not in the key. Quotes that wrap a word are
 *     dropped. `''` counts as gershayim.
 *   • digits, Latin letters, punctuation and entities other than &quot;/&#39; separate words.
 */

export interface HebToken {
  /** search key: Hebrew letters only, final letters unified */
  readonly key: string;
  /** raw offset of the first letter (opening tags before it are skipped) */
  readonly rawStart: number;
  /** raw offset just past the word's last letter / mark (exclusive) */
  readonly rawEnd: number;
  /** written with gershayim inside (ת"ר, רש"י) — an acronym */
  readonly acronym: boolean;
  /** ends with a geresh (ר׳, גמ׳) — a truncated word */
  readonly truncated: boolean;
}

const FINALS: Readonly<Record<string, string>> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const BREAK_TAGS = /^\/?(br|p|div|h[1-6]|li|ul|ol|tr|td|th|table|hr|blockquote)\b/i;

const isLetter = (c: string) => c >= "א" && c <= "ת";
const isSeparatorMark = (c: string) => c === "־" || c === "׀" || c === "׃" || c === "׆";
const isMark = (c: string) => c >= "֑" && c <= "ׇ" && !isSeparatorMark(c);
const DOUBLE_Q = new Set(['"', "״", "“", "”", "″", "‟", "„"]);
const SINGLE_Q = new Set(["'", "׳", "‘", "’", "´", "`"]);

/** Tokenizes one line. Pure; the input is never modified. */
export function hebrewTokens(html: unknown): HebToken[] {
  const s = String(html ?? "");
  const out: HebToken[] = [];
  let key = "";
  let start = -1;
  let end = -1;
  let acronym = false;
  /** a quote seen after letters of the current word: 1 = geresh, 2 = gershayim */
  let pending = null as { kind: 1 | 2; at: number } | null;

  const flush = () => {
    if (start >= 0 && key) {
      let truncated = false;
      let e = end;
      if (pending?.kind === 1) {
        truncated = true;
        e = pending.at + 1;
      }
      out.push({ key, rawStart: start, rawEnd: e, acronym, truncated });
    }
    key = "";
    start = -1;
    end = -1;
    acronym = false;
    pending = null;
  };
  const quote = (kind: 1 | 2, at: number) => {
    if (start < 0) return; // opening quote: ignored
    if (pending) pending = { kind: 2, at }; // '' → gershayim
    else pending = { kind, at };
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<") {
      const close = s.indexOf(">", i + 1);
      if (close < 0) break; // the generator hides the rest of the line
      if (BREAK_TAGS.test(s.slice(i + 1, close))) flush();
      i = close;
      continue;
    }
    if (c === "&") {
      // an entity is at most 10 characters (offsets.ts): look only that far, never to the end of the line
      let semi = -1;
      for (let j = i + 1; j < Math.min(s.length, i + 10); j++)
        if (s[j] === ";") {
          semi = j;
          break;
        }
      if (semi > i) {
        const ent = s.slice(i + 1, semi).toLowerCase();
        if (ent === "quot") quote(2, semi);
        else if (ent === "#39" || ent === "apos") quote(1, semi);
        else flush();
        i = semi;
        continue;
      }
      flush();
      continue;
    }
    if (isLetter(c)) {
      if (start < 0) start = i;
      else if (pending) {
        if (pending.kind === 2) acronym = true;
        pending = null;
      }
      key += FINALS[c] ?? c;
      end = i + 1;
      continue;
    }
    if (isMark(c)) {
      if (start >= 0 && !pending) end = i + 1;
      continue;
    }
    if (DOUBLE_Q.has(c)) {
      quote(2, i);
      continue;
    }
    if (SINGLE_Q.has(c)) {
      quote(1, i);
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/** The search key of a single word or phrase, words joined by one space (same rules as above). */
export function searchKey(text: unknown): string {
  return hebrewTokens(text)
    .map((t) => t.key)
    .join(" ");
}

/** The visible text of `html[from, to)`: tags removed, entities kept as written. For display/reasons. */
export function visibleSlice(html: string, from: number, to: number): string {
  return html.slice(from, to).replace(/<[^>]*>/g, "");
}
