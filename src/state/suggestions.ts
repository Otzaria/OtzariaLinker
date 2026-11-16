import { batch, computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { BookRef, Link, LinkSide } from "../core/links/model";
import { CONFIDENCE_ORDER, recordsOf, type Confidence, type EngineId, type EngineResult, type Reason, type Suggestion } from "../linking/automatic";
import { pairByTitle, type BatchPair } from "../linking/batch";
import type { MaxLinkRunInfo } from "../linking/maxlink-report";
import { linePairKey } from "../linking/merge";
import { addChanges, commit, type Change, type LinkState } from "./history";
import type { BooksService, CallOptions, OpenedSource } from "./services";
import type { NoticeKind, Pick as LinePick, Side, SideTab } from "./store";
import { CHUNK, type LineStore } from "./lines";
import { htmlToPlainText } from "../core/text/html";

/*
 * Automatic suggestions (stage 8): running an engine on a pair of books, the citations engine on one
 * book, or a batch of commentaries against their bases; the state of every suggestion of the current
 * run (pending / approved / rejected / exists), and the user's decisions on them. Approving makes
 * "auto:<id>" links through history.commit — ONE undoable action per decision — so "approved" is
 * derived from the links, and undo returns a suggestion to "pending". A max-link run (state/maxlink.ts)
 * writes its merged suggestions into the same `run`, so everything here works on it unchanged.
 * Kept out of store.ts on purpose, like alt-toc.ts and ranges.ts.
 */
export interface SuggestionsHost {
  readonly linkState: Signal<LinkState>;
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  readonly sources: ReadonlySignal<OpenedSource[]>;
  readonly view: Record<Side, Signal<string | null>>;
  readonly pick: Record<Side, Signal<LinePick | null>>;
  readonly sideTab: Signal<SideTab>;
  refOf(bookKey: string): BookRef;
  /** the lines of open books (the suggestion table shows the start of each line, audit F17) */
  readonly lines: Pick<LineStore, "peek" | "load">;
  /** a line's place name when the database has none: "<title> <headings>" (store.autoHeRef) */
  autoHeRef(at: { bookKey: string; line: number }): string;
  reveal(side: Side, bookKey: string, line: number): void;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
  /** keys of the open books (of the given keys) the library treats as Sefaria's (AppStore.sefariaOwnedKeys) */
  sefariaOwnedKeys?(keys?: Iterable<string>): string[];
}

/** One run of an automatic engine and the user's decisions on it. */
export interface SuggestionRun {
  engine: EngineId;
  /** "<source> ← <target>" or "אצווה: N ספרים" */
  label: string;
  result: EngineResult;
  at: number;
  /** a batch run: one summary row per book (paired or not) */
  batch?: BatchRow[];
  /** a max-link run: the plan, every step's outcome and the merge counts (state/maxlink.ts) */
  maxlink?: MaxLinkRunInfo;
  /** a pair run: the book the user chose as the source — the table reads every row from it (audit F18) */
  from?: string;
  /** the run was cancelled: its suggestions are what the engine found until then ("engine/aborted") */
  partial?: boolean;
  /**
   * Books whose database links could not be read (review C13): their suggestions cannot be compared with
   * the library, so one that exists there shows as pending — a bulk approval waits for retryDbLinks().
   */
  dbLinksUnread?: readonly { key: string; title: string }[];
}

/** A suggestion as the table shows it: from the user's book to the other (audit F17, F18). */
export interface SuggestionView {
  from: LinkSide;
  to: LinkSide;
  /** the place name of `to` */
  toLabel: string;
  /** the suggestion is stored the other way (base → commentary); the table reads it from the user's book */
  reversed: boolean;
}

const SNIPPET_WORDS = 7;

export interface BatchRow {
  source: BookRef;
  target: BookRef | null;
  /** why the book was not run (unpaired) or failed */
  problem?: string;
  suggestions: number;
  certain: number;
  high: number;
  review: number;
}
/**
 * The id of the link a suggestion's record is approved as: "auto:<suggestion id>" for its target line, and
 * "auto:<suggestion id>~L<line>" for each further line of a span written a line at a time on a Sefaria side
 * (Suggestion.spanLines). suggestionIdOfLink reads the suggestion back from either.
 */
export function recordLinkId(s: Suggestion, line: number): string {
  return line === s.target.line ? `auto:${s.id}` : `auto:${s.id}~L${line}`;
}

/** The suggestion an "auto:" link was approved from (recordLinkId), or undefined for any other link. */
export function suggestionIdOfLink(linkId: string): string | undefined {
  return linkId.startsWith("auto:") ? linkId.slice(5).replace(/~L\d+$/, "") : undefined;
}

/** pending → the user has not decided; approved → a link exists for it; exists → the project already has that link */
export type SuggestionState = "pending" | "approved" | "rejected" | "exists";

/**
 * Approving many suggestions together (V5 UX audit U21, the owner's decision): the levels to include,
 * and optionally one book (either side) or one method. Nothing is chosen for the user: "possible" and
 * "ambiguous" are in only when ticked. The approval itself is the one path there is, `approve`.
 */
export interface BulkChoice {
  levels: readonly Confidence[];
  book?: string;
  engine?: EngineId;
}

/** What a bulk choice would approve: the suggestions, per level, and the records they write. */
export interface BulkPreview {
  ids: string[];
  byLevel: Partial<Record<Confidence, number>>;
  /** the links (file records) approving them writes — more than `ids` when a span on a Sefaria side is written a line at a time */
  records: number;
}

/** The levels a bulk approval starts with; the others only when the user ticks them. */
export const BULK_DEFAULT_LEVELS: readonly Confidence[] = ["certain", "high"];

export class SuggestionsState {
  readonly run = signal<SuggestionRun | null>(null);
  /** line pairs the open databases already link, for the books of the current run (see linePairKey) */
  readonly dbLinkKeys = signal<ReadonlySet<string>>(new Set());
  /**
   * Rejected suggestions, by a key made of book TITLES and positions (rejectionKey) — session book keys
   * change between sessions, titles do not — so a rejection survives re-runs and saved projects. They
   * live in LinkState: rejecting is an undoable action like approving, and it is saved (review C10).
   */
  readonly rejected = computed<ReadonlySet<string>>(() => this.host.linkState.value.rejected);
  /** the suggestion shown in the inline/card views */
  readonly current = signal<string | null>(null);

  readonly state = computed(() => {
    const run = this.run.value;
    const m = new Map<string, SuggestionState>();
    if (!run) return m;
    const links = this.host.linkState.value.links;
    const rejected = this.rejected.value;
    // every other link counts — also one approved from ANOTHER run (another engine, a max-link run), which
    // would otherwise be approved twice; only this run's own approvals are left out
    const ownIds = new Set(run.result.suggestions.flatMap((s) => recordsOf(s).map((r) => recordLinkId(s, r.line))));
    const existing = new Set<string>();
    for (const l of links.values()) if (l.status !== "deleted" && !ownIds.has(l.id)) existing.add(linePairKey(l));
    for (const k of this.dbLinkKeys.value) existing.add(k);
    for (const s of run.result.suggestions) {
      const records = recordsOf(s);
      // approved: a link of any of its records; exists: every record is already there (a span written a line at a time)
      const own = records.some((r) => {
        const l = links.get(recordLinkId(s, r.line));
        return l !== undefined && l.status !== "deleted";
      });
      m.set(s.id, own ? "approved" : rejectionKeys(s).some((k) => rejected.has(k)) ? "rejected" : records.every((r) => existing.has(linePairKey(recordAt(s, r.line)))) ? "exists" : "pending");
    }
    return m;
  });

  readonly counts = computed(() => {
    const c: Record<Confidence | SuggestionState, number> = { certain: 0, high: 0, possible: 0, ambiguous: 0, none: 0, pending: 0, approved: 0, rejected: 0, exists: 0 };
    const st = this.state.value;
    for (const s of this.run.value?.result.suggestions ?? []) {
      c[s.confidence]++;
      c[st.get(s.id) ?? "pending"]++;
    }
    return c;
  });

  constructor(
    private readonly host: SuggestionsHost,
    private readonly service: Pick<BooksService, "runEngine" | "runCitations" | "runBatch" | "existingLinks">,
  ) {}

  async runEngine(engine: EngineId, sourceKey: string, targetKey: string, options: Record<string, unknown> = {}): Promise<boolean> {
    const source = this.host.refOf(sourceKey);
    const target = this.host.refOf(targetKey);
    // a cancel keeps what the engine found until then (keepPartial), shown as partial
    const result = await this.host.runTask(`מחפש התאמות: ${source.title} ← ${target.title}…`, (opts) => this.service.runEngine(engine, source, target, this.withSefaria(options, [source.key, target.key]), { ...opts, keepPartial: true }));
    if (!result) return false;
    const unread = await this.loadDbLinkKeys([source.key]);
    const partial = isPartial(result);
    batch(() => {
      this.run.value = { engine, label: `${source.title} ← ${target.title}${partial ? PARTIAL_LABEL : ""}`, result, at: Date.now(), from: sourceKey, ...(unread.length && { dbLinksUnread: unread }), ...(partial && { partial }) };
      this.current.value = result.suggestions[0]?.id ?? null;
      this.host.sideTab.value = "suggestions";
    });
    const c = this.counts.value;
    if (partial) this.host.notify("warning", partialNotice(result.suggestions.length));
    else this.host.notify("success", `נמצאו ${result.suggestions.length.toLocaleString("he")} הצעות: ${c.certain} ודאיות, ${c.high} גבוהות, ${c.possible + c.ambiguous} לבדיקה.`);
    return true;
  }

  /**
   * The citations engine (single book): the references in one book ("(בראשית א, ב)", "ב"ק דף ט:"),
   * linked into whatever books are open. There is no target to pick.
   */
  async runCitations(sourceKey: string, options: Record<string, unknown> = {}): Promise<boolean> {
    const source = this.host.refOf(sourceKey);
    const result = await this.host.runTask(`מחפש מראי מקומות: ${source.title}…`, (opts) => this.service.runCitations(source, this.withSefaria(options), { ...opts, keepPartial: true }));
    if (!result) return false;
    const unread = await this.loadDbLinkKeys([source.key]);
    const partial = isPartial(result);
    batch(() => {
      this.run.value = { engine: "citations", label: `מראי מקומות: ${source.title}${partial ? PARTIAL_LABEL : ""}`, result, at: Date.now(), ...(unread.length && { dbLinksUnread: unread }), ...(partial && { partial }) };
      this.current.value = result.suggestions[0]?.id ?? null;
      this.host.sideTab.value = "suggestions";
    });
    const c = this.counts.value;
    if (partial) return this.host.notify("warning", partialNotice(result.suggestions.length)), true;
    this.host.notify("success", `נמצאו ${result.suggestions.length.toLocaleString("he")} מראי מקומות: ${c.certain} ודאיים, ${c.high} בוודאות גבוהה, ${c.possible + c.ambiguous} לבדיקה.`);
    return true;
  }

  /**
   * Batch linking (stage 8.4): every book of one open source (e.g. a folder of commentaries) against
   * the base book its title names, among all open books. Unpaired books are listed with the reason.
   */
  async runBatch(engine: EngineId, sourceId: string, options: Record<string, unknown> = {}): Promise<boolean> {
    const src = this.host.sources.value.find((s) => s.info.id === sourceId);
    if (!src) return false;
    const commentaries = src.books.map((b) => this.host.refOf(b.key));
    const bases = [...this.host.books.value.values()].map((b) => this.host.refOf(b.key));
    const pairs = pairByTitle(commentaries, bases);
    const runnable = pairs.filter((p): p is BatchPair & { target: BookRef } => p.target !== null);
    if (!runnable.length) {
      this.host.notify("warning", "לא זוהה ספר בסיס לאף ספר במקור הזה.", pairs.map((p) => `${p.source.title}: ${p.reason}`));
      return false;
    }
    const items = await this.host.runTask(`קישור אצוותי: ${runnable.length} ספרים…`, (opts) => this.service.runBatch(engine, runnable.map(({ source, target }) => ({ source, target })), this.withSefaria(options, runnable.flatMap((p) => [p.source.key, p.target.key])), { ...opts, keepPartial: true }));
    if (!items) return false;
    const unread = await this.loadDbLinkKeys(runnable.map((p) => p.source.key));
    const suggestions: Suggestion[] = [];
    const notes: Reason[] = [];
    // a cancel keeps the books done and what the last one found (keepPartial); the rest say they did not run
    const reached = new Set(items.map((it) => it.source.key));
    const partial = items.length < runnable.length || items.some((it) => it.result && isPartial(it.result));
    const rows: BatchRow[] = pairs.map((p) => ({ source: p.source, target: p.target, ...((p.reason && { problem: p.reason }) || (p.target && !reached.has(p.source.key) && { problem: "לא רץ: הריצה נעצרה לפני הספר הזה." })), suggestions: 0, certain: 0, high: 0, review: 0 }));
    for (const it of items) {
      const row = rows.find((r) => r.source.key === it.source.key)!;
      if (it.error) row.problem = it.error;
      for (const sg of it.result?.suggestions ?? []) {
        suggestions.push(sg);
        row.suggestions++;
        if (sg.confidence === "certain") row.certain++;
        else if (sg.confidence === "high") row.high++;
        else row.review++;
      }
      for (const n of it.result?.notes ?? []) notes.push({ code: n.code, text: `${it.source.title}: ${n.text}` });
    }
    batch(() => {
      this.run.value = { engine, label: `אצווה: ${runnable.length} מתוך ${pairs.length} ספרים${partial ? PARTIAL_LABEL : ""}`, result: { suggestions, notes, unmatched: [] }, at: Date.now(), batch: rows, ...(unread.length && { dbLinksUnread: unread }), ...(partial && { partial }) };
      this.current.value = suggestions[0]?.id ?? null;
      this.host.sideTab.value = "suggestions";
    });
    if (partial) return this.host.notify("warning", partialNotice(suggestions.length)), true;
    const failed = rows.filter((r) => r.problem).length;
    this.host.notify(failed ? "warning" : "success", `האצווה הסתיימה: ${suggestions.length.toLocaleString("he")} הצעות ב־${runnable.length} ספרים${failed ? `; ${failed} ספרים לא קושרו (ראו בטבלת הסיכום)` : ""}.`);
    return true;
  }

  /**
   * The engine options with the library's answer to "is this a Sefaria book" for the books of the run
   * (core/links/sefaria-owned.ts): the engines then never propose what the export refuses (F1).
   */
  private withSefaria(options: Record<string, unknown>, keys?: Iterable<string>): Record<string, unknown> {
    return this.host.sefariaOwnedKeys ? { ...options, sefariaOwned: this.host.sefariaOwnedKeys(keys) } : options;
  }

  /**
   * The library may already have a suggested link (compatibility review #7): read the database links
   * of the run's source books, so such suggestions show as "already exists" instead of as new.
   * A source without links (text files) answers with none; a throw is a real failure (a damaged
   * database, a restarted worker): the user is told, and the books are returned so the run can hold
   * back a bulk approval until the read succeeds (review C13). `add` keeps the keys read before.
   */
  private async loadDbLinkKeys(bookKeys: readonly string[], add = false): Promise<{ key: string; title: string }[]> {
    const keys = new Set<string>(add ? this.dbLinkKeys.peek() : []);
    const unread: { key: string; title: string; why: string }[] = [];
    for (const key of new Set(bookKeys)) {
      try {
        for (const l of await this.service.existingLinks(key, 0, Number.MAX_SAFE_INTEGER)) keys.add(linePairKey(l));
      } catch (err) {
        unread.push({ key, title: this.host.refOf(key).title, why: (err as Error)?.message ?? String(err) });
      }
    }
    this.dbLinkKeys.value = keys;
    if (unread.length)
      this.host.notify(
        "warning",
        `הקישורים שכבר יש במסד ל־${unread.map((u) => `"${u.title}"`).join(", ")} לא נקראו, ולכן הצעות שכבר קיימות בספרייה עלולות להופיע כממתינות. אישור של כמה הצעות יחד מושבת עד שהם ייקראו: לחצו "קריאה חוזרת" בחלונית ההצעות.`,
        unread.map((u) => `${u.title}: ${u.why}`),
      );
    return unread.map(({ key, title }) => ({ key, title }));
  }

  /** Reads again the database links that failed for the current run (review C13). True when all were read. */
  async retryDbLinks(): Promise<boolean> {
    const run = this.run.peek();
    if (!run?.dbLinksUnread?.length) return true;
    const unread = await this.loadDbLinkKeys(run.dbLinksUnread.map((u) => u.key), true);
    if (this.run.peek() !== run) return false;
    const { dbLinksUnread: _u, ...rest } = run;
    this.run.value = { ...rest, ...(unread.length && { dbLinksUnread: unread }) };
    if (!unread.length) this.host.notify("success", "הקישורים שכבר יש במסד נקראו. הצעות שכבר קיימות בספרייה מסומנות עכשיו \"כבר קיים\".");
    return !unread.length;
  }

  /** The link approving a suggestion makes. */
  /**
   * The links approving a suggestion makes: one per record (recordsOf — one, or a line at a time for a
   * short span on a Sefaria side), less the records the project or the database already has (`existing`:
   * line-pair keys), so an identical record is never written twice.
   */
  private linksOf(s: Suggestion, existing: ReadonlySet<string>): Link[] {
    const records = recordsOf(s);
    return records
      .map((r): Link => {
        const at = recordAt(s, r.line);
        return {
          id: recordLinkId(s, r.line),
          status: "new",
          provenance: "auto",
          source: at.source,
          target: at.target,
          declaredType: s.declaredType,
          // every engine's reference, never blank (B3): the target's title and line otherwise
          heRef2: r.heRef2.trim() ? r.heRef2 : `${at.target.book.title} ${at.target.line + 1}`,
          ...(s.anchor && { anchor: s.anchor }),
        };
      })
      .filter((l) => records.length === 1 || !existing.has(linePairKey(l)));
  }

  /** line-pair keys of the links the project and the open databases have, but not those of these suggestions' own records */
  private existingKeys(own: readonly Suggestion[]): Set<string> {
    const ownIds = new Set(own.flatMap((s) => recordsOf(s).map((r) => recordLinkId(s, r.line))));
    const out = new Set<string>(this.dbLinkKeys.value);
    for (const l of this.host.linkState.value.links.values()) if (l.status !== "deleted" && !ownIds.has(l.id)) out.add(linePairKey(l));
    return out;
  }

  approve(ids: readonly string[]): number {
    const run = this.run.value;
    if (!run) return 0;
    const st = this.state.value;
    const want = new Set(ids);
    const chosen = run.result.suggestions.filter((s) => want.has(s.id) && st.get(s.id) !== "approved" && st.get(s.id) !== "exists");
    if (!chosen.length) return 0;
    const existing = this.existingKeys(chosen);
    const links = chosen.flatMap((s) => this.linksOf(s, existing));
    if (chosen.length > 1 && run.dbLinksUnread?.length) {
      this.host.notify("warning", `ההצעות לא אושרו: הקישורים שכבר יש במסד ל־${run.dbLinksUnread.map((u) => `"${u.title}"`).join(", ")} לא נקראו, וחלק מההצעות אולי כבר קיימות בספרייה. לחצו "קריאה חוזרת" בחלונית ההצעות, או אשרו הצעות אחת אחת אחרי בדיקה.`);
      return 0;
    }
    // an approval forgets a rejection of the same suggestion, in the same step: undo brings both back
    const keys = chosen.flatMap(rejectionKeys);
    this.commit(chosen.length === 1 ? "אישור הצעה" : `אישור ${chosen.length.toLocaleString("he")} הצעות`, addChanges(links), { remove: keys });
    return chosen.length;
  }

  /** Rejects suggestions — and removes the links of the approved ones among them — as ONE undoable action. */
  reject(ids: readonly string[]): void {
    const { links } = this.host.linkState.value;
    const byId = new Map((this.run.value?.result.suggestions ?? []).map((s) => [s.id, s]));
    // every record's link of an approved suggestion goes with it (a span written a line at a time)
    const recordIds = (id: string) => {
      const s = byId.get(id);
      return s ? recordsOf(s).map((r) => recordLinkId(s, r.line)) : [`auto:${id}`];
    };
    const approvedIds = ids.filter((id) => recordIds(id).some((x) => links.has(x)));
    const removed = ids.flatMap(recordIds).filter((x) => links.has(x));
    const n = ids.length;
    const label = approvedIds.length
      ? approvedIds.length === 1 ? "ביטול אישור של הצעה" : `ביטול אישור של ${approvedIds.length.toLocaleString("he")} הצעות`
      : n === 1 ? "דחיית הצעה" : `דחיית ${n.toLocaleString("he")} הצעות`;
    this.commit(label, removed.map((id) => ({ id, before: links.get(id)! })), { add: this.keysOf(ids) });
  }

  /** Back to "pending": forgets the rejection (undoable). */
  reset(ids: readonly string[]): void {
    this.commit(ids.length === 1 ? "החזרת הצעה להמתנה" : `החזרת ${ids.length.toLocaleString("he")} הצעות להמתנה`, [], { remove: this.keysOf(ids) });
  }

  private keysOf(ids: readonly string[]): string[] {
    const want = new Set(ids);
    return (this.run.value?.result.suggestions ?? []).filter((x) => want.has(x.id)).flatMap(rejectionKeys);
  }

  /** The pending suggestions by book (either side) and by method, most first — what a bulk approval can narrow to. */
  bulkGroups(): { books: { title: string; count: number }[]; engines: { id: EngineId; count: number }[] } {
    const st = this.state.value;
    const books = new Map<string, number>();
    const engines = new Map<EngineId, number>();
    for (const x of this.run.value?.result.suggestions ?? []) {
      if (st.get(x.id) !== "pending") continue;
      for (const t of new Set([x.source.book.title, x.target.book.title])) books.set(t, (books.get(t) ?? 0) + 1);
      engines.set(x.engine, (engines.get(x.engine) ?? 0) + 1);
    }
    const most = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1]);
    return { books: most(books).map(([title, count]) => ({ title, count })), engines: most(engines).map(([id, count]) => ({ id, count })) };
  }

  /** The pending suggestions a bulk choice takes, per level, and the records approving them writes (the same count `approve` makes). */
  bulkPreview(c: BulkChoice): BulkPreview {
    const st = this.state.value;
    const levels = new Set(c.levels);
    const chosen = (this.run.value?.result.suggestions ?? []).filter(
      (x) => st.get(x.id) === "pending" && levels.has(x.confidence) && (!c.book || x.source.book.title === c.book || x.target.book.title === c.book) && (!c.engine || x.engine === c.engine),
    );
    const byLevel: Partial<Record<Confidence, number>> = {};
    for (const x of chosen) byLevel[x.confidence] = (byLevel[x.confidence] ?? 0) + 1;
    const existing = chosen.length ? this.existingKeys(chosen) : new Set<string>();
    const records = chosen.reduce((n, x) => n + this.linksOf(x, existing).length, 0);
    return { ids: chosen.map((x) => x.id), byLevel, records };
  }

  /** Pending suggestions at or above a confidence, e.g. "approve every certain one". */
  pendingAtLeast(level: Confidence): string[] {
    const st = this.state.value;
    const max = CONFIDENCE_ORDER.indexOf(level);
    return (this.run.value?.result.suggestions ?? []).filter((s) => st.get(s.id) === "pending" && CONFIDENCE_ORDER.indexOf(s.confidence) <= max).map((s) => s.id);
  }

  /**
   * A row as the user reads it (audit F18): a pair run reads from the book the user chose as the
   * source, also where the engine stores the link the other way (dibur hamatchil: base → commentary);
   * then the place name is the base line's own.
   */
  display(s: Suggestion): SuggestionView {
    const from = this.run.peek()?.from;
    const reversed = !!from && s.source.book.key !== from && s.target.book.key === from;
    if (!reversed) return { from: s.source, to: s.target, toLabel: s.heRef2, reversed };
    return { from: s.target, to: s.source, toLabel: this.host.autoHeRef({ bookKey: s.source.book.key, line: s.source.line }), reversed };
  }

  /** The start of a line's text, which tells apart rows with the same place name (audit F17); undefined until loaded. */
  snippet(side: LinkSide): string | undefined {
    const l = this.host.lines.peek(side.book.key, side.line);
    if (!l) return undefined;
    const words = htmlToPlainText(l.text).trim().split(/\s+/).filter(Boolean);
    return words.slice(0, SNIPPET_WORDS).join(" ") + (words.length > SNIPPET_WORDS ? "…" : "");
  }

  /** Loads the lines at both ends of the shown rows, for their snippets and place names. */
  async loadPreviews(list: readonly Suggestion[]): Promise<void> {
    const books = this.host.books.peek();
    const need = new Map<string, Set<number>>();
    for (const s of list)
      for (const side of [s.source, s.target])
        if (books.has(side.book.key)) need.set(side.book.key, (need.get(side.book.key) ?? new Set()).add(Math.floor(side.line / CHUNK)));
    for (const [key, chunks] of need)
      for (const c of chunks)
        try {
          await this.host.lines.load(key, c * CHUNK, c * CHUNK);
        } catch {
          /* a preview is best effort: a book closed meanwhile shows the place name alone */
        }
  }

  /** Moves the inline/card view to a suggestion and shows both ends in the readers. */
  show(id: string): void {
    const s = this.run.value?.result.suggestions.find((x) => x.id === id);
    if (!s) return;
    const { view, pick } = this.host;
    batch(() => {
      this.current.value = id;
      // show each end in the reader that already holds its book (a suggestion may run base → commentary)
      const sideOf = (key: string, fallback: Side): Side => (view.source.value === key ? "source" : view.target.value === key ? "target" : fallback);
      const a = sideOf(s.source.book.key, "source");
      const b: Side = a === "source" ? "target" : "source";
      for (const [side, end] of [[a, s.source], [b, s.target]] as const) {
        pick[side].value = { bookKey: end.book.key, line: end.line, ...(end.end !== undefined && { end: end.end }) };
        this.host.reveal(side, end.book.key, end.line);
      }
    });
  }

  private commit(label: string, changes: Change[], rejections?: { add?: Iterable<string>; remove?: Iterable<string> }): void {
    this.host.linkState.value = commit(this.host.linkState.value, label, changes, Date.now(), [], [], rejections);
  }
}

/** One record of a suggestion: the suggestion with its target moved to that line (recordsOf). */
function recordAt(s: Suggestion, line: number): { source: LinkSide; target: LinkSide } {
  return line === s.target.line ? s : { source: s.source, target: { book: s.target.book, line } };
}

/** An engine result cut short by a cancel: the engines stop with an "engine/aborted" note and return what they found. */
export const isPartial = (r: EngineResult): boolean => r.notes.some((n) => n.code === "engine/aborted");
const PARTIAL_LABEL = " (חלקי: הריצה נעצרה)";
const partialNotice = (n: number) => `הריצה נעצרה לפני הסוף: מוצגות ${n.toLocaleString("he")} ההצעות שנמצאו עד העצירה, והן חלקיות — לא כל הספר נבדק. הריצו שוב כדי לקבל את כולן.`;

/** A suggestion's identity across sessions: engine, book titles, lines and anchor — never session keys. */
export function rejectionKey(s: Suggestion): string {
  const end = (e: LinkSide) => `${e.book.title}#${e.line}${e.end !== undefined ? `-${e.end}` : ""}`;
  return `${s.engine}|${end(s.source)}${s.anchor ? `@${s.anchor.rawStart}` : ""}>${end(s.target)}`;
}

/**
 * Every key a rejection of this suggestion is stored and recognised under. A merged (max-link)
 * suggestion also has the key of each raw suggestion it was made of — so a rejection made in a
 * single-engine run still holds — and one without engine or direction, which survives a re-run whose
 * representative record comes from another engine. (Its anchor counts only where one engine gave
 * several links between the same two lines — footnote markers — and the merge kept them apart.)
 */
export function rejectionKeys(s: Suggestion): string[] {
  const members = (s as { members?: readonly { suggestion: Suggestion }[] }).members;
  if (!members?.length) return [rejectionKey(s)];
  const end = (e: LinkSide) => `${e.book.title}#${e.line}${e.end !== undefined ? `-${e.end}` : ""}`;
  const pair = (x: Suggestion) => [end(x.source), end(x.target)].sort().join("<>");
  const own = pair(s);
  const exact = members.filter((m) => pair(m.suggestion) === own).map((m) => rejectionKey(m.suggestion));
  const split = s.id.includes("@") && s.anchor ? `@${end(s.source)}:${s.anchor.rawStart}` : "";
  return [...new Set([rejectionKey(s), ...exact])].concat(`*|${own}${split}`);
}
