import { pushTo } from "../core/collections";
import { batch, computed, type ReadonlySignal, type Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { BookRef } from "../core/links/model";
import type { EngineId, Reason } from "../linking/automatic";
import { buildReport, reportCsv, type MaxLinkReport, type MaxLinkRunInfo, type StepOutcome } from "../linking/maxlink-report";
import { linePairKey, mergeSuggestions, type MergedSuggestion, type MergeItem } from "../linking/merge";
import { planMaxLink, type MaxLinkPlan, type PlanBook } from "../linking/plan";
import type { LinkState } from "./history";
import type { BooksService, CallOptions, OpenedSource, Saver } from "./services";
import type { NoticeKind, SideTab } from "./store";
import type { SuggestionsState } from "./suggestions";

/*
 * Max-link ("קישור מרבי", stage 8.4) in the state layer: plan a selection (linking/plan.ts), run the
 * plan's steps in the worker, merge everything into ONE suggestions run (linking/merge.ts), and keep
 * the report. The run is an ordinary SuggestionRun, so the table, inline and card views, approve,
 * reject and undo work on it unchanged. Kept out of store.ts on purpose, like AltTocState.
 */
export type MaxLinkScope = { kind: "book"; key: string } | { kind: "source"; id: string } | { kind: "all" };

export interface MaxLinkHost {
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  readonly sources: ReadonlySignal<OpenedSource[]>;
  readonly linkState: Signal<LinkState>;
  /** the run, its state and the shown suggestion: a max-link run is an ordinary suggestions run */
  readonly suggestions: Pick<SuggestionsState, "run" | "dbLinkKeys" | "current" | "state">;
  readonly sideTab: Signal<SideTab>;
  refOf(bookKey: string): BookRef;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

export interface MaxLinkRunOptions {
  /** per-engine options (advanced mode) */
  engineOptions?: Partial<Record<EngineId, Record<string, unknown>>>;
}

export class MaxLinkState {
  /** the report of the current run, live: approvals, rejections and undo update it */
  readonly report = computed<MaxLinkReport | null>(() => {
    const run = this.host.suggestions.run.value;
    if (!run?.maxlink) return null;
    const st = this.host.suggestions.state.value;
    return buildReport(run.maxlink, run.result.suggestions as readonly MergedSuggestion[], (id) => st.get(id));
  });

  constructor(
    private readonly host: MaxLinkHost,
    private readonly service: BooksService,
    private readonly saver: Saver,
  ) {}

  /** The keys of the books a scope selects. */
  selection(scope: MaxLinkScope): string[] {
    if (scope.kind === "book") return this.host.books.value.has(scope.key) ? [scope.key] : [];
    if (scope.kind === "source") return this.host.sources.value.find((s) => s.info.id === scope.id)?.books.map((b) => b.key) ?? [];
    return [...this.host.books.value.keys()];
  }

  scopeLabel(scope: MaxLinkScope): string {
    if (scope.kind === "book") return `הספר "${this.host.refOf(scope.key).title}"`;
    if (scope.kind === "source") return `המקור "${this.host.sources.value.find((s) => s.info.id === scope.id)?.info.label ?? scope.id}"`;
    return "כל הספרים הפתוחים";
  }

  /** The plan for a scope, with only the ticked engines (all when `engines` is absent). */
  plan(scope: MaxLinkScope, engines?: ReadonlySet<EngineId>): MaxLinkPlan {
    const library: PlanBook[] = [...this.host.books.value.values()].map((b) => ({
      ...this.host.refOf(b.key),
      ...(b.bases && { bases: b.bases }),
      ...(b.dependence && { dependence: b.dependence }),
    }));
    return planMaxLink({ selected: this.selection(scope), library, ...(engines && { engines }) });
  }

  /** Runs a plan and makes its merged suggestions the current run. */
  async run(plan: MaxLinkPlan, scopeLabel: string, options: MaxLinkRunOptions = {}): Promise<boolean> {
    const run = this.service.runMaxLink?.bind(this.service);
    if (!run) return void this.host.notify("error", "קישור מרבי אינו זמין בגרסה הזו של הכלי."), false;
    const steps = plan.steps;
    if (!steps.length) {
      this.host.notify("warning", "אין מה להריץ: לא נמצא אף ספר שאפשר לקשר אוטומטית.", plan.books.filter((b) => b.skipped).map((b) => `${b.book.title}: ${b.skipped}`));
      return false;
    }
    const books = new Set(steps.map((s) => s.source.key)).size;
    const t0 = Date.now();
    const res = await this.host.runTask(`קישור מרבי: ${steps.length.toLocaleString("he")} שלבים ב־${books.toLocaleString("he")} ספרים…`, (opts) =>
      run(steps, { ...(options.engineOptions && { engineOptions: options.engineOptions }) }, opts),
    );
    if (!res) return false;

    const byId = new Map(steps.map((s) => [s.id, s]));
    const items: MergeItem[] = [];
    const outcomes: StepOutcome[] = [];
    for (const it of res.items) {
      const step = byId.get(it.stepId);
      if (!step) continue;
      for (const sg of it.result?.suggestions ?? []) items.push({ suggestion: sg, focus: step.source.key });
      outcomes.push({
        id: step.id,
        kind: step.kind,
        engine: step.engine,
        source: step.source,
        ...(step.kind === "pair" && { target: step.target }),
        raw: it.result?.suggestions.length ?? 0,
        unmatched: it.unmatched,
        ms: it.ms,
        ...(it.error !== undefined && { error: it.error }),
        notes: it.result?.notes ?? [],
      });
    }

    // "already exists": the database's links, and the project's — except the link a suggestion's own approval made
    const db = new Set(res.dbLinkKeys);
    const project = new Map<string, string[]>();
    for (const l of this.host.linkState.value.links.values()) if (l.status !== "deleted") pushTo(project, linePairKey(l), l.id);
    const merged = mergeSuggestions(items, {
      reference: db,
      existing: (s) => (db.has(linePairKey(s)) ? "db" : project.get(linePairKey(s))?.some((id) => id !== `auto:${s.id}`) ? "project" : null),
    });

    const info: MaxLinkRunInfo = { scope: scopeLabel, books: plan.books, identified: plan.identified, steps: outcomes, stats: merged.stats, ms: Date.now() - t0 };
    const failed = outcomes.filter((o) => o.error).length;
    const st = merged.stats;
    const notes: Reason[] = [
      {
        code: "maxlink/summary",
        text: `${st.input.toLocaleString("he")} הצעות מ־${outcomes.length.toLocaleString("he")} שלבים אוחדו ל־${st.output.toLocaleString("he")}: ${st.duplicates.toLocaleString("he")} כפילויות אוחדו, ${st.agreements.toLocaleString("he")} קישורים ששתי שיטות או יותר הגיעו אליהם, ${st.conflicts.toLocaleString("he")} סתירות בין שיטות (מסומנות "עמומה").`,
      },
      ...(st.contradictedPairs
        ? [{ code: "maxlink/contradicts-library", text: `ב־${st.contradictedPairs} זוגות ספרים ההצעות סותרות את הקישורים שכבר יש בספרייה ברוב השורות (למשל ספר שממוספר בדפים משלו). שם אף הצעה אינה "ודאית"; הן מסומנות לבדיקה.` }]
        : []),
      ...(st.suspectPairs
        ? [{ code: "maxlink/pair-disagree", text: `ב־${st.suspectPairs} זוגות ספרים השיטות סותרות זו את זו ברוב השורות (למשל ספר שממוספר בדפים משלו). שם אף הצעה של שיטה אחת אינה "ודאית"; הן מסומנות לבדיקה.` }]
        : []),
      ...(failed ? [{ code: "maxlink/errors", text: `${failed} שלבים נכשלו; שאר השלבים רצו. הפרטים ב"דוח הקישור המרבי".` }] : []),
    ];
    batch(() => {
      this.host.suggestions.dbLinkKeys.value = db;
      this.host.suggestions.run.value = { engine: steps[0]!.engine, label: `${scopeLabel}: ${plan.books.length.toLocaleString("he")} ספרים`, result: { suggestions: merged.suggestions, notes, unmatched: [] }, at: Date.now(), maxlink: info };
      this.host.suggestions.current.value = merged.suggestions[0]?.id ?? null;
      this.host.sideTab.value = "suggestions";
    });
    const c = this.report.value!.overall;
    this.host.notify(
      failed ? "warning" : "success",
      `הקישור המרבי הסתיים: ${c.links.toLocaleString("he")} הצעות — ${c.certain.toLocaleString("he")} ודאיות, ${c.review.toLocaleString("he")} לבדיקה, ${c.existing.toLocaleString("he")} כבר קיימות${failed ? `; ${failed} שלבים נכשלו` : ""}.`,
    );
    return true;
  }

  saveReport(): void {
    const rep = this.report.value;
    if (rep) this.saver.save(`קישור-מרבי-${new Date().toISOString().slice(0, 10)}.csv`, reportCsv(rep), "text/csv;charset=utf-8");
  }
}
