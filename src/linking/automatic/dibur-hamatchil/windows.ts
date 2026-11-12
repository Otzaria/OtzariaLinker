/*
 * Where in the base book to look for a commentary line, when the caller gives no windows.
 *
 * Headings: a commentary heading whose text equals a base heading ("פרק א" ↔ "פרק א",
 * "דף ב." ↔ "דף ב.") narrows the search to that base section — the section runs until the next
 * base heading of the same or a higher level. Nested commentary headings narrow further, each
 * inside the section its parent resolved to; a heading with no counterpart is skipped. A trailing
 * "." / ":" (the עמוד of a daf) must agree when the base has a heading that agrees. This is the
 * header-segment alignment of otzaria-link-generator (`findMatchingSegment`), reduced to exact
 * normalized equality so a near-miss can never move the window to the wrong chapter.
 *
 * With no matching heading at all the window is the whole base book; the engine then relies on
 * sequential progress (search near the previous match first) — see engine.ts.
 */
import type { EngineBook } from "../types";
import { normalize } from "../../../core/text/hebrew";
import { headingLevel, stripTags } from "../../../core/text/html";

export type WindowKind = "caller" | "heading" | "book";

export interface SearchWindow {
  /** first base line index (0-based, inclusive) */
  readonly from: number;
  /** last base line index (inclusive) */
  readonly to: number;
  readonly kind: WindowKind;
  /** the base heading the window was derived from */
  readonly label?: string;
}

interface Heading {
  readonly index: number;
  readonly level: number;
  readonly key: string;
  /** trailing "." / ":" — the עמוד of a daf heading ("דף טו." ≠ "דף טו:"); normalize() drops it */
  readonly mark: string;
  readonly text: string;
  /** last line of its section (inclusive) */
  end: number;
}

const levelOf = (l: { text: string; heading: number | null }) => l.heading ?? headingLevel(l.text);
const keyOf = (text: string) => normalize(stripTags(text));
const markOf = (text: string) => /([.:])\s*$/.exec(stripTags(text))?.[1] ?? "";

function headingsOf(book: EngineBook): Heading[] {
  const out: Heading[] = [];
  for (const l of book.lines) {
    const level = levelOf(l);
    if (level !== null) out.push({ index: l.index, level, key: keyOf(l.text), mark: markOf(l.text), text: stripTags(l.text), end: -1 });
  }
  const last = book.lines.at(-1)?.index ?? 0;
  for (let i = 0; i < out.length; i++) {
    const h = out[i]!;
    const next = out.slice(i + 1).find((x) => x.level <= h.level);
    h.end = next ? next.index - 1 : last;
  }
  return out;
}

export interface HeadingWindows {
  /** per commentary line index → the base window derived from matching headings */
  readonly windowOf: (commentaryLine: number) => SearchWindow;
  /**
   * Set when the matching headings were NOT used (every window is the whole book): the commentary's
   * headings match only inside one minor base section the commentary never names (see below).
   */
  readonly distrusted?: { readonly section: string; readonly matched: readonly string[] };
}

/** Per commentary line index → the base window derived from matching headings. */
export function headingWindows(commentary: EngineBook, base: EngineBook): (commentaryLine: number) => SearchWindow {
  return headingWindowPlan(commentary, base).windowOf;
}

/**
 * The heading windows, and whether they can be trusted.
 *
 * A commentary heading matches the first base heading with the same text inside the scope its parent
 * resolved to — at any depth. Matching DEEPER than the commentary names is normal (a commentary's
 * "סימן א" under an unnamed "הלכות …" section of the base), but when EVERY outermost match of the
 * commentary falls inside one and the same base section that the commentary never names (no heading,
 * not its title), and that section is a minor part of the base, the commentary's structure is not the
 * base's: the whole commentary would be searched inside that one section. Measured on the real
 * database (REAL_DATA_REPORT.md §7.1): "מקדש מלך" on the Zohar has "כרך א/ב/ג" › "דף ה." (Vilna
 * volumes and pages); the Zohar is divided by parsha, and its only "כרך א/ב/ג" are the volumes of the
 * appendix "תוספות" (966 of 18,769 lines) — so every line was searched in the appendix, and all 56
 * certain/high suggestions were wrong. Then no heading window is used, and the engine falls back on
 * sequential progress over the whole book.
 */
export function headingWindowPlan(commentary: EngineBook, base: EngineBook): HeadingWindows {
  const first = base.lines[0]?.index ?? 0;
  const last = base.lines.at(-1)?.index ?? 0;
  const whole: SearchWindow = { from: first, to: last, kind: "book" };
  const baseHeadings = headingsOf(base);
  const byLine = new Map<number, SearchWindow>();
  const stack: { level: number; key: string; mark: string }[] = [];
  let current: SearchWindow = whole;
  /** the outermost base heading each heading path matched */
  const outermost = new Set<Heading>();

  const resolve = (): SearchWindow => {
    let from = first;
    let to = last;
    let label: string | undefined;
    for (const h of stack) {
      const inScope = (b: Heading) => b.key === h.key && b.index >= from && b.index <= to;
      const hit = baseHeadings.find((b) => inScope(b) && b.mark === h.mark) ?? baseHeadings.find(inScope);
      if (!hit) continue;
      if (label === undefined) outermost.add(hit);
      from = hit.index;
      to = hit.end;
      label = hit.text;
    }
    return label === undefined ? whole : { from, to, kind: "heading", label };
  };

  for (const l of commentary.lines) {
    const level = levelOf(l);
    if (level !== null) {
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      const key = keyOf(l.text);
      if (key) stack.push({ level, key, mark: markOf(l.text) });
      current = resolve();
    }
    byLine.set(l.index, current);
  }

  // the base section that holds every outermost match, when it is one, unnamed and minor
  const titleKey = normalize(commentary.book.title);
  const named = new Set(commentary.lines.map((l) => (levelOf(l) !== null ? keyOf(l.text) : "")).filter(Boolean));
  /** the nearest base heading enclosing h, other than one spanning the whole book (the title) */
  const enclosing = (h: Heading) => {
    let best: Heading | null = null;
    for (const b of baseHeadings)
      if (b.level < h.level && b.index < h.index && b.end >= h.index && !(b.index === first && b.end === last) && (!best || b.index > best.index)) best = b;
    return best;
  };
  const sections = new Set([...outermost].map(enclosing));
  const [section] = sections;
  if (outermost.size && sections.size === 1 && section && !named.has(section.key) && !(section.key && titleKey.includes(section.key)) && (section.end - section.index + 1) * 2 < last - first + 1)
    return { windowOf: () => whole, distrusted: { section: section.text, matched: [...outermost].map((h) => h.text) } };
  return { windowOf: (i) => byLine.get(i) ?? whole };
}

/** Rung C of the ladder: the window widened by its own width on each side (the neighbouring sections). */
export function widen(w: SearchWindow, base: EngineBook): SearchWindow {
  const first = base.lines[0]?.index ?? 0;
  const last = base.lines.at(-1)?.index ?? 0;
  const width = Math.max(10, w.to - w.from + 1);
  return { ...w, from: Math.max(first, w.from - width), to: Math.min(last, w.to + width) };
}
