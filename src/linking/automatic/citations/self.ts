import { normalize } from "../../../core/text/hebrew";
import { parseHeading, type PathElement } from "../headings/numbering";
import type { AddrElem, Kind } from "./address";
import { heRefKeys, type Resolution, type TargetIndex } from "./resolve";

/*
 * References INSIDE the citing book: "לעיל סימן ה", "לקמן סעיף ג ס"ק ב", "כמ"ש לעיל כלל ז' סי' ח'",
 * "עיין לקמן באות ז". The book's own structure tells what the words mean — no table of books here:
 *
 *   • the citing book's headings name the kind of each level ("כלל א", "סימן ה", "פרק ג" › "פסוק ד");
 *   • its line references (heRef "חכמת אדם, ז, ג") give the path of every line, and lining the two up
 *     tells which level of the references each heading kind is (`StructureTracker.depthKinds`);
 *   • a reference keeps the levels above the first one it names ("לעיל סי' ג" in כלל ז = כלל ז סי' ג),
 *     and must point the way it says: "לעיל" before the citing line, "לקמן"/"להלן" after it.
 *
 * The scanner feeds every line to the tracker (detect.ts); the engine resolves the reference against the
 * book's own index once the whole book was read (engine.ts), when every level's kind is known.
 */

/** A heading's kind id (headings/numbering.ts) → the citation's kind for that level. */
const KIND_OF_HEADING: Readonly<Record<string, Kind>> = {
  perek: "perek", pasuk: "pasuk", siman: "siman", seif: "seif", seifkatan: "sk", halacha: "halacha", mishna: "mishna", os: "os", mizmor: "mizmor", chelek: "chelek",
  klal: "klal", shaar: "shaar", maamar: "maamar", teshuva: "teshuva", "w:רמז": "remez", "w:פסקה": "piska", "w:דרוש": "drush",
};
const kindOfHeading = (id: string): Kind | null => (Object.hasOwn(KIND_OF_HEADING, id) ? KIND_OF_HEADING[id]! : id === "?" ? "?" : null);

/** One level of the citing line's place by the headings above it: a kind (or "?") and its number. */
export interface HerePart {
  readonly kind: Kind;
  readonly n: number;
}

/** Where a citing line is: its reference path (heRef keys) and its numbered heading path. */
export interface Here {
  /** the keys of the line's structured heRef ("n7", "n3"), or null */
  readonly keys: readonly string[] | null;
  /** the numbered headings above it, outermost first (names left out, as the headings index does) */
  readonly path: readonly HerePart[];
}

/** An internal reference: which way it points, and where it was written. */
export interface InternalRef {
  /** -1 "לעיל" (before the citing line), 1 "לקמן"/"להלן" (after it), 0 either ("וע"ל": עיין לעיל or עיין לקמן) */
  readonly dir: -1 | 0 | 1;
  readonly here: Here;
}

/** At least this many headings must agree on a level's kind, and this share of them. */
const MIN_VOTES = 2;
const MIN_SHARE = 0.8;

export class StructureTracker {
  /** the parsed headings by level (2…6; the h1 is the book's title) */
  private readonly stack: (readonly PathElement[] | undefined)[] = [];
  private alignPending = false;
  /** per depth of the references: heading kind → how many headings of that kind sat at that depth */
  private readonly votes: Map<Kind, number>[] = [];
  private pathCache: readonly HerePart[] | null = null;
  private heRef: string | null = null;

  constructor(private readonly title: string) {}

  /** A heading line (level 1–6). */
  heading(level: number, html: string): void {
    if (level <= 1) return;
    this.stack[level] = parseHeading(html);
    this.stack.length = level + 1;
    this.alignPending = true;
    this.pathCache = null;
  }

  /** A content line: the first after headings lines the headings up with the line's references. */
  content(heRef: string | null | undefined): void {
    this.heRef = heRef ?? null;
    if (!this.alignPending || !heRef) return;
    const keys = heRefKeys(heRef, this.title);
    if (!keys) return;
    this.align(keys);
    this.alignPending = false;
  }

  /** The headings above the current line that are names ("ספר בראשית", "פרשת נח"), outermost first. */
  names(): string[] {
    const out: string[] = [];
    for (const elems of this.stack) for (const e of elems ?? []) if (e.kind === "name") out.push(e.label);
    return out;
  }

  /** Where the last content line is. */
  here(): Here {
    return { keys: this.heRef ? heRefKeys(this.heRef, this.title) : null, path: this.path() };
  }

  /** The kind of each depth of the book's references, where the headings agree on it. */
  depthKinds(): (Kind | null)[] {
    // a kind belongs to the one depth most of its headings sat at (a stray match one level down — "כלל ג"
    // over a line "ז, ג" — is not a second home for it); a depth takes the kind most of its votes name
    const home = new Map<Kind, number>();
    const byKind = new Map<Kind, number[]>();
    this.votes.forEach((m, d) => {
      for (const [k, n] of m) (byKind.get(k) ?? byKind.set(k, []).get(k)!)[d] = n;
    });
    for (const [k, perDepth] of byKind) {
      let total = 0;
      let best = -1;
      for (const [d, n] of perDepth.entries()) {
        if (!n) continue;
        total += n;
        if (best < 0 || n > perDepth[best]!) best = d;
      }
      if (best >= 0 && perDepth[best]! >= MIN_VOTES && perDepth[best]! / total >= MIN_SHARE) home.set(k, best);
    }
    return this.votes.map((m, d) => {
      let total = 0;
      let best: Kind | null = null;
      let top = 0;
      for (const [k, n] of m) {
        total += n;
        if (n > top) {
          top = n;
          best = k;
        }
      }
      return best && home.get(best) === d && top / total >= MIN_SHARE ? best : null;
    });
  }

  private path(): readonly HerePart[] {
    if (this.pathCache) return this.pathCache;
    const out: HerePart[] = [];
    for (const elems of this.stack) {
      if (!elems) continue;
      for (const e of elems) {
        if (e.n === undefined || e.kind === "name" || e.kind === "daf" || e.kind === "amud") continue;
        const k = kindOfHeading(e.kind);
        if (k) out.push({ kind: k, n: e.n });
      }
    }
    return (this.pathCache = out);
  }

  /**
   * The headings above a line against its reference keys, in order: a named heading matches a named
   * level ("הלכות שחרית"), a numbered one the next level with its number — a vote for its kind there.
   */
  private align(keys: readonly string[]): void {
    let at = 0;
    for (const elems of this.stack) {
      if (!elems) continue;
      for (const e of elems) {
        let j = at;
        if (e.kind === "name") {
          const want = `$${e.name ?? normalize(e.label)}`;
          while (j < keys.length && keys[j] !== want) j++;
          if (j < keys.length) at = j + 1;
          continue;
        }
        if (e.n === undefined || e.kind === "daf" || e.kind === "amud") continue;
        while (j < keys.length && keys[j] !== `n${e.n}`) j++;
        if (j >= keys.length) continue;
        const k = kindOfHeading(e.kind);
        if (k && k !== "?") {
          const m = (this.votes[j] ??= new Map());
          m.set(k, (m.get(k) ?? 0) + 1);
        }
        for (let d = this.votes.length; d < j; d++) this.votes[d] ??= new Map();
        at = j + 1;
      }
    }
  }
}

/**
 * An internal reference against the book's own index. Its levels are placed by kind: the first named
 * level where the book has that kind, the levels above it kept from the citing line; a kind the book
 * does not name goes to its one level whose kind no heading told. Then the unit must lie the way the
 * words point, and must not hold the citing line itself.
 */
export function resolveInternal(ref: InternalRef, line: number, elems: readonly AddrElem[], index: TargetIndex, depthKinds: readonly (Kind | null)[]): Resolution | null {
  if (!elems.length || elems.some((e) => e.kind === "?" || e.kind === "daf" || e.to !== undefined)) return null;
  const r = index.via === "heref" ? byKeys(ref.here, elems, index, depthKinds) : index.via === "headings" ? byHeadings(ref.here, elems, index) : null;
  if (!r) return null;
  if (r.line <= line && line <= r.end) return null;
  if (ref.dir < 0 ? r.end >= line : ref.dir > 0 && r.line <= line) return null;
  return r;
}

/** where each element goes: the depth of its kind, else the one depth no heading named */
/**
 * The kinds a level no heading names may be taken as: numbered paragraphs of the book itself (סימן, סעיף,
 * ס"ק, אות). Not a verse, chapter, halacha or mishna — those number a base text: in the Yalkut "לעיל פסוק
 * טו" is the verse of the Torah, and its references' second level is its own paragraph, not that verse.
 */
const UNNAMED_LEVEL: ReadonlySet<Kind> = new Set(["siman", "seif", "sk", "os"]);

function place(kinds: readonly (Kind | null)[], elems: readonly AddrElem[], depth: number): number[] | null {
  const known = new Set(kinds.filter((k): k is Kind => !!k && k !== "?"));
  const unknown = kinds.map((k, i) => (k === null || k === "?" ? i : -1)).filter((i) => i >= 0 && i < depth);
  const first = elems[0]!;
  let d = kinds.indexOf(first.kind);
  if (d < 0 || kinds.indexOf(first.kind, d + 1) >= 0) {
    if (known.has(first.kind) || unknown.length !== 1 || !UNNAMED_LEVEL.has(first.kind)) return null;
    d = unknown[0]!;
  }
  const out: number[] = [];
  for (const [i, e] of elems.entries()) {
    const at = d + i;
    if (at >= depth) return null;
    const k = kinds[at];
    if (k && k !== "?" ? k !== e.kind : known.has(e.kind)) return null;
    out.push(at);
  }
  return out;
}

function byKeys(here: Here, elems: readonly AddrElem[], index: TargetIndex, kinds: readonly (Kind | null)[]): Resolution | null {
  const keys = here.keys;
  if (!keys || !index.resolvePath) return null;
  const depths = place(kinds.slice(0, keys.length).concat(Array(Math.max(0, keys.length - kinds.length)).fill(null)), elems, keys.length);
  if (!depths) return null;
  const d = depths[0]!;
  // the levels above the first one named are the citing line's; only numbered levels may be kept
  const path = [...keys.slice(0, d), ...elems.map((e) => `n${e.n}`)];
  return index.resolvePath(path);
}

function byHeadings(here: Here, elems: readonly AddrElem[], index: TargetIndex): Resolution | null {
  const kinds = here.path.map((p) => p.kind);
  if (!kinds.length) return null;
  const depths = place(kinds, elems, Math.max(kinds.length, 1));
  if (!depths) return null;
  const d = depths[0]!;
  const want: AddrElem[] = [
    ...here.path.slice(0, d).map((p): AddrElem => ({ kind: p.kind, n: p.n, explicit: true, numeral: { n: p.n, form: "gershayim", common: false } })),
    ...elems,
  ];
  return index.resolve(want, "other");
}
