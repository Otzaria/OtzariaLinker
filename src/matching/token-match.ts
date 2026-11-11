/*
 * One step of aligning two token sequences: does the next word (or words) of A match the next
 * word(s) of B? Besides plain word similarity (./similarity), it bridges the spelling gaps that a
 * quotation and its source typically have, all WITHOUT a dictionary:
 *
 *   • acronym ↔ words by initials (ת"ר ↔ תנו רבנן), only for a token WRITTEN with gershayim — an
 *     unmarked short word is never expanded (link-generator BUG-07); the first letter may be a
 *     prefix glued to the first word (וא"ר ↔ ואמר רבי);
 *   • truncation ↔ word by prefix (ר׳ ↔ רבי, מתני׳ ↔ מתניתין), only for a token ending in a geresh;
 *   • one word ↔ two glued words (והאמר ↔ והא אמר), from lemma_head_match (REUSE_MATRIX §2.5);
 *   • a few fixed Aramaic contractions (קמשמע ↔ קא משמע) from link-generator replacements.ts;
 *   • the divine name written ה׳ ↔ יהוה (also after a prefix letter: וה׳, לה׳);
 *   • the whole-word skeleton (בונה ↔ בנה) when the stems hide it.
 *
 * Every bridge is a CANDIDATE with a damped similarity, never a rewrite of the text.
 */
import type { HebToken } from "./hebrew-tokens";
import { skeleton } from "../core/text/hebrew";
import { boundedMemo } from "../core/text/memo";
import { wordSimilarity } from "./similarity";

export type StepKind = "exact" | "fuzzy" | "acronym" | "truncation" | "split";

export interface Step {
  /** tokens of A consumed */
  readonly a: number;
  /** tokens of B consumed */
  readonly b: number;
  /** 0..1 */
  readonly sim: number;
  readonly kind: StepKind;
}

/** Similarity of an expansion bridge (initials / prefix / split) — below a stem match (0.92). */
export const BRIDGE_SIM = 0.85;

const simMemo = boundedMemo((pair: string) => {
  const bar = pair.indexOf("|");
  const a = pair.slice(0, bar);
  const b = pair.slice(bar + 1);
  const s = wordSimilarity(a, b);
  if (s > 0) return s;
  // plene/defective spelling of the WHOLE word: wordSimilarity compares skeletons of the stems
  // only, and peeling a "prefix" that is really a root letter (בונה → ונה) hides בונה ≈ בנה
  const k = skeleton(a);
  return k.length >= 3 && k === skeleton(b) ? 0.88 : 0;
}, 200_000);

/** Memoized, symmetric word similarity of two search keys. */
export function keySimilarity(a: string, b: string): number {
  if (a === b) return 1;
  return a < b ? simMemo(`${a}|${b}`) : simMemo(`${b}|${a}`);
}

const PREFIX_LETTERS = new Set(["ו", "ב", "ד", "ה", "כ", "ל", "מ", "ש"]);

/** Fixed contractions: one word ↔ the words it stands for (search keys). */
const CONTRACTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["קמשמע", ["קא", "משמע"]],
  ["קמיבעיא", ["קא", "מיבעיא"]],
  ["קמיבעי", ["קא", "מיבעי"]],
]);

/** The divine name written as ה׳ (with a prefix letter: וה׳, לה׳…) — a substitute, not a prefix. */
const DIVINE_NAMES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const m = new Map<string, Set<string>>();
  for (const p of ["", "ו", "ב", "ל", "מ", "כ", "ה", "ש", "וב", "ול", "ומ", "וכ", "וה", "מה"]) {
    const names = new Set(["יהוה", "אדני", "אלהימ"].map((n) => p + n));
    m.set(p + "ה", names); // not ד׳: in the ש"ס it is mostly the numeral 4 (ד׳ מאות)
  }
  return m;
})();

/** One-letter truncations are too short to be a prefix of anything; only these are known. */
const ONE_LETTER: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["ר", new Set(["רבי", "רב", "רבנ", "רבנו", "רבינו"])],
]);

/** Does the truncated word `short` (ר׳, מתני׳, ה׳) stand for `full`? */
function truncates(short: string, full: string): boolean {
  const divine = DIVINE_NAMES.get(short);
  if (divine) return divine.has(full);
  if (short.length === 1) return ONE_LETTER.get(short)?.has(full) ?? false;
  return full.length > short.length && full.startsWith(short);
}

/**
 * Is `whole` the two words `first second` written as one (והאמר ↔ והא אמר, with the second word's
 * opening א dropped as in speech, or kept: לכדתניא ↔ לכד תניא)? Both parts need 2+ letters.
 */
function glued(whole: string, first: string, second: string | undefined): boolean {
  if (!second || whole.length < 5 || first.length < 2 || second.length < 2 || !whole.startsWith(first)) return false;
  const rest = whole.slice(first.length);
  return rest === second || (second[0] === "א" && rest.length >= 2 && rest === second.slice(1));
}

/** Number of B tokens from `j` whose initials spell `letters` (0 when they do not). */
function initialsAt(letters: string, b: readonly HebToken[], j: number, gluedPrefix: boolean): number {
  const n = gluedPrefix ? letters.length - 1 : letters.length;
  if (n < 2 || j + n > b.length) return 0;
  for (let k = 0; k < n; k++) {
    const w = b[j + k]!.key;
    if (gluedPrefix && k === 0) {
      if (w.length < 2 || w[0] !== letters[0] || w[1] !== letters[1]) return 0;
    } else if (w[0] !== letters[gluedPrefix ? k + 1 : k]) return 0;
  }
  return n;
}

function acronymSpan(acr: HebToken, other: readonly HebToken[], j: number): number {
  const L = acr.key;
  if (!acr.acronym || L.length < 2 || L.length > 6) return 0;
  return initialsAt(L, other, j, false) || (L.length >= 3 && PREFIX_LETTERS.has(L[0]!) ? initialsAt(L, other, j, true) : 0);
}

function sameWords(t: readonly HebToken[], j: number, words: readonly string[]): boolean {
  if (j + words.length > t.length) return false;
  return words.every((w, k) => t[j + k]!.key === w);
}

/**
 * The best step aligning a[i…] with b[j…], or null. Plain similarity first (an exact word always
 * wins); bridges are tried only when the plain words do not match.
 */
export function matchStep(a: readonly HebToken[], i: number, b: readonly HebToken[], j: number, fuzzy = true): Step | null {
  const x = a[i];
  const y = b[j];
  if (!x || !y) return null;
  if (x.key === y.key) return { a: 1, b: 1, sim: 1, kind: "exact" };
  if (fuzzy) {
    const s = keySimilarity(x.key, y.key);
    if (s > 0) return { a: 1, b: 1, sim: s, kind: "fuzzy" };
  }
  if (x.acronym || y.acronym) {
    let n = acronymSpan(x, b, j);
    if (n) return { a: 1, b: n, sim: BRIDGE_SIM, kind: "acronym" };
    n = acronymSpan(y, a, i);
    if (n) return { a: n, b: 1, sim: BRIDGE_SIM, kind: "acronym" };
  }
  if ((x.truncated && truncates(x.key, y.key)) || (y.truncated && truncates(y.key, x.key)))
    return { a: 1, b: 1, sim: BRIDGE_SIM, kind: "truncation" };
  const cx = CONTRACTIONS.get(x.key);
  if (cx && sameWords(b, j, cx)) return { a: 1, b: cx.length, sim: BRIDGE_SIM, kind: "split" };
  const cy = CONTRACTIONS.get(y.key);
  if (cy && sameWords(a, i, cy)) return { a: cy.length, b: 1, sim: BRIDGE_SIM, kind: "split" };
  if (glued(x.key, y.key, b[j + 1]?.key)) return { a: 1, b: 2, sim: BRIDGE_SIM, kind: "split" };
  if (glued(y.key, x.key, a[i + 1]?.key)) return { a: 2, b: 1, sim: BRIDGE_SIM, kind: "split" };
  return null;
}
