import type { SourceBook, SourceLine } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import type { LineFacts, ValidationContext } from "../core/links/validate";
import { planExport, type ExportPlan } from "../formats/links-json/export";
import { runPair, type LinkerAdapters } from "../linking/adapters";
import { suggestionLinks } from "../linking/approve";
import { CONFIDENCE_ORDER, ENGINES, type Confidence, type EngineId, type EngineResult, type Suggestion } from "../linking/automatic";
import { linePairKey } from "../linking/merge";
import { isPairEngine } from "../linking/plan";

/*
 * The headless core (issue 9, V7 §4.15): the ONE entry a host without the app calls — an Otzaria plugin through its own API
 * (headless/otzaria-host.ts), a test, a script. It is a thin layer over what the app already uses: the engines through the ports
 * of linking/adapters.ts, approval through linking/approve.ts (the same code the app's suggestions use), and the export through
 * formats/links-json/export.ts planExport (the same rules as the app's export and quality check, validate.ts validateExport).
 *
 * Read-only on the host's data (AGENTS.md §2.3): nothing here writes a book or a link into the host's library; the result is
 * files, handed to SavePort. Pure: `core`, `matching`, `linking`, `formats` only (tests/unit/architecture.test.ts).
 *
 * The API is documented in docs/PLUGIN_READINESS.md §2a. CORE_API_VERSION follows SemVer: a field removed or changed in meaning
 * is a major version.
 */
export const CORE_API_VERSION = "1.0.0";

export interface EngineSummary {
  id: EngineId;
  title: string;
  /** "pair": a source and a target book; "single": one book against all the books (runPair does not run it) */
  kind: "pair" | "single";
  description: string;
}

/** One run of a pair engine, with the host's existing links already compared. */
export interface PairRun {
  engine: EngineId;
  source: BookRef;
  target: BookRef;
  result: EngineResult;
  /** ids of the suggestions whose two lines the host already links (linePairKey, core/links/equality.ts "same lines") */
  exists: ReadonlySet<string>;
}

export interface ApproveChoice {
  /** the lowest confidence approved (default "certain": only what the app's "approve all certain" approves) */
  minConfidence?: Confidence;
  /** only these suggestions (still filtered by minConfidence and `exists`) */
  ids?: readonly string[];
  /** links already chosen (another engine's run on the same books): a record between the same two lines is not written again */
  already?: readonly Link[];
}

export interface ExportChoice {
  /**
   * "private" (default): files for the user's own use — the library's sync rules are warnings. "submission": the library's
   * rules are errors and a link that breaks them is held back, as in the app.
   */
  purpose?: "private" | "submission";
}

export interface LinkerCore {
  readonly version: string;
  engines(): readonly EngineSummary[];
  books(): Promise<readonly SourceBook[]>;
  /** Runs one pair engine on two books of the host (read through BooksPort), and marks what the host already has (LinksPort). */
  runPair(engine: EngineId, sourceKey: string, targetKey: string, options?: Record<string, unknown>): Promise<PairRun>;
  /** The links approving the chosen suggestions makes (the app's approval: linking/approve.ts), without those that exist. */
  approve(run: PairRun, choice?: ApproveChoice): Link[];
  /** The `_links.json` files for links, by the export's rules (formats/links-json/export.ts planExport). */
  exportFiles(links: readonly Link[], choice?: ExportChoice): Promise<ExportPlan>;
  /** Hands every file of an export to SavePort; returns their names. Throws when the host has no SavePort. */
  save(plan: Pick<ExportPlan, "files">): Promise<string[]>;
}

export function engineSummaries(): EngineSummary[] {
  return ENGINES.map((e) => ({ id: e.id, title: e.title, kind: e.singleBook ? "single" : "pair", description: e.description }));
}

/** The core over a host's ports. */
export function createLinkerCore(a: LinkerAdapters): LinkerCore {
  const refOf = async (key: string): Promise<BookRef> => {
    const b = (await a.books.list()).find((x) => x.key === key);
    if (!b) throw new Error(`unknown book ${key}`);
    return { key: b.key, title: b.title, origin: b.origin };
  };
  const allLines = (key: string): Promise<readonly SourceLine[]> => a.books.lines(key, 0, Number.MAX_SAFE_INTEGER, a.cancel);

  return {
    version: CORE_API_VERSION,
    engines: engineSummaries,
    books: () => a.books.list(),

    async runPair(engine, sourceKey, targetKey, options = {}) {
      if (!isPairEngine(engine)) throw new Error(`${engine} is not a pair engine`);
      const source = await refOf(sourceKey);
      const target = await refOf(targetKey);
      const result = await runPair(a, engine, source, target, options);
      const have = new Set<string>();
      if (a.links)
        for (const key of new Set([source.key, target.key])) for (const l of await a.links.existing(key, a.cancel)) if (l.status !== "deleted") have.add(linePairKey(l));
      const exists = new Set(result.suggestions.filter((s) => suggestionLinks(s).every((l) => have.has(linePairKey(l)))).map((s) => s.id));
      return { engine, source, target, result, exists };
    },

    approve(run, choice = {}) {
      const floor = CONFIDENCE_ORDER.indexOf(choice.minConfidence ?? "certain");
      const want = choice.ids ? new Set(choice.ids) : null;
      const chosen = run.result.suggestions.filter((s: Suggestion) => !run.exists.has(s.id) && (!want || want.has(s.id)) && CONFIDENCE_ORDER.indexOf(s.confidence) <= floor);
      const seen = new Set<string>((choice.already ?? []).map(linePairKey));
      const out: Link[] = [];
      // two suggestions of one run never write the same two lines twice (the app checks the project the same way)
      for (const s of chosen)
        for (const l of suggestionLinks(s, seen)) {
          const k = linePairKey(l);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(l);
        }
      return out;
    },

    async exportFiles(links, choice = {}) {
      const facts = new Map<string, readonly SourceLine[]>();
      for (const l of links) for (const b of [l.source.book, l.target.book]) if (!facts.has(b.key)) facts.set(b.key, await allLines(b.key));
      const ctx: ValidationContext = {
        line(book, index): LineFacts | undefined {
          const l = facts.get(book.key)?.[index];
          return l && { exists: l.existsInDb, heading: l.heading, anchorLength: l.anchorText.length };
        },
        lineCount: (book) => facts.get(book.key)?.length,
        purpose: choice.purpose ?? "private",
      };
      return planExport(links, ctx);
    },

    async save(plan) {
      if (!a.save) throw new Error("the host gave no SavePort");
      const names: string[] = [];
      for (const f of plan.files) {
        a.cancel?.throwIfAborted();
        await a.save.save({ name: f.name, mimeType: "application/json", content: f.text });
        names.push(f.name);
      }
      return names;
    },
  };
}
