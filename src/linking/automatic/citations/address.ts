import { numeralOf, strictValue, type Numeral } from "./numbers";
import type { Tok } from "./text";

/*
 * The LOCATION part of a citation, read from the tokens after a book name: "פרק ג פסוק ד", "פ"ג ה"א",
 * "סי' רפ"ח ס"ד", "דף כ"ג ע"א", "כג.", "(ל"ד א')", "א, ב", "א׳:כ׳", "יב, ז-ט". The parse is NEUTRAL: it
 * does not know the target book yet, so a bare numeral stays kind "?" and a daf's side stays a
 * separate fact; resolve.ts interprets the elements against each candidate book's scheme
 * (daf/amud for the Bavli, chapter/verse for Tanakh, siman/seif for the Shulchan Aruch…).
 *
 * Markers are matched on the word as written (quote marks normalised): "ס'" (סימן or סעיף?) and a bare
 * "ד'" not followed by a numeral are NOT markers, and a compact "ס"ד" is a seif only after a siman.
 */

export type Kind = "perek" | "pasuk" | "siman" | "seif" | "sk" | "halacha" | "mishna" | "daf" | "os" | "mizmor" | "chelek" | "?";

export interface AddrElem {
  readonly kind: Kind;
  readonly n: number;
  /** last number of a range written "א-ג" on this element */
  readonly to?: number;
  /** daf only: 1 = עמוד א, 2 = עמוד ב (from "." / ":" / ע"א / עמוד ב / a following א'/ב') */
  readonly amud?: 1 | 2;
  /** written with a marker word (פרק, סי', דף…) or a compact marker (פ"ג, ה"א, סק"ב) */
  readonly explicit: boolean;
  readonly numeral: Numeral;
  /** a bare "א"/"ב" (or "א'") right after a numeral: an amud for a daf book, else a plain number */
  readonly maybeAmud?: 1 | 2;
  /** the amud came from a "."/":" glued to the numeral — for a book without dafim it is punctuation */
  readonly amudGlued?: boolean;
}

export interface Address {
  readonly elems: readonly AddrElem[];
  /** index of the first token of the address (an opening bracket included) */
  readonly from: number;
  /** index just past the last token of the location (a closing bracket NOT included) */
  readonly to: number;
  /** the address sits inside brackets that open right after the book name */
  readonly bracketed: boolean;
  /** brackets around the location close right after it: "(בראשית א, ב)" or "ב"ק (דף ט:)" */
  readonly closed: boolean;
  /** how strongly the tokens say "this is a location" */
  readonly evidence: "strong" | "medium" | "weak";
}

const WORD_MARKERS: Readonly<Record<string, Kind>> = {
  פרק: "perek", "פ'": "perek", "פר'": "perek", פרקים: "perek",
  פסוק: "pasuk", "פס'": "pasuk", פסוקים: "pasuk",
  סימן: "siman", "סי'": "siman", "סימ'": "siman", סימנים: "siman",
  סעיף: "seif", "סע'": "seif", "סעי'": "seif", סעיפים: "seif",
  'ס"ק': "sk", "סק'": "sk", "סעיף קטן": "sk",
  הלכה: "halacha", "הל'": "halacha", הלכות: "halacha",
  משנה: "mishna", "מש'": "mishna",
  דף: "daf", "ד'": "daf", דפים: "daf",
  אות: "os", "או'": "os",
  מזמור: "mizmor",
  // "ח'" is not a marker: "ח' ע"א" is daf 8
  חלק: "chelek",
};

/** words that may precede a marker without breaking the address ("מ"ב סוף סי' ק"ו") */
const POSITION_WORDS = new Set(["סוף", "ריש", "תחלת", "תחילת", "רוש"]);

const shape = (t: Tok): string => {
  let s = t.gershayimAt > 0 ? `${t.text.slice(0, t.gershayimAt)}"${t.text.slice(t.gershayimAt)}` : t.text;
  if (t.geresh) s += "'";
  return s;
};

/** A marker word at toks[i] (one or two tokens), or null. */
function markerAt(toks: readonly Tok[], i: number): { kind: Kind; width: number } | null {
  const t = toks[i];
  if (!t || t.kind !== "word") return null;
  const s = shape(t);
  const two = toks[i + 1]?.kind === "word" ? WORD_MARKERS[`${s} ${shape(toks[i + 1]!)}`] : undefined;
  if (two) return { kind: two, width: 2 };
  const one = WORD_MARKERS[s];
  return one ? { kind: one, width: 1 } : null;
}

/**
 * A compact marker+numeral in ONE word: פ"ג, פי"א, פ"ק (= פרק קמא), ה"א, הי"ב, מ"ד (משנה, only after a
 * perek), ס"ד (סעיף, only after a siman), סק"ב / ס"ק ב (handled as a word marker).
 */
function compactAt(t: Tok | undefined, prev: Kind | null): { kind: Kind; n: number } | null {
  if (!t || t.kind !== "word" || !t.gershayim || t.geresh || t.gershayimAt !== t.text.length - 1) return null;
  const tryPrefix = (prefix: string, kind: Kind): { kind: Kind; n: number } | null => {
    if (!t.text.startsWith(prefix) || t.text.length <= prefix.length) return null;
    const rest = t.text.slice(prefix.length);
    if (kind === "perek" && rest === "ק") return { kind, n: 1 }; // פ"ק = פרק קמא
    const n = strictValue(rest);
    return n === null ? null : { kind, n };
  };
  return (
    tryPrefix("פ", "perek") ??
    tryPrefix("ה", "halacha") ??
    tryPrefix("סק", "sk") ??
    (prev === "perek" ? tryPrefix("מ", "mishna") : null) ??
    (prev === "siman" ? tryPrefix("ס", "seif") : null)
  );
}

/** "ע"א" / "ע"ב" (one word), "עמוד א", "עמ' ב" at toks[i] → [amud, tokens]. */
function amudAt(toks: readonly Tok[], i: number): [1 | 2, number] | null {
  const t = toks[i];
  if (!t || t.kind !== "word") return null;
  if (t.gershayim && !t.geresh && t.text.length === 2 && t.text[0] === "ע" && (t.text[1] === "א" || t.text[1] === "ב")) return [t.text[1] === "א" ? 1 : 2, 1];
  const s = shape(t);
  if (s === "עמוד" || s === "עמ'") {
    const n = toks[i + 1];
    if (n?.kind === "word" && !n.gershayim && (n.text === "א" || n.text === "ב")) return [n.text === "א" ? 1 : 2, 2];
  }
  return null;
}

const isPunct = (t: Tok | undefined, chars: string): boolean => t?.kind === "punct" && chars.includes(t.text);
const OPEN = "([{";
const CLOSE = ")]}";

/**
 * Reads an address starting at toks[i]. Returns null when there is no location there, or when the
 * only evidence is one bare numeral outside brackets (a word like "שמות ה'" or "בראשית ברא").
 */
export function parseAddress(toks: readonly Tok[], i: number, opts: { enclosed?: boolean } = {}): Address | null {
  let j = i;
  let bracketed = false;
  if (isPunct(toks[j], OPEN)) {
    bracketed = true;
    j++;
  } else if (isPunct(toks[j], ",") && toks[j + 1]?.kind !== "punct") j++; // "שבת, דף כג"
  const elems: AddrElem[] = [];
  let lastKind: Kind | null = null;
  let separators = 0;
  let to = j;
  for (;;) {
    const t = toks[j];
    if (!t) break;
    if (elems.length && isPunct(t, ",:;") && !isPunct(toks[j + 1], ",:;.")) {
      // a separator between two elements; it is consumed only if an element follows
      const next = readElem(toks, j + 1, lastKind);
      if (!next) break;
      separators++;
      j++;
      continue;
    }
    if (t.kind === "word" && POSITION_WORDS.has(t.text) && markerAt(toks, j + 1)) {
      j++;
      continue;
    }
    const e = readElem(toks, j, lastKind);
    if (!e) break;
    elems.push(e.elem);
    lastKind = e.elem.kind === "?" ? lastKind : e.elem.kind;
    j = e.next;
    to = j;
    if (elems.length >= 4) break;
  }
  if (!elems.length) return null;
  const strongTok = elems.some((e) => e.explicit || e.numeral.form !== "bare" || e.amud !== undefined);
  const commonOnly = elems.every((e) => e.numeral.common && !e.explicit);
  // brackets count only when they close right after the location: "(בראשית ב א)", "נדרים (כ ב)"
  const closed = (bracketed || !!opts.enclosed) && isPunct(toks[to], CLOSE);
  // two numerals in a row ("ברכות נה א") are evidence too, unless one of them is an everyday word
  const pair = elems.length >= 2 && (separators > 0 || !elems.some((e) => e.numeral.common));
  let evidence: Address["evidence"] = strongTok ? "strong" : closed || pair ? "medium" : "weak";
  if (commonOnly && !closed) evidence = "weak";
  // a single bare numeral outside brackets ("שמות ה'", "דברים רבה") is not a location
  if (evidence === "weak") return null;
  // "(בראשית א, ב" with no closing bracket is fine; the span ends at the last element either way
  return { elems, from: i, to, bracketed, closed, evidence };
}

/** One element at toks[j]: a marker + numeral, a compact marker, a daf, or a bare numeral. */
function readElem(toks: readonly Tok[], j: number, prev: Kind | null): { elem: AddrElem; next: number } | null {
  const t = toks[j];
  if (!t) return null;
  // "פ"ח ע"א" after a tractate is daf 88, not chapter 8
  // and "ס"ק" is a marker word, not seif 100
  const compact = (amudAt(toks, j + 1) && numeralOf(t)) || markerAt(toks, j) ? null : compactAt(t, prev);
  if (compact) {
    const numeral: Numeral = { n: compact.n, form: "gershayim", common: false };
    return withRange(toks, j + 1, { kind: compact.kind, n: compact.n, explicit: true, numeral });
  }
  const m = markerAt(toks, j);
  // "ד' ע"א" is daf 4 side a, not "דף ע"א"
  if (m && !amudAt(toks, j + m.width)) {
    const k = j + m.width;
    const num = numeralOf(toks[k]);
    if (!num) return null;
    if (m.kind === "daf") return readDaf(toks, k, num, true);
    return withRange(toks, k + 1, { kind: m.kind, n: num.n, explicit: true, numeral: num });
  }
  const num = numeralOf(t);
  if (!num) return null;
  // glued "." / ":" right after a bare numeral (or digits) is an amud (כג. / כג:), unless another
  // numeral is glued after it ("ח:ח", Sefaria's chapter:verse)
  const after = toks[j + 1];
  if ((num.form === "bare" || num.form === "digits") && isPunct(after, ".:") && after!.glued) {
    const glueNext = toks[j + 2];
    if (!(glueNext?.glued && numeralOf(glueNext))) return readDaf(toks, j, num, false);
  }
  if (amudAt(toks, j + 1)) return readDaf(toks, j, num, false);
  return withRange(toks, j + 1, { kind: "?", n: num.n, explicit: false, numeral: num });
}

/** A daf numeral at toks[k] and its side: "כג." "כג:" "כ"ג ע"א" "כג עמוד ב" "כ ב" "ל"ד א'". */
function readDaf(toks: readonly Tok[], k: number, num: Numeral, marker: boolean): { elem: AddrElem; next: number } {
  let next = k + 1;
  let amud: 1 | 2 | undefined;
  let maybeAmud: 1 | 2 | undefined;
  let glued = false;
  const after = toks[next];
  if ((num.form === "bare" || num.form === "digits") && isPunct(after, ".:") && after!.glued) {
    amud = after!.text === "." ? 1 : 2;
    glued = true;
    next++;
  } else {
    const a = amudAt(toks, next);
    if (a) {
      amud = a[0];
      next += a[1];
    } else {
      const s = toks[next];
      // "נה א" / "ל"ד א'": a lone א/ב after the daf — an amud for a daf book, a number otherwise
      if (s?.kind === "word" && !s.gershayim && (s.text === "א" || s.text === "ב") && !numeralOf(toks[next + 1])) {
        maybeAmud = s.text === "א" ? 1 : 2;
        next++;
      }
    }
  }
  const elem: AddrElem = {
    kind: marker || amud !== undefined ? "daf" : "?",
    n: num.n,
    explicit: marker,
    numeral: num,
    ...(amud !== undefined && { amud }),
    ...(maybeAmud !== undefined && { maybeAmud }),
    ...(glued && { amudGlued: true }),
  };
  return { elem, next };
}

/** "א-ג" / "א - ג": a range on the element just read. */
function withRange(toks: readonly Tok[], next: number, elem: AddrElem): { elem: AddrElem; next: number } {
  if (isPunct(toks[next], "-")) {
    const end = numeralOf(toks[next + 1]);
    if (end && end.n > elem.n && end.n - elem.n <= 50) return { elem: { ...elem, to: end.n }, next: next + 2 };
  }
  return { elem, next };
}

/** A closing bracket right after the address (it is not part of the anchored span). */
export const closesAt = (toks: readonly Tok[], i: number): boolean => isPunct(toks[i], CLOSE);
export const opensAt = (toks: readonly Tok[], i: number): boolean => isPunct(toks[i], OPEN);
