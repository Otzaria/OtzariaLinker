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
import { skeleton, stem } from "../core/text/hebrew";
import { maxEdits, wordSimilarity } from "./similarity";

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

function similarity(a: string, b: string): number {
  const s = wordSimilarity(a, b);
  if (s > 0) return s;
  // plene/defective spelling of the WHOLE word: wordSimilarity compares skeletons of the stems
  // only, and peeling a "prefix" that is really a root letter (בונה → ונה) hides בונה ≈ בנה
  const k = skeleton(a);
  return k.length >= 3 && k === skeleton(b) ? 0.88 : 0;
}

/*
 * The memo of keySimilarity: a → b → similarity, for a < b. Two lookups of keys that already exist
 * (V8 keeps a string's hash), never a concatenated "a|b" key: the ד"ה search asks this for every
 * word of every candidate base line, and building and hashing that string was half of the engine's
 * time (profile of "הערות שוליים על מכילתא דרשב\"י", 2026-11-11). When the memo outgrows its bound
 * it starts over instead of freezing: a frozen memo made every later pair of a large book a miss.
 */
const SIM_MEMO_MAX = 1_000_000;
let simMemo = new Map<string, Map<string, number>>();
let simMemoSize = 0;

function memoSimilarity(a: string, b: string): number {
  let row = simMemo.get(a);
  if (row) {
    const hit = row.get(b);
    if (hit !== undefined) return hit;
  }
  const s = similarity(a, b);
  if (++simMemoSize > SIM_MEMO_MAX) {
    simMemo = new Map();
    simMemoSize = 1;
    row = undefined;
  }
  if (!row) simMemo.set(a, (row = new Map()));
  row.set(b, s);
  return s;
}

/** Memoized, symmetric word similarity of two search keys. */
export function keySimilarity(a: string, b: string): number {
  if (a === b) return 1;
  return a < b ? memoSimilarity(a, b) : memoSimilarity(b, a);
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

/*
 * A cheap NECESSARY condition for matchStep(a, i, b, j) ≠ null, for search loops that try a word
 * against every word of many lines (the ד"ה search: the first words of a ד"ה against every word of
 * every candidate base line — almost always no step). Short-string and integer tests only, no memo
 * lookup; whenever it says false, matchStep is null (tests/unit/matching/token-match.test.ts checks
 * that against matchStep on real and generated words). Case by case, from matchStep:
 *   • exact key → true;
 *   • acronym: the initials of the words from b[j] spell it, so b[j] (or a[i]) opens with its letter;
 *   • truncation / contraction / glued words: the conditions of truncates(), CONTRACTIONS and glued()
 *     that involve only these two words;
 *   • wordSimilarity > 0 needs equal stems, equal stem skeletons, equal whole-word skeletons, or an
 *     edit distance d ≤ maxEdits between the stems — and d edits change the stems' LETTER SETS by
 *     at most 2d letters (a substitution removes one and adds one), which a bit mask counts.
 */
export interface StepProfile {
  readonly key: string;
  /** ids from the profiler that made this profile: equal ids ⇔ equal strings */
  readonly keyId: number;
  readonly stem: string;
  readonly stemId: number;
  readonly stemSkeletonId: number;
  /** stem skeleton of ≥ 2 letters (wordSimilarity compares it only then) */
  readonly stemSkeletonUsable: boolean;
  readonly skeletonId: number;
  /** whole-word skeleton of ≥ 3 letters */
  readonly skeletonUsable: boolean;
  readonly keyLength: number;
  readonly stemLength: number;
  /** first letter's code unit (an acronym's initials start there) */
  readonly first: number;
  /** letters of the stem as bits (by code point from א) */
  readonly mask: number;
  /** the first word a contraction stands for ("קמשמע" → "קא"), else null */
  readonly contractionHead: string | null;
}

/**
 * A memoizing profile maker for ONE search (one engine run): the ids it hands out are comparable
 * only among its own profiles, and everything is dropped with it — no global table grows across
 * runs. Every key gets one profile object.
 */
export function stepProfiler(): (key: string) => StepProfile {
  const ids = new Map<string, number>();
  const id = (s: string) => {
    let v = ids.get(s);
    if (v === undefined) ids.set(s, (v = ids.size));
    return v;
  };
  const made = new Map<string, StepProfile>();
  return (key) => {
    let p = made.get(key);
    if (p) return p;
    const st = stem(key);
    let mask = 0;
    for (let k = 0; k < st.length; k++) {
      const bit = st.charCodeAt(k) - 0x5d0;
      if (bit >= 0 && bit < 27) mask |= 1 << bit;
    }
    const stemSkel = skeleton(st);
    const skel = skeleton(key);
    const c = CONTRACTIONS.get(key);
    p = {
      key,
      keyId: id(key),
      stem: st,
      stemId: id(st),
      stemSkeletonId: id(stemSkel),
      stemSkeletonUsable: stemSkel.length >= 2,
      skeletonId: id(skel),
      skeletonUsable: skel.length >= 3,
      keyLength: key.length,
      stemLength: st.length,
      first: key.charCodeAt(0),
      mask,
      contractionHead: c ? c[0]! : null,
    };
    made.set(key, p);
    return p;
  };
}

/** Set bits of a 32-bit integer (SWAR popcount: constant time, no loop). */
function bitCount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * false only when matchStep(…x…, …y…) is certainly null (see above). `px`/`py`: the tokens'
 * profiles, from ONE stepProfiler. Integer tests first; strings only for the rare bridges.
 */
export function mayStep(x: HebToken, px: StepProfile, y: HebToken, py: StepProfile): boolean {
  if (px.keyId === py.keyId || px.stemId === py.stemId) return true;
  if (px.stemSkeletonUsable && px.stemSkeletonId === py.stemSkeletonId) return true;
  if (px.skeletonUsable && px.skeletonId === py.skeletonId) return true;
  const lim = maxEdits(px.stemLength > py.stemLength ? px.stemLength : py.stemLength);
  if (lim && (px.stemLength > py.stemLength ? px.stemLength - py.stemLength : py.stemLength - px.stemLength) <= lim && bitCount(px.mask ^ py.mask) <= 2 * lim) return true;
  // bridges (matchStep tries them only when the words themselves differ)
  if ((x.acronym || y.acronym) && px.first === py.first) return true;
  if ((x.truncated && truncates(x.key, y.key)) || (y.truncated && truncates(y.key, x.key))) return true;
  if (px.contractionHead !== null || py.contractionHead !== null) return px.contractionHead === y.key || py.contractionHead === x.key || mayGlue(px, py) || mayGlue(py, px);
  return mayGlue(px, py) || mayGlue(py, px);
}

/** glued(whole, first, …) is possible: the length rules and the shared opening of glued(). */
const mayGlue = (whole: StepProfile, first: StepProfile) => whole.keyLength >= 5 && first.keyLength >= 2 && whole.keyLength > first.keyLength && whole.key.startsWith(first.key);

/** A line's step profiles as typed arrays, for scanning it with `startsOf` (built once per line). */
export interface StepTable {
  readonly tokens: readonly HebToken[];
  readonly profiles: readonly StepProfile[];
  readonly keyId: Int32Array;
  readonly stemId: Int32Array;
  readonly stemSkeletonId: Int32Array;
  readonly skeletonId: Int32Array;
  readonly stemLength: Int32Array;
  readonly mask: Int32Array;
  /** first letter, or -1 for a word that may bridge to anything (truncated, a contraction) */
  readonly first: Int32Array;
  /** 1 = an acronym, 2 = long enough to be glued words (≥ 5 letters) */
  readonly bridge: Uint8Array;
}

export function stepTable(tokens: readonly HebToken[], profiles: readonly StepProfile[]): StepTable {
  const n = tokens.length;
  const t: StepTable = {
    tokens,
    profiles,
    keyId: new Int32Array(n),
    stemId: new Int32Array(n),
    stemSkeletonId: new Int32Array(n),
    skeletonId: new Int32Array(n),
    stemLength: new Int32Array(n),
    mask: new Int32Array(n),
    first: new Int32Array(n),
    bridge: new Uint8Array(n),
  };
  for (let k = 0; k < n; k++) {
    const p = profiles[k]!;
    const tok = tokens[k]!;
    t.keyId[k] = p.keyId;
    t.stemId[k] = p.stemId;
    t.stemSkeletonId[k] = p.stemSkeletonId;
    t.skeletonId[k] = p.skeletonId;
    t.stemLength[k] = p.stemLength;
    t.mask[k] = p.mask;
    t.first[k] = tok.truncated || p.contractionHead !== null ? -1 : p.first;
    t.bridge[k] = (tok.acronym ? 1 : 0) | (p.keyLength >= 5 ? 2 : 0);
  }
  return t;
}

/**
 * The positions k < limit of `line` where mayStep(x, line[k]) holds, ascending, into `out` (cleared).
 * The same test as mayStep, over typed arrays: the integer conditions inline, the rare bridges
 * (same first letter with an acronym or a long word; a truncated word; a contraction) through
 * mayStep itself.
 */
export function startsOf(x: HebToken, px: StepProfile, line: StepTable, limit: number, out: number[]): number[] {
  out.length = 0;
  const xKey = px.keyId;
  const xStem = px.stemId;
  const xStemSkel = px.stemSkeletonUsable ? px.stemSkeletonId : -2;
  const xSkel = px.skeletonUsable ? px.skeletonId : -2;
  const xLen = px.stemLength;
  const xMask = px.mask;
  const xFirst = x.truncated || px.contractionHead !== null ? -1 : px.first;
  const xBridge = (x.acronym ? 1 : 0) | (px.keyLength >= 5 ? 2 : 0);
  const { keyId, stemId, stemSkeletonId, skeletonId, stemLength, mask, first, bridge } = line;
  for (let k = 0; k < limit; k++) {
    if (keyId[k] === xKey || stemId[k] === xStem || stemSkeletonId[k] === xStemSkel || skeletonId[k] === xSkel) {
      out.push(k);
      continue;
    }
    // maxEdits(max length) inline: 0 up to 3 letters, 1 up to 6, else 2
    const yLen = stemLength[k]!;
    const longer = xLen > yLen ? xLen : yLen;
    const lim = longer <= 3 ? 0 : longer <= 6 ? 1 : 2;
    if (lim !== 0 && (xLen > yLen ? xLen - yLen : yLen - xLen) <= lim && bitCount(xMask ^ mask[k]!) <= 2 * lim) {
      out.push(k);
      continue;
    }
    const f = first[k]!;
    if (xFirst === -1 || f === -1 || (f === xFirst && (xBridge | bridge[k]!) !== 0)) {
      if (mayStep(x, px, line.tokens[k]!, line.profiles[k]!)) out.push(k);
    }
  }
  return out;
}

/*
 * The words of a book, each (key, acronym, truncated) once, with the queries a ד"ה search needs:
 * `compatible(x, next)` = every entry y a step from x (followed by `next`) could start at — a
 * SUPERSET of the entries where matchStep(…x…, …y…) ≠ null, except x's OWN acronym expansions (those
 * depend on the words after y: `acronymInitials` / `initialsAt` below find them), built from lookups
 * instead of comparing x with every word:
 *   • the same key, stem, stem skeleton or whole-word skeleton (maps by id);
 *   • stems within the edit distance wordSimilarity allows: both stems reduce to a common string
 *     by at most that many deletions (1 up to 6 letters, 2 from 7 — and a pair that may use 2 has
 *     both stems ≥ 5 letters), so stems are indexed by their deletion variants (SymSpell's idea);
 *   • the bridges, from the same tables matchStep uses: a base acronym whose first letter is x's,
 *     truncations (a prefix, ה׳ and ר׳), contractions, and glued words — x = y + the word after y
 *     (y is a prefix of x), or y = x + `next` (with `next`'s opening א dropped or kept).
 * Each candidate is then checked with mayStep. tests/unit/matching/token-match.test.ts compares it
 * with matchStep against a whole vocabulary.
 */
export interface VocabularyEntry {
  readonly token: HebToken;
  readonly profile: StepProfile;
}

export class StepVocabulary {
  readonly entries: VocabularyEntry[] = [];
  private readonly ids = new Map<string, number>();
  private readonly byKey = new Map<string, number[]>();
  private readonly byStem = new Map<number, number[]>();
  private readonly byStemSkeleton = new Map<number, number[]>();
  private readonly bySkeleton = new Map<number, number[]>();
  private readonly byDeletion = new Map<string, number[]>();
  private readonly byFirst = new Map<number, number[]>();
  private readonly acronymsByFirst = new Map<number, number[]>();
  private readonly contractions: number[] = [];
  private sortedKeys: string[] | null = null;
  private readonly memo = new Map<string, readonly number[]>();

  constructor(private readonly profile: (key: string) => StepProfile) {}

  /** The entry of a token (added on first sight). */
  add(t: HebToken): number {
    const flags = (t.acronym ? 1 : 0) | (t.truncated ? 2 : 0);
    const id = `${flags}${t.key}`;
    let e = this.ids.get(id);
    if (e !== undefined) return e;
    e = this.entries.length;
    const p = this.profile(t.key);
    this.entries.push({ token: t, profile: p });
    this.ids.set(id, e);
    push(this.byKey, t.key, e);
    push(this.byStem, p.stemId, e);
    if (p.stemSkeletonUsable) push(this.byStemSkeleton, p.stemSkeletonId, e);
    if (p.skeletonUsable) push(this.bySkeleton, p.skeletonId, e);
    for (const v of deletionVariants(p.stem)) push(this.byDeletion, v, e);
    push(this.byFirst, p.first, e);
    if (t.acronym) push(this.acronymsByFirst, p.first, e);
    if (p.contractionHead !== null) this.contractions.push(e);
    this.sortedKeys = null;
    this.memo.clear();
    return e;
  }

  /** Entries a step from `x` (then `next`) may start at (a superset of matchStep's, see above), ascending. */
  compatible(x: HebToken, next?: HebToken): readonly number[] {
    const own = this.compatibleAlone(x);
    // x and `next` glued into one base word (the only part that depends on `next`)
    if (!next || x.key.length < 2 || next.key.length < 2) return own;
    const px = this.profile(x.key);
    const glued = [this.byKey.get(x.key + next.key), next.key[0] === "א" ? this.byKey.get(x.key + next.key.slice(1)) : undefined]
      .flatMap((l) => l ?? [])
      .filter((e) => !own.includes(e) && mayStep(x, px, this.entries[e]!.token, this.entries[e]!.profile));
    return glued.length ? [...own, ...glued].sort((a, b) => a - b) : own;
  }

  private compatibleAlone(x: HebToken): readonly number[] {
    const flags = (x.acronym ? 1 : 0) | (x.truncated ? 2 : 0);
    const memoKey = `${flags}${x.key}`;
    const hit = this.memo.get(memoKey);
    if (hit) return hit;
    const px = this.profile(x.key);
    const cands = new Set<number>();
    const addAll = (list: readonly number[] | undefined) => {
      if (list) for (const e of list) cands.add(e);
    };
    const key = x.key;
    addAll(this.byKey.get(key));
    addAll(this.byStem.get(px.stemId));
    if (px.stemSkeletonUsable) addAll(this.byStemSkeleton.get(px.stemSkeletonId));
    if (px.skeletonUsable) addAll(this.bySkeleton.get(px.skeletonId));
    for (const v of deletionVariants(px.stem)) addAll(this.byDeletion.get(v));
    // a base acronym spelled by x and the words after it (x's own acronym: acronymInitials)
    addAll(this.acronymsByFirst.get(px.first));
    // truncation, both ways (truncates()): a proper prefix, or the fixed ה׳ / ר׳ tables
    for (let n = 1; n < key.length; n++) addAll(this.byKey.get(key.slice(0, n)));
    for (const [short, fulls] of [...DIVINE_NAMES, ...ONE_LETTER]) {
      if (short === key) for (const f of fulls) addAll(this.byKey.get(f));
      if (fulls.has(key)) addAll(this.byKey.get(short));
    }
    // contractions, both ways
    if (px.contractionHead !== null) addAll(this.byKey.get(px.contractionHead));
    addAll(this.contractions);
    // longer keys that open with this one: x truncates them (any), or x and `next` glued together
    if (x.truncated) for (const k of this.keysStartingWith(key)) addAll(this.byKey.get(k));
    const out = [...cands].filter((e) => mayStep(x, px, this.entries[e]!.token, this.entries[e]!.profile)).sort((a, b) => a - b);
    this.memo.set(memoKey, out);
    return out;
  }

  private keysStartingWith(prefix: string): string[] {
    const keys = (this.sortedKeys ??= [...this.byKey.keys()].sort());
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < keys.length && keys[i]!.startsWith(prefix); i++) if (keys[i]!.length > prefix.length) out.push(keys[i]!);
    return out;
  }
}

function push<K>(m: Map<K, number[]>, k: K, v: number): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * The initials an acronym token can be spelled by, as keys of `initialsKeys`: its first two letters
 * spread over two words ("תר" for ת"ר ↔ תנו רבנן), and — when its first letter may be a prefix glued to
 * the first word (וא"ר ↔ ואמר רבי) — the first word's two opening letters and the next word's initial.
 * acronymSpan accepts nothing else, so an acronym step at b[j] has one of these among
 * initialsKeys(b[j], b[j + 1]). Empty for a token that is not an acronym of 2–6 letters.
 */
export function acronymInitials(x: HebToken): string[] {
  const L = x.key;
  if (!x.acronym || L.length < 2 || L.length > 6) return [];
  const out = [`1${L[0]}${L[1]}`];
  if (L.length >= 3 && PREFIX_LETTERS.has(L[0]!)) out.push(`2${L[0]}${L[1]}${L[2]}`);
  return out;
}

/** The initials keys of word `y` followed by word `after` (see acronymInitials). */
export function initialsKeys(y: HebToken, after: HebToken | undefined): string[] {
  if (!after) return [];
  const out = [`1${y.key[0]}${after.key[0]}`];
  if (y.key.length >= 2) out.push(`2${y.key[0]}${y.key[1]}${after.key[0]}`);
  return out;
}

/** The stem itself, its 1-deletion variants from 3 letters, its 2-deletion variants from 5 letters. */
function deletionVariants(s: string): string[] {
  const out = new Set<string>([s]);
  if (s.length >= 3) {
    for (let i = 0; i < s.length; i++) {
      const d1 = s.slice(0, i) + s.slice(i + 1);
      out.add(d1);
      if (s.length >= 5) for (let j = i; j < d1.length; j++) out.add(d1.slice(0, j) + d1.slice(j + 1));
    }
  }
  return [...out];
}
