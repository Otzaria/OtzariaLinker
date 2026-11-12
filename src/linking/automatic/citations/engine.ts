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
import type { AddrElem } from "./address";
import { AliasIndex, type AliasTarget, type CatalogBook, type Collection } from "./aliases";
import { CitationScanner, type Citation } from "./detect";
import type { Resolution, TargetIndex } from "./resolve";

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

export interface CitationsOptions {
  /** suggestions below this confidence are not returned. Default "possible". */
  readonly minConfidence?: "certain" | "high" | "possible";
  /** resolve "שם" (ibid). Default true. */
  readonly ibid?: boolean;
  /** a citation of a whole chapter / daf links to the whole range (true) or only to its first line. Default true. */
  readonly ranges?: boolean;
  /** "auto": an anchor on the citation words when both books are Otzaria's; "off": never. */
  readonly anchors?: "auto" | "off";
  /** "all" books, or only the classic corpora (Tanakh, Mishna, both Talmuds, Tosefta, Rambam, Tur, Shulchan Aruch and its commentaries). */
  readonly scope?: "all" | "classic";
  readonly thresholds?: ConfidenceThresholds;
  /** alternatives kept on each suggestion. Default 3. */
  readonly maxAlternatives?: number;
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
  ibidFull: 0.09,
  ibidPartial: 0.1,
  ibidBook: 0.06,
  commentator: 0.03,
  /** located by the target's headings, not its references: weaker evidence of the right unit */
  headings: 0.1,
  /** a title that is also an everyday word ("דברים", "שבת"), with one number and nothing else */
  commonTitle: 0.07,
  /** "תהלים פ"ו": chapter 6 or Psalm 86 */
  compactOrNumber: 0.12,
  numericName: 0.05,
  otherCollection: 0.06,
  commonNumeral: 0.05,
  reversed: 0.02,
  relative: 0.03,
  /** "במשנה (ב"ק דף ט:)": a collection word that does not fit the book */
  qualifierMismatch: 0.08,
} as const;

export interface Pending {
  readonly citation: Citation;
  readonly resolved: { target: AliasTarget; res: Resolution; heRef: string | null }[];
  /** books whose index could not be read or had no structure */
  unindexed: number;
}

export class CitationRun {
  private readonly scanner: CitationScanner;
  private readonly pending = new Map<number, Pending>();
  private readonly opts: Required<Omit<CitationsOptions, "thresholds">> & { thresholds: ConfidenceThresholds };
  private lines = 0;
  /** source lines with merged notes: an anchor there would cancel the notes merge (validate.ts) */
  private readonly notesLines = new Set<number>();

  constructor(
    readonly source: BookRef,
    readonly aliases: AliasIndex,
    options: CitationsOptions = {},
  ) {
    this.opts = {
      minConfidence: options.minConfidence ?? "possible",
      ibid: options.ibid ?? true,
      ranges: options.ranges ?? true,
      anchors: options.anchors ?? "auto",
      scope: options.scope ?? "all",
      thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
      maxAlternatives: options.maxAlternatives ?? 3,
    };
    this.scanner = new CitationScanner(aliases, source.key, { ibid: this.opts.ibid }, source.title);
  }

  static fromCatalog(source: BookRef, catalog: readonly CatalogBook[], options: CitationsOptions = {}): CitationRun {
    return new CitationRun(source, AliasIndex.build(catalog), options);
  }

  /** Step 1: lines of the source book, in order (any chunk size). */
  scan(lines: readonly { index: number; text: string; heading: number | null }[]): void {
    for (const l of lines) {
      this.lines++;
      if (l.text.includes('class="footnote"')) this.notesLines.add(l.index);
      const before = this.scanner.citations.length;
      this.scanner.scanLine(l.index, l.text, l.heading);
      for (let k = before; k < this.scanner.citations.length; k++) {
        const c = this.scanner.citations[k]!;
        const cands = this.opts.scope === "classic" ? c.candidates.filter((x) => x.collection !== "other") : c.candidates;
        if (cands.length) this.pending.set(c.seq, { citation: { ...c, candidates: cands }, resolved: [], unindexed: 0 });
      }
    }
  }

  /** Step 2a: every book some citation may point to (each once, in a stable order). */
  targets(): BookRef[] {
    const out = new Map<string, BookRef>();
    for (const p of this.pending.values()) for (const c of p.citation.candidates) out.set(c.book.key, c.book);
    return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Step 2b: resolves every citation that may mean `index.book`. `heRefAt` gives a target line's reference, if known. */
  resolveWith(index: TargetIndex | null, book: BookRef, heRefAt?: (line: number) => string | null): void {
    for (const p of this.pending.values()) {
      for (const t of p.citation.candidates) {
        if (t.book.key !== book.key) continue;
        if (!index || index.via === "none") {
          p.unindexed++;
          continue;
        }
        const res = index.resolve(p.citation.elems, t.collection, t.section);
        // book_acronym is too noisy to trust without the target's own references: a database name
        // located only by headings ("בתרא" → a commentary's headings) is not a reading
        if (res && res.via === "headings" && t.tier === "acronym") continue;
        if (res) p.resolved.push({ target: t, res, heRef: res.line === res.end && heRefAt ? heRefAt(res.line) : null });
      }
    }
  }

  /** Step 3. */
  finish(ctx: EngineContext = {}): EngineResult {
    const suggestions: Suggestion[] = [];
    const unmatched = new Map<number, Reason[]>();
    const notes: Reason[] = [];
    const counts = { detected: this.pending.size, resolved: 0, noLocation: 0, noBook: 0, ibid: 0, belowMin: 0, duplicate: 0 };
    const minRank = CONFIDENCE_ORDER.indexOf(this.opts.minConfidence);
    const chosenBook = new Map<number, string>();
    const seen = new Set<string>();
    const anchorsAllowed = new Map<string, boolean>();
    let done = 0;
    const ordered = [...this.pending.values()].sort((a, b) => a.citation.seq - b.citation.seq);
    for (const p of ordered) {
      if (ctx.signal?.aborted) break;
      if (++done % PROGRESS_EVERY === 0) ctx.progress?.(done, ordered.length);
      const c = p.citation;
      let options = p.resolved;
      // an ibid follows the book its antecedent was linked to
      if (c.ibidOf !== undefined && chosenBook.has(c.ibidOf)) options = options.filter((o) => o.target.book.key === chosenBook.get(c.ibidOf!));
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
      const scored = options.map((o) => ({ ...o, score: scoreOf(c, o.target, o.res) })).sort((a, b) => b.score - a.score || tierOrder(a.target) - tierOrder(b.target));
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
      // no range into a Sefaria book: the weekly sync remaps only the start line from ref_2, so the end would drift (B1)
      const ranged = this.opts.ranges && res.end > res.line && !sefariaSide(res.book);
      const target: LinkSide = ranged ? { book: res.book, line: res.line, end: res.end } : { book: res.book, line: res.line };
      const allowAnchor = this.anchorPolicy(res.book, anchorsAllowed);
      const anchor: RawAnchor | undefined = allowAnchor && !this.notesLines.has(c.line) ? { rawStart: c.rawStart, rawEnd: c.rawEnd } : undefined;
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
      const { reasons, warnings, rules } = explain(c, best.target, res, ranged, anchor !== undefined, allowAnchor, this.notesLines.has(c.line));
      if (rival && confidence === "ambiguous") warnings.push({ code: "citations/ambiguous", text: `השם "${c.name}" מתאים גם ל${rival.target.book.title}, ושם המקום קיים גם כן` });
      suggestions.push({
        id,
        engine: ENGINE,
        source: { book: this.source, line: c.line },
        ...(anchor && { anchor }),
        target,
        declaredType: "reference",
        heRef2: best.heRef?.trim() ? best.heRef : res.label,
        score: round(best.score),
        confidence,
        reasons,
        rules,
        alternatives: scored
          .filter((o) => o !== best)
          .slice(0, this.opts.maxAlternatives)
          .map((o): Candidate => ({
            target: this.opts.ranges && o.res.end > o.res.line && !sefariaSide(o.res.book) ? { book: o.res.book, line: o.res.line, end: o.res.end } : { book: o.res.book, line: o.res.line },
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
    if (counts.noLocation) notes.push({ code: "citations/not-found", text: `${counts.noLocation.toLocaleString("he")} מראי מקומות לא אותרו: המקום (פרק, דף, סימן) אינו קיים בספר שזוהה. הם ברשימת "בלי התאמה".` });
    if (counts.noBook) notes.push({ code: "citations/no-structure", text: `${counts.noBook.toLocaleString("he")} מראי מקומות מפנים לספרים בלי מבנה שאפשר לאתר בו מקום (בלי ציוני מקום במסד ובלי כותרות של פרקים או סימנים).` });
    if (counts.belowMin) notes.push({ code: "citations/below-minimum", text: `${counts.belowMin.toLocaleString("he")} הצעות היו מתחת לוודאות המינימלית שנבחרה ולא הוצגו.` });
    const dropped = [...this.scanner.dropped.entries()].filter(([, n]) => n > 0);
    if (dropped.length) notes.push({ code: "citations/guards", text: `כללי זהירות דחו ${dropped.reduce((s, [, n]) => s + n, 0).toLocaleString("he")} מועמדים: ${dropped.map(([k, n]) => `${GUARD_LABEL[k] ?? k} (${n})`).join(", ")}.` });
    if (ctx.signal?.aborted) notes.push({ code: "engine/aborted", text: "הריצה הופסקה לבקשת המשתמש; התוצאות חלקיות" });
    const anchorNote = this.anchorNote(anchorsAllowed);
    if (anchorNote) notes.push(anchorNote);
    return { suggestions, notes, unmatched: [...unmatched.entries()].sort((a, b) => a[0] - b[0]).map(([line, reasons]) => ({ line, reasons })) };
  }

  private anchorPolicy(target: BookRef, cache: Map<string, boolean>): boolean {
    const hit = cache.get(target.key);
    if (hit !== undefined) return hit;
    const ok = this.opts.anchors === "auto" && this.source.origin === "otzaria" && target.origin === "otzaria";
    cache.set(target.key, ok);
    return ok;
  }

  private anchorNote(cache: ReadonlyMap<string, boolean>): Reason | null {
    if (this.opts.anchors === "off") return { code: "citations/anchors-off", text: "עוגנים כובו בהגדרות: הקישורים יוצגו בפאנל הקישורים בלבד, בלי סימון המילים." };
    if (!cache.size) return null;
    const without = [...cache.values()].filter((v) => !v).length;
    if (!without) return { code: "citations/anchors", text: "כל קישור מסמן את מילות ההפניה בשורה (עוגן), כך שבאוצריא הן יוצגו כקישור בתוך הטקסט." };
    if (this.source.origin !== "otzaria")
      return { code: "citations/anchors-source", text: "ספר המקור אינו ספר של ספריית אוצריא, ולכן הקישורים נכתבים בלי עוגן על מילות ההפניה (הם יוצגו בפאנל הקישורים)." };
    return { code: "citations/anchors-sefaria", text: "קישורים לספרי ספריא נכתבים בלי עוגן על מילות ההפניה: הספרייה אינה מקבלת עוגן בקישור מספר אוצריא אל ספר ספריא. הם יוצגו בפאנל הקישורים." };
  }
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
};

/** The score of one reading: the name's strength minus everything that makes the reading less sure. */
export function scoreOf(c: Citation, t: AliasTarget, r: Resolution): number {
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
  if (COMMON_TITLES.has(t.book.title) && c.ibid === "none" && !c.bracketed && c.elems.length === 1 && !c.elems[0]!.explicit && c.elems[0]!.amud === undefined) s -= PENALTY.commonTitle;
  if (c.elems[0]?.alsoNumber !== undefined && !r.daf) s -= PENALTY.compactOrNumber;
  if (c.numericName) s -= PENALTY.numericName;
  // a book outside the known corpora, read positionally from bare numbers
  if (t.collection === "other" && !r.daf && c.elems.some((e) => e.kind === "?")) s -= PENALTY.otherCollection;
  if (c.elems.some((e) => e.numeral.common && !e.explicit)) s -= PENALTY.commonNumeral;
  if (c.form === "reversed") s -= PENALTY.reversed;
  if (c.form === "relative") s -= PENALTY.relative;
  if (c.qualifier && TALMUDIC.has(c.qualifier) && TALMUDIC.has(t.collection) && t.collection !== c.qualifier && !c.commentator) s -= PENALTY.qualifierMismatch;
  return Math.max(0, Math.min(1, s));
}

/** titles that are everyday words: "לב' דברים, א'" is "two things", "בשבת כ"ח" may be a date */
const COMMON_TITLES: ReadonlySet<string> = new Set([
  "דברים", "שמות", "במדבר", "שופטים", "עזרא", "יונה", "רות", "שבת", "ברכות", "ביצה", "סוכה", "תמיד", "מכות", "נדרים", "חולין", "מנחות", "ערכין", "כריתות", "נזיר", "שבועות", "גיטין", "תענית", "מגילה", "חגיגה", "סוטה", "תמורה", "מעילה", "נדה", "בכורות", "זבחים", "פסחים",
]);

const TALMUDIC: ReadonlySet<Collection> = new Set(["bavli", "mishna", "yerushalmi", "tosefta"]);

const KIND_WORD: Readonly<Record<string, string>> = {
  perek: "פרק", pasuk: "פסוק", siman: "סימן", seif: "סעיף", sk: "סעיף קטן", halacha: "הלכה", mishna: "משנה", daf: "דף", os: "אות", mizmor: "מזמור", chelek: "חלק",
};

const COLLECTION_WORD: Readonly<Record<Collection, string>> = {
  tanakh: 'תנ"ך', bavli: "תלמוד בבלי", mishna: "משנה", yerushalmi: "תלמוד ירושלמי", tosefta: "תוספתא", rambam: 'רמב"ם', sa: "שולחן ערוך", "sa-commentary": "מפרשי השולחן ערוך", tur: "טור", other: "",
};

function explain(c: Citation, t: AliasTarget, r: Resolution, ranged: boolean, anchored: boolean, anchorAllowed: boolean, notesLine: boolean): { reasons: Reason[]; warnings: Reason[]; rules: string[] } {
  const reasons: Reason[] = [];
  const warnings: Reason[] = [];
  const rules: string[] = [`citations.${c.form}`, `citations.name-${t.tier}`];
  reasons.push({ code: "citations/span", text: `ההפניה בטקסט: "${c.text}"` });
  const tierText = { title: "שם הספר המלא", derived: "צורה מקובלת של שם הספר", acronym: "כינוי של הספר מתוך רשימת הכינויים במסד", secondary: "שם המסכת, שבצירוף מקום של פרק ומשנה מפנה למשנה" }[t.tier];
  if (c.ibid === "none") reasons.push({ code: `citations/name-${t.tier}`, text: `"${c.name}" — ${tierText}: ${t.book.title}${COLLECTION_WORD[t.collection] && t.collection !== "other" ? ` (${COLLECTION_WORD[t.collection]})` : ""}` });
  else {
    rules.push(`citations.ibid-${c.ibid}`);
    reasons.push({ code: `citations/ibid-${c.ibid}`, text: c.ibid === "book" ? `"${c.text}": אותו מקום כמו ההפניה הקודמת ל${t.book.title}` : c.ibid === "full" ? `"שם": אותו מקום כמו ההפניה הקודמת (${t.book.title})` : `"${c.text}": ההפניה הקודמת (${t.book.title}), עם המקום החדש שצוין` });
  }
  const loc = c.elems.map((e) => (e.kind === "?" ? "" : `${KIND_WORD[e.kind] ?? ""} `) + e.n + (e.to ? `–${e.to}` : "")).join(", ");
  reasons.push({ code: `citations/location-${r.via}`, text: r.via === "heref" ? `המקום (${loc}) נמצא לפי ציוני המקום של השורות בספר: ${r.label}` : `המקום (${loc}) נמצא לפי כותרות הספר: ${r.label}` });
  rules.push(`citations.via-${r.via}`);
  if (c.bracketed) reasons.push({ code: "citations/brackets", text: "ההפניה כתובה בסוגריים" });
  if (c.commentator) {
    rules.push("citations.commentator");
    reasons.push({ code: "citations/commentator", text: `לפני ההפניה כתוב "${c.commentator}", ולכן הקישור הוא אל ${t.book.title} ולא אל ספר הבסיס` });
  }
  if (c.qualifier) rules.push(`citations.qualifier-${c.qualifier}`);
  if (r.wholeDaf) {
    rules.push("citations.whole-daf");
    warnings.push({ code: "citations/whole-daf", text: "לא צוין עמוד, ולכן הקישור הוא לשני עמודי הדף" });
  } else if (r.amudFromBareLetter) {
    rules.push("citations.amud-letter");
    warnings.push({ code: "citations/amud-letter", text: 'האות שאחרי מספר הדף נקראה כעמוד (א = ע"א, ב = ע"ב)' });
  }
  if (r.end > r.line) {
    rules.push("citations.range");
    if (ranged) reasons.push({ code: "citations/range", text: `ההפניה היא ליחידה שלמה, ולכן הקישור לכל השורות שלה (${r.line + 1}–${r.end + 1})` });
    else warnings.push({ code: "citations/range-first-line", text: "ההפניה היא ליחידה שלמה; לפי ההגדרות הקישור הוא לשורה הראשונה שלה בלבד" });
  }
  if (c.evidence === "medium") warnings.push({ code: "citations/bare-numbers", text: "המקום כתוב במספרים בלי סימן (פרק, סימן, דף) ובלי גרשיים" });
  if (c.numericName) warnings.push({ code: "citations/numeric-name", text: `השם "${c.name}" יכול להיקרא גם כמספר` });
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
  /** the index of a cited book, or null when it cannot be read */
  index(book: BookRef): TargetIndex | null;
  heRefAt?(book: BookRef, line: number): string | null;
}

export function runCitationsEngine(source: EngineBook, library: CitationLibrary, options: CitationsOptions = {}, ctx: EngineContext = {}): EngineResult {
  const run = CitationRun.fromCatalog(source.book, library.catalog, options);
  run.scan(source.lines);
  for (const b of run.targets()) run.resolveWith(library.index(b), b, library.heRefAt ? (l) => library.heRefAt!(b, l) : undefined);
  return run.finish(ctx);
}

/**
 * a book the library manages through Sefaria refs, by the database origin: the library list
 * (core/links/sefaria-titles.ts) stays out of the worker bundle; the export checks ranges by the list
 */
const sefariaSide = (book: BookRef): boolean => book.origin === "sefaria";
