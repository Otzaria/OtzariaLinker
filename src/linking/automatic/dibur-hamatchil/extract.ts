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
 */
import type { EngineLine } from "../types";
import { headingLevel } from "../../../core/text/html";
import { hebrewTokens, visibleSlice, type HebToken } from "../../../matching/hebrew-tokens";

export type DhLineKind = "dh" | "baad" | "sham" | "heading" | "empty";
export type DhBoundary = "bold" | "etc" | "punctuation" | "dash" | "none";

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

function emptyResult(kind: DhLineKind, tokens: readonly HebToken[] = [], stripped: readonly string[] = []): ExtractedDh {
  return { kind, tokens, from: tokens.length, dh: [], continuation: [], explicit: false, boundary: "none", stripped, text: "" };
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

  // bold run at the very start (after an optional bracketed number)
  let boldEnd = -1;
  const bm = BOLD_OPEN_RE.exec(html);
  if (bm) {
    // the matching close tag, counting nested same-name tags (רש"י on the ש"ס opens "<b><b></b>…")
    const tag = new RegExp(`<(/?)${bm[1]}(?![a-z])[^>]*>`, "gi");
    tag.lastIndex = bm[0].length;
    let depth = 1;
    for (let m = tag.exec(html); m; m = tag.exec(html)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        boldEnd = m.index;
        break;
      }
    }
  }

  let p = leadingMarkerTokens(html, tokens);

  // pointer words, to a fixed point
  const stripped: string[] = [];
  const take = (n: number) => {
    stripped.push(visibleSlice(html, tokens[p]!.rawStart, tokens[p + n - 1]!.rawEnd));
    p += n;
  };
  let kind: DhLineKind = "dh";
  for (let pass = 0; pass < 6 && p < tokens.length; pass++) {
    const t = tokens[p]!;
    const next = tokens[p + 1];
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
        take(2);
        continue;
      }
      if (p + 1 >= tokens.length) kind = "sham";
      take(1);
      continue;
    }
    if (isDhMark(t) || (DH_GLUED.has(t.key) && t.acronym)) {
      take(1);
      continue;
    }
    if (SOURCE_NAMES.has(t.key) && isDhMark(next)) {
      take(2);
      continue;
    }
    if ((POINTERS_TRUNC.has(t.key) && t.truncated) || POINTERS_FULL.has(t.key)) {
      take(1);
      continue;
    }
    break;
  }
  if (kind === "baad" || kind === "sham") return emptyResult(kind, tokens, stripped);
  if (p >= tokens.length) return emptyResult("empty", tokens, stripped);

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
  if (end === p) return emptyResult("empty", tokens, stripped);

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
  };
}
