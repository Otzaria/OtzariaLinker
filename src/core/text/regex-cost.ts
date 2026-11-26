/*
 * An upper bound on the backtracking work of a regular expression at ONE start position, for the
 * ReDoS guard (safe-regex.ts, Issue #41 B16). A rule per shape (no nested quantifiers, at most two
 * unbounded ones) let `a{1,8}a{1,8}…a{1,8}b` through: every link multiplies the number of ways to
 * split a run of "a" between them, 8^k, and k=7 ran 12–14 s on a 200-character line.
 *
 * The bound follows how a backtracking engine explores a sequence: an element with f choices
 * (`x{n,m}` has m−n+1, `x?` two, an alternation one per branch) runs the rest of the pattern once per
 * choice — f × (1 + rest). Choices only multiply when more than one of them can get far: each
 * choice is compared with what follows through a SIGNATURE, the characters the next few positions
 * can take on every path. A shorter repetition leaves another repetition next; when the rest can
 * never start like one, every choice but the longest fails within a few characters, and the cost
 * is f × (those few) + rest instead (`[א-ת]{1,6}\s{1,3}\d{1,4}` is a sum, `a{1,8}a{1,8}` a
 * product). In the same way, branches of an alternation add up unless their signatures are
 * pairwise disjoint at some position, and an optional group doubles the rest unless "take it" and
 * "skip it" are. A path that reaches the end of the pattern succeeds, and the first success ends
 * the search, so it constrains nothing.
 *
 * Conservative where it is not exact: a lookaround is charged its own cost on every path through
 * it, a lookbehind gets no discount (it is matched backwards), a signature that is too costly to
 * work out is "unknown", and under the `i` flag any set with a cased letter outside ASCII is
 * "anything". The pattern given is the one that RUNS (quantifiers already capped).
 */

/** A set of code points: `ranges`, or everything except them when `neg`. */
interface CharSet {
  readonly neg: boolean;
  readonly ranges: readonly (readonly [number, number])[];
}

type Node =
  | { readonly t: "char"; readonly set: CharSet }
  | { readonly t: "assert" }
  | { readonly t: "look"; readonly behind: boolean; readonly body: Alt }
  | { readonly t: "group"; readonly body: Alt }
  | { readonly t: "rep"; readonly node: Node; readonly min: number; readonly max: number };
type Seq = readonly Node[];
type Alt = readonly Seq[];

const ANY: CharSet = { neg: true, ranges: [] };
const DIGIT: [number, number][] = [[0x30, 0x39]];
const WORD: [number, number][] = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
const SPACE: [number, number][] = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];
const LINE_END: [number, number][] = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];
/** no case folding touches these: ASCII is folded by hand, the rest has no case */
const CASELESS: [number, number][] = [[0x00, 0x7f], [0xa0, 0xa0], [0x0590, 0x05ff], [0x1680, 0x1680], [0x2000, 0x206f], [0x3000, 0x3000], [0xfb1d, 0xfb4f], [0xfeff, 0xfeff]];
/** a union of more sets than this, at one position, is treated as "anything" */
const MAX_SET_LIST = 32;

class Parser {
  private i = 0;
  constructor(
    private readonly p: string,
    private flags: { readonly i: boolean; readonly s: boolean; readonly u: boolean },
    private readonly cap: number,
  ) {}

  parse(): Alt {
    const alt = this.alt();
    if (this.i < this.p.length) throw new Error("unbalanced )");
    return alt;
  }

  private alt(): Alt {
    const alts: Seq[] = [this.seq()];
    while (this.p[this.i] === "|") {
      this.i++;
      alts.push(this.seq());
    }
    return alts;
  }

  private seq(): Seq {
    const out: Node[] = [];
    while (this.i < this.p.length && this.p[this.i] !== "|" && this.p[this.i] !== ")") {
      const atom = this.atom();
      out.push(this.quantified(atom));
    }
    return out;
  }

  private quantified(atom: Node): Node {
    const c = this.p[this.i];
    let min: number, max: number;
    if (c === "*" || c === "+" || c === "?") {
      this.i++;
      [min, max] = c === "*" ? [0, this.cap] : c === "+" ? [1, this.cap] : [0, 1];
    } else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.p.slice(this.i));
      if (!m) return atom; // a literal "{" (outside u mode)
      this.i += m[0].length;
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] ? Number(m[3]) : min + this.cap;
    } else return atom;
    if (this.p[this.i] === "?") this.i++; // lazy: the same choices, in another order
    return { t: "rep", node: atom, min, max };
  }

  private atom(): Node {
    const c = this.p[this.i]!;
    if (c === "(") {
      this.i++;
      let look: "ahead" | "behind" | null = null;
      const modifiers = /^\?[a-z]*(?:-[a-z]*)?:/.exec(this.p.slice(this.i));
      const outer = this.flags;
      if (this.p.startsWith("?:", this.i)) this.i += 2;
      else if (this.p.startsWith("?=", this.i) || this.p.startsWith("?!", this.i)) (this.i += 2), (look = "ahead");
      else if (this.p.startsWith("?<=", this.i) || this.p.startsWith("?<!", this.i)) (this.i += 3), (look = "behind");
      else if (this.p.startsWith("?<", this.i)) this.i = this.p.indexOf(">", this.i) + 1;
      else if (modifiers) {
        // (?i:…) / (?-s:…): whichever way a flag is switched, read the body as if both were on (the wider sets)
        this.i += modifiers[0].length;
        this.flags = { ...outer, i: true, s: true };
      }
      const body = this.alt();
      this.flags = outer;
      if (this.p[this.i] !== ")") throw new Error("unbalanced (");
      this.i++;
      return look ? { t: "look", behind: look === "behind", body } : { t: "group", body };
    }
    this.i++;
    if (c === "[") return { t: "char", set: this.cls() };
    if (c === ".") return { t: "char", set: this.flags.s ? ANY : { neg: true, ranges: LINE_END } };
    if (c === "^" || c === "$") return { t: "assert" };
    if (c === "\\") {
      const e = this.p[this.i]!;
      if (e === "b" || e === "B") return this.i++, { t: "assert" };
      return { t: "char", set: this.fold(this.escape(false)) };
    }
    return { t: "char", set: this.fold(this.single(this.literal(c))) };
  }

  /** the code point of a literal that starts one character back (a surrogate pair is one in u mode) */
  private literal(c: string): number {
    const code = c.charCodeAt(0);
    if (this.flags.u && code >= 0xd800 && code <= 0xdbff && this.i < this.p.length) {
      const lo = this.p.charCodeAt(this.i);
      if (lo >= 0xdc00 && lo <= 0xdfff) return this.i++, (code - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
    }
    return code;
  }

  /** an escape after "\" (the index is on the escaped character); a set, or for a class item a single code point */
  private escape(inClass: boolean): CharSet {
    const e = this.p[this.i++]!;
    switch (e) {
      case "d": return { neg: false, ranges: DIGIT };
      case "D": return { neg: true, ranges: DIGIT };
      case "w": return this.flags.i && this.flags.u ? ANY : { neg: false, ranges: WORD }; // \w/iu also takes ſ and K (U+212A)
      case "W": return { neg: true, ranges: WORD };
      case "s": return { neg: false, ranges: SPACE };
      case "S": return { neg: true, ranges: SPACE };
      case "p": case "P":
        if (this.flags.u && this.p[this.i] === "{") this.i = this.p.indexOf("}", this.i) + 1;
        return ANY;
      case "n": return this.single(0x0a);
      case "r": return this.single(0x0d);
      case "t": return this.single(0x09);
      case "f": return this.single(0x0c);
      case "v": return this.single(0x0b);
      case "0": return this.single(0);
      case "b": return this.single(inClass ? 0x08 : 0x62);
      case "c": {
        const l = this.p.charCodeAt(this.i);
        if (/[A-Za-z]/.test(this.p[this.i] ?? "")) return this.i++, this.single(l % 32);
        return this.single(0x5c);
      }
      case "x": {
        const m = /^[0-9a-fA-F]{2}/.exec(this.p.slice(this.i));
        if (m) return (this.i += 2), this.single(parseInt(m[0], 16));
        return this.single(0x78);
      }
      case "u": {
        const braced = this.flags.u ? /^\{([0-9a-fA-F]{1,6})\}/.exec(this.p.slice(this.i)) : null;
        if (braced) return (this.i += braced[0].length), this.single(parseInt(braced[1]!, 16));
        const m = /^[0-9a-fA-F]{4}/.exec(this.p.slice(this.i));
        if (m) return (this.i += 4), this.single(parseInt(m[0], 16));
        return this.single(0x75);
      }
      default:
        // a back-reference is refused before this runs; whatever it would be, it can match anything
        if (/[1-9]/.test(e) || e === "k") return ANY;
        return this.single(this.literal(e));
    }
  }

  private cls(): CharSet {
    let neg = false;
    if (this.p[this.i] === "^") (neg = true), this.i++;
    const ranges: (readonly [number, number])[] = [];
    let any = false;
    while (this.i < this.p.length && this.p[this.i] !== "]") {
      const lo = this.classAtom();
      if (lo === null) {
        any = true;
        continue;
      }
      if (typeof lo !== "number") {
        ranges.push(...lo);
        continue;
      }
      if (this.p[this.i] === "-" && this.p[this.i + 1] !== "]" && this.i + 1 < this.p.length) {
        this.i++;
        const hi = this.classAtom();
        if (typeof hi === "number") {
          ranges.push([lo, Math.max(lo, hi)]);
          continue;
        }
        ranges.push([lo, lo], [0x2d, 0x2d]);
        if (hi === null) any = true;
        else ranges.push(...hi);
        continue;
      }
      ranges.push([lo, lo]);
    }
    this.i++; // "]"
    // a negated escape inside a class ([\D_]) is a complement within a union: just call it anything
    if (any) return ANY;
    return this.fold({ neg, ranges });
  }

  /** one class item: a code point, the ranges of \d \w \s, or null for what cannot be listed (\D, \p{…}) */
  private classAtom(): number | (readonly (readonly [number, number])[]) | null {
    const c = this.p[this.i++]!;
    if (c !== "\\") return this.literal(c);
    const set = this.escape(true);
    if (set.neg) return null;
    if (set.ranges.length === 1 && set.ranges[0]![0] === set.ranges[0]![1]) return set.ranges[0]![0];
    return set.ranges;
  }

  /** one code point, not case-folded yet: a class folds its whole set once, ranges included */
  private single(code: number): CharSet {
    return { neg: false, ranges: [[code, code]] };
  }

  /** Under `i`: ASCII letters get their other case; a set with any other cased letter is "anything". */
  private fold(set: CharSet): CharSet {
    if (!this.flags.i || set === ANY) return set;
    const out: [number, number][] = [];
    for (const [lo, hi] of set.ranges) {
      if (!covered(lo, hi, CASELESS)) return ANY;
      out.push([lo, hi]);
      const upper = clip(lo, hi, 0x61, 0x7a);
      if (upper) out.push([upper[0] - 0x20, upper[1] - 0x20]);
      const lower = clip(lo, hi, 0x41, 0x5a);
      if (lower) out.push([lower[0] + 0x20, lower[1] + 0x20]);
    }
    return { neg: set.neg, ranges: out };
  }
}

function clip(lo: number, hi: number, a: number, b: number): [number, number] | null {
  const l = Math.max(lo, a);
  const h = Math.min(hi, b);
  return l <= h ? [l, h] : null;
}

/** whether [lo, hi] lies inside the union of `ranges` */
function covered(lo: number, hi: number, ranges: readonly (readonly [number, number])[]): boolean {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  let at = lo;
  for (const [a, b] of sorted) {
    if (a > at) break;
    if (b >= at) at = b + 1;
    if (at > hi) return true;
  }
  return at > hi;
}

function overlaps(a: CharSet, b: CharSet): boolean {
  if (a.neg && b.neg) return true;
  if (a.neg || b.neg) {
    const [n, p] = a.neg ? [a, b] : [b, a];
    return p.ranges.some(([lo, hi]) => !covered(lo, hi, n.ranges));
  }
  return a.ranges.some(([lo, hi]) => b.ranges.some(([x, y]) => lo <= y && x <= hi));
}

const anyOverlap = (a: readonly CharSet[], b: readonly CharSet[]) => a.some((x) => b.some((y) => overlaps(x, y)));

function union(a: readonly CharSet[], b: readonly CharSet[]): readonly CharSet[] {
  if (a === b) return a;
  const out = [...a, ...b];
  return out.length > MAX_SET_LIST || out.includes(ANY) ? [ANY] : out;
}

function nullable(n: Node): boolean {
  switch (n.t) {
    case "char": return false;
    case "assert": case "look": return true;
    case "group": return n.body.some((s) => s.every(nullable));
    case "rep": return n.min === 0 || nullable(n.node);
  }
}

/** a fixed run of single characters: one per position, no choice inside */
function fixedChars(n: Node): readonly CharSet[] | null {
  if (n.t === "char") return [n.set];
  if (n.t === "rep" && n.min === n.max && n.max <= 16) {
    const inner = fixedChars(n.node);
    return inner && Array.from({ length: n.min }, () => inner).flat();
  }
  if (n.t !== "group" || n.body.length !== 1) return null;
  const out: CharSet[] = [];
  for (const e of n.body[0]!) {
    const f = fixedChars(e);
    if (!f) return null;
    out.push(...f);
  }
  return out;
}

/** What comes after the element being costed: the rest of a sequence, then what follows that sequence. */
interface Cont {
  readonly seq: Seq;
  readonly i: number;
  readonly next: Cont | null;
}

/**
 * The first SIG_DEPTH characters any path through a continuation can consume (one list of sets per
 * position; shorter when a path ends or cannot be followed — "unknown" beyond), and `probes[d]`:
 * an upper bound on the work of walking every path through positions 0..d, which is what the
 * continuation costs when it fails at position d at the latest.
 */
interface Sig {
  readonly sets: readonly (readonly CharSet[])[];
  readonly probes: readonly number[];
}

const SIG_DEPTH = 6;
const UNKNOWN: Sig = { sets: [], probes: [] };
/** walks of one signature beyond this give up ("unknown": never a reason for a discount) */
const SIG_STEPS = 4000;
const TOTAL_STEPS = 200_000;

function mergeSigs(a: Sig, b: Sig): Sig {
  const n = Math.min(a.sets.length, b.sets.length);
  const sets: (readonly CharSet[])[] = [];
  const probes: number[] = [];
  for (let k = 0; k < n; k++) sets.push(union(a.sets[k]!, b.sets[k]!)), probes.push(a.probes[k]! + b.probes[k]!);
  return { sets, probes };
}

/** The first position at which no input can satisfy both signatures (their characters are disjoint), or -1. */
function divergence(a: Sig, b: Sig): number {
  for (let k = 0; k < Math.min(a.sets.length, b.sets.length); k++) if (!anyOverlap(a.sets[k]!, b.sets[k]!)) return k;
  return -1;
}

const at = (seq: Seq, i: number, next: Cont | null): Cont => ({ seq, i, next });
const repOf = (n: Extract<Node, { t: "rep" }>, min: number, max: number): Node => ({ t: "rep", node: n.node, min, max });

class Cost {
  private readonly looks = new Map<Node, number>();
  private steps = 0;
  /** all walks of one analysis: past TOTAL_STEPS every signature is unknown, so the analysis stays fast */
  private total = 0;

  constructor(private readonly budget: number) {}

  alt(alt: Alt, k: number, cont: Cont | null, exact: boolean): number {
    if (alt.length === 1) return this.seq(alt[0]!, k, cont, exact);
    const costs = alt.map((s) => this.seq(s, k, cont, exact));
    if (!exact) {
      // branches that pairwise cannot match the same text: the losers fail within their signature, one goes on
      const sigs = alt.map((s) => this.sig(at(s, 0, cont)));
      let losers = 0;
      for (let x = 0; x < sigs.length && losers >= 0; x++) {
        // when another branch is the one that matches, branch x fails by the last position it differs from them
        let last = 0;
        for (let y = 0; y < sigs.length && last >= 0; y++) {
          if (x === y) continue;
          const d = divergence(sigs[x]!, sigs[y]!);
          last = d < 0 ? -1 : Math.max(last, d);
        }
        losers = last < 0 ? -1 : losers + sigs[x]!.probes[last]!;
      }
      if (losers >= 0) return losers + Math.max(...costs);
    }
    return costs.reduce((a, b) => a + b, 0);
  }

  /** `exact`: no discount (inside a lookbehind, which is matched backwards) */
  seq(s: Seq, k: number, cont: Cont | null, exact: boolean): number {
    let cost = k;
    for (let i = s.length - 1; i >= 0 && cost <= this.budget; i--) cost = this.node(s[i]!, cost, at(s, i + 1, cont), exact);
    return cost;
  }

  /** The cost of `n` followed by `rest`, whose own cost is `k`. */
  node(n: Node, k: number, rest: Cont, exact: boolean): number {
    switch (n.t) {
      case "char":
      case "assert":
        return 1 + k;
      case "look":
        // atomic: its body runs to its own first success, then the pattern goes on once
        return this.lookCost(n) + k;
      case "group":
        return this.alt(n.body, k, rest, exact);
      case "rep": {
        if (n.max === 0) return 1 + k;
        const fixed = fixedChars(n.node);
        if (fixed && fixed.length) {
          const choices = n.max - n.min + 1;
          if (choices === 1) return 1 + k;
          // a shorter choice leaves another repetition next; when the rest cannot start with one, every
          // choice but the longest fails within the rest's signature
          if (!exact) {
            const restSig = this.sig(rest);
            const body: Sig = { sets: fixed.slice(0, SIG_DEPTH).map((c) => [c]), probes: [] };
            const d = divergence(body, restSig);
            if (d >= 0) return (choices - 1) * (1 + restSig.probes[d]!) + 1 + k;
          }
          return choices * (1 + k);
        }
        return this.repCost(n, n.min, n.max, k, rest, exact);
      }
    }
  }

  /** A repetition whose body has choices of its own, unrolled: required copies, then "take it or not" ones. */
  private repCost(n: Extract<Node, { t: "rep" }>, min: number, max: number, k: number, rest: Cont, exact: boolean): number {
    if (max === 0 || k > this.budget) return k;
    const remaining = repOf(n, Math.max(0, min - 1), max - 1);
    const afterCopy = at([remaining], 0, rest);
    const take = this.node(n.node, this.repCost(n, Math.max(0, min - 1), max - 1, k, rest, exact), afterCopy, exact);
    if (min > 0) return take;
    if (!exact) {
      const takeSig = this.sig(at([n.node], 0, afterCopy));
      const skipSig = this.sig(rest);
      const d = divergence(takeSig, skipSig);
      // taking the copy and skipping it cannot both get past position d: one of them fails by then
      if (d >= 0) return Math.max(take, k) + takeSig.probes[d]! + skipSig.probes[d]!;
    }
    return take + k;
  }

  private lookCost(n: Extract<Node, { t: "look" }>): number {
    let c = this.looks.get(n);
    if (c === undefined) this.looks.set(n, (c = this.alt(n.body, 0, null, n.behind)));
    return c;
  }

  sig(cont: Cont | null): Sig {
    this.steps = 0;
    return this.walk(cont, SIG_DEPTH);
  }

  private walk(cont: Cont | null, depth: number): Sig {
    if (++this.steps > SIG_STEPS || ++this.total > TOTAL_STEPS || depth === 0) return UNKNOWN;
    // the end of the pattern (or of a lookahead's body): a path that gets here succeeds, and the first
    // success ends the search — it constrains nothing and never fails
    if (cont === null) return { sets: Array<readonly CharSet[]>(depth).fill([]), probes: Array<number>(depth).fill(0) };
    if (cont.i >= cont.seq.length) return this.walk(cont.next, depth);
    const n = cont.seq[cont.i]!;
    const next = at(cont.seq, cont.i + 1, cont.next);
    switch (n.t) {
      case "char": {
        const r = this.walk(next, depth - 1);
        return { sets: [[n.set], ...r.sets], probes: [1, ...r.probes.map((p) => 1 + p)] };
      }
      case "assert":
      case "look": {
        // zero-width: the characters come from what follows; checking it is part of the walk
        const r = this.walk(next, depth);
        const c = n.t === "look" ? this.lookCost(n) : 1;
        return { sets: r.sets, probes: r.probes.map((p) => c + p) };
      }
      case "group":
        return n.body.map((s) => this.walk(at(s, 0, next), depth)).reduce(mergeSigs);
      case "rep": {
        if (n.max === 0) return this.walk(next, depth);
        if (nullable(n.node)) return UNKNOWN; // a copy may consume nothing: no bound on the paths
        const take = this.walk(at([n.node, repOf(n, Math.max(0, n.min - 1), n.max - 1)], 0, next), depth);
        return n.min > 0 ? take : mergeSigs(take, this.walk(next, depth));
      }
    }
  }
}

/**
 * The bound on the backtracking steps of `source` at one start position; any value above `budget`
 * may be returned as soon as it is known to exceed it. Throws on a pattern it cannot parse.
 */
export function backtrackingCost(source: string, flags: string, opts: { readonly cap: number; readonly budget: number }): number {
  const ast = new Parser(source, { i: flags.includes("i"), s: flags.includes("s"), u: flags.includes("u") }, opts.cap).parse();
  return new Cost(opts.budget).alt(ast, 0, null, false);
}

