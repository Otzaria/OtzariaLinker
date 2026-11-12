/*
 * Where in the base book to look for a commentary line, when the caller gives no windows.
 *
 * Headings: a commentary heading that NAMES the same place as a base heading narrows the search to
 * that base section — the section runs until the next base heading of the same or a higher level.
 * Nested commentary headings narrow further, each inside the section its parent resolved to; a
 * heading with no counterpart is skipped. This is the header-segment alignment of
 * otzaria-link-generator (`findMatchingSegment`), reduced to exact equality of a canonical KEY so a
 * near-miss can never move the window to the wrong chapter:
 *   • a numbered heading is its kind and its number — "סימן י"ב" = "סימן יב" = "סימן יב - דין …",
 *     "ס"ק ג" = "סעיף קטן ג" (`headingKey`); a heading without a number is its normalized text;
 *   • a daf heading is its page and amud, in every notation — "דף ב." = "דף ב ע"א" = "דף ב עמוד א";
 *     a daf without an amud ("דף לט") spans both amudim of the base.
 * Below the deepest heading the base has, the commentary may name LINES the base numbers itself:
 * "פסוק ג" ↔ the base line that opens with "(ג)" inside the chapter its parent resolved to ("unit"
 * windows), when most lines of that chapter are numbered and the number occurs once.
 * A base with no daf headings but inline page markers — `<i data-overlay="Vilna Pages"
 * data-value="5a">` in the Zohar — answers the commentary's "דף ה." with the lines of that page
 * ("page" windows; the volume is the commentary's "כרך"/"חלק" number, the base's volumes are where
 * the page numbering starts again).
 *
 * With no matching heading at all the window is the whole base book; the engine then relies on
 * sequential progress (search near the previous match first) and on the monotone alignment of all
 * the matches together — see engine.ts.
 */
import type { EngineBook } from "../types";
import { normalize } from "../../../core/text/hebrew";
import { fromGematria, toGematria } from "../../../core/text/gematria";
import { headingLevel, stripTags } from "../../../core/text/html";
import { openingNoteNumbers } from "./markers";

export type WindowKind = "caller" | "heading" | "unit" | "page" | "book";

export interface SearchWindow {
  /** first base line index (0-based, inclusive) */
  readonly from: number;
  /** last base line index (inclusive) */
  readonly to: number;
  readonly kind: WindowKind;
  /** the base heading the window was derived from */
  readonly label?: string;
}

/** What a heading names: a kind and a number ("סימן", 12), a daf (page, amud), or just its text. */
export interface HeadingKey {
  /** the comparison key: "סימן:12", "daf:5", or the normalized text */
  readonly key: string;
  readonly kind: string;
  readonly n: number | null;
  /** a daf heading's amud: "a" (".", ע"א), "b" (":", ע"ב), or null (none written) */
  readonly amud: "a" | "b" | null;
}

/** Heading words that are followed by a number. Longest first ("סעיף קטן" before "סעיף"). */
const KINDS = ["סעיף קטן", "סימן", "סעיף", "פרק", "משנה", "הלכה", "פסוק", "אות", "פסקה", "מאמר", "שער", "חלק", "כרך", "דרוש", "תיקון", "מצוה", "ענף", "כלל", "אופן", "פרשה", "קונטרס", "ספר", "עמוד", "שאלה", "תשובה"];
const QUOTES = /["'׳״]/g;
/** Kinds whose number may name a line the base numbers itself (a verse, a mishna, a seif) — not a chapter. */
const UNIT_KINDS = new Set(["פסוק", "משנה", "הלכה", "סעיף", "סעיף קטן", "אות", "פסקה", ""]);

/** A Hebrew numeral as written in a heading (י"ב, יב, טו, קכ"ג), else null. "אחד" is not 13. */
export function headingNumber(token: string): number | null {
  const t = token.replace(QUOTES, "").replace(/ך/g, "כ").replace(/ם/g, "מ").replace(/ן/g, "נ").replace(/ף/g, "פ").replace(/ץ/g, "צ");
  if (/^\d{1,4}$/.test(t)) return Number(t);
  if (!/^[א-ת]{1,4}$/.test(t)) return null;
  const n = fromGematria(t);
  if (n === null || n <= 0) return null;
  // canonical spelling only (ט"ו/ט"ז, and the י"ה/י"ו some books write)
  const canon = toGematria(n);
  return canon === t || (n % 100 === 15 && t.endsWith("יה")) || (n % 100 === 16 && t.endsWith("יו")) ? n : null;
}

const DAF_RE = /^(?:דף|דאף)\s+([א-ת"'׳״]{1,6}|\d{1,3})\s*(?:([.:])|ע["״'׳]?\s*([אב])['׳]?|עמוד\s+([אב])['׳]?)?\s*$/;
const BARE_DAF_RE = /^([א-ת"'׳״]{1,6})\s*([.:])$/;

/** The canonical key of a heading's text (see the file comment). Pure. */
export function headingKey(html: string): HeadingKey {
  const plain = stripTags(html).replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  const daf = DAF_RE.exec(plain) ?? BARE_DAF_RE.exec(plain);
  if (daf) {
    const n = headingNumber(daf[1]!);
    if (n !== null) {
      const mark = daf[2] ?? "";
      const letter = daf[3] ?? daf[4] ?? "";
      const amud = mark === "." || letter === "א" ? "a" : mark === ":" || letter === "ב" ? "b" : null;
      return { key: `daf:${n}`, kind: "daf", n, amud };
    }
  }
  const text = normalize(plain);
  for (const kind of KINDS) {
    if (!text.startsWith(`${kind} `)) continue;
    const num = text.slice(kind.length + 1).split(" ")[0]!;
    // "סימן א - דין …": the number is enough; "פרק ראשון" / "סימן אחד" are not numbers
    const n = headingNumber(num);
    if (n !== null) return { key: `${kind}:${n}`, kind, n, amud: null };
    break;
  }
  const bare = headingNumber(text);
  if (bare !== null) return { key: `:${bare}`, kind: "", n: bare, amud: null };
  return { key: text, kind: "", n: null, amud: null };
}

interface Heading extends HeadingKey {
  readonly index: number;
  readonly level: number;
  readonly text: string;
  /** last line of its section (inclusive) */
  end: number;
}

const levelOf = (l: { text: string; heading: number | null }) => l.heading ?? headingLevel(l.text);

function headingsOf(book: EngineBook): Heading[] {
  const out: Heading[] = [];
  for (const l of book.lines) {
    const level = levelOf(l);
    if (level !== null) out.push({ index: l.index, level, ...headingKey(l.text), text: stripTags(l.text), end: -1 });
  }
  const last = book.lines.at(-1)?.index ?? 0;
  for (let i = 0; i < out.length; i++) {
    const h = out[i]!;
    const next = out.slice(i + 1).find((x) => x.level <= h.level);
    h.end = next ? next.index - 1 : last;
  }
  return out;
}

/** The base's inline page markers (data-overlay="… Pages"), as volume:page:amud → line span. */
interface PageMarks {
  readonly spans: ReadonlyMap<string, { from: number; to: number }>;
  readonly volumes: number;
}
const PAGE_RE = /data-overlay\s*=\s*["'][^"']*Pages["'][^>]*?data-value\s*=\s*["'](\d{1,3})([ab])["']/gi;

function pageMarks(book: EngineBook): PageMarks | null {
  const seen: { line: number; n: number; amud: string }[] = [];
  for (const l of book.lines) if (l.text.includes("data-overlay")) for (const m of l.text.matchAll(PAGE_RE)) seen.push({ line: l.index, n: Number(m[1]), amud: m[2]! });
  if (seen.length < 20) return null;
  const spans = new Map<string, { from: number; to: number }>();
  let volume = 1;
  const last = book.lines.at(-1)?.index ?? 0;
  for (let i = 0; i < seen.length; i++) {
    const s = seen[i]!;
    // a new volume: the numbering starts again from the first pages after a long run
    if (i > 0 && s.n < 10 && seen[i - 1]!.n >= 50) volume++;
    const to = seen[i + 1]?.line ?? last;
    for (const key of [`${volume}:${s.n}:${s.amud}`, `${volume}:${s.n}:`]) {
      const sp = spans.get(key);
      if (!sp) spans.set(key, { from: s.line, to });
      else spans.set(key, { from: Math.min(sp.from, s.line), to: Math.max(sp.to, to) });
    }
  }
  return { spans, volumes: volume };
}

export interface HeadingWindows {
  /** per commentary line index → the base window derived from matching headings */
  readonly windowOf: (commentaryLine: number) => SearchWindow;
  /**
   * Set when the matching headings were NOT used (every window is the whole book): the commentary's
   * headings match only inside one minor base section the commentary never names (see below).
   */
  readonly distrusted?: { readonly section: string; readonly matched: readonly string[] };
  /**
   * Line kinds whose numbers are the commentary's own count, not the base's (ownNumbering): their
   * headings give no "unit" window, the window stays the section their parent resolved to.
   */
  readonly ownNumbering?: readonly OwnNumbering[];
  /** how many commentary lines got each window kind (for the run's notes) */
  readonly kinds: Readonly<Partial<Record<WindowKind, number>>>;
  /** the line numbered `n` inside `w` ("(ה)" for a commentary line's "(סעיף ה')"), when the base numbers its lines there */
  readonly unitOf: (w: SearchWindow, n: number) => SearchWindow | null;
}

/** A line kind the commentary numbers by its own count ("סעיף" of the ש"ך = its ס"ק), with the evidence. */
export interface OwnNumbering {
  readonly kind: string;
  /** sections (resolved parent windows whose base lines are numbered) the kind was compared in */
  readonly sections: number;
  /** of them, sections where the commentary's highest number is above the base's highest */
  readonly exceeding: number;
}

/*
 * A commentary may number its notes under a base section with the kind word of the base's lines while
 * counting its OWN notes: Otzaria's "שפתי כהן על שולחן ערוך חושן משפט" heads its notes "סעיף טו" where
 * "טו" is the ש"ך's ס"ק — the note on the שולחן ערוך's סעיף יד ("ואם העד ת"ח"). A "unit" window then
 * searches the wrong סעיף, and the words are not found. A commentary that counts the base's lines never
 * names a line the section does not have; one that counts its own notes does, in section after section:
 * measured on the real database, the highest "סעיף" under a סימן is above the שולחן ערוך's in 197 of 386
 * סימנים of that ש"ך (306/401 in יורה דעה, all 697 of כף החיים, 50/323 of קצות החושן), and in 4 of 665
 * of ביאור הגר"א and 0 of 524 of ביאור הלכה, which do count the base's סעיפים.
 */
/** sections in which the commentary's numbers must exceed the base's before the kind is its own count */
const OWN_MIN_SECTIONS = 3;
/** …and their share of the sections compared */
const OWN_MIN_SHARE = 0.1;

/** Per commentary line index → the base window derived from matching headings. */
export function headingWindows(commentary: EngineBook, base: EngineBook): (commentaryLine: number) => SearchWindow {
  return headingWindowPlan(commentary, base).windowOf;
}

/**
 * The heading windows, and whether they can be trusted.
 *
 * A commentary heading matches the first base heading with the same key inside the scope its parent
 * resolved to — at any depth. Matching DEEPER than the commentary names is normal (a commentary's
 * "סימן א" under an unnamed "הלכות …" section of the base), but when EVERY outermost match of the
 * commentary falls inside one and the same base section that the commentary never names (no heading,
 * not its title), and that section is a minor part of the base, the commentary's structure is not the
 * base's: the whole commentary would be searched inside that one section. Measured on the real
 * database (REAL_DATA_REPORT.md §7.1): "מקדש מלך" on the Zohar has "כרך א/ב/ג" › "דף ה." (Vilna
 * volumes and pages); the Zohar is divided by parsha, and its only "כרך א/ב/ג" are the volumes of the
 * appendix "תוספות" (966 of 18,769 lines) — so every line was searched in the appendix, and all 56
 * certain/high suggestions were wrong. Then no heading window is used, and the engine falls back on
 * sequential progress over the whole book. (Since the Zohar's page markers are read, its "דף ה." is a
 * page window and its "כרך" a volume number, and this does not happen there any more.)
 */
export function headingWindowPlan(commentary: EngineBook, base: EngineBook): HeadingWindows {
  const first = base.lines[0]?.index ?? 0;
  const last = base.lines.at(-1)?.index ?? 0;
  const whole: SearchWindow = { from: first, to: last, kind: "book" };
  const baseHeadings = headingsOf(base);
  const byLine = new Map<number, SearchWindow>();
  const stack: (HeadingKey & { level: number })[] = [];
  let current: SearchWindow = whole;
  /** the outermost base heading each heading path matched */
  const outermost = new Set<Heading>();

  // page markers answer daf headings only when the base has no daf headings of its own
  const pages = baseHeadings.some((h) => h.kind === "daf") ? null : pageMarks(base);
  // numbered base lines ("(ג) …") by window, for "unit" windows
  const numbered = new Map<string, Map<number, number[]> | null>();
  const contentIdx = base.lines.filter((l) => levelOf(l) === null).map((l) => l.index);
  const lineByIndex = new Map(base.lines.map((l) => [l.index, l]));
  const unitsIn = (from: number, to: number): Map<number, number[]> | null => {
    const k = `${from}-${to}`;
    if (numbered.has(k)) return numbered.get(k)!;
    const by = new Map<number, number[]>();
    let content = 0;
    let count = 0;
    for (const i of contentIdx) {
      if (i < from || i > to) continue;
      content++;
      const n = openingNoteNumbers(lineByIndex.get(i)!.text)[0];
      if (n === undefined) continue;
      count++;
      const at = by.get(n);
      if (at) at.push(i);
      else by.set(n, [i]);
    }
    // the base numbers its own lines here (verses, mishnayot, seifim): most lines open with a number
    const out = content >= 2 && count * 10 >= content * 6 ? by : null;
    numbered.set(k, out);
    return out;
  };

  const unitOf = (w: SearchWindow, n: number): SearchWindow | null => {
    const at = unitsIn(w.from, w.to)?.get(n);
    if (!at || at.length !== 1) return null;
    const start = at[0]!;
    const next = contentIdx.find((i) => i > start && i <= w.to && openingNoteNumbers(lineByIndex.get(i)!.text).length > 0);
    return { from: start, to: next !== undefined ? next - 1 : w.to, kind: "unit", label: `${w.label ? `${w.label}, ` : ""}(${toGematria(n)})` };
  };

  /** per kind: section ("from-to") → [the commentary's highest number, the base's highest] */
  const seen = new Map<string, Map<string, [number, number]>>();
  let own: ReadonlySet<string> = new Set<string>();
  const resolve = (): SearchWindow => {
    let from = first;
    let to = last;
    let label: string | undefined;
    let kind: WindowKind = "heading";
    let volume: number | null = null;
    let missed: (HeadingKey & { level: number }) | null = null;
    for (const h of stack) {
      if (pages && (h.kind === "כרך" || h.kind === "חלק") && h.n !== null) {
        // a volume of the page markers, not a base heading
        volume = h.n;
        continue;
      }
      if (pages && h.kind === "daf" && h.n !== null) {
        const v = volume ?? (pages.volumes === 1 ? 1 : null);
        const sp = v === null ? undefined : pages.spans.get(`${v}:${h.n}:${h.amud === "a" ? "a" : h.amud === "b" ? "b" : ""}`);
        if (sp) {
          [from, to, label, kind, missed] = [sp.from, sp.to, `דף ${toGematria(h.n)}${h.amud === "a" ? "." : h.amud === "b" ? ":" : ""}`, "page", null];
          continue;
        }
      }
      const inScope = (b: Heading) => b.key === h.key && b.index >= from && b.index <= to;
      let hit = baseHeadings.find((b) => inScope(b) && b.amud === h.amud) ?? (h.amud ? baseHeadings.find((b) => inScope(b) && b.amud === null) : undefined);
      let end = hit?.end;
      if (!hit && h.kind === "daf" && h.amud === null) {
        // "דף לט" with no amud: both amudim of the base
        const both = baseHeadings.filter(inScope);
        hit = both[0];
        end = both.at(-1)?.end;
      }
      if (!hit) {
        missed = h;
        continue;
      }
      if (label === undefined) outermost.add(hit);
      from = hit.index;
      to = end!;
      label = hit.text;
      kind = "heading";
      missed = null;
    }
    // the deepest heading names a line the base numbers itself ("פסוק ג" ↔ "(ג) …")
    if (missed && missed === stack.at(-1) && missed.n !== null && UNIT_KINDS.has(missed.kind) && label !== undefined && !own.has(missed.kind)) {
      const units = unitsIn(from, to);
      if (units?.size) {
        const bySection = seen.get(missed.kind) ?? new Map<string, [number, number]>();
        const k = `${from}-${to}`;
        const prev = bySection.get(k);
        bySection.set(k, [Math.max(prev?.[0] ?? 0, missed.n), Math.max(...units.keys())]);
        seen.set(missed.kind, bySection);
      }
      const at = units?.get(missed.n);
      if (at && at.length === 1) {
        const start = at[0]!;
        const next = contentIdx.find((i) => i > start && i <= to && openingNoteNumbers(lineByIndex.get(i)!.text).length > 0);
        return { from: start, to: next !== undefined ? next - 1 : to, kind: "unit", label: `${label}, ${stripTags(lineByIndex.get(start)!.text).slice(0, 12).trim()}` };
      }
    }
    return label === undefined ? whole : { from, to, kind, label };
  };

  const walk = () => {
    stack.length = 0;
    current = whole;
    for (const l of commentary.lines) {
      const level = levelOf(l);
      if (level !== null) {
        while (stack.length && stack.at(-1)!.level >= level) stack.pop();
        const key = headingKey(l.text);
        if (key.key) stack.push({ level, ...key });
        current = resolve();
      }
      byLine.set(l.index, current);
    }
  };
  walk();
  // the kinds the commentary counts by itself: walked again without their unit windows
  const ownNumbering: OwnNumbering[] = [];
  for (const [kind, bySection] of seen) {
    const sections = bySection.size;
    let exceeding = 0;
    for (const [c, b] of bySection.values()) if (c > b) exceeding++;
    if (exceeding >= OWN_MIN_SECTIONS && exceeding >= OWN_MIN_SHARE * sections) ownNumbering.push({ kind, sections, exceeding });
  }
  if (ownNumbering.length) {
    own = new Set(ownNumbering.map((o) => o.kind));
    outermost.clear();
    walk();
  }
  const kinds: Partial<Record<WindowKind, number>> = {};
  for (const w of byLine.values()) kinds[w.kind] = (kinds[w.kind] ?? 0) + 1;

  // the base section that holds every outermost match, when it is one, unnamed and minor
  const titleKey = normalize(commentary.book.title);
  const named = new Set(commentary.lines.map((l) => (levelOf(l) !== null ? headingKey(l.text).key : "")).filter(Boolean));
  /** the nearest base heading enclosing h, other than one spanning the whole book (the title) */
  const enclosing = (h: Heading) => {
    let best: Heading | null = null;
    for (const b of baseHeadings)
      if (b.level < h.level && b.index < h.index && b.end >= h.index && !(b.index === first && b.end === last) && (!best || b.index > best.index)) best = b;
    return best;
  };
  const sections = new Set([...outermost].map(enclosing));
  const [section] = sections;
  if (outermost.size && sections.size === 1 && section && !named.has(section.key) && !(section.key && titleKey.includes(normalize(section.text))) && (section.end - section.index + 1) * 2 < last - first + 1)
    return { windowOf: () => whole, distrusted: { section: section.text, matched: [...outermost].map((h) => h.text) }, kinds: { book: byLine.size }, unitOf };
  return { windowOf: (i) => byLine.get(i) ?? whole, kinds, unitOf, ...(ownNumbering.length && { ownNumbering }) };
}

/** Rung C of the ladder: the window widened by its own width on each side (the neighbouring sections). */
export function widen(w: SearchWindow, base: EngineBook): SearchWindow {
  const first = base.lines[0]?.index ?? 0;
  const last = base.lines.at(-1)?.index ?? 0;
  const width = Math.max(10, w.to - w.from + 1);
  return { ...w, from: Math.max(first, w.from - width), to: Math.min(last, w.to + width) };
}
