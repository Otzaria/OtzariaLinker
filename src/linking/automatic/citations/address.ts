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

export type Kind = "perek" | "pasuk" | "siman" | "seif" | "sk" | "halacha" | "mishna" | "daf" | "os" | "mizmor" | "chelek" | SectionKind | "?";

/**
 * The levels books name in their own headings beyond the classic ones ("כלל", "שער", "רמז", "תשובה"…):
 * a citation names them ("חכמת אדם כלל ז סי' ג", "לעיל כלל ה"), and a book's own structure says
 * which of its levels they are (self.ts, resolve.ts).
 */
export type SectionKind = "klal" | "shaar" | "maamar" | "remez" | "piska" | "drush" | "teshuva";

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
  /** read from a compact marker word (פ"ט, ה"א) */
  readonly compact?: boolean;
  /** a compact "פ"ו" that is also the plain number 86 (for a book of chapters, either may be meant) */
  readonly alsoNumber?: number;
  /** read with a marker added in V4 ("ס"ס", "ססי'", "כלל", "שער", "ח"א", "ה'" after a chapter): for the measurement's tally */
  readonly v4?: true;
  /**
   * read after "פ'", which is also the numeral 80: "תה' פ' ב" is chapter 2, or Psalm 80 verse 2 — the engine
   * tries both readings in the cited book (engine.ts, alternativeReading)
   */
  readonly afterPeh?: true;
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
  // "פ'" is פרק or פסוק (אבן עזרא: "שם פ' י"): a number without a kind, but written as a location
  פרק: "perek", "פ'": "?", "פר'": "perek", פרקים: "perek",
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
  // "ס"ס קכ"ח", "ססי' א'", "רס"י ה'": the end / start of a siman — the siman
  'ס"ס': "siman", "ססי'": "siman", 'סוס"י': "siman", 'רס"י': "siman", "רסי'": "siman",
  כלל: "klal", שער: "shaar", מאמר: "maamar", רמז: "remez", פסקה: "piska", דרוש: "drush", תשובה: "teshuva",
};
/** the markers added in V4 (for the measurement's tally of new forms) */
const V4_MARKERS = new Set(['ס"ס', "ססי'", 'סוס"י', 'רס"י', "רסי'", "כלל", "שער", "מאמר", "רמז", "פסקה", "דרוש", "תשובה"]);

/** own keys only: a token like "constructor" is not a marker (security review A10) */
const marker = (s: string): Kind | undefined => (Object.hasOwn(WORD_MARKERS, s) ? WORD_MARKERS[s] : undefined);

/** words that may precede a marker without breaking the address ("מ"ב סוף סי' ק"ו") */
const POSITION_WORDS = new Set(["סוף", "ריש", "תחלת", "תחילת", "רוש"]);

const shape = (t: Tok): string => {
  let s = t.gershayimAt > 0 ? `${t.text.slice(0, t.gershayimAt)}"${t.text.slice(t.gershayimAt)}` : t.text;
  if (t.geresh) s += "'";
  return s;
};

/** A marker word at toks[i] (one or two tokens), or null. */
function markerAt(toks: readonly Tok[], i: number): { kind: Kind; width: number; v4?: true } | null {
  const t = toks[i];
  if (!t || t.kind !== "word") return null;
  const full = shape(t);
  // "בסימן", "ובסעיף", "בדף": a ב/ו/ד glued to the marker word
  for (let p = 0; p <= 2; p++) {
    if (p && !/^[ובד]$/.test(full[p - 1]!)) break;
    const s = full.slice(p);
    // "בד'" is not "in daf", but "בדף" is
    if (p && s.length < 3 && s !== "דף") break;
    const two = toks[i + 1]?.kind === "word" ? marker(`${s} ${shape(toks[i + 1]!)}`) : undefined;
    if (two) return { kind: two, width: 2 };
    const one = marker(s);
    if (one) return { kind: one, width: 1, ...(V4_MARKERS.has(s) && { v4: true }) };
  }
  return null;
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
    // "הל"א" is הלכה א, not ה + ל"א
    tryPrefix("הל", "halacha") ??
    tryPrefix("ה", "halacha") ??
    tryPrefix("סק", "sk") ??
    // "ח"א סי' ה", "זוה"ק ח"ב דף קנא": a part (חלק) — only before another element (parseAddress drops it last)
    (prev === null ? tryPrefix("ח", "chelek") : null) ??
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
export function parseAddress(toks: readonly Tok[], i: number, opts: { enclosed?: boolean; after?: Kind } = {}): Address | null {
  let j = i;
  let bracketed = false;
  if (isPunct(toks[j], OPEN)) {
    bracketed = true;
    j++;
  } else if (isPunct(toks[j], ",") && toks[j + 1]?.kind !== "punct") j++; // "שבת, דף כג"
  const elems: AddrElem[] = [];
  // "פ"ד דסוכה מ"ד": after a chapter given before the name, a compact מ"ד is mishna 4
  let lastKind: Kind | null = opts.after ?? null;
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
    // "סי' ג' וסי' ד'", "כלל ג' ובכלל ב'": a marker with "ו" opens a second place, not a deeper level
    if (elems.length && t.kind === "word" && t.text[0] === "ו" && markerAt(toks, j)) break;
    if (t.kind === "word" && POSITION_WORDS.has(t.text) && markerAt(toks, j + 1)) {
      j++;
      continue;
    }
    // "במנחות פ"ק (ז'.)": a daf in brackets after a chapter is where in it
    if (lastKind === "perek" && isPunct(t, OPEN)) {
      const d = readElem(toks, j + 1, lastKind);
      if (d && (d.elem.kind === "daf" || d.elem.amud !== undefined)) {
        j++;
        continue;
      }
    }
    const e = readElem(toks, j, lastKind);
    if (!e) break;
    // "תהילים קי"ט: פ"ט": after a number, a compact "פ"ט" is the number 89, not a chapter
    const asNumber = e.elem.compact && e.elem.kind === "perek" && elems.length ? numeralOf(toks[j]) : null;
    if (asNumber) elems.push({ kind: "?", n: asNumber.n, explicit: false, numeral: asNumber });
    else if (e.elem.compact && e.elem.kind === "perek" && !elems.length && numeralOf(toks[j])) elems.push({ ...e.elem, alsoNumber: numeralOf(toks[j])!.n });
    else elems.push(e.elem);
    lastKind = e.elem.kind === "?" ? lastKind : e.elem.kind;
    j = e.next;
    to = j;
    if (elems.length >= 4) break;
    // "דף מ"ד ת"ר", "ל"א ע"ב לא", "לקמן ה' ע"ב רב": a daf with its amud (or "דף X") is as deep as a
    // citation goes — the words after it are the quote, not more levels (only a marked level follows)
    const last = elems[elems.length - 1]!;
    if ((last.kind === "daf" || last.amud !== undefined) && !nextIsMarked(toks, j, lastKind)) break;
  }
  // "ח"ו" alone is "חס ושלום", not a part: a compact part counts only with a place inside it
  if (elems.length === 1 && elems[0]!.kind === "chelek" && elems[0]!.compact) return null;
  if (!elems.length) return null;
  // "תהילים פ"ט: ט'": a compact "פ"ט" followed by a plain number is the number 89, not "פרק ט"
  const f = elems[0]!;
  if (f.compact && f.kind === "perek" && elems[1]?.kind === "?") {
    const asNumber = numeralOf(toks[parsedFrom(toks, i)]);
    if (asNumber) elems[0] = { kind: "?", n: asNumber.n, explicit: false, numeral: asNumber };
  }
  // "פ"ה הכ"א": a marked level after it makes the compact "פ"ה" a chapter — the number 85 has no "הלכה" under it
  if (elems[0]!.alsoNumber !== undefined && elems[1]?.explicit) {
    const { alsoNumber: _n, ...chapter } = elems[0]!;
    elems[0] = chapter;
  }
  const strongTok = elems.some((e) => e.explicit || e.numeral.form !== "bare" || e.amud !== undefined);
  // "לקמן ה' ע"ב", "במ"ק כ' ע"ב": an amud written out (ע"א / ע"ב) makes even an everyday word a daf
  const commonOnly = elems.every((e) => e.numeral.common && !e.explicit && (e.amud === undefined || !!e.amudGlued));
  // brackets count only when they close right after the location: "(בראשית ב א)", "נדרים (כ ב)"
  const closed = (bracketed || !!opts.enclosed) && isPunct(toks[to], CLOSE);
  // two numerals in a row ("ברכות נה א", "בראשית מו א") are evidence too, unless one of them is an everyday
  // word outside brackets ("(בראשית מו א, ועיין שם עוד)", "בנדרים (לד ב, ד"ה …)" are places); a lone א/ב
  // after a numeral (maybeAmud) is the second of them
  const numerals = elems.length + elems.filter((e) => e.maybeAmud !== undefined).length;
  const pair = numerals >= 2 && (separators > 0 || bracketed || !!opts.enclosed || !elems.some((e) => e.numeral.common));
  let evidence: Address["evidence"] = strongTok ? "strong" : closed || pair ? "medium" : "weak";
  if (commonOnly && !closed) evidence = "weak";
  // a single bare numeral outside brackets ("שמות ה'", "דברים רבה") is not a location
  if (evidence === "weak") return null;
  // "(בראשית א, ב" with no closing bracket is fine; the span ends at the last element either way
  return { elems, from: i, to, bracketed, closed, evidence };
}

/** the first token of the location (after an opening bracket or a comma) */
function parsedFrom(toks: readonly Tok[], i: number): number {
  return isPunct(toks[i], OPEN) || isPunct(toks[i], ",") ? i + 1 : i;
}

/** One element at toks[j]: a marker + numeral, a compact marker, a daf, or a bare numeral. */
function readElem(toks: readonly Tok[], j: number, prev: Kind | null): { elem: AddrElem; next: number } | null {
  const t = toks[j];
  if (!t) return null;
  // "פ"ח ע"א" after a tractate is daf 88, not chapter 8
  // and "ס"ק" is a marker word, not seif 100
  // likewise "פ"ח:" (a "." or ":" glued after it)
  const gluedSide = isPunct(toks[j + 1], ".:") && toks[j + 1]!.glued && !(toks[j + 2]?.glued && numeralOf(toks[j + 2]));
  const compact = ((amudAt(toks, j + 1) || gluedSide) && numeralOf(t)) || markerAt(toks, j) ? null : compactAt(t, prev);
  if (compact) {
    const numeral: Numeral = { n: compact.n, form: "gershayim", common: false };
    return withRange(toks, j + 1, { kind: compact.kind, n: compact.n, explicit: true, numeral, compact: true, ...(compact.kind === "chelek" && { v4: true }) });
  }
  // "פ"ג ממע"ש (ה' י"ז)": after a chapter, "ה'" is "הלכה" (alone it is the number 5, or the divine name)
  if (prev === "perek" && t.kind === "word" && shape(t) === "ה'" && !amudAt(toks, j + 1)) {
    const num = numeralOf(toks[j + 1]);
    if (num) return withRange(toks, j + 2, { kind: "halacha", n: num.n, explicit: true, numeral: num, v4: true });
  }
  const m = markerAt(toks, j);
  // "בחולין (דף ע"ב)", "בב"ק דף ע"א": after the full word "דף", "ע"א"/"ע"ב" is daf 71/72 (an amud
  // follows only a number) — "ד' ע"א" stays daf 4 side a
  const ayin = m?.kind === "daf" && m.width === 1 && /דף$/.test(shape(t)) ? amudAt(toks, j + 1) : null;
  if (ayin && ayin[1] === 1) return readDaf(toks, j + 1, { n: 70 + ayin[0], form: "gershayim", common: false }, true);
  // "ד' ע"א" is daf 4 side a, not "דף ע"א"
  if (m && !amudAt(toks, j + m.width)) {
    const k = j + m.width;
    const num = numeralOf(toks[k]);
    // "(דניאל ד', כ"ד)": "ד'" with no numeral after it is the numeral 4, not "דף"
    if (!num && !(m.width === 1 && m.kind === "daf" && shape(t) === "ד'")) return null;
    if (num) {
      if (m.kind === "daf") return readDaf(toks, k, num, true);
      return withRange(toks, k + 1, { kind: m.kind, n: num.n, explicit: true, numeral: num, ...(m.v4 && { v4: true }), ...(shape(t) === "פ'" && { afterPeh: true }) });
    }
  }
  // "מנחות דמ"ג ע"ב", "ברכות די"ז ע"א", "ד"ז ע"א", "ביומא דנ"ד א'": a ד for "דף" glued to the number, before an amud
  // (written out, or a lone א/ב)
  const dalet = dafWithDalet(t);
  if (dalet && (amudAt(toks, j + 1) || amudLetter(toks, j + 1))) return readDaf(toks, j, dalet, true);
  const num = numeralOf(t);
  if (!num) return null;
  // glued "." / ":" right after a bare numeral (or digits) is an amud (כג. / כג:), unless another
  // numeral is glued after it ("ח:ח", Sefaria's chapter:verse)
  const after = toks[j + 1];
  if (sideMark(num, after, toks[j + 2])) {
    const glueNext = toks[j + 2];
    // a ":" after a quoted numeral and before another numeral is a separator ("קי"ט: פ"ט")
    const separator = glueNext && numeralOf(glueNext) && (glueNext.glued || (after!.text === ":" && num.form !== "bare" && num.form !== "digits"));
    if (!separator) return readDaf(toks, j, num, false);
  }
  if (amudAt(toks, j + 1) || commaAmud(toks, j + 1)) return readDaf(toks, j, num, false);
  return withRange(toks, j + 1, { kind: "?", n: num.n, explicit: false, numeral: num });
}

/**
 * A "." / ":" glued to a numeral marks the amud: after a bare numeral both do ("כג.", "כג:"); after a
 * quoted one only ":" ("מ"א:", "ט':"), since "כ"ג." is far more often the end of a sentence.
 */
function sideMark(num: Numeral, after: Tok | undefined, afterThat?: Tok): boolean {
  if (!after || !after.glued || !isPunct(after, ".:")) return false;
  // …and "." too when a closing bracket follows at once ("(כ'.)", "(שבת י"א.)"): no sentence ends there
  return num.form === "bare" || num.form === "digits" || after.text === ":" || isPunct(afterThat, CLOSE);
}

/** A daf numeral at toks[k] and its side: "כג." "כג:" "כ"ג ע"א" "כג עמוד ב" "כ ב" "ל"ד א'". */
function readDaf(toks: readonly Tok[], k: number, num: Numeral, marker: boolean): { elem: AddrElem; next: number } {
  let next = k + 1;
  let amud: 1 | 2 | undefined;
  let maybeAmud: 1 | 2 | undefined;
  let glued = false;
  const after = toks[next];
  if (sideMark(num, after, toks[next + 1])) {
    amud = after!.text === "." ? 1 : 2;
    glued = true;
    next++;
  } else {
    // "ברכות ל"ג, ע"א"
    if (commaAmud(toks, next)) next++;
    const a = amudAt(toks, next);
    if (a) {
      amud = a[0];
      next += a[1];
    } else {
      // "נה א" / "ל"ד א'": a lone א/ב after the daf — an amud for a daf book, a number otherwise
      const letter = amudLetter(toks, next);
      if (letter) {
        maybeAmud = letter;
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

/** a lone א/ב (maybe with a geresh) that ends the numbers: an amud after a daf ("נה א", "ל"ד א'") */
function amudLetter(toks: readonly Tok[], i: number): 1 | 2 | null {
  const s = toks[i];
  if (s?.kind !== "word" || s.gershayim || (s.text !== "א" && s.text !== "ב") || numeralOf(toks[i + 1])) return null;
  return s.text === "א" ? 1 : 2;
}

/** ", ע"א" — a comma between a daf and its amud ("ברכות ל"ג, ע"א") */
const commaAmud = (toks: readonly Tok[], i: number): boolean => isPunct(toks[i], ",") && !!amudAt(toks, i + 1);

/** after a daf: the next element (past a separator) carries a marker of its own */
function nextIsMarked(toks: readonly Tok[], j: number, prev: Kind | null): boolean {
  const at = isPunct(toks[j], ",:;") ? j + 1 : j;
  return !!readElem(toks, at, prev)?.elem.explicit;
}

/**
 * "דמ"ג", "די"ז", "דקנ"א", "ד"ז": the letter ד ("דף") glued to a daf number that is canonical without
 * it (the whole word is no numeral: "דמ"ג" would be 47). "ד"ה" is דיבור המתחיל.
 */
function dafWithDalet(t: Tok): Numeral | null {
  if (t.kind !== "word" || !t.gershayim || t.geresh || t.text[0] !== "ד" || t.gershayimAt !== t.text.length - 1 || t.key === "דה") return null;
  if (numeralOf(t)) return null;
  const n = strictValue(t.text.slice(1));
  return n && n >= 2 ? { n, form: "gershayim", common: false } : null;
}

/** "א-ג" / "א - ג": a range on the element just read. */
function withRange(toks: readonly Tok[], next: number, elem: AddrElem): { elem: AddrElem; next: number } {
  if (isPunct(toks[next], "-")) {
    const end = numeralOf(toks[next + 1]);
    if (end && end.n > elem.n && end.n - elem.n <= 50) return { elem: { ...elem, to: end.n }, next: next + 2 };
  }
  return { elem, next };
}

/** "ע"ב", "עמוד א" alone at toks[i] (an amud with no daf: "ושם ע"ב") → [amud, tokens], or null. */
export const amudOnlyAt = (toks: readonly Tok[], i: number): [1 | 2, number] | null => amudAt(toks, i);

/** A closing bracket right after the address (it is not part of the anchored span). */
export const closesAt = (toks: readonly Tok[], i: number): boolean => isPunct(toks[i], CLOSE);
export const opensAt = (toks: readonly Tok[], i: number): boolean => isPunct(toks[i], OPEN);
