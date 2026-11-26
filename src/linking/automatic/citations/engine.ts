import { INLINE_LINKER_TYPE, inlineLinkerVersionNote } from "../../../core/links/connection-type";
import type { BookRef, LinkSide, RawAnchor } from "../../../core/links/model";
import {
  confidenceOf,
  CONFIDENCE_ORDER,
  DEFAULT_THRESHOLDS,
  type Candidate,
  type Confidence,
  type ConfidenceThresholds,
  type EngineBook,
  type EngineContext,
  type EngineResult,
  type Reason,
  type Suggestion,
} from "../types";
import { pageShaped, type AddrElem } from "./address";
import { AliasIndex, COMMON_TITLES, type AliasTarget, type CatalogBook, type Collection } from "./aliases";
import { CitationScanner, type Citation } from "./detect";
import { NamedUnitIndex, unitKindOf, unitNameKey, type NamedUnit, type NamedUnitSource } from "./named";
import type { Resolution, TargetIndex } from "./resolve";
import { resolveInternal } from "./self";
import { resolveAltDaf, type DafStructure } from "./altdaf";
import { hebrewTokens } from "../../../matching/hebrew-tokens";
import { keySimilarity } from "../../../matching/token-match";
import { firstRefIn, refBlockByHeRef, sefariaOwnedOf, type RefBlock, type SefariaOwned, type SefariaOwnedOption } from "../../../core/links/sefaria-owned";

/*
 * The CITATIONS engine ("מראי מקומות"): finds references to other books in ONE book's text and links
 * each to the line it names. Single-book: the targets are whatever books the open sources hold.
 *
 * A run has three steps so the worker can keep memory bounded (workers/citations-job.ts):
 *   1. scan  — the source book chunk by chunk: citation spans with their candidate books (detect.ts);
 *   2. resolve — for each book some citation may mean, its index is built once (resolve.ts), every
 *      citation that names it is resolved, and the index is dropped;
 *   3. finish — per citation, the best resolved candidate becomes a suggestion with a confidence.
 * `runCitationsEngine` does the three in memory, for tests and small inputs.
 *
 * Record shape: source = the citing line, target = the cited line (or range), type "reference". It is
 * a REFERENCE in Otzaria: shown in the links panel of both books, never flipped by the generator, so
 * the anchor on the citation words survives (LINK_FORMATS §1.5–1.6, OTZARIA_COMPATIBILITY §2). The
 * database's own citation layer (LINKER) cannot be written by a links file (the generator skips
 * "linker" records, LINK_FORMATS §1.4). The anchor is written only between two Otzaria books, as the
 * library pipeline requires (§1.8: no `start` towards a Sefaria book, no `end` on a Sefaria record).
 */

export interface CitationsOptions extends SefariaOwnedOption {
  /** suggestions below this confidence are not returned. Default "possible". */
  readonly minConfidence?: "certain" | "high" | "possible";
  /** resolve "שם" (ibid). Default true. */
  readonly ibid?: boolean;
  /** a citation of a whole chapter / daf links to the whole range (true) or only to its first line. Default true. */
  readonly ranges?: boolean;
  /** "auto": an anchor on the citation words when both books are Otzaria's; "off": never. */
  readonly anchors?: "auto" | "off";
  /**
   * "reference" (default): a REFERENCE link, which the library accepts. "inline-linker": the app's "ציטוט בטקסט"
   * (INLINE_LINKER, core/links/connection-type.ts) — clickable inside the text, with an anchor also towards a Sefaria
   * book. For PRIVATE use only: the library does not know it, and validateLink holds it back unless the export is
   * for private use (LINK_FORMATS §1.12). Where the anchor cannot be written (a Sefaria source, a line with merged
   * notes, anchors off) the suggestion stays a REFERENCE.
   */
  readonly citationType?: "reference" | "inline-linker";
  /** "all" books, or only the classic corpora (Tanakh, Mishna, both Talmuds, Tosefta, Rambam, Tur, Shulchan Aruch and its commentaries). */
  readonly scope?: "all" | "classic";
  readonly thresholds?: ConfidenceThresholds;
  /** alternatives kept on each suggestion. Default 3. */
  readonly maxAlternatives?: number;
  /**
   * Run on a book although the suitability gate sees no sign of a place in it (suitability.ts CITATION_GATE): a book that cites by the name of a
   * book and numbers alone, with no place word, may be skipped by it. Default false.
   */
  readonly noGate?: boolean;
}

const ENGINE = "citations" as const;
const PROGRESS_EVERY = 2000;

/* ---------- the confidence ladder (calibrated on the real library, docs/AUTOMATION_ENGINE.md §6) ---------- */

const TIER_SCORE = { title: 1, derived: 0.99, acronym: 0.95, secondary: 0.9 } as const;
const PENALTY = {
  medium: 0.04,
  /** one bare number on a chapter/verse book ("(משלי ב)"): the easiest reading to get wrong */
  singleBare: 0.03,
  wholeDaf: 0.04,
  amudFromBareLetter: 0.04,
  /**
   * "(שם)" alone: the place is the last citation's, and nothing in the words confirms it — at most "possible"
   * (§6.8: 12% confirmed by the database, about 70% right by hand; it was 0.09, "high")
   */
  ibidFull: 0.16,
  ibidPartial: 0.1,
  ibidBook: 0.06,
  commentator: 0.03,
  /** located by the target's headings, not its references: weaker evidence of the right unit */
  headings: 0.1,
  /** a title that is also an everyday word ("דברים", "שבת"), with one number and nothing else */
  commonTitle: 0.07,
  /**
   * "תהלים פ"ו": chapter 6 or Psalm 86; "תה' פ' ב": chapter 2 or Psalm 80 verse 2 — only when the book has
   * both places (in בראשית "פ"ו" can only be chapter 6)
   */
  compactOrNumber: 0.12,
  numericName: 0.05,
  otherCollection: 0.06,
  commonNumeral: 0.05,
  reversed: 0.02,
  relative: 0.03,
  /** "במשנה (ב"ק דף ט:)": a collection word that does not fit the book */
  qualifierMismatch: 0.08,
  /** a unit cited by name with a location found inside it ("בפ' הזהב (דף מד.)"), the book not named */
  named: 0.02,
  /**
   * the link is the whole unit ("בפרק הזהב", "בפרשת וירא"): a coarse target, and the share the
   * database confirms is low (it rarely links these) — at most "possible" (§6.8)
   */
  unitRange: 0.16,
  /** no book named next to it and no base book: the name alone told the book */
  unitAlone: 0.04,
  /** the words are only the start of the unit's name ("פרק האשה" for "האשה שהיא עושה") */
  unitPartial: 0.03,
  /** a location after the name was not found in the book; the unit itself is linked */
  unitFallback: 0.03,
  /** a Rambam topic read from its initials ("פ"ג מא"ב"): one topic has them, but an abbreviation is a guess */
  rambamInitials: 0.04,
  /** "דף לה" with no tractate in a commentary on one: the tractate is inferred from the book, not written */
  baseDaf: 0.07,
  /**
   * "בפרק קמא דכתובות" with nothing after: the Mishna's chapter is the nearest target, but books mostly
   * mean the Gemara's discussion in it — at most "possible"
   */
  ordinalChapter: 0.05,
  /**
   * "המל"מ פ"ג מהל' תרומות": the commentary's whole chapter on it — coarse (the database rarely links
   * these), at most "possible"; a halacha after it is a precise place
   */
  rambamCommentaryChapter: 0.1,
  /**
   * "לעיל סי' ה", "לקמן כלל ז": a place in the citing book itself (self.ts). The level's kind was told by the
   * book's own headings and the place lies the way the words point; the database has few such links to
   * confirm it (§6.8), so it stays "high"
   */
  internal: 0.06,
  /**
   * "(א, כ"ז)" with no book: the book a heading above names ("ספר בראשית") or the one this book comments
   * on — told by the context, not the words: at most "high", like "שם"
   */
  implicitContext: 0.1,
  /** the same, from the citation before it a line or more away, or a daf: one in four wrong by hand — "possible" */
  implicitFar: 0.1,
  /** "הריב"ש סי' ת"ו": an author's responsa by his name alone (no "בתשו'"): his only work in the library */
  responsaAuthor: 0.05,
  /**
   * the author's other work, when his responsa were cited by his name alone: when both have the place the
   * responsa win (the margin of "ambiguous" is 0.05) — before, a siman in both was a tie and nothing was linked
   */
  otherWork: 0.06,
  /** "ובמדרש רבה [ויקרא פכ"ב]": the midrash of the book named, told by the word before it — at most "high" */
  midrashRabbah: 0.05,
  /**
   * a daf of a book's printed pagination (the Zohar): the page by the alt_toc, while the database's links
   * put about one quote in ten tens of lines away (פנחס, where sections printed beside the page interleave) —
   * "possible" until the two are reconciled (§6.3ג)
   */
  pages: 0.15,
  pagesSplit: 0.15,
  /** "שם" more than six lines (up to fifteen) after the citation it completes, with no heading between */
  ibidFar: 0.05,
  /**
   * "ברכות יג: ד"ה והא" with no commentator's name (issue #41 B7): the ד"ה is some commentary's words on the daf; the daf itself is
   * linked, a coarse target — at most "possible", like a unit cited by name
   */
  diburNoCommentator: 0.16,
  /**
   * "הוריות 10 סעיפים" (issue #41 B8): one bare Arabic number between a name that is also a word and a Hebrew word — as often a count
   * of that word as an address; at most "possible"
   */
  quantityLike: 0.16,
  /**
   * a siman of a book in parts of the Shulchan Aruch (by its headings), with no part in the context (issue #42 C20): the simanim
   * restart in each part, and only one part's was found — at most "possible" (a book by headings already pays 0.1)
   */
  partUndecided: 0.06,
  /**
   * loose forms read in the V7 round (issue #42 C21): one bare numeral where the words end ("בראשית א.", "ויקרא רבה ג"), a name
   * that is also a numeral outside brackets ("שמ"א ג ד") — each was no place before, for a reason (prose writes them): "possible"
   */
  looseForm: 0.16,
} as const;

export interface Pending {
  readonly citation: Citation;
  /** fallback: a unit cited by name whose location was not found (the unit is linked); addressed: its location was; dibur: the ד"ה's line was found */
  /** partUndecided: found in one part of a book in parts of the Shulchan Aruch, and the context names none (issue #42 C20) */
  readonly resolved: { target: AliasTarget; res: Resolution; heRef: string | null; fallback?: boolean; addressed?: boolean; dibur?: boolean; partUndecided?: boolean }[];
  /** books whose index could not be read or had no structure */
  unindexed: number;
  /** the place was found only in another part of the Shulchan Aruch than the context's (issue #42 C20) */
  partMismatch?: { want: string; found: string };
  /** the numbers' other reading ("פ"ב" as 82) names a place in one of the candidate books */
  altElsewhere?: boolean;
}

export class CitationRun {
  private readonly scanner: CitationScanner;
  private readonly pending = new Map<number, Pending>();
  /**
   * The pending citations by candidate book (built by targets(), after the scan): each step of the resolution
   * visits only the citations that may mean its book — a big book (מיקרופדיה תלמודית: ~100K citations of ~2K books)
   * would otherwise walk every citation once per book and step.
   */
  private byBook: Map<string, Pending[]> | null = null;
  /** the books resolveWith() has been run for: after a cancel, a citation with a candidate not among them is not ranked */
  private readonly resolvedBooks = new Set<string>();
  private readonly opts: Required<Omit<CitationsOptions, "thresholds" | "sefariaOwned">> & { thresholds: ConfidenceThresholds };
  /** the library's answer to "is this a Sefaria book" (core/links/sefaria-owned.ts): no anchor and no range on such a side */
  private readonly sefariaOwned: SefariaOwned;
  private lines = 0;
  /** source lines with merged notes: an anchor there would cancel the notes merge (validate.ts) */
  private readonly notesLines = new Set<number>();
  /** per cited book with known heRefs: which lines a single-line record into it can carry (firstRef, sefaria-owned.ts) */
  private readonly refBlocks = new Map<string, RefBlock>();

  constructor(
    readonly source: BookRef,
    readonly aliases: AliasIndex,
    options: CitationsOptions = {},
    /** chapter and parsha names (alt_toc of the Bavli and the Torah); without it no unit is cited by name */
    readonly units: NamedUnitIndex = NamedUnitIndex.build([]),
  ) {
    this.opts = {
      minConfidence: options.minConfidence ?? "possible",
      ibid: options.ibid ?? true,
      ranges: options.ranges ?? true,
      anchors: options.anchors ?? "auto",
      citationType: options.citationType ?? "reference",
      scope: options.scope ?? "all",
      thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
      maxAlternatives: options.maxAlternatives ?? 3,
      noGate: options.noGate ?? false,
    };
    this.sefariaOwned = sefariaOwnedOf(options.sefariaOwned);
    this.scanner = new CitationScanner(aliases, source.key, { ibid: this.opts.ibid, self: source }, source.title, units);
  }

  static fromCatalog(source: BookRef, catalog: readonly CatalogBook[], options: CitationsOptions = {}, units: readonly NamedUnitSource[] = []): CitationRun {
    return new CitationRun(source, AliasIndex.build(catalog), options, NamedUnitIndex.build(units));
  }

  /**
   * Whether resolving against `book` needs its own named units, beyond the indexed ones: a chapter
   * cited by name and moved to a commentary ("תוס' פ' השולח" → תוספות על גיטין, its own chapters).
   */
  needsUnits(book: BookRef): boolean {
    if (this.units.byBook.has(book.key)) return false;
    for (const p of this.pendingOf(book)) if (p.citation.unit || chapterByNumber(p.citation)) return true;
    return false;
  }

  /**
   * Whether resolving against `book` needs its printed pagination (altdaf.ts): a citation of it by daf
   * ("זוה"ק ח"א פ"ט ע"ב") when its own references are not by daf.
   */
  wantsPages(book: BookRef, index: TargetIndex | null): boolean {
    if (index?.daf) return false;
    for (const p of this.pendingOf(book)) if (pageShaped(p.citation.elems)) return true;
    return false;
  }

  /**
   * Step 2c (optional): the lines of `book` a ד"ה must be looked for in — a commentator's whole amud
   * ("תוס' … ד"ה רבי מאיר"). The caller reads them and hands them to refineDibur().
   */
  diburSpans(book: BookRef): { line: number; end: number }[] {
    const out: { line: number; end: number }[] = [];
    for (const p of this.pendingOf(book)) {
      if (!p.citation.dh?.length) continue;
      for (const r of p.resolved) if (r.target.book.key === book.key && r.res.end > r.res.line && r.res.end - r.res.line <= MAX_DIBUR_SPAN) out.push({ line: r.res.line, end: r.res.end });
    }
    return out;
  }

  /**
   * The commentator's line whose heading starts with the ד"ה's words (the first two or three, each the same
   * word or one letter off — matching/token-match), within the amud the citation was resolved to. One
   * such line: the link is to it; none or several: the amud stays.
   */
  refineDibur(book: BookRef, lines: readonly { index: number; text: string }[], heRefAt?: (line: number) => string | null): void {
    const byIndex = new Map(lines.map((l) => [l.index, l.text] as const));
    for (const p of this.pendingOf(book)) {
      const dh = p.citation.dh;
      if (!dh?.length) continue;
      const want = dh.slice(0, Math.min(3, dh.length));
      for (const [k, r] of p.resolved.entries()) {
        if (r.target.book.key !== book.key || r.res.end <= r.res.line || r.dibur) continue;
        const hits: number[] = [];
        for (let i = r.res.line; i <= r.res.end; i++) {
          const text = byIndex.get(i);
          if (text !== undefined && opensWith(text, want)) hits.push(i);
        }
        if (hits.length !== 1) continue;
        const line = hits[0]!;
        p.resolved[k] = { ...r, res: { ...r.res, line, end: line, leaf: true, label: `${r.res.label} ד"ה ${dh.slice(0, 3).join(" ")}` }, heRef: heRefAt?.(line) ?? null, dibur: true };
      }
    }
  }

  /** Step 1: lines of the source book, in order (any chunk size). `heRef` (the line's own reference) places its internal references. */
  scan(lines: readonly { index: number; text: string; heading: number | null; heRef?: string | null }[]): void {
    for (const l of lines) {
      this.lines++;
      if (l.text.includes('class="footnote"')) this.notesLines.add(l.index);
      const before = this.scanner.citations.length;
      this.scanner.scanLine(l.index, l.text, l.heading, l.heRef);
      for (let k = before; k < this.scanner.citations.length; k++) {
        const c = this.scanner.citations[k]!;
        const cands = this.opts.scope === "classic" ? c.candidates.filter((x) => x.collection !== "other") : c.candidates;
        if (cands.length) this.pending.set(c.seq, { citation: { ...c, candidates: cands }, resolved: [], unindexed: 0 });
      }
    }
    this.byBook = null;
  }

  /** the pending citations that may mean `book` */
  private pendingOf(book: BookRef): readonly Pending[] {
    if (!this.byBook) {
      this.byBook = new Map();
      for (const p of this.pending.values())
        for (const key of new Set(p.citation.candidates.map((c) => c.book.key))) {
          const list = this.byBook.get(key);
          if (list) list.push(p);
          else this.byBook.set(key, [p]);
        }
    }
    return this.byBook.get(book.key) ?? [];
  }

  /** Step 2a: every book some citation may point to (each once, in a stable order). */
  targets(): BookRef[] {
    const out = new Map<string, BookRef>();
    for (const p of this.pending.values()) for (const c of p.citation.candidates) out.set(c.book.key, c.book);
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * Step 2b: resolves every citation that may mean `index.book`. `heRefAt` gives a target line's
   * reference, if known; `bookUnits` the book's own named units when needsUnits() asked for them.
   */
  resolveWith(index: TargetIndex | null, book: BookRef, heRefAt?: (line: number) => string | null, bookUnits?: readonly NamedUnit[] | null, pages?: DafStructure | null): void {
    // the citing book's own levels, for its internal references: known once the whole book was scanned
    const depthKinds = book.key === this.source.key ? this.scanner.structure.depthKinds() : [];
    this.resolvedBooks.add(book.key);
    if (heRefAt && !this.refBlocks.has(book.key)) this.refBlocks.set(book.key, refBlockByHeRef(heRefAt));
    for (const p of this.pendingOf(book)) {
      for (const t of p.citation.candidates) {
        if (t.book.key !== book.key) continue;
        if (p.citation.internal) {
          const res = index && book.key === this.source.key ? resolveInternal(p.citation.internal, p.citation.line, p.citation.elems, index, depthKinds) : null;
          if (res) p.resolved.push({ target: t, res, heRef: res.line === res.end && heRefAt ? heRefAt(res.line) : null });
          else if (!index || index.via === "none") p.unindexed++;
          continue;
        }
        // "בזוה"ק (וירא קג:)", "זוה"ק ח"א פ"ט ע"ב": a daf of the book's printed pagination
        if (pages && !index?.daf && pageShaped(p.citation.elems) && (!p.citation.unit || p.citation.unit.kind === "parsha")) {
          const u = p.citation.unit;
          const span = u ? (index?.resolveNamed?.(u.key, []) ?? null) : null;
          const res = resolveAltDaf(pages, p.citation.elems, u ? { key: u.key, span } : null);
          if (res) {
            p.resolved.push({ target: t, res, heRef: null, ...(p.citation.unit && { addressed: true }) });
            continue;
          }
        }
        if (p.citation.unit) {
          const found = resolveUnit(p.citation, t, index, this.units.byBook.get(book.key) ?? bookUnits ?? null);
          const res = found && { ...found, r: contentStart(found.r, index, heRefAt) };
          if (res) p.resolved.push({ target: t, res: res.r, heRef: res.r.line === res.r.end && heRefAt ? heRefAt(res.r.line) : null, ...(res.fallback && { fallback: true }), ...(res.addressed && { addressed: true }) });
          else if (!index || index.via === "none") p.unindexed++;
          continue;
        }
        if (!index || index.via === "none") {
          p.unindexed++;
          continue;
        }
        // "תוס' פ"ק דסנהדרין", "בש"ס פ"ב דכתובות": a chapter alone of a book by daf (a tractate, a commentary on
        // one) is its Nth chapter in the book's own structure (alt_toc "Chapters") — the whole chapter
        if (index.daf && chapterByNumber(p.citation)) {
          const n = p.citation.elems[0]!.n;
          const chapters = (this.units.byBook.get(book.key) ?? bookUnits ?? []).filter((x) => x.kind === "chapter");
          // "פרק בתרא": the last chapter
          const u = n === 0 ? chapters.at(-1) : chapters.find((x) => x.ordinal === n);
          if (u) p.resolved.push({ target: t, res: contentStart({ book, line: u.line, end: u.end, leaf: false, wholeDaf: false, amudFromBareLetter: false, label: `${book.title}, פרק ${u.name}`, via: "named", daf: true }, index, heRefAt), heRef: null });
          continue;
        }
        // "[בב"ש שער ג']": a book's own level named by its word ("כלל", "שער") is read by the position of the
        // number in the book's references — only under a name that IS the book (its title, a canonical form)
        if (t.tier === "acronym" && p.citation.elems.some((e) => SECTION_KINDS.has(e.kind))) continue;
        const res = index.resolve(p.citation.elems, t.collection, t.section);
        // book_acronym is too noisy to trust without the target's own references: a database name
        // located only by headings ("בתרא" → a commentary's headings) is not a reading
        if (res && res.via === "headings" && t.tier === "acronym") continue;
        // a book in parts of the Shulchan Aruch, by its headings ("משכנות יעקב": יורה דעה, then glosses on חושן משפט): the siman found
        // is in one part. Another part in the context — not this place (issue #42 C20); no part in it — not sure which (below).
        // A part written in the citation itself was asked of the index already (t.section)
        let partUndecided = false;
        if (res?.part && index.parts && !t.section) {
          const want = p.citation.partContext;
          if (want && want !== res.part) {
            p.partMismatch = { want, found: res.part };
            continue;
          }
          partUndecided = !want;
        }
        // "תהלים פ"ו", "תה' פ' ב": the numbers have a second reading; it costs only when some book the name may
        // mean has that place too — this one, or another candidate ("בכתובות פ"ב": chapter 2 of the Mishna, or
        // daf 82 of the Bavli). In a midrash rabbah "פי"א" is its parsha 11, the way it is cited.
        const alt = !res?.daf && p.citation.rule !== "midrash-rabbah" ? alternativeReading(p.citation.elems) : null;
        const other = alt ? index.resolve(alt, t.collection, t.section) : null;
        if (other && (!res || other.line !== res.line || other.end !== res.end)) p.altElsewhere = true;
        if (res) p.resolved.push({ target: t, res, heRef: res.line === res.end && heRefAt ? heRefAt(res.line) : null, ...(partUndecided && { partUndecided: true }) });
      }
    }
  }

  /** Step 3. */
  finish(ctx: EngineContext = {}): EngineResult {
    const suggestions: Suggestion[] = [];
    const unmatched = new Map<number, Reason[]>();
    const notes: Reason[] = [];
    const counts = { detected: this.pending.size, resolved: 0, noLocation: 0, noBook: 0, ibid: 0, belowMin: 0, duplicate: 0, unfinished: 0 };
    const minRank = CONFIDENCE_ORDER.indexOf(this.opts.minConfidence);
    const chosenBook = new Map<number, string>();
    const seen = new Set<string>();
    const anchorsAllowed = new Map<string, boolean>();
    let done = 0;
    const ordered = [...this.pending.values()].sort((a, b) => a.citation.seq - b.citation.seq);
    for (const p of ordered) {
      if (++done % PROGRESS_EVERY === 0) ctx.progress?.(done, ordered.length);
      const c = p.citation;
      // a cancelled run (the resolution stopped before every book was read) still ranks what it resolved — this
      // step is in memory and quick — but not a citation one of whose books was never read: its best reading
      // may be in that book
      if (c.candidates.some((x) => !this.resolvedBooks.has(x.book.key))) {
        counts.unfinished++;
        continue;
      }
      let options = p.resolved;
      // an ibid follows the book its antecedent was linked to
      // (one moved to a commentator — "רש"י שם ד"ה" — is in that commentary, not in the antecedent's book)
      if (c.ibidOf !== undefined && chosenBook.has(c.ibidOf) && !c.commentator) options = options.filter((o) => o.target.book.key === chosenBook.get(c.ibidOf!));
      if (!options.length && p.partMismatch && !p.resolved.length) {
        counts.noLocation++;
        const list = unmatched.get(c.line) ?? [];
        list.push({ code: "citations/part-mismatch", text: `"${c.text}": בספר ${c.candidates.map((x) => x.book.title).slice(0, 3).join(" / ")} המקום נמצא רק בחלק ${p.partMismatch.found}, וההקשר מדבר על ${p.partMismatch.want}. הספר מחולק לפי חלקי השולחן ערוך והסימנים מתחילים מחדש בכל חלק, ולכן לא קושר. אם זה המקום, קשרו אותו ביד.` });
        unmatched.set(c.line, list);
        continue;
      }
      if (!options.length) {
        const why = p.resolved.length
          ? `"${c.text}": המקום שאליו מפנה ה"שם" לא נמצא בספר של ההפניה הקודמת`
          : p.unindexed === c.candidates.length
            ? `"${c.text}": בספר ${c.candidates.map((x) => x.book.title).join(" / ")} אין מבנה של פרקים, סימנים או דפים שאפשר לאתר בו מקום`
            : `"${c.text}": המקום לא נמצא ב${c.candidates.map((x) => x.book.title).slice(0, 3).join(" / ")}`;
        if (p.unindexed === c.candidates.length) counts.noBook++;
        else counts.noLocation++;
        const list = unmatched.get(c.line) ?? [];
        list.push({ code: p.resolved.length ? "citations/ibid-not-found" : p.unindexed === c.candidates.length ? "citations/no-structure" : "citations/location-not-found", text: why });
        unmatched.set(c.line, list);
        continue;
      }
      const scored = options.map((o) => ({ ...o, score: scoreOf(c, o.target, o.res, o.addressed, !!p.altElsewhere) - (o.fallback ? PENALTY.unitFallback : 0) - (o.partUndecided ? PENALTY.partUndecided : 0) })).sort((a, b) => b.score - a.score || tierOrder(a.target) - tierOrder(b.target));
      const best = scored[0]!;
      // the same book reached through two names (a title and an acronym) is not a rival
      const rival = scored.find((o) => o.target.book.key !== best.target.book.key);
      const confidence: Confidence = confidenceOf(best.score, rival ? rival.score : null, this.opts.thresholds);
      chosenBook.set(c.seq, best.target.book.key);
      if (c.ibid !== "none") counts.ibid++;
      if (confidence === "none" || CONFIDENCE_ORDER.indexOf(confidence) > minRank) {
        counts.belowMin++;
        continue;
      }
      const res = best.res;
      const inlineMode = this.opts.citationType === "inline-linker";
      const allowAnchor = this.anchorPolicy(res.book, anchorsAllowed);
      const anchor: RawAnchor | undefined = allowAnchor && !this.notesLines.has(c.line) ? { rawStart: c.rawStart, rawEnd: c.rawEnd } : undefined;
      // INLINE_LINKER needs the anchor (start and end after it): without one the suggestion stays a REFERENCE
      const inline = inlineMode && anchor !== undefined && c.rawEnd > c.rawStart;
      // no range into a Sefaria book: the weekly sync remaps only the start line from ref_2, so the end would drift (B1). An
      // INLINE_LINKER record never reaches the sync (private use only, LINK_FORMATS §1.12, which allows its line_index_2_end):
      // "בראשית א, א-ג" is the three verses there (issue #42 C17)
      const ranged = this.opts.ranges && res.end > res.line && (inline || !this.sefariaOwned(res.book));
      // a unit cut on a Sefaria side: its first line that can carry a ref_2 (an alt_toc chapter may start on a line without a heRef)
      const firstRef = !ranged && this.opts.ranges && res.end > res.line ? firstRefIn(res.line, res.end, this.refBlocks.get(res.book.key)) : { line: res.line };
      const target: LinkSide = ranged ? { book: res.book, line: res.line, end: res.end } : { book: res.book, line: firstRef.line };
      // the id names the span (raw offsets in the line) even without an anchor, so a measure or a
      // reviewer can tell two mentions in one line apart; two mentions of the same place in one line
      // without anchors are still ONE link
      const where = `${res.book.key}:${target.line}${target.end !== undefined ? `-${target.end}` : ""}`;
      const id = `${ENGINE}:${this.source.key}:${c.line}@${c.rawStart}-${c.rawEnd}>${where}`;
      const pairKey = anchor ? id : `${c.line}>${where}`;
      if (seen.has(pairKey)) {
        counts.duplicate++;
        continue;
      }
      seen.add(pairKey);
      counts.resolved++;
      const narrowed = res.end > res.line && !ranged ? (this.opts.ranges ? "sefaria" : "settings") : null;
      const { reasons, warnings, rules } = explain(c, best.target, res, narrowed, anchor !== undefined, allowAnchor, this.notesLines.has(c.line));
      if (firstRef.reason) {
        reasons.push(firstRef.reason);
        rules.push("citations.first-ref");
      }
      if (best.partUndecided && res.part) {
        rules.push("citations.part-undecided");
        warnings.push({ code: "citations/part-undecided", text: `הספר מחולק לפי חלקי השולחן ערוך, והסימן נמצא בחלק ${res.part}. ההקשר אינו אומר איזה חלק, ולכן ייתכן שהכוונה לסימן בחלק אחר` });
      }
      if (rival && confidence === "ambiguous") warnings.push({ code: "citations/ambiguous", text: `השם "${c.name}" מתאים גם ל${rival.target.book.title}, ושם המקום קיים גם כן` });
      suggestions.push({
        id,
        engine: ENGINE,
        source: { book: this.source, line: c.line },
        ...(anchor && { anchor }),
        target,
        ...(narrowed && { citedSpan: { line: res.line, end: res.end } }),
        declaredType: inline ? INLINE_LINKER_TYPE : "reference",
        heRef2: best.heRef?.trim() ? best.heRef : res.label,
        score: round(best.score),
        confidence,
        reasons,
        rules: best.dibur ? [...rules, "citations.dibur-line"] : rules,
        alternatives: scored
          .filter((o) => o !== best)
          .slice(0, this.opts.maxAlternatives)
          .map((o): Candidate => ({
            target: this.opts.ranges && o.res.end > o.res.line && !this.sefariaOwned(o.res.book) ? { book: o.res.book, line: o.res.line, end: o.res.end } : { book: o.res.book, line: o.res.line },
            score: round(o.score),
            reasons: [{ code: "citations/alternative", text: `${o.res.label} (${o.target.book.title})` }],
          })),
        warnings,
      });
    }
    ctx.progress?.(ordered.length, ordered.length);
    notes.push({
      code: "citations/summary",
      text: `נסרקו ${this.lines.toLocaleString("he")} שורות. נמצאו ${counts.detected.toLocaleString("he")} מראי מקומות לספרים שפתוחים בכלי; ${counts.resolved.toLocaleString("he")} אותרו עד השורה${counts.ibid ? ` (מהם ${counts.ibid.toLocaleString("he")} "שם")` : ""}.`,
    });
    if (!counts.detected) {
      const missing = this.missingCorpora();
      if (missing.length)
        notes.push({
          code: "citations/no-target-books",
          text: `לא נמצאו מראי מקומות. ייתכן שהספר פשוט אינו מצטט; וייתכן שספרי היעד לא נפתחו: המנוע מזהה הפניות רק לספרים שפתוחים בכלי, ובספרים שנפתחו אין ${missing.join(", ")}. אם הספר מצטט אותם, פתחו את מסד אוצריא (או את הספרים שאליהם הוא מפנה) והריצו שוב.`,
        });
    }
    if (counts.noLocation) notes.push({ code: "citations/not-found", text: `${counts.noLocation.toLocaleString("he")} מראי מקומות לא אותרו: המקום (פרק, דף, סימן) אינו קיים בספר שזוהה. הם ברשימת "בלי התאמה".` });
    if (counts.noBook) notes.push({ code: "citations/no-structure", text: `${counts.noBook.toLocaleString("he")} מראי מקומות מפנים לספרים בלי מבנה שאפשר לאתר בו מקום (בלי ציוני מקום במסד ובלי כותרות של פרקים או סימנים).` });
    if (counts.belowMin) notes.push({ code: "citations/below-minimum", text: `${counts.belowMin.toLocaleString("he")} הצעות היו מתחת לוודאות המינימלית שנבחרה ולא הוצגו.` });
    const dropped = [...this.scanner.dropped.entries()].filter(([, n]) => n > 0);
    if (dropped.length) notes.push({ code: "citations/guards", text: `כללי זהירות דחו ${dropped.reduce((s, [, n]) => s + n, 0).toLocaleString("he")} מועמדים: ${dropped.map(([k, n]) => `${GUARD_LABEL[k] ?? k} (${n})`).join(", ")}.` });
    if (ctx.signal?.aborted || counts.unfinished) notes.push({ code: "engine/aborted", text: `הריצה הופסקה לבקשת המשתמש; התוצאות חלקיות${counts.unfinished ? ` (${counts.unfinished.toLocaleString("he")} מראי מקומות לא נבדקו עד הסוף)` : ""}` });
    const anchorNote = this.anchorNote(anchorsAllowed);
    if (anchorNote) notes.push(anchorNote);
    return { suggestions, notes, unmatched: [...unmatched.entries()].sort((a, b) => a[0] - b[0]).map(([line, reasons]) => ({ line, reasons })) };
  }

  /**
   * The well-known corpora (as collectionOf() reads a title) with no book among the open ones. A run that found
   * nothing is most often one whose targets are not open; the scanner cannot tell what a citation to a closed
   * book looks like (no name table: it is built from the open catalog), so this is the explanation instead.
   */
  private missingCorpora(): string[] {
    const have = new Set(this.aliases.collections.values());
    const groups: [readonly string[], string][] = [
      [["tanakh"], 'תנ"ך'],
      [["bavli", "mishna", "yerushalmi"], 'ש"ס או משנה'],
      [["rambam"], "משנה תורה"],
      [["sa", "tur"], "שולחן ערוך"],
    ];
    return groups.filter(([colls]) => !colls.some((c) => have.has(c as never))).map(([, label]) => label);
  }

  private anchorPolicy(target: BookRef, cache: Map<string, boolean>): boolean {
    const hit = cache.get(target.key);
    if (hit !== undefined) return hit;
    // INLINE_LINKER (private use): the offsets are in the user's own source line, so the target may be a Sefaria book.
    // A book of a personal database (origin "personal") too (issue #41 B9): Otzaria's personal import places such a book (an
    // attached database, docs/contracts/LINK_FORMATS.md §1.12) — but only as INLINE_LINKER, which validateLink accepts for a
    // PRIVATE export alone; a "reference" from it stays anchorless, as the library is not where its links go
    const inline = this.opts.citationType === "inline-linker";
    const ok =
      this.opts.anchors === "auto" &&
      ((this.source.origin === "otzaria" && !this.sefariaOwned(this.source)) || (inline && this.source.origin === "personal")) &&
      (inline || (target.origin === "otzaria" && !this.sefariaOwned(target)));
    cache.set(target.key, ok);
    return ok;
  }

  private anchorNote(cache: ReadonlyMap<string, boolean>): Reason | null {
    if (this.opts.anchors === "off") return { code: "citations/anchors-off", text: "עוגנים כובו בהגדרות: הקישורים יוצגו בפאנל הקישורים בלבד, בלי סימון המילים." };
    if (!cache.size) return null;
    const without = [...cache.values()].filter((v) => !v).length;
    if (!without && this.opts.citationType === "inline-linker")
      return { code: "citations/inline-linker", text: 'כל קישור הוא "ציטוט בטקסט": מילות ההפניה בשורה מסומנות ויוצגו באוצריא כקישור שנפתח בלחיצה. הסוג הזה מוכר רק לייבוא האישי של אוצריא: בייצוא לספרייה הקישורים יוחזקו, ולכן ייצאו אותם בבחירה "לשימוש פרטי". ' + inlineLinkerVersionNote() };
    if (!without) return { code: "citations/anchors", text: "כל קישור מסמן את מילות ההפניה בשורה (עוגן), כך שבאוצריא הן יוצגו כקישור בתוך הטקסט." };
    if (this.source.origin === "personal")
      return {
        code: "citations/anchors-source",
        text: 'ספר המקור הוא ספר ממסד אישי, ולכן קישור מסוג "הפניה" נכתב בלי עוגן על מילות ההפניה (הוא יוצג בפאנל הקישורים). כדי שהמילים יסומנו ויהיו לחיצות בתוך הטקסט, בחרו בסוג הקישור "ציטוט בטקסט" וייצאו לשימוש פרטי: ייבוא אישי באוצריא יודע לאתר ספרים של מסד מצורף. ' + inlineLinkerVersionNote(),
      };
    if (this.source.origin !== "otzaria" || this.sefariaOwned(this.source))
      return { code: "citations/anchors-source", text: "ספר המקור אינו ספר של ספריית אוצריא, ולכן הקישורים נכתבים בלי עוגן על מילות ההפניה (הם יוצגו בפאנל הקישורים)." };
    return { code: "citations/anchors-sefaria", text: "קישורים לספרי ספריא נכתבים בלי עוגן על מילות ההפניה: הספרייה אינה מקבלת עוגן בקישור מספר אוצריא אל ספר ספריא. הם יוצגו בפאנל הקישורים." };
  }
}

/**
 * The other reading of numbers that can be read two ways: a compact "פ"ו" as the number 86, "פ' ב" as the
 * numbers 80 and 2. Null when there is none.
 */
function alternativeReading(elems: readonly AddrElem[]): AddrElem[] | null {
  const [first, ...rest] = elems;
  if (!first) return null;
  if (first.alsoNumber !== undefined) return [{ kind: "?", n: first.alsoNumber, explicit: false, numeral: { n: first.alsoNumber, form: "gershayim", common: false } }, ...rest];
  if (first.afterPeh && first.kind === "?" && elems.length === 1) return [{ kind: "?", n: 80, explicit: false, numeral: { n: 80, form: "geresh", common: false } }, { ...first, explicit: false }];
  return null;
}

const SECTION_KINDS: ReadonlySet<string> = new Set(["klal", "shaar", "maamar", "remez", "piska", "drush", "teshuva"]);

/** how far past a unit's first line its first line of content is looked for (a chapter heading, an amud heading, a title) */
const MAX_HEADING_SKIP = 8;

/**
 * A unit cited whole starts at its first line of CONTENT (issue #42 C18). A chapter's alt_toc entry (a unit cited by name, a
 * chapter by number) is often its heading line, and the export holds a link with a heading at either end (export/heading-line):
 * 35 of 24,619 suggestions of a sample began on one. In a book indexed by its references a heading is a line with no heRef —
 * the first line under it that has one is where the unit's text begins. The reference index's own nodes already begin there.
 */
function contentStart(r: Resolution, index: TargetIndex | null, heRefAt: ((line: number) => string | null) | undefined): Resolution {
  if (!heRefAt || index?.via !== "heref" || r.end <= r.line || heRefAt(r.line)) return r;
  for (let l = r.line + 1, last = Math.min(r.end, r.line + MAX_HEADING_SKIP); l <= last; l++) if (heRefAt(l)) return { ...r, line: l };
  return r;
}

const isDafElem = (e: AddrElem): boolean => e.kind === "daf" || e.amud !== undefined;


/** an amud of a commentator is a few dozen lines; a longer range is no place to look for a ד"ה in */
const MAX_DIBUR_SPAN = 200;

/** the line's first words (past a leading "ד"ה", "גמ'", "מתני'") are the heading `want` */
function opensWith(html: string, want: readonly string[]): boolean {
  const toks = hebrewTokens(html).slice(0, want.length + 3);
  for (let s = 0; s <= 2; s++) {
    if (s && !/^(?:דה|גמ|גמרא|מתני|מתנ|בא|באד|שמ|תוד)$/.test(toks[s - 1]?.key ?? "")) break;
    if (want.every((w, q) => {
      const t = toks[s + q];
      if (!t) return false;
      return t.key === w || (w.length >= 3 && keySimilarity(t.key, w) >= 0.8);
    })) return true;
  }
  return false;
}

const tierOrder = (t: AliasTarget): number => ({ title: 0, derived: 1, acronym: 2, secondary: 3 })[t.tier];
const round = (x: number) => Math.round(x * 1000) / 1000;

const GUARD_LABEL: Readonly<Record<string, string>> = {
  "numeric-name": "שם שהוא גם מספר, בלי סימן מקום אחריו",
  date: "תאריך ולא מקום",
  self: "הפניה של הספר לעצמו",
  "commentator-not-in-library": "הפניה לפירוש שאינו פתוח בכלי",
  "dibur-without-commentator": 'ד"ה בלי שם הפירוש',
  "ibid-shape": '"שם" שאי אפשר להשלים',
  "ibid-other-book": '"שם" אחרי שם של ספר אחר',
  "siman-of-another-book": "סימן של ספר אחר שנזכר לידו",
  "daf-of-another-book": "דף של ספר אחר שנזכר לידו",
  "rambam-topic-unknown": 'פרק אחרי "רמב"ם" בלי שם הלכות שאפשר לזהות',
  "internal-of-another-book": '"לעיל"/"לקמן" של ספר אחר שנזכר לידו',
  "note-number": "מספר הערה בסוגריים (ספרות), לא מקום",
  quantity: 'מספר שסופר דבר ("ח\' ימים", "שני דברים"), לא מקום',
  "part-of-another-work": 'חלק של השולחן ערוך אחרי שם של ספר תשובות ("שו"ת … או"ח סי\'") — החלק של ספר התשובות',
  "midrash-not-in-library": "מדרש רבה על הספר אינו פתוח בכלי",
};

/**
 * A unit cited by name in one candidate book. The unit's range is the indexed one (the Bavli tractate,
 * the book of the Torah), or the book's own structure by the same name (a commentary on the tractate),
 * or a named level of the book's references (the Zohar's parshiyot). A location after the name is
 * resolved as usual but must fall inside the unit; when the book has no such location the unit itself
 * is linked (a fallback, scored lower).
 */
function resolveUnit(c: Citation, t: AliasTarget, index: TargetIndex | null, units: readonly NamedUnit[] | null): { r: Resolution; fallback: boolean; addressed?: boolean } | null {
  const u = c.unit!;
  const own = u.base && u.base.book.key === t.book.key ? u.base : (u.bases?.find((b) => b.book.key === t.book.key) ?? ownUnit(u.kind, u.name, u.key, units ?? []));
  const indexed = index && index.via !== "none" ? index : null;
  if (c.elems.length && indexed) {
    // a level of the book's references: the location is under it; else the location in the whole book
    const r = u.base || u.bases ? indexed.resolve(c.elems, t.collection, t.section) : (indexed.resolveNamed?.(u.key, c.elems) ?? null);
    if (r) {
      // "בפרק הזהב (דף ס.)": a daf outside the chapter contradicts the name — no guess
      if (own && (r.end < own.line || r.line > own.end)) return null;
      return { r, fallback: false, addressed: true };
    }
  }
  const fallback = c.elems.length > 0;
  // a name several tractates share is told apart only by its daf: no daf inside, no link; and a name written
  // with no "פרק" is a chapter only by the daf inside it
  if (u.bases || c.rule === "named-bare") return null;
  if (own) {
    const word = u.kind === "chapter" ? "פרק" : "פרשת";
    return { r: { book: t.book, line: own.line, end: own.end, leaf: false, wholeDaf: false, amudFromBareLetter: false, label: `${t.book.title}, ${word} ${own.name}`, via: "named", daf: false }, fallback };
  }
  if (!u.base && indexed?.resolveNamed) {
    const r = indexed.resolveNamed(u.key, []);
    return r ? { r, fallback } : null;
  }
  return null;
}

/**
 * A chapter alone ("פ"ק", "ספ"ב"), in a book by daf, read as the book's Nth chapter: only when the words say the
 * Gemara or a commentary on it is meant — a commentator moved it ("התו' בפ"ק דר"ה"), or "ש"ס"/"גמ'" stands
 * before it. Without them the chapter is the Mishna's (detect.ts sends it there).
 */
function chapterByNumber(c: Citation): boolean {
  const e = c.elems[0];
  // "רשב"א [שבת פ"ח]" after the name is chapter 8 or daf 88 (LINKER reads the daf): only a chapter that cannot be a
  // number — before the name ("פ"ב דכתובות"), or "ספ"ב"
  return c.elems.length === 1 && e!.kind === "perek" && e!.alsoNumber === undefined && !c.unit && (c.commentator !== undefined || c.qualifier === "bavli" || !!c.ordinal || !!e!.ordinal);
}

/** A book's own unit of that name: the same name, or else the only one whose name starts with the cited words ("שלח" → "שלח לך"). */
function ownUnit(kind: NamedUnit["kind"], name: string, key: string, units: readonly NamedUnit[]): NamedUnit | undefined {
  const same = units.filter((x) => x.kind === kind && (x.name === name || unitNameKey(x.name) === unitNameKey(name) || unitNameKey(x.name) === key));
  if (same.length) return same.length === 1 ? same[0] : undefined;
  const longer = units.filter((x) => x.kind === kind && unitNameKey(x.name)?.startsWith(`${key} `));
  return longer.length === 1 ? longer[0] : undefined;
}

/** The score of one reading: the name's strength minus everything that makes the reading less sure. */
export function scoreOf(c: Citation, t: AliasTarget, r: Resolution, addressed = false, twoReadings = false): number {
  let s: number = TIER_SCORE[t.tier];
  if (c.evidence === "medium") s -= PENALTY.medium;
  if (!r.daf && c.elems.length === 1 && c.elems[0]!.kind === "?") s -= PENALTY.singleBare;
  if (r.wholeDaf) s -= PENALTY.wholeDaf;
  if (r.amudFromBareLetter) s -= PENALTY.amudFromBareLetter;
  if (c.ibid === "full") s -= PENALTY.ibidFull;
  if (c.ibid === "partial") s -= PENALTY.ibidPartial;
  if (c.ibid === "book") s -= PENALTY.ibidBook;
  if (c.commentator) s -= PENALTY.commentator;
  if (r.via === "headings") s -= PENALTY.headings;
  if (r.via === "pages") s -= r.split ? PENALTY.pagesSplit : PENALTY.pages;
  if (COMMON_TITLES.has(t.book.title) && c.ibid === "none" && !c.bracketed && c.elems.length === 1 && !c.elems[0]!.explicit && c.elems[0]!.amud === undefined) s -= PENALTY.commonTitle;
  if (twoReadings) s -= PENALTY.compactOrNumber;
  if (c.numericName) s -= PENALTY.numericName;
  // a book outside the known corpora, read positionally from bare numbers
  // (or by a number that may be read two ways: "מנחת חינוך (פ"ד)" — chapter 4, or mitzva 84)
  if (t.collection === "other" && !r.daf && (twoReadings || c.elems.some((e) => e.kind === "?"))) s -= PENALTY.otherCollection;
  if (c.elems.some((e) => e.numeral.common && !e.explicit)) s -= PENALTY.commonNumeral;
  if (c.form === "reversed") s -= PENALTY.reversed;
  if (c.form === "relative") s -= PENALTY.relative;
  if (c.internal) s -= PENALTY.internal;
  if (c.rule && /^rambam-(?:topic|named|hilchot)-(?:initials|abbrev|word)$/.test(c.rule)) s -= PENALTY.rambamInitials;
  if (c.rule === "base-daf") s -= PENALTY.baseDaf;
  // "בירושלמי דסוכה פ' החליל": a chapter of the Yerushalmi / the Mishnah by its opening words — the whole chapter is
  // coarse, like a unit by name ("possible"); with a halacha after it, the name only confirms the place
  if (c.rule === "chapter-name-other") s -= c.elems.length > 1 ? PENALTY.named : PENALTY.unitRange;
  if (c.rule === "implicit-context") s -= PENALTY.implicitContext;
  if (c.rule === "implicit-previous-far") s -= PENALTY.implicitFar;
  if (c.rule === "responsa-author") s -= PENALTY.responsaAuthor;
  if (t.otherWork) s -= PENALTY.otherWork;
  if (c.rule === "ibid-far") s -= PENALTY.ibidFar;
  if (c.rule === "dibur-no-commentator") s -= PENALTY.diburNoCommentator;
  if (c.quantityLike) s -= PENALTY.quantityLike;
  if (c.rule === "single-bare" || c.rule === "numeric-name-verse") s -= PENALTY.looseForm;
  // "התוס' בדף ט"ו ע"ב ד"ה": the daf is written, the tractate is the context's
  if (c.rule === "dibur-context" && c.ibid === "none") s -= PENALTY.baseDaf;
  // "רש"י ד"ה X" with no daf at all: the daf the citing line is on — told by the context, like "שם"
  if (c.rule === "dibur-here") s -= PENALTY.ibidPartial;
  // "במג"א סק"א": the siman is the citing line's, told by the context
  if (c.rule === "sk-here") s -= PENALTY.ibidPartial;
  // the book is told by a word before the name, not by the name: "ברבות [בראשית פי"א]", a glossary of Rashi's words
  if (c.rule === "midrash-rabbah") s -= PENALTY.midrashRabbah;
  // its twin to the place itself ("title-commentator-base") is the citation as written: no cost
  if (c.rule === "title-commentator") s -= PENALTY.baseDaf;
  if (c.ordinal && c.elems.length === 1 && TALMUDIC.has(t.collection)) s -= PENALTY.ordinalChapter;
  // "[פ"ק דברכות] בשר ודם…": a chapter alone sent to the Mishna, though the book did not say "משנה" — books
  // mostly mean the Gemara's discussion in it (on the held-out sample 874 of 1,230 such "high" were not
  // confirmed by the database; LIBRARY_BENCHMARK §4.3): at most "possible"
  else if (c.form === "reversed" && c.elems.length === 1 && t.collection === "mishna" && c.qualifier !== "mishna" && !c.commentator) s -= PENALTY.ordinalChapter;
  if (c.commentator && t.collection === "rambam" && !r.leaf) s -= PENALTY.rambamCommentaryChapter;
  if (c.qualifier && TALMUDIC.has(c.qualifier) && TALMUDIC.has(t.collection) && t.collection !== c.qualifier && !c.commentator) s -= PENALTY.qualifierMismatch;
  // a unit whose location was found inside it: the location is the citation and the name confirms
  // it — with the book named next to it, as sure as "<tractate> <daf>"
  // "תוס' פ"ק דסנהדרין": the whole chapter, coarse like a unit cited by name
  if (!c.unit && r.via === "named") s -= PENALTY.unitRange;
  if (c.unit) {
    if (!addressed) s -= PENALTY.unitRange;
    else if (c.unit.context !== "named") s -= PENALTY.named;
    // a parsha name is unique by itself; a chapter name told its tractate only by being unique
    if (c.unit.context !== "named" && (c.unit.kind === "chapter" || !addressed)) s -= PENALTY.unitAlone;
    if (c.unit.partial && !addressed) s -= PENALTY.unitPartial;
  }
  return Math.max(0, Math.min(1, s));
}

const TALMUDIC: ReadonlySet<Collection> = new Set(["bavli", "mishna", "yerushalmi", "tosefta"]);

/** what a rule beyond the form did (Citation.rule), in words */
const RULE_REASON: Readonly<Record<string, string>> = {
  "rambam-topic-full": `שם ההלכות נכתב בלי "הלכות" (או בקיצור "ה'"), ונמצא בשמות ספרי משנה תורה`,
  "rambam-topic-first": "נכתבה רק המילה הראשונה של שם ההלכות, ואין עוד הלכות שמתחילות בה",
  "rambam-topic-initials": "שם ההלכות נכתב בראשי תיבות, ורק הלכות אחת מתאימות להם",
  "rambam-topic-abbrev": "שם ההלכות נכתב בקיצור של כמה מילים ממנו (\"יו\"ט\", \"מע\"ק\"), ורק הלכות אחת מתאימות לו",
  "rambam-topic-word": "נכתבה מילה אחת משם ההלכות (\"לולב\"), ורק בשם הלכות אחד היא נמצאת",
  "rambam-named-full": "\"רמב\"ם\" ושם ההלכות (בלי \"הלכות\") לפני הפרק",
  "rambam-named-first": "\"רמב\"ם\" והמילה הראשונה של שם ההלכות לפני הפרק",
  "rambam-named-initials": "\"רמב\"ם\" ושם ההלכות בראשי תיבות לפני הפרק",
  "rambam-named-abbrev": "\"רמב\"ם\" ושם ההלכות בקיצור לפני הפרק",
  "rambam-named-word": "\"רמב\"ם\" ומילה משם ההלכות לפני הפרק",
  "rambam-hilchot-full": "\"הלכות\" ושם ההלכות לפני הפרק",
  "rambam-hilchot-first": "\"הלכות\" והמילים הראשונות של שם ההלכות לפני הפרק",
  "rambam-hilchot-initials": "\"הלכות\" ושם ההלכות בראשי תיבות לפני הפרק",
  "rambam-hilchot-abbrev": "\"הלכות\" ושם ההלכות בקיצור לפני הפרק",
  "rambam-hilchot-word": "\"הלכות\" ומילה משם ההלכות לפני הפרק",
  "rambam-hilchot-known": "\"הלכות\" ושם ההלכות כפי שספרים כותבים אותו, מרשימת השמות שנבדקה מול הקישורים שבמסד",
  "rambam-topic-known": "שם ההלכות נכתב כפי שספרים כותבים אותו (\"מעשר\", \"שביעית\", \"איסורי מזבח\"), מרשימת השמות שנבדקה מול הקישורים שבמסד",
  "rambam-named-known": "\"רמב\"ם\" ושם ההלכות כפי שספרים כותבים אותו, מרשימת השמות שנבדקה מול הקישורים שבמסד",
  "named-level": "אחרי שם הספר נכתב שם של פרשה, שהיא רמה בציוני המקום של הספר (או חלק במבנה הדפים שלו), ואחריה המקום",
  "author-part": "שם שהמסד נותן לכמה חיבורים של מחבר אחד, וחלק השולחן ערוך שאחריו בוחר אחד מהם",
  "part-book": "\"ח\"א\", \"ח\"ב\" אחרי שם החיבור: הכרך, שהוא ספר נפרד בספרייה",
  "base-daf": "נכתב דף בלי שם מסכת, והספר הוא חיבור על המסכת הזאת, ולכן הדף נקרא בה",
  "chapter-name-other": "פרק של הירושלמי או של המשנה לפי שמו — המילים הראשונות של הפרק בספר עצמו (במסד יש שמות פרקים רק לבבלי)",
  "context-daf": "נכתב \"דף\" בלי שם מסכת, מיד אחרי הפניה לדף בגמרא (באותה שורה או בשורה שלפניה, ובלי ספר אחר ביניהן) — הדף נקרא במסכת ההיא, כמו \"שם\"",
  "dibur-context": "שם המפרש ו\"ד\"ה\" בלי שם מסכת: הדף נלקח מההפניה שלפניו (או מהמסכת שהחיבור נכתב עליה), והקישור הוא לפירוש על הדף הזה",
  "dibur-here": "שם המפרש ו\"ד\"ה\" בלי דף ובלי הפניה לפניו: הדף הוא זה שהשורה המצטטת עומדת עליו (לפי ציוני המקום שלה), במסכת שהחיבור נכתב עליה",
  "commentator-ibid": "שם של מפרש ו\"שם\": דבריו על המקום של ההפניה הקודמת (או על הדף שנכתב אחרי \"שם\"), בפירוש שלו על המסכת או על ספר התנ\"ך שנזכר בה",
  "sk-ibid": "נכתב ס\"ק בלי סימן, של הספר שההפניה הקודמת אליו כתבה סימן: הסימן ההוא (כמו \"שם\")",
  "sk-siman-before": "ס\"ק של פירוש על השולחן ערוך, והסימן נכתב מיד לפני שם הפירוש (\"סי' ר\"ח במג\"א ס\"ק ז'\")",
  "rema-ibid": "\"רמ\"א שם\" וסעיף: הגהת הרמ\"א בשולחן ערוך, בסימן של ההפניה הקודמת (לשולחן ערוך או לפירוש על אחד מחלקיו)",
  "sk-here": "נכתב ס\"ק בלי סימן, בחיבור על השולחן ערוך: הסימן הוא זה שהשורה המצטטת עומדת עליו (לפי ציוני המקום שלה), בפירוש על אותו חלק",
  "named-bare": "שם של פרק בלי המילה \"פרק\", ואחריו בסוגריים דף שנמצא בתוך הפרק הזה",
  "midrash-rabbah": "לפני שם הספר כתוב \"מדרש רבה\" / \"ברבות\" / \"במד\"ר\": ההפניה היא למדרש רבה על הספר הזה, לא לפסוק",
  "title-commentator": "הספר הוא אוצר של מילות מפרש אחד, ולכן המקום הוא בפירוש שלו על הדף או על הפרק",
  "title-commentator-base": "הספר הוא אוצר של מילות מפרש אחד: ההפניה מקושרת לפירוש שלו במקום הזה (בהצעה נפרדת), וגם למקום עצמו, לפסוק או לדף שהמילה כתובה בו",
  "commentator-after-base": "אחרי המקום כתוב \"ו\" ושם של מפרש עם ד\"ה (\"שבת סח א, ותוס' ד\"ה …\"): המקום עצמו מצוטט, ודברי המפרש עליו בהצעה נפרדת",
  "dalet-four": "\"ד'\" ואחריו מספר בספר של התנ\"ך: פרק ד והפסוק (בספר שאין בו דפים \"ד'\" אינו \"דף\")",
  "tur-seif": "סימן וסעיף בטור: הסעיף הוא הרמה השנייה בציוני המקום של הטור",
  "part-siman": "אחרי חלק של השולחן ערוך (\"או\"ח\", \"יו\"ד\") מספר אחד בלי סימן: הסימן בחלק הזה",
  "rabbah-parsha": "פרשה של מדרש רבה כפי שכותבים אותה: \"פרשה ז'\", \"רפכ\"ב\" / \"ספמ\"ז\" (ריש / סוף פרשה), \"סוף פ\"ד\"",
  "yalkut-remez": "\"ילקוט\" ואחריו פרשה בתורה או ספר בנביאים ובכתובים, ורמז: הרמז בילקוט שמעוני על התורה או על נ\"ך",
  "yalkut-parsha": "\"ילקוט\" ואחריו פרשה בתורה, בלי רמז: כל הפרשה בילקוט שמעוני על התורה",
  "commentator-named": "לפני ההפניה נכתב שם של פירוש על הספר הזה (כפי שהספרייה קוראת לו), ולכן הקישור הוא לפירוש",
  "ibid-amud": "\"שם\" ועמוד בלבד (\"ושם ע\"ב\"): העמוד האחר של הדף שבהפניה הקודמת, באותו ספר (ואם היא של מפרש — בפירוש שלו)",
  "ibid-far": "ה\"שם\" רחוק מההפניה שהוא משלים (יותר משש שורות, בלי כותרת ביניהם)",
  "single-bare": "אחרי שם של ספר בתנ\"ך או של מדרש רבה נכתב מספר אחד בלבד, בלי סימן ובלי סוגריים, במקום שהמשפט נגמר בו: הפרק (הפרשה) כולו. צורה רופפת, ולכן לכל היותר \"אפשרית\"",
  "numeric-name-verse": "שם הספר הוא גם מספר (\"שמ\"א\"), ואחריו שני מספרים בלי סוגריים: פרק ופסוק. צורה רופפת, ולכן לכל היותר \"אפשרית\"",
  "dibur-no-commentator":"אחרי המקום כתוב ד\"ה בלי שם של מפרש: המילים הן של פירוש כלשהו על הדף, ולא כתוב איזה. הקישור הוא לדף עצמו, ולכן הוא גס (לכל היותר \"אפשרית\"); אם תדעו מי המפרש, קשרו לפירוש שלו",
  "responsa-named": "שם המחבר ומילה לתשובות (\"בתשו'\", \"שו\"ת\") לפני הסימן: ספר התשובות שלו בספרייה",
  "responsa-author": "שם המחבר לפני הסימן, וספר התשובות הוא החיבור היחיד שלו בספרייה",
  "implicit-previous": "נכתב מקום בסוגריים בלי שם ספר, ולכן הוא נקרא בספר של ההפניה שלפניו (כמו \"שם\")",
  "implicit-previous-far": "נכתב מקום בסוגריים בלי שם ספר, והוא נקרא בספר של ההפניה שלפניו — שאינה באותה שורה, או שהמקום הוא דף",
  "implicit-context": "נכתב מקום בסוגריים בלי שם ספר, ולכן הוא נקרא בספר שההקשר נותן: הכותרת שמעליו, או הספר שהחיבור נכתב עליו",
};

const KIND_WORD: Readonly<Record<string, string>> = {
  perek: "פרק", pasuk: "פסוק", siman: "סימן", seif: "סעיף", sk: "סעיף קטן", halacha: "הלכה", mishna: "משנה", daf: "דף", os: "אות", mizmor: "מזמור", chelek: "חלק",
  klal: "כלל", shaar: "שער", maamar: "מאמר", remez: "רמז", piska: "פסקה", drush: "דרוש", teshuva: "תשובה",
};

const COLLECTION_WORD: Readonly<Record<Collection, string>> = {
  tanakh: 'תנ"ך', bavli: "תלמוד בבלי", mishna: "משנה", yerushalmi: "תלמוד ירושלמי", tosefta: "תוספתא", rambam: 'רמב"ם', sa: "שולחן ערוך", "sa-commentary": "מפרשי השולחן ערוך", tur: "טור", other: "",
};

function explain(c: Citation, t: AliasTarget, r: Resolution, narrowed: "sefaria" | "settings" | null, anchored: boolean, anchorAllowed: boolean, notesLine: boolean): { reasons: Reason[]; warnings: Reason[]; rules: string[] } {
  const reasons: Reason[] = [];
  const warnings: Reason[] = [];
  const rules: string[] = [`citations.${c.form}`, `citations.name-${t.tier}`];
  reasons.push({ code: "citations/span", text: `ההפניה בטקסט: "${c.text}"` });
  const tierText = { title: "שם הספר המלא", derived: "צורה מקובלת של שם הספר", acronym: "כינוי של הספר מתוך רשימת הכינויים במסד", secondary: "שם המסכת, שבצירוף מקום של פרק ומשנה מפנה למשנה" }[t.tier];
  if (c.internal && c.ibid === "none") {
    reasons.push({ code: "citations/internal", text: `"${c.name}": מקום בספר עצמו, ${c.internal.dir < 0 ? "לפני" : c.internal.dir > 0 ? "אחרי" : "לפני או אחרי"} השורה המצטטת. סוג הרמה (${c.elems.map((e) => KIND_WORD[e.kind] ?? e.kind).join(", ")}) נקבע לפי הכותרות של הספר` });
  } else if (c.ibid === "none") reasons.push({ code: `citations/name-${t.tier}`, text: `"${c.name}" — ${tierText}: ${t.book.title}${COLLECTION_WORD[t.collection] && t.collection !== "other" ? ` (${COLLECTION_WORD[t.collection]})` : ""}` });
  else {
    rules.push(`citations.ibid-${c.ibid}`);
    reasons.push({ code: `citations/ibid-${c.ibid}`, text: c.ibid === "book" ? `"${c.text}": אותו מקום כמו ההפניה הקודמת ל${t.book.title}` : c.ibid === "full" ? `"שם": אותו מקום כמו ההפניה הקודמת (${t.book.title})` : `"${c.text}": ההפניה הקודמת (${t.book.title}), עם המקום החדש שצוין` });
  }
  const loc = c.elems.map((e) => (e.kind === "?" ? "" : `${KIND_WORD[e.kind] ?? ""} `) + e.n + (e.to ? `–${e.to}` : "")).join(", ");
  reasons.push({
    code: `citations/location-${r.via}`,
    text:
      r.via === "heref"
        ? `המקום (${loc || c.unit?.name}) נמצא לפי ציוני המקום של השורות בספר: ${r.label}`
        : r.via === "named"
          ? `ה${c.unit?.kind === "parsha" ? "פרשה" : "פרק"} נמצא לפי מבנה התוכן החלופי של הספר: ${r.label}`
          : r.via === "pages"
            ? `הדף נמצא לפי מבנה הדפים (מבנה התוכן החלופי) של הספר: ${r.label}`
          : `המקום (${loc}) נמצא לפי כותרות הספר: ${r.label}`,
  });
  rules.push(`citations.via-${r.via}`);
  if (c.bracketed) reasons.push({ code: "citations/brackets", text: "ההפניה כתובה בסוגריים" });
  if (c.commentator) {
    rules.push("citations.commentator");
    reasons.push({ code: "citations/commentator", text: `לפני ההפניה כתוב "${c.commentator}", ולכן הקישור הוא אל ${t.book.title} ולא אל ספר הבסיס` });
  }
  if (c.qualifier) rules.push(`citations.qualifier-${c.qualifier}`);
  if (c.ordinal) rules.push("citations.perek-ordinal");
  if (c.elems.some((e) => e.v4)) rules.push("citations.marker-v4");
  if (!c.unit && r.via === "named") {
    // "תוס' פ"ק דסנהדרין": a chapter by number in a book by daf, found by the book's own chapters
    rules.push("citations.chapter-number");
    reasons.push({ code: "citations/chapter-number", text: `נכתב פרק במספר, והספר מסודר לפי דפים: הפרק נמצא לפי מבנה הפרקים של הספר עצמו (${r.label})` });
  }
  if (c.rule) {
    rules.push(`citations.${c.rule}`);
    const why = RULE_REASON[c.rule];
    if (why) reasons.push({ code: `citations/${c.rule}`, text: why });
  }
  if (c.unit) {
    const u = c.unit;
    rules.push(`citations.unit-${u.kind}`, `citations.unit-context-${u.context}`);
    if (u.partial) rules.push("citations.unit-partial");
    const what = u.kind === "chapter" ? "פרק" : "פרשה";
    const how =
      u.context === "named"
        ? `והספר נזכר לידו (${t.book.title})`
        : u.context === "base"
          ? `והספר הוא זה שהחיבור נכתב עליו (${t.book.title})`
          : `והשם קיים רק ב${u.base?.book.title ?? t.book.title}`;
    reasons.push({ code: "citations/unit", text: `"${u.name}" הוא שם של ${what} לפי מבני התוכן החלופיים של הספרייה, ${how}` });
    if (u.partial) warnings.push({ code: "citations/unit-partial", text: `נכתבו רק המילים הראשונות של שם ה${what} "${u.name}"` });
  }
  if (r.wholeDaf) {
    rules.push("citations.whole-daf");
    warnings.push({ code: "citations/whole-daf", text: "לא צוין עמוד, ולכן הקישור הוא לשני עמודי הדף" });
  } else if (r.amudFromBareLetter) {
    rules.push("citations.amud-letter");
    warnings.push({ code: "citations/amud-letter", text: 'האות שאחרי מספר הדף נקראה כעמוד (א = ע"א, ב = ע"ב)' });
  }
  if (r.end > r.line) {
    rules.push("citations.range");
    const lines = `${r.line + 1}–${r.end + 1}`;
    if (!narrowed) reasons.push({ code: "citations/range", text: `ההפניה היא ליחידה שלמה, ולכן הקישור לכל השורות שלה (${lines})` });
    else if (narrowed === "sefaria")
      warnings.push({ code: "citations/range-first-line", text: `ההפניה היא ליחידה שלמה (שורות ${lines}). הספר מספריא, והסנכרון השבועי מעדכן רק את שורת ההתחלה, ולכן הקישור הוא לשורה הראשונה שלה בלבד` });
    else warnings.push({ code: "citations/range-first-line", text: `ההפניה היא ליחידה שלמה (שורות ${lines}); לפי ההגדרות הקישור הוא לשורה הראשונה שלה בלבד` });
  }
  if (c.evidence === "medium") warnings.push({ code: "citations/bare-numbers", text: "המקום כתוב במספרים בלי סימן (פרק, סימן, דף) ובלי גרשיים" });
  if (c.numericName) warnings.push({ code: "citations/numeric-name", text: `השם "${c.name}" יכול להיקרא גם כמספר` });
  if (c.quantityLike) {
    rules.push("citations.quantity-like");
    warnings.push({ code: "citations/quantity-like", text: "המקום הוא מספר אחד בספרות, בלי סימן ובלי סוגריים, ואחריו מילה: ייתכן שזו כמות (\"10 סעיפים\") ולא מקום. בדקו לפני שאתם מאשרים" });
  }
  if (c.elems.some((e) => e.numeral.common && !e.explicit)) warnings.push({ code: "citations/common-word-number", text: "אחד המספרים הוא גם מילה רגילה" });
  if (t.collection === "other" && !r.daf && c.elems.some((e) => e.kind === "?")) warnings.push({ code: "citations/generic-book", text: "הספר אינו מהקבצים המוכרים (תנ\"ך, ש\"ס, רמב\"ם, שולחן ערוך), והמספרים הותאמו לרמות הספר לפי הסדר" });
  if (anchored) {
    rules.push("citations.anchor");
    reasons.push({ code: "citations/anchor", text: "העוגן מסמן את מילות ההפניה בשורה" });
  } else if (anchorAllowed && notesLine) warnings.push({ code: "citations/anchor-skipped-notes", text: "בשורה יש הערות ממוזגות. עוגן עליה היה מבטל את מיזוג ההערות בספרייה, ולכן לא נוסף עוגן." });
  return { reasons, warnings, rules };
}

/* ---------- all in memory (tests, small inputs) ---------- */

export interface CitationLibrary {
  readonly catalog: readonly CatalogBook[];
  /** a book's lines (anchor text), for a ד"ה looked up on a commentator's amud */
  lines?(book: BookRef, from: number, to: number): readonly { index: number; text: string }[];
  /** a book's printed pagination (alt_toc "דפים", altdaf.ts), for citations of it by daf */
  pages?(book: BookRef): DafStructure | null;
  /** named units (alt_toc chapters and parshiyot) of the indexed books, and of any book that has them */
  readonly units?: readonly NamedUnitSource[];
  /** the index of a cited book, or null when it cannot be read */
  index(book: BookRef): TargetIndex | null;
  heRefAt?(book: BookRef, line: number): string | null;
}

export function runCitationsEngine(source: EngineBook, library: CitationLibrary, options: CitationsOptions = {}, ctx: EngineContext = {}): EngineResult {
  // the names are read from the Bavli and the Torah (as the worker job does); other books' units resolve a moved citation
  const indexed = (library.units ?? []).filter((u) => unitKindOf(u.book.title) === u.kind);
  const run = CitationRun.fromCatalog(source.book, library.catalog, options, indexed);
  run.scan(source.lines);
  for (const b of run.targets()) {
    const own = run.needsUnits(b) ? (library.units ?? []).find((u) => u.book.key === b.key) : undefined;
    const index = library.index(b);
    run.resolveWith(index, b, library.heRefAt ? (l) => library.heRefAt!(b, l) : undefined, own ? NamedUnitIndex.build([own]).byBook.get(b.key) : null, run.wantsPages(b, index) ? (library.pages?.(b) ?? null) : null);
    const spans = library.lines ? run.diburSpans(b) : [];
    if (spans.length) run.refineDibur(b, spans.flatMap((x) => library.lines!(b, x.line, x.end)), library.heRefAt ? (l) => library.heRefAt!(b, l) : undefined);
  }
  return run.finish(ctx);
}

