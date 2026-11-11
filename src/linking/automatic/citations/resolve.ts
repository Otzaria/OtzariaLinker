import type { BookRef } from "../../../core/links/model";
import { normalize } from "../../../core/text/hebrew";
import { analyzeBook, buildUnits } from "../headings/structure";
import type { PathElement } from "../headings/numbering";
import type { EngineLine } from "../types";
import type { AddrElem, Kind } from "./address";
import { normTitle, type Collection } from "./aliases";
import { strictValue } from "./numbers";

/*
 * Location → line(s) of one target book. Two kinds of index:
 *
 *   • REFERENCES (books from the database with Sefaria-style line.heRef: "בראשית, א, ב",
 *     "ברכות, ב., א", "שולחן ערוך, אורח חיים, א, ב", "טור, אורח חיים,  יט, א"). The heRef after the
 *     title is split into levels; numbers, dafim ("יז." / "יז:") and names ("אורח חיים", "הקדמה") become
 *     a tree, and every node knows the first and last line under it. A citation walks the tree; when
 *     it stops above the leaves ("ברכות יז.", "בראשית א") the target is the range of the node.
 *   • HEADINGS (text-file books, and database books whose heRef is just "<title> <line>"): the
 *     headings engine's own structure (headings/structure.ts) gives units with typed paths
 *     (פרק › פסוק, סימן › סעיף, דף › עמוד); a citation matches units with the same numbered path.
 *
 * Line numbers are 0-based line indexes of the book (LINK_FORMATS: the model is 0-based).
 */

export interface RefLine {
  readonly index: number;
  readonly heRef: string | null;
}

interface Node {
  readonly children: Map<string, Node>;
  first: number;
  last: number;
}

export interface Resolution {
  readonly book: BookRef;
  /** 0-based first and last (inclusive) line */
  readonly line: number;
  readonly end: number;
  /** the citation reached the deepest level of the book (a verse, a seif, a segment of an amud…) */
  readonly leaf: boolean;
  /** "ברכות יז" with no amud: both sides of the daf */
  readonly wholeDaf: boolean;
  /** a bare "א/ב" after the daf was read as the amud */
  readonly amudFromBareLetter: boolean;
  /** heRef-like label of the target, for heRef_2 */
  readonly label: string;
  readonly via: "heref" | "headings";
  /** the book is addressed by daf/amud, so the location's kind was checked */
  readonly daf: boolean;
}

export interface TargetIndex {
  readonly book: BookRef;
  readonly via: "heref" | "headings" | "none";
  /** the book is addressed by daf/amud (Bavli, its commentaries) */
  readonly daf: boolean;
  resolve(elems: readonly AddrElem[], collection: Collection, section?: string): Resolution | null;
}

const newNode = (): Node => ({ children: new Map(), first: Number.MAX_SAFE_INTEGER, last: -1 });

/** Share of content lines that must carry a structured heRef for the reference index to be used. */
const MIN_STRUCTURED = 0.5;

/* ---------- references (heRef) ---------- */

type Level = { kind: "n"; n: number } | { kind: "d"; n: number; amud: 1 | 2 } | { kind: "name"; name: string };

function levelOf(part: string): Level | null {
  const p = part.trim();
  if (!p) return null;
  const daf = /^([א-ת]{1,4})([.:])$/.exec(p);
  if (daf) {
    const n = strictValue(daf[1]!);
    return n ? { kind: "d", n, amud: daf[2] === "." ? 1 : 2 } : null;
  }
  if (/^\d{1,4}$/.test(p)) return { kind: "n", n: parseInt(p, 10) };
  // canonical numerals only: "הקדמה" sums to 154 but is a name
  if (/^[א-ת]{1,5}$/.test(p)) {
    const n = strictValue(p);
    if (n) return { kind: "n", n };
  }
  return { kind: "name", name: normalize(p) };
}

const keyOf = (l: Level): string => (l.kind === "n" ? `n${l.n}` : l.kind === "d" ? `d${l.n}${l.amud === 1 ? "a" : "b"}` : `$${l.name}`);

/** The levels of one line's heRef after the book's title, or null when it is not structured. */
export function heRefLevels(heRef: string | null, title: string): Level[] | null {
  if (!heRef) return null;
  const h = normTitle(heRef);
  const t = normTitle(title);
  if (!h.startsWith(`${t},`)) return null;
  const parts = h.slice(t.length + 1).split(",");
  const out: Level[] = [];
  for (const p of parts) {
    const l = levelOf(p);
    if (!l) return null;
    out.push(l);
  }
  return out.length ? out : null;
}

export function buildRefIndex(book: BookRef, lines: readonly RefLine[]): TargetIndex | null {
  const root = newNode();
  let structured = 0;
  let total = 0;
  let daf = 0;
  for (const l of lines) {
    if (!l.heRef) continue;
    total++;
    const levels = heRefLevels(l.heRef, book.title);
    if (!levels) continue;
    structured++;
    let node = root;
    touch(node, l.index);
    for (const lv of levels) {
      if (lv.kind === "d") daf++;
      const k = keyOf(lv);
      let next = node.children.get(k);
      if (!next) node.children.set(k, (next = newNode()));
      node = next;
      touch(node, l.index);
    }
  }
  if (!total || structured / total < MIN_STRUCTURED) return null;
  const isDaf = daf > structured / 2;
  return {
    book,
    via: "heref",
    daf: isDaf,
    resolve: (elems, collection, section) => resolveRefs(book, root, isDaf, elems, collection, section),
  };
}

function touch(n: Node, line: number): void {
  if (line < n.first) n.first = line;
  if (line > n.last) n.last = line;
}

const SA_PART_KEYS = new Set(["אורח חיים", "יורה דעה", "אבן העזר", "חושן משפט"].map((x) => normalize(x)));

/** Which citation kinds a collection's levels can be (a "?" is always allowed). */
const KINDS: Readonly<Record<Collection, ReadonlySet<Kind>>> = {
  tanakh: new Set(["perek", "pasuk", "mizmor"]),
  bavli: new Set(["daf"]),
  mishna: new Set(["perek", "mishna"]),
  yerushalmi: new Set(["perek", "halacha"]),
  tosefta: new Set(["perek", "halacha"]),
  rambam: new Set(["perek", "halacha"]),
  sa: new Set(["siman", "seif"]),
  "sa-commentary": new Set(["siman", "sk", "seif"]),
  tur: new Set(["siman"]),
  other: new Set(["perek", "pasuk", "siman", "seif", "sk", "halacha", "mishna", "os", "mizmor", "chelek"]),
};

/** The position of each kind in a two-level scheme: "פסוק ד" alone cannot be the first level. */
const SECOND_LEVEL = new Set<Kind>(["pasuk", "seif", "sk", "halacha", "mishna"]);

function resolveRefs(book: BookRef, root: Node, isDaf: boolean, elems: readonly AddrElem[], collection: Collection, section?: string): Resolution | null {
  let node = root;
  const label: string[] = [];
  if (section) {
    const s = node.children.get(`$${normalize(section)}`);
    if (s) {
      node = s;
      label.push(section);
    } else if ([...node.children.keys()].some((k) => k.startsWith("$") && SA_PART_KEYS.has(k.slice(1)))) return null; // another part
    // a book without parts (מגן אברהם on אורח חיים): the part named in the citation adds nothing
  }
  if (isDaf) return resolveDaf(book, node, elems, label);
  const allowed = KINDS[collection];
  // expand "נה א" (a bare letter after a number) into a second number
  const nums: { n: number; to?: number; kind: Kind }[] = [];
  for (const [i, e] of elems.entries()) {
    // a "." glued to the LAST number is punctuation ("בראשית א, כח."); "מט." alone is a daf
    if (e.kind === "daf" && (e.explicit || !e.amudGlued || i === 0)) return null;
    if (e.kind !== "?" && e.kind !== "daf" && !allowed.has(e.kind)) return null;
    nums.push({ n: e.n, kind: e.kind === "daf" ? "?" : e.kind, ...(e.to !== undefined && { to: e.to }) });
    if (e.maybeAmud) nums.push({ n: e.maybeAmud, kind: "?" });
  }
  if (!nums.length) return null;
  if (SECOND_LEVEL.has(nums[0]!.kind) && collection !== "other") return null;
  let rangeEnd: Node | null = null;
  for (const [i, x] of nums.entries()) {
    const next = node.children.get(`n${x.n}`);
    if (!next) return null;
    label.push(gem(x.n));
    if (x.to !== undefined) {
      if (i !== nums.length - 1) return null;
      const last = node.children.get(`n${x.to}`);
      if (!last) return null;
      rangeEnd = last;
      label[label.length - 1] += `-${gem(x.to)}`;
    }
    node = next;
  }
  const end = rangeEnd ? rangeEnd.last : node.last;
  return { book, line: node.first, end, leaf: node.children.size === 0 && !rangeEnd, wholeDaf: false, amudFromBareLetter: false, label: `${book.title} ${label.join(", ")}`, via: "heref", daf: false };
}

function resolveDaf(book: BookRef, node: Node, elems: readonly AddrElem[], label: string[]): Resolution | null {
  const e = elems[0]!;
  if (e.kind !== "daf" && e.kind !== "?") return null;
  if (e.to !== undefined) return null;
  let amud = e.amud ?? e.maybeAmud;
  let fromLetter = e.amud === undefined;
  if (elems.length > 1) {
    // "נה א" / "(ל"ד א')": a second number 1 or 2 right after the daf is its amud
    const s = elems[1]!;
    if (elems.length > 2 || amud !== undefined || s.kind !== "?" || (s.n !== 1 && s.n !== 2) || s.numeral.form === "gershayim") return null;
    amud = s.n as 1 | 2;
    fromLetter = true;
  }
  const a = node.children.get(`d${e.n}a`);
  const b = node.children.get(`d${e.n}b`);
  const lbl = (side: string) => `${book.title} ${[...label, `${gem(e.n)}${side}`].join(", ")}`;
  if (amud === 1 || amud === 2) {
    const side = amud === 1 ? a : b;
    if (!side) return null;
    return { book, line: side.first, end: side.last, leaf: false, wholeDaf: false, amudFromBareLetter: fromLetter, label: lbl(amud === 1 ? "." : ":"), via: "heref", daf: true };
  }
  if (!a && !b) return null;
  const first = (a ?? b)!.first;
  const last = (b ?? a)!.last;
  return { book, line: first, end: last, leaf: false, wholeDaf: true, amudFromBareLetter: false, label: lbl(""), via: "heref", daf: true };
}

const gem = (n: number): string => {
  const ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
  const HUN = ["", "ק", "ר", "ש", "ת", "תק", "תר", "תש", "תת", "תתק"];
  const r = n % 100;
  return HUN[Math.floor(n / 100)]! + (r === 15 ? "טו" : r === 16 ? "טז" : TENS[Math.floor(r / 10)]! + ONES[r % 10]!);
};

/* ---------- headings ---------- */

const HEADING_KIND: Readonly<Partial<Record<Kind, string>>> = {
  perek: "perek", pasuk: "pasuk", siman: "siman", seif: "seif", sk: "seifkatan", halacha: "halacha", mishna: "mishna", daf: "daf", os: "os", mizmor: "mizmor", chelek: "chelek",
};

/** A book with headings (פרק / סימן / דף…) as a target. Lines are the whole book, in order. */
export function buildHeadingsIndex(book: BookRef, lines: readonly EngineLine[]): TargetIndex {
  const s = analyzeBook({ book, lines }, { numbering: "lenient", untaggedHeadings: true });
  const isDaf = s.kinds.has("daf");
  // line indexes resolved now, so the index keeps no line text (it may be cached between runs)
  const units = buildUnits(s)
    .filter((u) => !u.marker)
    .map((u) => ({ path: u.path.filter((e) => e.kind !== "name"), line: lines[u.start]!.index, end: lines[u.end]!.index, leaf: !u.hasSubunits, label: `${book.title} ${u.path.map((e) => e.label).join(", ")}` }))
    .filter((u) => u.path.length > 0);
  const byLast = new Map<number, typeof units>();
  for (const u of units) {
    const n = u.path.at(-1)!.n!;
    byLast.set(n, [...(byLast.get(n) ?? []), u]);
  }
  return {
    book,
    via: units.length ? "headings" : "none",
    daf: isDaf,
    resolve(elems) {
      const want = expand(elems);
      if (!want) return null;
      const last = want.at(-1)!;
      const cands = (byLast.get(last.n) ?? []).filter((u) => u.path.length === want.length && u.path.every((e, i) => same(e, want[i]!)));
      const wholeDaf = last.kind === "daf" && last.amud === undefined;
      // "דף ב" with no amud: the one or two sides of that daf under the same parent
      const hits = wholeDaf && cands.length === 2 && cands.every((u) => u.path.at(-1)!.amud !== undefined) ? [{ ...cands[0]!, end: Math.max(cands[0]!.end, cands[1]!.end), line: Math.min(cands[0]!.line, cands[1]!.line), leaf: false }] : cands;
      if (hits.length !== 1) return null; // none, or several units with that path (several חלקים): no guess
      const u = hits[0]!;
      return { book, line: u.line, end: u.end, leaf: u.leaf, wholeDaf, amudFromBareLetter: false, label: u.label, via: "headings", daf: isDaf };
    },
  };
}

interface Want {
  kind: string;
  n: number;
  amud?: 1 | 2;
}

function expand(elems: readonly AddrElem[]): Want[] | null {
  const out: Want[] = [];
  for (const e of elems) {
    if (e.to !== undefined) return null;
    if (e.kind === "daf") {
      const amud = e.amud ?? e.maybeAmud;
      out.push({ kind: "daf", n: e.n, ...(amud && { amud }) });
      continue;
    }
    const k = e.kind === "?" ? "?" : HEADING_KIND[e.kind];
    if (!k) return null;
    out.push({ kind: k, n: e.n });
    if (e.maybeAmud) out.push({ kind: "?", n: e.maybeAmud });
  }
  return out.length ? out : null;
}

function same(e: PathElement, w: Want): boolean {
  if (e.kind === "daf") return w.kind === "daf" && e.n === w.n && (w.amud === undefined || e.amud === undefined || e.amud === w.amud);
  if (w.kind === "daf") return false;
  if (e.n !== w.n) return false;
  return w.kind === "?" || e.kind === "?" || e.kind === w.kind;
}
