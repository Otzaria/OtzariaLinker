import type { BookRef } from "../core/links/model";
import { baseTitleKey, declaredBaseTitle } from "../core/links/titles";
import { editionKey, pairOne, resolveBaseKey, titleIndex } from "./batch";
import { notesBaseTitle } from "./plan";

/*
 * Discovery of base/commentary pairs among many books (2.8, 2.9): which book is written on which, by the evidence the books carry —
 * the title ("X על Y", "הערות על Y"; the generator's own rule, batch.ts), the links the book already has to that base, and the folder
 * it is in. It PROPOSES, with a confidence and the reasons; it never links anything and never trusts a name alone: every proposal
 * says `requiresReview`, the engines then place the lines, and the user approves what they found.
 *
 * Confidence (what each says, nothing more):
 *   high    the book already has links to the base the title names (even where the title is shared and a choice was made), or the title
 *           names a base found by its exact title and the book sits in the same folder
 *   medium  the title names a base found by its exact title, one book, nothing else says it
 *   low     the base was found only after a choice (a title two books share, another spelling): the note says which
 * A title that names a book that is not open, or names none, is `unresolved` with the reason.
 *
 * HOW the base was decided is a separate answer, `selection` (fix round before the merge of PR 2): a name alone never decides a base.
 *   confirmed  the name AND another kind of evidence agree on this very book: links to it by KEY (or by title, when the title is unique),
 *              or the same category; and the links, if their highest line is known, fit the book's length
 *   review     the name alone (a unique title): a candidate for the user to look at, not to be linked on trust
 *   ambiguous  another open book has the very same title and no link by KEY says which, or the links reach lines the chosen book does not
 *              have (they were probably made to the other one): flagged, never to be linked automatically
 * `confidence` keeps its meaning (how strongly the name and the link counts say so); it is NOT permission to link: only `selection` is.
 */
export interface DiscoveryBook extends BookRef {
  /** the library folder path, when the source has one ("תלמוד בבלי") */
  category?: string;
  lineCount?: number;
  /** titles of the books this one already has links to, with how many (the source's own link summary) */
  linkedTo?: Readonly<Record<string, number>>;
  /** the same by the other book's KEY: when a title is shared by two books, this says which one the links go to */
  linkedKeys?: Readonly<Record<string, number>>;
  /** how many of its lines already carry a link (any) */
  linkedLines?: number;
  /**
   * The highest 0-based line index its links reach in the other book, by that book's KEY (when the source can tell): links that go past the
   * end of the book they are assigned to say they were made to another book of the same title.
   */
  linkedMaxLine?: Readonly<Record<string, number>>;
}

export type PairConfidence = "high" | "medium" | "low";
/**
 * unlinked: no line has a link; partly-linked: under 30% of its lines (the planner's old "thin" threshold); linked: the rest;
 * unknown: some lines are linked but the book's length is not known, so the share cannot be told
 */
export type PairStatus = "unlinked" | "partly-linked" | "linked" | "unknown";
/** ambiguous-title: another open book has the very same title as the base (typically one in the personal database and one in the official) */
/**
 * ambiguous-title: see above. links-exceed-base: the book's links to the base reach past the base's last line. (A proposal made on the name
 * alone is not a marker: it is `selection: "review"` with `evidence.links: "none"`.)
 */
export type ProposalMarker = "ambiguous-title" | "links-exceed-base";

/** How the base was decided (see the header): only "confirmed" may be linked without a person looking. */
export type PairSelection = "confirmed" | "review" | "ambiguous";

/** The kinds of evidence behind a proposal, for the screen to show and for the decision to be checked. */
export interface PairEvidence {
  /** the title names the base (always true: a proposal starts from a name) */
  name: true;
  /** the two books are in the same category/folder */
  category: boolean;
  /**
   * key: links go to THIS book (by its key); title: by title, and the title is unique; title-shared: by title, but another book has the
   * title too (no proof); none: no links known
   */
  links: "key" | "title" | "title-shared" | "none";
  /** fits: the highest linked line is inside the base; exceeds: past its end; unknown: not known */
  structure: "fits" | "exceeds" | "unknown";
  /** how many OTHER open books have the base's exact title */
  sameTitleBooks: number;
}

export interface PairProposal {
  dependant: DiscoveryBook;
  base: DiscoveryBook;
  kind: "commentary" | "notes";
  confidence: PairConfidence;
  reasons: string[];
  baseIsOfficial: boolean;
  status: PairStatus;
  /** how the base was decided: only "confirmed" may be linked without review */
  selection: PairSelection;
  evidence: PairEvidence;
  /** warnings about the proposal itself (empty: none) */
  markers: ProposalMarker[];
  /** keys of the OTHER open books with the base's exact title, when there are any (the user decides which one is meant) */
  sameTitleKeys?: string[];
  /** lines of the dependant already linked (when known) */
  existingLines?: number;
  /** links of the dependant to this very base (when known) */
  existingToBase?: number;
  requiresReview: true;
}

export interface DiscoverySummary {
  /** books whose title names a base ("X על Y", "הערות על Y") */
  titled: number;
  proposals: number;
  unresolved: number;
  officialBase: number;
  personalBase: number;
  byConfidence: Record<PairConfidence, number>;
  byStatus: Record<PairStatus, number>;
  bySelection: Record<PairSelection, number>;
}

export interface DiscoveryOptions {
  /** which books may be dependants (default: all); the bases are always every book given */
  dependants?: (b: DiscoveryBook) => boolean;
}

/** Under this share of its lines linked, a book counts as only partly linked. */
export const THIN_LINKED_SHARE = 0.3;

export function discoverPairs(books: readonly DiscoveryBook[], options: DiscoveryOptions = {}): { proposals: PairProposal[]; unresolved: { book: DiscoveryBook; reason: string }[]; summary: DiscoverySummary } {
  const index = titleIndex(books);
  const byKey = new Map(books.map((x) => [x.key, x] as const));
  const proposals: PairProposal[] = [];
  const unresolved: { book: DiscoveryBook; reason: string }[] = [];
  let titled = 0;
  for (const dep of books) {
    if (options.dependants && !options.dependants(dep)) continue;
    const notes = notesBaseTitle(dep.title);
    const named = notes ?? declaredBaseTitle(dep.title);
    if (!named) continue;
    titled++;
    const r = notes !== null ? resolveBaseKey(baseTitleKey(named), index, dep, named) : (() => {
      const p = pairOne(dep, index);
      return p.target ? { target: p.target, ...(p.note && { note: p.note }) } : { reason: p.reason! };
    })();
    if (!("target" in r)) {
      unresolved.push({ book: dep, reason: r.reason });
      continue;
    }
    let base = byKey.get(r.target.key)!;
    // the title is shared by books of two sources and the links the book already has go to the OTHER one: they decide (by key)
    let byLinks = false;
    if (dep.linkedKeys && !dep.linkedKeys[base.key]) {
      const sameTitle = (index.exact.get(baseTitleKey(base.title)) ?? []).filter((x) => x.key !== base.key && dep.linkedKeys![x.key]);
      if (sameTitle.length === 1) {
        base = byKey.get(sameTitle[0]!.key)!;
        byLinks = true;
      }
    }
    // another book with the base's very title, or an equivalent one ("מסכת ברכות"; #42 C12): a name alone cannot say which one the
    // commentary is on (v52: "ברכות" is a personal book and an official one; the book's 556 links reach lines the personal book does not have)
    const edition = editionKey(base.title);
    const sameTitle = books.filter((x) => x.key !== base.key && x.key !== dep.key && editionKey(x.title) === edition);
    const toBase = dep.linkedKeys?.[base.key] ?? dep.linkedTo?.[base.title];
    const keyConfirmed = (dep.linkedKeys?.[base.key] ?? 0) > 0;
    const titleOnly = sameTitle.length > 0 && !keyConfirmed;
    const sameFolder = !!dep.category && !!base.category && (dep.category === base.category || dep.category.startsWith(`${base.category}/`) || base.category.startsWith(`${dep.category}/`));
    const reasons = [`השם "${dep.title}" מציין את "${named}", והוא ספר ${base.origin === "personal" ? "אישי" : "של המאגר הרשמי"} פתוח בשם "${base.title}".`];
    if (r.note && !byLinks) reasons.push(r.note);
    if (byLinks) reasons.push(`יש כמה ספרים בשם "${base.title}"; הקישורים הקיימים של הספר מצביעים על זה (${base.origin === "personal" ? "אישי" : "של המאגר הרשמי"}), ולכן נבחר הוא.`);
    if (toBase) reasons.push(`לספר כבר יש ${toBase.toLocaleString("he")} קישורים אל "${base.title}"${titleOnly ? " (לפי שם הספר בלבד: יש גם ספר אחר בשם הזה, ולכן אין בכך הוכחה שהם אל הספר שנבחר)" : ""}.`);
    if (sameTitle.length && !byLinks) reasons.push(`יש כמה ספרים בשם "${base.title}" (${sameTitle.map((x) => `${x.key}, ${x.origin === "personal" ? "אישי" : "של המאגר הרשמי"}`).join("; ")}); בדקו שנבחר הספר הנכון.`);
    if (sameFolder) reasons.push(`שני הספרים באותה קטגוריה ("${dep.category}").`);
    // links the book already has to that title confirm even a choice made between lookalikes; a folder only confirms a plain match
    const confidence: PairConfidence = toBase ? "high" : r.note && !byLinks ? "low" : sameFolder ? "high" : "medium";
    // the decision, from what the books say and not from the name: see the header
    const maxLine = dep.linkedMaxLine?.[base.key];
    const structure: PairEvidence["structure"] = maxLine === undefined || !base.lineCount ? "unknown" : maxLine >= base.lineCount ? "exceeds" : "fits";
    const linkEvidence: PairEvidence["links"] = keyConfirmed ? "key" : toBase ? (sameTitle.length ? "title-shared" : "title") : "none";
    if (structure === "exceeds") reasons.push(`הקישורים של הספר אל "${base.title}" מגיעים עד שורה ${(maxLine! + 1).toLocaleString("he")}, מעבר לסוף הספר שנבחר (${base.lineCount!.toLocaleString("he")} שורות): ייתכן שהם נעשו לספר אחר באותו שם.`);
    const selection: PairSelection = structure === "exceeds" || (sameTitle.length > 0 && !keyConfirmed) ? "ambiguous" : linkEvidence === "key" || linkEvidence === "title" || sameFolder ? "confirmed" : "review";
    const linked = dep.linkedLines;
    const status: PairStatus = !linked ? "unlinked" : !dep.lineCount ? "unknown" : linked / dep.lineCount < THIN_LINKED_SHARE ? "partly-linked" : "linked";
    proposals.push({
      dependant: dep,
      base,
      kind: notes !== null ? "notes" : "commentary",
      confidence,
      reasons,
      baseIsOfficial: base.origin !== "personal",
      status,
      selection,
      evidence: { name: true, category: sameFolder, links: linkEvidence, structure, sameTitleBooks: sameTitle.length },
      markers: [...(sameTitle.length ? (["ambiguous-title"] as const) : []), ...(structure === "exceeds" ? (["links-exceed-base"] as const) : [])],
      ...(sameTitle.length && { sameTitleKeys: sameTitle.map((x) => x.key) }),
      ...(linked !== undefined && { existingLines: linked }),
      ...(toBase !== undefined && { existingToBase: toBase }),
      requiresReview: true,
    });
  }
  const summary: DiscoverySummary = {
    titled,
    proposals: proposals.length,
    unresolved: unresolved.length,
    officialBase: proposals.filter((p) => p.baseIsOfficial).length,
    personalBase: proposals.filter((p) => !p.baseIsOfficial).length,
    byConfidence: { high: 0, medium: 0, low: 0 },
    byStatus: { unlinked: 0, "partly-linked": 0, linked: 0, unknown: 0 },
    bySelection: { confirmed: 0, review: 0, ambiguous: 0 },
  };
  for (const p of proposals) {
    summary.byConfidence[p.confidence]++;
    summary.byStatus[p.status]++;
    summary.bySelection[p.selection]++;
  }
  return { proposals, unresolved, summary };
}


