import { fromGematria } from "../../../core/text/gematria";
import { MAX_CUSTOM_REGEX_INPUT, checkCustomPattern } from "../../../core/text/safe-regex";
import { unitAt, visibleBetween, visibleMap, type VisibleMap } from "../../../core/text/visible-map";

/*
 * Footnote-marker detection — the marker half of Otzaria/Link-Notes @ b1e0670 (index.html
 * stripWrapperChars / normalizeRefToken / extractRefsFromLineByTag / extractRefsFromLineByRegex),
 * reworked:
 *   • Offsets are RAW offsets into the line, and every span is checked against the generator's
 *     visible-character rules (src/core/text/offsets.ts) — what the reader sees between rawStart and
 *     rawEnd is exactly the marker.
 *   • Hebrew numerals use the shared lenient reader (fromGematria: sum, any order, final letters),
 *     as REUSE_MATRIX §5.1 decided for footnote markers.
 *   • Text outside tags is matched on the VISIBLE text (tags hidden, entities one unit), so
 *     "(<b>12</b>)" is one marker and "(12)" inside an attribute is none.
 *   • Broken tags are repaired where the intent is clear (missing ">" on the closing tag, no
 *     closing tag, a new <sup> before the old one closed) and reported.
 *   • A tag holding several numbers ("<sup>3,4</sup>") gives one marker per number.
 *   • A user regex is guarded (checkCustomPattern) because synchronous JS cannot time it out.
 */

/** How markers are written. A string names a built-in style; an object is a custom rule. */
export type MarkerStyle =
  /** `<sup>12</sup>`, `<sup>(א)</sup>`, `<sup>*3</sup>`, `<sup>3,4</sup>` */
  | "sup"
  /** the same with `<sub>` */
  | "sub"
  /** `(12)` / `(יב)` in the text outside tags (tags inside the parentheses are allowed) */
  | "parentheses"
  /** any element name, e.g. `{ tag: "small" }` */
  | { readonly tag: string }
  /**
   * Sefaria's note places: an EMPTY element `<i data-commentator="…" data-label="12"></i>` in the line
   * (the number is the label; nothing is visible). "label" reads every commentator; `{ label: name }`
   * one of them. 423 books of the official database carry such markers (dibur-hamatchil/markers.ts).
   */
  | "label"
  | { readonly label: string }
  /**
   * A JavaScript regular expression run on the RAW line (tags included). Group `n` (named) or
   * group 1 holds the number; without groups the whole match is read (wrappers are stripped).
   * Flags: only i, m, s, u are kept. See checkCustomPattern for what is refused and why.
   */
  | { readonly regex: string; readonly flags?: string };

export type Numbering = "digits" | "letters";

export interface Marker {
  /** raw offset where the marker starts (the opening tag for tag styles, "(" for parentheses) */
  readonly rawStart: number;
  /** raw offset just after the marker (exclusive) */
  readonly rawEnd: number;
  /** the visible text between rawStart and rawEnd, e.g. "12", "(א)", " *3" */
  readonly visible: string;
  /** the number as written, without stars and wrappers, e.g. "12" or "יב" */
  readonly token: string;
  readonly num: number;
  /** what must agree between the book and the notes: stars + number + stars ("*3" ≠ "3") */
  readonly key: string;
  /** "stars": a marker made of stars only ("*", "**"), matched by order */
  readonly numbering: Numbering | "stars";
  /** wrapped in parentheses/brackets or other punctuation besides stars */
  readonly decorated: boolean;
  /** "label": a Sefaria data-label element (nothing visible); "position": a note line with no marker, numbered by its place in its section */
  readonly style: "sup" | "sub" | "tag" | "parentheses" | "regex" | "leading" | "label" | "position";
  /** set when a malformed tag was repaired: "unclosed" | "close-without-gt" */
  readonly broken?: "unclosed" | "close-without-gt";
  /** a `<sup class="footnote-marker">` — the generator's own marker of an inline (line_note) footnote */
  readonly inlineNote?: boolean;
}

export interface DetectOptions {
  /** only accept this numbering */
  readonly numbering?: Numbering;
  /** keep `<sup class="footnote-marker">` (default false: they belong to footnotes already inside the line) */
  readonly includeInlineNoteMarkers?: boolean;
}

/* ------------------------------------------------------------------ tokens */

const LETTERS = `(?:[א-ת]{1,3}["״][א-ת]|[א-ת]{1,4}['׳]?)`;
const CORE = `(?:\\d{1,4}|${LETTERS})`;
/** A marker as it appears in text: a number with optional stars, or stars alone. */
const MARK = `(?:\\*{1,3}(?!\\d|[א-ת])|\\*{0,3}${CORE}\\*{0,3})`;
/** decoration around the number: punctuation, not letters, digits or spaces (Link-Notes normalizeRefToken) */
const TOKEN_RE = new RegExp(`^([^0-9א-תA-Za-z\\s]*?)(\\d{1,4}|${LETTERS})([^0-9א-תA-Za-z\\s]*)$`);
const WRAPPERS = `"'״׳()[]{}<>«»`;
/** Bidi controls the token may carry (Link-Notes normalizeRefToken). */
const BIDI_RE = /[‎‏‪-‮]/g;
/** A Hebrew word in parentheses that is a citation, not a marker. */
const PAREN_STOP_WORDS = new Set(["שם"]);

export interface ParsedToken {
  readonly token: string;
  /** 0 for a stars-only marker */
  readonly num: number;
  readonly key: string;
  readonly numbering: Numbering | "stars";
  readonly decorated: boolean;
}

export interface TokenRules {
  /** Hebrew letters must not increase in value (יב, טו, קכג — not הגה). For running text, where words look like numbers. */
  readonly ordered?: boolean;
  /** at most this many Hebrew letters */
  readonly maxLetters?: number;
}

/** Link-Notes stripWrapperChars: peels matching wrapper characters; "*" is part of the key and stays. */
function stripWrappers(s: string): string {
  let out = s.trim();
  while (out.length >= 2 && WRAPPERS.includes(out[0]!) && WRAPPERS.includes(out[out.length - 1]!)) out = out.slice(1, -1).trim();
  return out;
}

const LETTER_VALUE = (ch: string) => fromGematria(ch) ?? 0;

/**
 * Reads one marker token ("12", "(יב)", "א)", "*3", "ט״ו", "**") — port of Link-Notes
 * normalizeRefToken with the shared lenient Hebrew reader: the key is the number plus the stars
 * around it; other punctuation is decoration. Stars alone ("*", "**") are a marker with no number,
 * matched by order. Returns null for anything else.
 */
export function parseMarkerToken(raw: string, rules: TokenRules = {}): ParsedToken | null {
  const cleaned = String(raw).replace(BIDI_RE, "").replace(/\s+/g, "");
  const inner = stripWrappers(cleaned);
  if (/^\*{1,3}$/.test(inner)) return { token: inner, num: 0, key: inner, numbering: "stars", decorated: inner.length !== cleaned.length };
  const m = TOKEN_RE.exec(inner);
  if (!m) return null;
  const [, pre, core, post] = m as unknown as [string, string, string, string];
  const digits = /^\d+$/.test(core);
  if (!digits) {
    const letters = [...core.replace(/["'״׳]/g, "")];
    if (rules.maxLetters !== undefined && letters.length > rules.maxLetters) return null;
    if (rules.ordered && letters.some((ch, i) => i > 0 && LETTER_VALUE(ch) > LETTER_VALUE(letters[i - 1]!))) return null;
  }
  const num = digits ? parseInt(core, 10) : fromGematria(core);
  if (num === null || !(num > 0)) return null;
  const stars = (s: string) => "*".repeat((s.match(/\*/g) ?? []).length);
  return {
    token: core,
    num,
    key: `${stars(pre)}${num}${stars(post)}`,
    numbering: digits ? "digits" : "letters",
    decorated: inner.length !== cleaned.length || pre.replace(/\*/g, "") !== "" || post.replace(/\*/g, "") !== "",
  };
}

/* ------------------------------------------------------------------ visible map and user patterns */

// shared with the other engines that search line text (core/text); re-exported for existing callers
export { boundQuantifiers, checkCustomPattern, MAX_CUSTOM_REGEX_INPUT, QUANTIFIER_CAP, type PatternCheck } from "../../../core/text/safe-regex";

/* ------------------------------------------------------------------ tag styles */

const escapeTag = (t: string) => t.replace(/[^a-zA-Z0-9:_-]/g, "");

function detectTag(html: string, map: VisibleMap, tagName: string, style: Marker["style"], opts: DetectOptions): Marker[] {
  const tag = escapeTag(tagName);
  if (!tag) return [];
  const openRe = new RegExp(`<\\s*${tag}\\b([^>]*)>`, "gi");
  const opens = [...html.matchAll(openRe)];
  const out: Marker[] = [];
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i]!;
    const tagStart = open.index;
    const openEnd = tagStart + open[0].length;
    const inlineNote = /\bclass\s*=\s*["']?footnote-marker\b/i.test(open[1] ?? "");
    if (inlineNote && !opts.includeInlineNoteMarkers) continue;
    const limit = i + 1 < opens.length ? opens[i + 1]!.index : html.length;
    const closeRe = new RegExp(`<\\s*/\\s*${tag}\\b\\s*(>)?`, "gi");
    closeRe.lastIndex = openEnd;
    const close = closeRe.exec(html);
    const closed = close && close.index < limit ? close : null;
    const extra = { style, ...(inlineNote ? { inlineNote: true } : {}) } as const;

    if (closed) {
      const closeEnd = closed.index + closed[0].length;
      const broken = closed[1] ? undefined : ("close-without-gt" as const);
      out.push(...tokensInside(map, openEnd, closed.index, tagStart, closeEnd, extra, broken, opts));
    } else {
      // No closing tag before the next opening one (or the end): the number right after the tag.
      const from = unitAt(map, openEnd);
      const to = unitAt(map, limit);
      const m = new RegExp(`^\\s*\\(?${MARK}[).]?`).exec(map.text.slice(from, to));
      if (!m) continue;
      const lastUnit = from + m[0].length - 1;
      const p = parseMarkerToken(m[0]);
      if (!p || !accept(p, opts)) continue;
      const rawEnd = map.ends[lastUnit]!;
      out.push({ rawStart: tagStart, rawEnd, visible: visibleBetween(map, tagStart, rawEnd), ...p, ...extra, broken: "unclosed" });
    }
  }
  return out;
}

/** The marker(s) inside one element: one number → the whole element; "3,4" → one span per number. */
function tokensInside(
  map: VisibleMap, innerStart: number, innerEnd: number, tagStart: number, closeEnd: number,
  extra: { readonly style: Marker["style"]; readonly inlineNote?: boolean }, broken: Marker["broken"], opts: DetectOptions,
): Marker[] {
  const from = unitAt(map, innerStart);
  const to = unitAt(map, innerEnd);
  const inside = map.text.slice(from, to);
  const whole = parseMarkerToken(inside);
  const flag = broken ? { broken } : {};
  if (whole) {
    return accept(whole, opts) ? [{ rawStart: tagStart, rawEnd: closeEnd, visible: visibleBetween(map, tagStart, closeEnd), ...whole, ...extra, ...flag }] : [];
  }
  // A list: "3,4" / "3, 4" — every part must be a number, otherwise this is not a marker. Only
  // commas separate: "ראה שם" (two words) must not become two markers.
  const parts = [...inside.matchAll(/[^,،]+/g)].filter((x) => x[0].trim());
  if (parts.length < 2) return [];
  const out: Marker[] = [];
  for (const part of parts) {
    const body = part[0].trim();
    const p = parseMarkerToken(body);
    if (!p) return [];
    if (!accept(p, opts)) continue;
    const at = from + part.index + part[0].indexOf(body);
    const rawStart = map.starts[at]!;
    const rawEnd = map.ends[at + body.length - 1]!;
    out.push({ rawStart, rawEnd, visible: visibleBetween(map, rawStart, rawEnd), ...p, ...extra, ...flag });
  }
  return out;
}

/** Stars-only markers carry no numbering and are always kept. */
const accept = (p: ParsedToken, opts: DetectOptions) => !opts.numbering || p.numbering === opts.numbering || p.numbering === "stars";

/* ------------------------------------------------------------------ parentheses */

const PAREN_RE = new RegExp(`\\(\\s*${MARK}\\s*\\)`, "g");
/** In running text a word in parentheses can look like a number: letters must be an ordered numeral of ≤3 letters. */
const RUNNING_TEXT: TokenRules = { ordered: true, maxLetters: 3 };

function detectParentheses(map: VisibleMap, opts: DetectOptions): Marker[] {
  const out: Marker[] = [];
  for (const m of map.text.matchAll(PAREN_RE)) {
    const p = parseMarkerToken(m[0], RUNNING_TEXT);
    if (!p || !accept(p, opts)) continue;
    if (p.numbering === "letters" && PAREN_STOP_WORDS.has(p.token)) continue;
    const rawStart = map.starts[m.index]!;
    const rawEnd = map.ends[m.index + m[0].length - 1]!;
    out.push({ rawStart, rawEnd, visible: m[0], ...p, style: "parentheses" });
  }
  return out;
}


function detectRegex(html: string, map: VisibleMap, regex: RegExp, opts: DetectOptions): Marker[] {
  if (html.length > MAX_CUSTOM_REGEX_INPUT) return [];
  const out: Marker[] = [];
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  for (const m of html.matchAll(re)) {
    if (!m[0].length) continue;
    const token = m.groups?.["n"] ?? m[1] ?? m[0];
    const p = parseMarkerToken(stripTagsLoose(token));
    if (!p || !accept(p, opts)) continue;
    const rawStart = m.index;
    const rawEnd = m.index + m[0].length;
    const visible = visibleBetween(map, rawStart, rawEnd);
    if (!visible.trim()) continue; // matched inside a tag: nothing the reader could see
    out.push({ rawStart, rawEnd, visible, ...p, style: "regex" });
  }
  return out;
}

const stripTagsLoose = (s: string) => s.replace(/<[^>]*>?/g, "");

/* ------------------------------------------------------------------ Sefaria data-label elements */

const LABEL_TAG_RE = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
const ATTR_RE: Readonly<Record<string, RegExp>> = { "data-commentator": /\bdata-commentator\s*=\s*(["'])([^"']*)\1/i, "data-label": /\bdata-label\s*=\s*(["'])([^"']*)\1/i };
const attr = (attrs: string, name: "data-commentator" | "data-label"): string | null => ATTR_RE[name]!.exec(attrs)?.[2] ?? null;

/**
 * `<i data-commentator="X" data-label="12"></i>`: the element (with its closing tag when it follows
 * at once) is the marker. Elements without data-commentator, or whose label is not a number
 * ("⚬"), are not markers.
 */
function detectLabels(html: string, commentator: string | undefined, opts: DetectOptions): Marker[] {
  if (!html.includes("data-label")) return [];
  const out: Marker[] = [];
  for (const m of html.matchAll(LABEL_TAG_RE)) {
    const who = attr(m[2] ?? "", "data-commentator");
    const label = attr(m[2] ?? "", "data-label");
    if (who === null || label === null || (commentator !== undefined && who !== commentator)) continue;
    const p = parseMarkerToken(label);
    if (!p || !accept(p, opts)) continue;
    const openEnd = m.index + m[0].length;
    const close = /^<\s*\/\s*([a-z][a-z0-9]*)\s*>/i.exec(html.slice(openEnd));
    out.push({ rawStart: m.index, rawEnd: openEnd + (close && close[1]!.toLowerCase() === m[1]!.toLowerCase() ? close[0].length : 0), visible: "", ...p, style: "label" });
  }
  return out;
}

/** The commentators whose data-label markers a line holds (chooseMainStyle tries each). */
export function labelCommentators(html: string): string[] {
  if (!html.includes("data-label")) return [];
  const out: string[] = [];
  for (const m of html.matchAll(LABEL_TAG_RE)) {
    const who = attr(m[2] ?? "", "data-commentator");
    if (who !== null && attr(m[2] ?? "", "data-label") !== null && !out.includes(who)) out.push(who);
  }
  return out;
}

/* ------------------------------------------------------------------ public */

export type CompiledStyle =
  | { readonly kind: "tag"; readonly tag: string; readonly style: Marker["style"] }
  | { readonly kind: "label"; readonly commentator?: string }
  | { readonly kind: "parentheses" }
  | { readonly kind: "regex"; readonly regex: RegExp };

/** Validates a style once (a custom pattern is checked here). */
export function compileStyle(style: MarkerStyle): { ok: true; compiled: CompiledStyle } | { ok: false; reason: string } {
  if (style === "sup" || style === "sub") return { ok: true, compiled: { kind: "tag", tag: style, style } };
  if (style === "parentheses") return { ok: true, compiled: { kind: "parentheses" } };
  if (style === "label") return { ok: true, compiled: { kind: "label" } };
  if (typeof style === "object" && style && "label" in style) return { ok: true, compiled: { kind: "label", commentator: String(style.label) } };
  if (typeof style === "object" && style && "tag" in style) {
    const tag = escapeTag(String(style.tag).replace(/[<>/\s]/g, ""));
    return tag ? { ok: true, compiled: { kind: "tag", tag, style: "tag" } } : { ok: false, reason: "שם התגית ריק או לא תקין." };
  }
  if (typeof style === "object" && style && "regex" in style) {
    const c = checkCustomPattern(style.regex, style.flags);
    return c.ok ? { ok: true, compiled: { kind: "regex", regex: c.regex } } : { ok: false, reason: c.reason };
  }
  return { ok: false, reason: "סגנון סימון לא מוכר." };
}

/**
 * Every marker of one style in one line, in line order. Pure. An invalid custom style yields [] —
 * call compileStyle first to show the user why.
 */
export function detectMarkers(text: string, style: MarkerStyle | CompiledStyle, opts: DetectOptions = {}): Marker[] {
  const html = String(text ?? "");
  let compiled: CompiledStyle;
  if (typeof style === "object" && style !== null && "kind" in style) compiled = style;
  else {
    const c = compileStyle(style);
    if (!c.ok) return [];
    compiled = c.compiled;
  }
  const map = visibleMap(html);
  let found: Marker[];
  if (compiled.kind === "tag") found = detectTag(html, map, compiled.tag, compiled.style, opts);
  else if (compiled.kind === "parentheses") found = detectParentheses(map, opts);
  else if (compiled.kind === "label") found = detectLabels(html, compiled.commentator, opts);
  else found = detectRegex(html, map, compiled.regex, opts);
  return found.sort((a, b) => a.rawStart - b.rawStart);
}

const LEAD_TAGS_ANY = /^(?:sup|sub)$/i;
const BARE_LETTERS_MAX = 2;

/**
 * The marker a NOTE line opens with, or null. With a style, the line's first marker of that style
 * must come before any visible text. Without one ("auto"), these openings are recognised:
 *   (12) / [12] / (יב)             — any number
 *   12. / 12) / יב) / א.           — digits, or at most two letters (a longer word is prose)
 *   <sup>יב</sup> / <sub>…</sub>    — any number
 *   <b>12</b> / <small>12</small>  — digits only (a bold first word is usually a dibur hamatchil)
 */
export function leadingMarker(text: string, style: MarkerStyle | CompiledStyle | "auto" = "auto", opts: DetectOptions = {}): Marker | null {
  const html = String(text ?? "");
  const map = visibleMap(html);
  const lead = /^\s*/.exec(map.text)![0].length;
  if (lead >= map.text.length) return null;
  if (style !== "auto") {
    const first = detectMarkers(html, style, opts)[0];
    if (!first) return null;
    return unitAt(map, first.rawStart) <= lead ? first : null;
  }
  const rest = map.text.slice(lead);
  const startRaw = map.starts[lead]!;
  const at = (len: number, p: ParsedToken): Marker => {
    const rawEnd = map.ends[lead + len - 1]!;
    return { rawStart: startRaw, rawEnd, visible: visibleBetween(map, startRaw, rawEnd), ...p, style: "leading" };
  };
  const wrapped = new RegExp(`^[(\\[]\\s*${MARK}\\s*[)\\]]`).exec(rest);
  if (wrapped) {
    const p = parseMarkerToken(wrapped[0]);
    if (p && accept(p, opts) && !(p.numbering === "letters" && PAREN_STOP_WORDS.has(p.token))) return at(wrapped[0].length, p);
  }
  const bare = new RegExp(`^${MARK}\\s*[).:\\]](?=\\s|$|[^\\d])`).exec(rest);
  if (bare) {
    const p = parseMarkerToken(bare[0].replace(/[).:\]]\s*$/, "").trim());
    if (p && accept(p, opts) && (p.numbering !== "letters" || p.token.replace(/["'״׳]/g, "").length <= BARE_LETTERS_MAX))
      return at(bare[0].replace(/\s+$/, "").length, { ...p, decorated: true });
  }
  // "* text": a printed star note
  const star = /^\*{1,3}(?=\s)/.exec(rest);
  if (star) return at(star[0].length, parseMarkerToken(star[0])!);
  return taggedLead(html, map, lead, opts);
}

/** A number in its own element at the very start of the line: `<sup>א</sup> text`, `<b>12</b> text`. */
function taggedLead(html: string, map: VisibleMap, lead: number, opts: DetectOptions): Marker | null {
  const n = map.starts.length;
  // the first run of visible units with no tag between them
  let j = lead;
  while (j + 1 < n && map.ends[j] === map.starts[j + 1]) j++;
  const p = parseMarkerToken(map.text.slice(lead, j + 1));
  if (!p || !accept(p, opts)) return null;
  const beforeFrom = lead > 0 ? map.ends[lead - 1]! : 0;
  const afterFrom = map.ends[j]!;
  const before = html.slice(beforeFrom, map.starts[lead]!);
  const after = html.slice(afterFrom, j + 1 < n ? map.starts[j + 1]! : html.length);
  const opens = [...before.matchAll(/<\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)];
  const closes = [...after.matchAll(/<\s*\/\s*([a-zA-Z][a-zA-Z0-9]*)\s*>/g)];
  // innermost element that opens right before the number and closes right after it
  for (const o of opens.reverse()) {
    const name = o[1]!.toLowerCase();
    if (p.numbering === "letters" && !LEAD_TAGS_ANY.test(name)) continue;
    const c = closes.find((x) => x[1]!.toLowerCase() === name);
    if (!c) continue;
    const rawStart = beforeFrom + o.index;
    const rawEnd = afterFrom + c.index + c[0].length;
    return { rawStart, rawEnd, visible: visibleBetween(map, rawStart, rawEnd), ...p, style: "leading" };
  }
  return null;
}

/* ------------------------------------------------------------------ the app's popup grammar */

/**
 * Will Otzaria show a hover popup for this printed marker? (otzaria lib/text_book/utils/
 * numbered_note_markers.dart, docs/contracts/OTZARIA_COMPATIBILITY.md §2): a number only as
 * `(\d{1,4})` in text outside tags; a Hebrew letter only as the whole `<sup>(א)</sup>` (up to two
 * asterisks); `<sup>9</sup>` without parentheses never. The note line must also OPEN with the same
 * marker — checked separately by the engine.
 */
export function appRecognisesMarker(line: string, m: Marker): boolean {
  const raw = String(line).slice(m.rawStart, m.rawEnd);
  if (m.numbering === "digits") return /^\(\d{1,4}\)$/.test(m.visible.trim()) && /\(\d{1,4}\)/.test(raw);
  return /^<sup>\(\*{0,2}[א-ת]{1,4}\*{0,2}\)<\/sup>$/.test(raw);
}
