/*
 * The Dibur Hamatchil (ד"ה) of a commentary line: the opening words that quote the base text.
 * Ported from otzaria-link-generator `extractDiburHamatchil`, `stripSecondaryPrefix`,
 * `stripLeadingMarkers`, `isBaadContinuationLine` (parserAlgorithm.ts @7ad8b2c) and the BOLD
 * format of SeforimLibrary's DhExtractor (idea only), reshaped to work on TOKENS that keep their
 * raw offsets — the extracted ד"ה is a list of positions in the untouched line, never a rewritten
 * string.
 *
 * Boundaries, strongest first:
 *   bold        the line opens with <b>…</b> / <strong>…</strong> (רש"י, תוספות and most printed
 *               commentaries) — the bold run is the ד"ה;
 *   etc         "וכו'", "כו'", "וגו'", "וגומר", "וכולי" — the quote stops there; the words after it
 *               (up to the next boundary) are a resumed quote ("continuation");
 *   punctuation a period / colon / semicolon / sof pasuq after a word;
 *   dash        a dash with a space on at least one side (a maqaf inside a word is not a dash).
 * Without any boundary the first `maxWords` words are the ד"ה and it is NOT explicit.
 *
 * Pointer words that only say WHERE to look are removed from the start, to a fixed point
 * (link-generator BUG-04): a bracketed number "(א)", "ד"ה"/"בד"ה", "רש"י ד"ה"/"תוס' ד"ה"/"תוד"ה",
 * "גמ'"/"בגמרא"/"מתני'"/"פיסקא", and a bare "שם" before other text. A line that opens with
 * "בא"ד"/"א"ד" (optionally after "שם") continues the previous line; a line that is only "שם" means
 * "the same place".
 *
 * Added for the owner's requirements (otzaria-library docs/דרישות-סקריפט-התאמת-דיבור-המתחיל.md):
 *   • WHOSE words the line quotes (`addressee`, ./addressee.ts, §2): "רש"י ד"ה" / "<b>שם תוס'</b>
 *     בד"ה" / "תוד"ה" name an intermediate commentator; "גמ'" / "גמרא" / "מתני'" / a bold "משנה"
 *     label name the base text; a bare "ד"ה" / "בד"ה" continues whoever was named last;
 *   • a bold label that only says "this continues" — "<b>שוב</b>", "<b>עוד</b>", "<b>והנה</b>",
 *     "<b>ונלע"ד</b>"… (§3) — and a line opening "עוד שם" / "עוד כתב" / "שוב כתב": kind
 *     "continuation", the previous line's place; unless a new bold quote follows the label;
 *   • an attribution before the quote (§15): "אר"ה כו' X" — the quote is X, not אמר רב הונא;
 *   • "ד"ה X … עד ד"ה Y" (§7): the ד"ה stops before "עד", and Y is the `range` end.
 */
import type { EngineLine } from "../types";
import { headingLevel } from "../../../core/text/html";
import { hebrewTokens, visibleSlice, type HebToken } from "../../../matching/hebrew-tokens";
import { commentatorOfGlued, commentatorOfToken, type Commentator } from "./addressee";
import { fromGematria, toGematria } from "../../../core/text/gematria";

export type DhLineKind = "dh" | "baad" | "sham" | "continuation" | "heading" | "empty";
export type DhBoundary = "bold" | "etc" | "range" | "punctuation" | "dash" | "none";

/**
 * Whose words the line quotes, as far as the line itself says: an intermediate commentator it names
 * ("named"), the base text by a label ("text"), or a bare ד"ה that names nobody ("bare").
 */
export type DhAddressee = { readonly kind: "named"; readonly commentator: Commentator } | { readonly kind: "text" } | { readonly kind: "bare" };

export interface ExtractedDh {
  readonly kind: DhLineKind;
  /** every word token of the line */
  readonly tokens: readonly HebToken[];
  /** index in `tokens` where the ד"ה starts (after the pointer words) */
  readonly from: number;
  /** the ד"ה (first segment, at most `maxWords` words) */
  readonly dh: readonly HebToken[];
  /** a resumed quote after "כו'" (at most `maxWords` words), else empty */
  readonly continuation: readonly HebToken[];
  /** the line itself marks where the ד"ה ends */
  readonly explicit: boolean;
  readonly boundary: DhBoundary;
  /** pointer words removed from the start, as written */
  readonly stripped: readonly string[];
  /** the ד"ה as written in the line (tags removed) */
  readonly text: string;
  /** whose words the line quotes, when it says so (null: it does not) */
  readonly addressee: DhAddressee | null;
  /** the end ד"ה of "ד"ה X … עד ד"ה Y" (Y), else empty */
  readonly range: readonly HebToken[];
  /** an attribution skipped before the quote ("אר"ה" of "אר"ה כו' X"), as written */
  readonly attribution: string | null;
  /** the line opens with bold (the usual mark of a ד"ה) */
  readonly bold: boolean;
  /**
   * a bold run of one or two words that the line's own punctuation continues ("<b>אפי' </b>נשים."):
   * the ד"ה up to that punctuation — printers often bold only the first word (dibur_matcher.py
   * extract_fresh_quote). Tried before the bold words alone. Else empty.
   */
  readonly extended: readonly HebToken[];
  /** a seif the line names before its quote — "(סעיף ה')", "<b>ס"ק ג</b>" — as kind and number, else null */
  readonly unit: { readonly kind: string; readonly n: number } | null;
}

export const DEFAULT_MAX_DH_WORDS = 12;

const ETC = new Set(["כו", "וכו", "וגו"]);
const ETC_FULL = new Set(["וכולי", "וגומר", "וגומרא"]);
const DH_MARK = new Set(["דה", "בדה"]);
const DH_GLUED = new Set(["תודה", "בתודה", "רשדה", "ברשדה"]);
const SOURCE_NAMES = new Set(["רשי", "ברשי", "פרשי", "בפרשי", "פירשי", "בפירשי", "תוס", "בתוס", "תוספות", "בתוספות", "תוספת", "בתוספת"]);
const POINTERS_TRUNC = new Set(["גמ", "בגמ", "מתני", "במתני"]);
const POINTERS_FULL = new Set(["גמרא", "בגמרא", "מתניתין", "במתניתין", "פיסקא", "בפיסקא"]);
const BAAD = new Set(["באד", "אד", "באוד", "אוד"]);

const isEtc = (t: HebToken) => (ETC.has(t.key) && t.truncated) || ETC_FULL.has(t.key);
const isDhMark = (t: HebToken | undefined) => !!t && DH_MARK.has(t.key) && t.acronym;
const isBaad = (t: HebToken | undefined) => !!t && BAAD.has(t.key) && t.acronym;

const PUNCT_RE = /[.:;׃]/;
/** a dash with whitespace on at least one side ("כל־האדם" has a maqaf, not a dash) */
const DASH_RE = /\s[-–—־]|[-–—־]\s/;
const BOLD_OPEN_RE = /^\s*(?:[([][^)\]<]{0,8}[)\]]\s*)?<(b|strong)\b[^>]*>/i;

/** Visible text between two raw offsets. */
const gap = (html: string, from: number, to: number) => visibleSlice(html, from, to);

function emptyResult(kind: DhLineKind, tokens: readonly HebToken[] = [], stripped: readonly string[] = [], addressee: DhAddressee | null = null, bold = false): ExtractedDh {
  return { kind, tokens, from: tokens.length, dh: [], continuation: [], explicit: false, boundary: "none", stripped, text: "", addressee, range: [], attribution: null, bold, extended: [], unit: null };
}

/** Bold labels that only say "this continues the previous line" (requirements §3; dibur_matcher.py PURE_CONTINUATION_LABELS). */
const OPENER_LABELS = new Set(["שוב", "עוד", "ועוד", "והנה", "אמנם", "וכן", "ונלעד", "ונלענד", "ובזה", "אכן", "ודע", "וראיתי", "ולפז", "ונל", "עוד שמ", "עוד כתב", "שוב כתב", "שוב ראיתי"]);
/** Openings that continue the previous line when written as plain text. */
const OPENER_PHRASES: readonly (readonly string[])[] = [["עוד", "שמ"], ["עוד", "כתב"], ["שוב", "כתב"]];
/** "אר"ה", "א"ר", "ת"ר", "ת"ש", "תנ"ה": who says it, not what is said (requirements §15) */
const ATTRIBUTION_RE = /^ו?(?:אר|אמר|תר|תש|תנ|תנו|מתיב|איתמ)[א-ת]{0,2}$/;
const isAttribution = (t: HebToken) => t.acronym && ATTRIBUTION_RE.test(t.key);
/** "משנה" / "במשנה" / "ברייתא" as a bold label of their own: the base text, not a quoted word */
const TEXT_LABELS = new Set(["משנה", "במשנה", "ברייתא", "בברייתא", "מתניתא"]);

/** "(סעיף ה')", "[ס"ק ג]", "<b>סעיף ה'.</b>" at the start of a line: the seif it names. */
const UNIT_LABEL_RE = /^\s*(?:<[^>]*>\s*)*[([]?\s*(סעיף|סעי['׳]|ס["״]ק|סק)\s+([א-ת]{1,3})['׳"״]?\s*[)\]]?/;
function unitLabel(m: RegExpExecArray): { kind: string; n: number } | null {
  const n = fromGematria(m[2]!);
  if (n === null || n <= 0 || toGematria(n) !== m[2]!.replace(/ך/g, "כ").replace(/ם/g, "מ").replace(/ן/g, "נ").replace(/ף/g, "פ").replace(/ץ/g, "צ")) return null;
  return { kind: m[1]!.startsWith("ס\"") || m[1]!.startsWith("ס״") || m[1] === "סק" ? "סעיף קטן" : "סעיף", n };
}

/** Where the bold run opened at `from` (the index just past its opening tag) closes, counting nested same-name tags; -1 if never. */
function boldClose(html: string, from: number, tagName: string): number {
  const tag = new RegExp(`<(/?)${tagName}(?![a-z])[^>]*>`, "gi");
  tag.lastIndex = from;
  let depth = 1;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return -1;
}

/**
 * How many tokens at the start of a line are a bracketed number — "(א)", "[ב]", "(יז)", "א)" —
 * that numbers the line rather than saying anything (verse numbers in תנ"ך lines, item numbers in
 * commentaries). Used on both sides of the search.
 */
export function leadingMarkerTokens(html: string, tokens: readonly HebToken[]): number {
  if (!tokens.length) return 0;
  const opened = /[([]\s*$/.test(gap(html, 0, tokens[0]!.rawStart));
  for (let k = 0; k < Math.min(2, tokens.length); k++) {
    const after = gap(html, tokens[k]!.rawEnd, tokens[k + 1]?.rawStart ?? html.length).trimStart();
    if (/^[)\]]/.test(after) && (opened || (k === 0 && tokens[0]!.key.length <= 3))) return k + 1;
    if (!opened) break;
  }
  return 0;
}

/**
 * Extracts the ד"ה of one commentary line. Pure: works on the line's tokens, never edits the text.
 * Accepts the raw line text or an EngineLine.
 */
export function extractDh(line: string | Pick<EngineLine, "text" | "heading">, maxWords = DEFAULT_MAX_DH_WORDS): ExtractedDh {
  const html = typeof line === "string" ? line : line.text;
  const heading = typeof line === "string" ? headingLevel(html) : (line.heading ?? headingLevel(html));
  if (heading !== null) return emptyResult("heading");
  const tokens = hebrewTokens(html);
  if (!tokens.length) return emptyResult("empty");

  // bold run at the very start (after an optional bracketed number); the matching close tag counts
  // nested same-name tags (רש"י on the ש"ס opens "<b><b></b>…")
  const bm = BOLD_OPEN_RE.exec(html);
  let boldEnd = bm ? boldClose(html, bm[0].length, bm[1]!) : -1;

  const unitMatch = UNIT_LABEL_RE.exec(html);
  const unit = unitMatch ? unitLabel(unitMatch) : null;
  let p = leadingMarkerTokens(html, tokens);
  // the seif label is a pointer, not a quote: "(סעיף ה')" / "<b>סעיף ה'</b>"
  if (unit) while (p < tokens.length && tokens[p]!.rawEnd <= unitMatch![0].length) p++;

  // pointer words, to a fixed point
  const stripped: string[] = [];
  const take = (n: number) => {
    stripped.push(visibleSlice(html, tokens[p]!.rawStart, tokens[p + n - 1]!.rawEnd));
    p += n;
  };
  let kind: DhLineKind = "dh";
  let addressee: DhAddressee | null = null;
  const bold = boldEnd >= 0;
  /** tokens[k] is the last word inside the current bold run (a bold label of its own) */
  const endsBold = (k: number) => boldEnd > tokens[k]!.rawStart && (tokens[k + 1]?.rawStart ?? Infinity) >= boldEnd;
  // a bold label that only continues: "<b>שוב</b> ראיתי", "<b>עוד כתב</b>"
  if (p < tokens.length && boldEnd > tokens[p]!.rawStart) {
    let k = p;
    if (tokens[k]!.key === "שמ" && !endsBold(k)) k++;
    for (const n of [2, 1]) {
      if (k + n > tokens.length || !endsBold(k + n - 1)) continue;
      if (!OPENER_LABELS.has(tokens.slice(k, k + n).map((t) => t.key).join(" "))) continue;
      p = k;
      take(n);
      // a new bold quote right after the label is a ד"ה of its own (dibur_matcher.py "fresh quote")
      const after = html.indexOf(">", boldEnd) + 1;
      const fresh = /^(\s|[.,:;])*<(b|strong)\b[^>]*>/i.exec(html.slice(after));
      if (!fresh || p >= tokens.length) return { ...emptyResult("continuation", tokens, stripped, null, bold), from: p };
      boldEnd = boldClose(html, after + fresh[0].length, fresh[2]!);
      break;
    }
  }
  if (OPENER_PHRASES.some((ph) => ph.every((w, i) => tokens[p + i]?.key === w && !tokens[p + i]!.acronym))) {
    take(2);
    return { ...emptyResult("continuation", tokens, stripped, null, bold), from: p };
  }
  for (let pass = 0; pass < 6 && p < tokens.length; pass++) {
    const t = tokens[p]!;
    const next = tokens[p + 1];
    const named = commentatorOfToken(t);
    if (named && isDhMark(next)) {
      addressee = { kind: "named", commentator: named };
      take(2);
      continue;
    }
    const glued = commentatorOfGlued(t);
    if (glued) {
      addressee = { kind: "named", commentator: glued };
      take(1);
      continue;
    }
    if (isBaad(t)) {
      kind = "baad";
      take(1);
      break;
    }
    if (t.key === "שמ") {
      if (isBaad(next)) {
        kind = "baad";
        take(2);
        break;
      }
      if (isDhMark(next)) {
        addressee ??= { kind: "bare" };
        take(2);
        continue;
      }
      if (p + 1 >= tokens.length) kind = "sham";
      take(1);
      continue;
    }
    if (isDhMark(t) || (DH_GLUED.has(t.key) && t.acronym)) {
      addressee ??= { kind: "bare" };
      take(1);
      continue;
    }
    if (SOURCE_NAMES.has(t.key) && isDhMark(next)) {
      take(2);
      continue;
    }
    if ((POINTERS_TRUNC.has(t.key) && t.truncated) || POINTERS_FULL.has(t.key) || (TEXT_LABELS.has(t.key) && (endsBold(p) || t.key.startsWith("ב")) && p + 1 < tokens.length)) {
      addressee = { kind: "text" };
      take(1);
      continue;
    }
    break;
  }
  if (kind === "baad" || kind === "sham") return emptyResult(kind, tokens, stripped, addressee, bold);
  if (p >= tokens.length) return emptyResult("empty", tokens, stripped, addressee, bold);
  // "אר"ה כו' X": the quote is X (requirements §15)
  let attribution: string | null = null;
  {
    let k = p;
    while (k < tokens.length && k < p + 3 && isAttribution(tokens[k]!)) k++;
    if (k > p && tokens[k] && isEtc(tokens[k]!) && k + 1 < tokens.length) {
      attribution = visibleSlice(html, tokens[p]!.rawStart, tokens[k - 1]!.rawEnd);
      take(k + 1 - p);
    }
  }

  // the ד"ה: up to the first boundary
  let end = p;
  let boundary: DhBoundary = "none";
  let contFrom = -1;
  const inBold = boldEnd > tokens[p]!.rawStart;
  for (let k = p; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (inBold && t.rawStart >= boldEnd) {
      boundary = "bold";
      break;
    }
    if (isEtc(t)) {
      if (k > p) {
        boundary = "etc";
        contFrom = k + 1;
      }
      break;
    }
    // "ד"ה X עד ד"ה Y": X ends before "עד"
    if (k > p && isRangeAt(tokens, k)) {
      boundary = "range";
      break;
    }
    end = k + 1;
    const sep = gap(html, t.rawEnd, tokens[k + 1]?.rawStart ?? html.length);
    if (inBold && t.rawEnd <= boldEnd && (tokens[k + 1]?.rawStart ?? Infinity) >= boldEnd) {
      boundary = "bold";
      break;
    }
    if (PUNCT_RE.test(sep)) {
      boundary = inBold ? "bold" : "punctuation";
      break;
    }
    if (DASH_RE.test(sep)) {
      boundary = inBold ? "bold" : "dash";
      break;
    }
  }
  if (end === p) return emptyResult("empty", tokens, stripped, addressee, bold);

  let explicit = boundary !== "none" && end - p <= maxWords;
  if (end - p > maxWords) {
    end = p + maxWords;
    if (boundary !== "bold") boundary = "none";
    explicit = boundary === "bold";
  }
  const dh = tokens.slice(p, end);

  // a resumed quote after כו'
  const continuation: HebToken[] = [];
  if (contFrom > 0) {
    for (let k = contFrom; k < tokens.length && continuation.length < maxWords; k++) {
      const t = tokens[k]!;
      if (isEtc(t) || (inBold && t.rawStart >= boldEnd)) break;
      continuation.push(t);
      const sep = gap(html, t.rawEnd, tokens[k + 1]?.rawStart ?? html.length);
      if (PUNCT_RE.test(sep) || DASH_RE.test(sep)) break;
    }
  }

  // a short bold run continued by the line's own punctuation (see `extended`)
  const extended: HebToken[] = [];
  if (boundary === "bold" && dh.length <= 2 && !PUNCT_RE.test(gap(html, dh.at(-1)!.rawEnd, tokens[end]?.rawStart ?? html.length))) {
    for (let k = end; k < tokens.length && k - p < maxWords; k++) {
      const t = tokens[k]!;
      if (isEtc(t) || isRangeAt(tokens, k)) {
        if (k > end) extended.push(...tokens.slice(p, k));
        break;
      }
      const sep = gap(html, t.rawEnd, tokens[k + 1]?.rawStart ?? html.length);
      if (PUNCT_RE.test(sep)) {
        extended.push(...tokens.slice(p, k + 1));
        break;
      }
      if (DASH_RE.test(sep)) break;
    }
  }

  // "… עד ד"ה Y": the range end, within the first words after the ד"ה
  const range: HebToken[] = [];
  for (let k = end; k < Math.min(tokens.length, end + 2 * maxWords + 4); k++) {
    if (!isRangeAt(tokens, k)) continue;
    let j = k + 1;
    while (j < tokens.length && !isDhMark(tokens[j])) j++;
    for (j++; j < tokens.length && range.length < maxWords; j++) {
      const t = tokens[j]!;
      if (isEtc(t)) break;
      range.push(t);
      const sep = gap(html, t.rawEnd, tokens[j + 1]?.rawStart ?? html.length);
      if (PUNCT_RE.test(sep) || DASH_RE.test(sep)) break;
    }
    break;
  }

  return {
    kind: "dh",
    tokens,
    from: p,
    dh,
    continuation,
    explicit,
    boundary: explicit ? boundary : "none",
    stripped,
    text: visibleSlice(html, dh[0]!.rawStart, dh.at(-1)!.rawEnd),
    addressee,
    range,
    attribution,
    bold,
    extended,
    unit,
  };
}

/** tokens[k] opens "עד ד"ה" / "עד בד"ה" / "עד סוף ד"ה" (the end of a range of lemmas). */
function isRangeAt(tokens: readonly HebToken[], k: number): boolean {
  if (tokens[k]?.key !== "עד") return false;
  const n = tokens[k + 1];
  return isDhMark(n) || ((n?.key === "סופ" || n?.key === "סוה") && isDhMark(tokens[k + 2]));
}
