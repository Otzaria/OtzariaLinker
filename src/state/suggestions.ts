import { batch, computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { BookRef, Link, LinkSide } from "../core/links/model";
import { CONFIDENCE_ORDER, type Confidence, type EngineId, type EngineResult, type Reason, type Suggestion } from "../linking/automatic";
import { pairByTitle, type BatchPair } from "../linking/batch";
import type { MaxLinkRunInfo } from "../linking/maxlink-report";
import { linePairKey } from "../linking/merge";
import { addChanges, commit, type Change, type LinkState } from "./history";
import type { BooksService, CallOptions, OpenedSource } from "./services";
import type { NoticeKind, Pick as LinePick, Side, SideTab } from "./store";

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
}

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
/** pending → the user has not decided; approved → a link exists for it; exists → the project already has that link */
export type SuggestionState = "pending" | "approved" | "rejected" | "exists";

export class SuggestionsState {
  readonly run = signal<SuggestionRun | null>(null);
  /** line pairs the open databases already link, for the books of the current run (see linePairKey) */
  readonly dbLinkKeys = signal<ReadonlySet<string>>(new Set());
  /**
   * Rejected suggestions, by a key made of book TITLES and positions (rejectionKey) — session book keys
   * change between sessions, titles do not — so a rejection survives re-runs and saved projects.
   */
  readonly rejected = signal<ReadonlySet<string>>(new Set());
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
    const ownIds = new Set(run.result.suggestions.map((s) => `auto:${s.id}`));
    const existing = new Set<string>();
    for (const l of links.values()) if (l.status !== "deleted" && !ownIds.has(l.id)) existing.add(linePairKey(l));
    for (const k of this.dbLinkKeys.value) existing.add(k);
    for (const s of run.result.suggestions) {
      const own = links.get(`auto:${s.id}`);
      m.set(s.id, own && own.status !== "deleted" ? "approved" : rejectionKeys(s).some((k) => rejected.has(k)) ? "rejected" : existing.has(linePairKey(s)) ? "exists" : "pending");
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
    const result = await this.host.runTask(`מחפש התאמות: ${source.title} ← ${target.title}…`, (opts) => this.service.runEngine(engine, source, target, this.withSefaria(options, [source.key, target.key]), opts));
    if (!result) return false;
    await this.loadDbLinkKeys([source.key]);
    batch(() => {
      this.run.value = { engine, label: `${source.title} ← ${target.title}`, result, at: Date.now() };
      this.current.value = result.suggestions[0]?.id ?? null;
      this.host.sideTab.value = "suggestions";
    });
    const c = this.counts.value;
    this.host.notify("success", `נמצאו ${result.suggestions.length.toLocaleString("he")} הצעות: ${c.certain} ודאיות, ${c.high} גבוהות, ${c.possible + c.ambiguous} לבדיקה.`);
    return true;
  }

  /**
   * The citations engine (single book): the references in one book ("(בראשית א, ב)", "ב"ק דף ט:"),
   * linked into whatever books are open. There is no target to pick.
   */
  async runCitations(sourceKey: string, options: Record<string, unknown> = {}): Promise<boolean> {
    const source = this.host.refOf(sourceKey);
    const result = await this.host.runTask(`מחפש מראי מקומות: ${source.title}…`, (opts) => this.service.runCitations(source, this.withSefaria(options), opts));
    if (!result) return false;
    await this.loadDbLinkKeys([source.key]);
    batch(() => {
      this.run.value = { engine: "citations", label: `מראי מקומות: ${source.title}`, result, at: Date.now() };
      this.current.value = result.suggestions[0]?.id ?? null;
      this.host.sideTab.value = "suggestions";
    });
    const c = this.counts.value;
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
    const items = await this.host.runTask(`קישור אצוותי: ${runnable.length} ספרים…`, (opts) => this.service.runBatch(engine, runnable.map(({ source, target }) => ({ source, target })), this.withSefaria(options, runnable.flatMap((p) => [p.source.key, p.target.key])), opts));
    if (!items) return false;
    await this.loadDbLinkKeys(runnable.map((p) => p.source.key));
    const suggestions: Suggestion[] = [];
    const notes: Reason[] = [];
    const rows: BatchRow[] = pairs.map((p) => ({ source: p.source, target: p.target, ...(p.reason && { problem: p.reason }), suggestions: 0, certain: 0, high: 0, review: 0 }));
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
      this.run.value = { engine, label: `אצווה: ${runnable.length} מתוך ${pairs.length} ספרים`, result: { suggestions, notes, unmatched: [] }, at: Date.now(), batch: rows };
      this.current.value = suggestions[0]?.id ?? null;
      this.host.sideTab.value = "suggestions";
    });
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
   */
  private async loadDbLinkKeys(bookKeys: readonly string[]): Promise<void> {
    const keys = new Set<string>();
    for (const key of new Set(bookKeys)) {
      try {
        for (const l of await this.service.existingLinks(key, 0, Number.MAX_SAFE_INTEGER)) keys.add(linePairKey(l));
      } catch {
        /* a source without links (text files) or a read error: nothing to compare with */
      }
    }
    this.dbLinkKeys.value = keys;
  }

  /** The link approving a suggestion makes. */
  private linkOf(s: Suggestion): Link {
    return {
      id: `auto:${s.id}`,
      status: "new",
      provenance: "auto",
      source: s.source,
      target: s.target,
      declaredType: s.declaredType,
      // every engine's reference, never blank (B3): the target's title and line otherwise
      heRef2: s.heRef2.trim() ? s.heRef2 : `${s.target.book.title} ${s.target.line + 1}`,
      ...(s.anchor && { anchor: s.anchor }),
    };
  }

  approve(ids: readonly string[]): number {
    const run = this.run.value;
    if (!run) return 0;
    const st = this.state.value;
    const want = new Set(ids);
    const links = run.result.suggestions.filter((s) => want.has(s.id) && st.get(s.id) !== "approved" && st.get(s.id) !== "exists").map((s) => this.linkOf(s));
    if (!links.length) return 0;
    const ids2 = new Set(links.map((l) => l.id.slice(5)));
    batch(() => {
      this.commit(links.length === 1 ? "אישור הצעה" : `אישור ${links.length.toLocaleString("he")} הצעות`, addChanges(links));
      const keys = new Set(run.result.suggestions.filter((x) => ids2.has(x.id)).flatMap(rejectionKeys));
      if ([...keys].some((k) => this.rejected.value.has(k))) this.rejected.value = new Set([...this.rejected.value].filter((k) => !keys.has(k)));
    });
    return links.length;
  }

  reject(ids: readonly string[]): void {
    const { linkState } = this.host;
    const approved = ids.map((id) => `auto:${id}`).filter((id) => linkState.value.links.has(id));
    batch(() => {
      if (approved.length) this.commit(approved.length === 1 ? "ביטול אישור של הצעה" : `ביטול אישור של ${approved.length.toLocaleString("he")} הצעות`, approved.map((id) => ({ id, before: linkState.value.links.get(id)! })));
      this.rejected.value = new Set([...this.rejected.value, ...this.keysOf(ids)]);
    });
  }

  /** Back to "pending": forgets the rejection. */
  reset(ids: readonly string[]): void {
    const drop = new Set(this.keysOf(ids));
    this.rejected.value = new Set([...this.rejected.value].filter((k) => !drop.has(k)));
  }

  private keysOf(ids: readonly string[]): string[] {
    const want = new Set(ids);
    return (this.run.value?.result.suggestions ?? []).filter((x) => want.has(x.id)).flatMap(rejectionKeys);
  }

  /** Pending suggestions at or above a confidence, e.g. "approve every certain one". */
  pendingAtLeast(level: Confidence): string[] {
    const st = this.state.value;
    const max = CONFIDENCE_ORDER.indexOf(level);
    return (this.run.value?.result.suggestions ?? []).filter((s) => st.get(s.id) === "pending" && CONFIDENCE_ORDER.indexOf(s.confidence) <= max).map((s) => s.id);
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

  private commit(label: string, changes: Change[]): void {
    this.host.linkState.value = commit(this.host.linkState.value, label, changes);
  }
}

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
