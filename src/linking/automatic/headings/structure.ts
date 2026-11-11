import { toGematria } from "../../../core/text/gematria";
import { normalize } from "../../../core/text/hebrew";
import type { EngineBook } from "../types";
import { dafElement, hebrewLetterCount, inlineMarker, parseHeading, plainText, untaggedHeading, type NumberingMode, type PathElement } from "./numbering";

/*
 * The structural tree of one book, flattened: every line gets the path of the headings above it
 * (h1–h6 nesting), and — for the base book — every heading and every inline-numbered line becomes a
 * UNIT that a commentary path can land on, with the content range it covers.
 *
 * Everything here is addressed by POSITION in book.lines, not by line index: a loaded slice of a
 * book may be sparse. The engine converts positions to line indexes at the very end.
 */

export type SkipReason = "heading" | "empty" | "few-letters";

export interface LineInfo {
  /** the heading path above (and including, for a heading line) this line */
  readonly path: readonly PathElement[];
  /** "(יב)" at the start of the line, or carried from the last marker line in the same section */
  readonly marker: number | null;
  /** true for the line that carries the marker itself */
  readonly markerLine: boolean;
  readonly skip: SkipReason | null;
}

export interface HeadingInfo {
  /** position in book.lines */
  readonly at: number;
  readonly level: number;
  readonly elements: readonly PathElement[];
  /** path of the heading INCLUDING its own elements */
  readonly path: readonly PathElement[];
  readonly tagged: boolean;
}

export interface Unit {
  readonly id: number;
  readonly path: readonly PathElement[];
  readonly pathKey: string;
  /** position of the first content line (never a heading line) */
  readonly start: number;
  /** position of the last content line, inclusive (never a heading line) */
  readonly end: number;
  /** position of the heading this unit hangs on; null for an inline-marker unit */
  readonly headingAt: number | null;
  /** an inline-marker unit (a numbered line such as "(יב) …" plus its continuation lines) */
  readonly marker: boolean;
  /** the unit has deeper sub-units (sub-headings or numbered lines) inside its range */
  readonly hasSubunits: boolean;
  /** id of the enclosing heading unit, for marker units */
  readonly parent: number | null;
}

export interface BookStructure {
  readonly lines: readonly LineInfo[];
  readonly headings: readonly HeadingInfo[];
  /** canonical kinds of numbered elements that occur in the book's headings (never "?") */
  readonly kinds: ReadonlySet<string>;
  readonly hasNamed: boolean;
  readonly markerLines: number;
  readonly untagged: number;
}

export interface AnalyzeOptions {
  readonly numbering: NumberingMode;
  readonly untaggedHeadings: boolean;
}

export const pathKey = (path: readonly PathElement[]): string => path.map(elementKey).join("/");

export function elementKey(e: PathElement): string {
  if (e.kind === "name") return `$${e.name}`;
  if (e.kind === "daf") return `d${e.n}${e.amud ? (e.amud === 1 ? "a" : "b") : ""}`;
  return `${e.kind}#${e.n}`;
}

/** Collapses an amud element into the daf before it ("דף ב" › "עמוד ב" → "דף ב:"), DafTracker-style. */
function withAmud(path: readonly PathElement[], lastDaf: number | null): PathElement[] {
  const out: PathElement[] = [];
  for (const e of path) {
    const prev = out[out.length - 1];
    if (e.kind === "amud") {
      if (prev?.kind === "daf" && prev.amud === undefined) out[out.length - 1] = dafElement(prev.n!, e.n as 1 | 2);
      else if (lastDaf !== null && prev?.kind !== "daf") out.push(dafElement(lastDaf, e.n as 1 | 2));
      else out.push(e);
      continue;
    }
    if (e.kind === "daf" && prev?.kind === "daf" && prev.n === e.n) {
      if (e.amud !== undefined) out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}

export function analyzeBook(book: EngineBook, opts: AnalyzeOptions): BookStructure {
  const src = book.lines;
  const titleKey = normalize(book.book.title);
  // pass 1: tagged headings, the level each kind uses, and the title heading
  const tagged: { at: number; level: number; elements: PathElement[] }[] = [];
  const kindLevel = new Map<string, number>();
  let minLevel = 7;
  for (let i = 0; i < src.length; i++) {
    const l = src[i]!;
    if (l.heading == null) continue;
    const elements = parseHeading(l.text, opts.numbering);
    tagged.push({ at: i, level: l.heading, elements });
    minLevel = Math.min(minLevel, l.heading);
    const first = elements[0];
    if (first && first.kind !== "name" && !kindLevel.has(first.kind)) kindLevel.set(first.kind, l.heading);
  }
  const titles = new Set<number>();
  const minCount = tagged.filter((t) => t.level === minLevel).length;
  for (const [k, t] of tagged.entries()) {
    const text = normalize(plainText(src[t.at]!.text));
    const onlyTopName = k === 0 && t.level === minLevel && minCount === 1 && t.elements.every((e) => e.kind === "name");
    if (text === titleKey || onlyTopName) titles.add(t.at);
  }

  // pass 2: walk the lines with a heading stack
  const taggedAt = new Map(tagged.map((t) => [t.at, t.elements] as const));
  const deepestTagged = tagged.reduce((m, t) => Math.max(m, t.level), 0);
  const stack: { level: number; elements: readonly PathElement[] }[] = [];
  const lines: LineInfo[] = [];
  const headings: HeadingInfo[] = [];
  const kinds = new Set<string>();
  let hasNamed = false;
  let lastDaf: number | null = null;
  let marker: number | null = null;
  let markerLines = 0;
  let untagged = 0;
  let path: PathElement[] = [];
  for (let i = 0; i < src.length; i++) {
    const l = src[i]!;
    let level: number | null = null;
    let elements: readonly PathElement[] | null = null;
    let isTagged = false;
    if (l.heading != null) {
      level = l.heading;
      isTagged = true;
      elements = titles.has(i) ? [] : taggedAt.get(i) ?? [];
    } else if (opts.untaggedHeadings) {
      const u = untaggedHeading(l.text, opts.numbering);
      if (u) {
        elements = u;
        level = kindLevel.get(u[0]!.kind) ?? deepestTagged + 1;
        untagged++;
      }
    }
    if (level !== null && elements !== null) {
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      if (elements.length) stack.push({ level, elements });
      path = withAmud(stack.flatMap((s) => s.elements), lastDaf);
      for (const e of path) if (e.kind === "daf") lastDaf = e.n!;
      if (elements.length) {
        for (const e of elements) {
          if (e.kind === "name") hasNamed = true;
          else if (e.kind !== "?") kinds.add(e.kind === "amud" ? "daf" : e.kind);
        }
        headings.push({ at: i, level, elements, path, tagged: isTagged });
      }
      marker = null;
      lines.push({ path, marker: null, markerLine: false, skip: "heading" });
      continue;
    }
    const text = plainText(l.text);
    const m = inlineMarker(l.text, opts.numbering);
    if (m !== null) { marker = m; markerLines++; }
    const skip: SkipReason | null = !text ? "empty" : hebrewLetterCount(text) < 2 ? "few-letters" : null;
    lines.push({ path, marker, markerLine: m !== null, skip });
  }
  return { lines, headings, kinds, hasNamed, markerLines, untagged };
}

/**
 * Units of the BASE book. A heading unit covers its content up to the next heading of the same or a
 * higher level; its range never starts or ends on a heading line (the generator drops such links).
 * A marker unit is a numbered line plus its unnumbered continuation lines.
 */
export function buildUnits(s: BookStructure): Unit[] {
  const lines = s.lines;
  const n = lines.length;
  const isContent = (i: number) => lines[i]!.skip !== "heading";
  const firstContentFrom = (i: number, limit: number) => {
    for (let k = i; k <= limit; k++) if (isContent(k)) return k;
    return -1;
  };
  const lastContentUpTo = (i: number, floor: number) => {
    for (let k = i; k >= floor; k--) if (isContent(k)) return k;
    return -1;
  };
  const units: Unit[] = [];
  const hs = s.headings;
  const unitOfHeading = new Map<number, number>(); // heading position → unit id
  const ownKeys = new Set<string>();
  const multi: { head: HeadingInfo; unit: number }[] = [];
  for (let h = 0; h < hs.length; h++) {
    const head = hs[h]!;
    let stop = n;
    for (let k = h + 1; k < hs.length; k++) if (hs[k]!.level <= head.level) { stop = hs[k]!.at; break; }
    const start = firstContentFrom(head.at + 1, stop - 1);
    if (start < 0) continue;
    const end = lastContentUpTo(stop - 1, start);
    let hasSub = h + 1 < hs.length && hs[h + 1]!.at < stop;
    if (!hasSub) for (let k = start; k <= end; k++) if (lines[k]!.markerLine) { hasSub = true; break; }
    const id = units.length;
    const key = pathKey(head.path);
    units.push({ id, path: head.path, pathKey: key, start, end, headingAt: head.at, marker: false, hasSubunits: hasSub, parent: null });
    unitOfHeading.set(head.at, id);
    ownKeys.add(key);
    if (head.elements.length > 1) multi.push({ head, unit: id });
  }
  // prefix units for multi-element headings ("פרק א משנה ב" also stands for "פרק א"), merged while contiguous
  const prefixByKey = new Map<string, number>();
  for (const { head, unit } of multi) {
    const u = units[unit]!;
    for (let cut = head.path.length - head.elements.length + 1; cut < head.path.length; cut++) {
      const prefix = head.path.slice(0, cut);
      const key = pathKey(prefix);
      if (ownKeys.has(key)) continue; // a real heading carries this path
      const prevId = prefixByKey.get(key);
      if (prevId !== undefined) {
        const prev = units[prevId]!;
        if (!hs.some((h) => h.at > prev.end && h.at < u.start && h.path.length < cut)) {
          units[prevId] = { ...prev, end: Math.max(prev.end, u.end) };
          continue;
        }
      }
      const id = units.length;
      units.push({ id, path: prefix, pathKey: key, start: u.start, end: u.end, headingAt: u.headingAt, marker: false, hasSubunits: true, parent: null });
      prefixByKey.set(key, id);
    }
  }
  // marker units
  let currentHeadingUnit: number | null = null;
  for (let i = 0; i < n; i++) {
    const l = lines[i]!;
    if (l.skip === "heading") {
      if (unitOfHeading.has(i)) currentHeadingUnit = unitOfHeading.get(i)!;
      continue;
    }
    if (!l.markerLine) continue;
    let end = i;
    for (let k = i + 1; k < n && lines[k]!.skip !== "heading" && !lines[k]!.markerLine; k++) end = k;
    end = lastContentUpTo(end, i);
    const path = [...l.path, { kind: "?", n: l.marker!, label: `(${toGematria(l.marker!)})` }];
    units.push({ id: units.length, path, pathKey: pathKey(path), start: i, end, headingAt: null, marker: true, hasSubunits: false, parent: currentHeadingUnit });
  }
  return units;
}
