import { signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import { dbLinkOrigin } from "../core/links/db-links";
import { diffLinks, mergeLinkSets, type LinkDiff, type LinkMerge } from "../core/links/link-diff";
import type { BookRef, Link } from "../core/links/model";
import { safeFileTitle, sourceTitleFromLinksFileName } from "../core/links/titles";
import { recordToLink } from "../formats/links-json/convert";
import { detectLayout } from "../formats/links-json/layout";
import { parseLinksJson } from "../formats/links-json/parse";
import { linkDiffCsv } from "../formats/report/link-diff-report";
import { addChanges, commit, fileChange, fileFingerprint, linksCount, type Change, type FileChange, type LinkState } from "./history";
import type { BooksService, CallOptions, Saver } from "./services";
import type { NoticeKind } from "./store";

/*
 * Managing EXISTING links (V5 P1-9): compare a book's links between the database, the project and
 * any number of `_links.json` files — a semantic diff (core/links/link-diff.ts), with a CSV report —
 * and merge several links files of one book losslessly. Files loaded here are only READ for the
 * comparison: nothing enters the project until the user applies a merge, which is ONE undoable action
 * that never overwrites a link: the preferred source is kept whole, what the others add comes in as
 * new links that remember their file (Link.origins), and conflicts stay out unless the user says so.
 */
export interface LinkCompareHost {
  readonly linkState: Signal<LinkState>;
  readonly allLinks: ReadonlySignal<Link[]>;
  readonly booksByTitle: ReadonlySignal<Map<string, SourceBook[]>>;
  resolveTitle(title: string): BookRef | null;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

/** One side of a comparison: the project's links of a book, its database links, or a links file. */
export interface LinkSet {
  readonly id: string;
  readonly kind: "project" | "db" | "file";
  /** the book (source title of its links file) */
  readonly title: string;
  /** shown, and kept as the origin of merged links */
  readonly name: string;
  readonly links: readonly Link[];
  /** a file: its text (a merge that prefers it loads it as the book's library file) */
  readonly text?: string;
  /** database links left out: the LINKER layer and Sefaria↔Sefaria links, which no links file can hold */
  readonly skipped?: number;
}

export const PROJECT_SET = "project";
export const DB_SET = "db";

export class LinkCompareState {
  /** the files and database lists loaded for comparing (not the project's) */
  readonly sets = signal<readonly LinkSet[]>([]);
  readonly result = signal<{ a: LinkSet; b: LinkSet; diff: LinkDiff; ms: number } | null>(null);
  private seq = 0;

  constructor(
    private readonly host: LinkCompareHost,
    private readonly service: Pick<BooksService, "dbLinkSummary" | "dbLinksPage">,
    private readonly saver: Saver,
  ) {}

  /** Reads `_links.json` files for comparing; returns the titles loaded. */
  addFiles(files: readonly { path: string; text: string }[]): string[] {
    const added: LinkSet[] = [];
    for (const f of files) {
      const title = sourceTitleFromLinksFileName(f.path.split(/[\\/]/).at(-1) ?? f.path);
      // the path the user picked names the file (and the merged links' origin); two of one name are told apart
      let name = f.path;
      for (let k = 2; [...this.sets.value, ...added].some((s) => s.name === name); k++) name = `${f.path} (${k})`;
      if (!title) {
        this.host.notify("error", `"${f.path}": שם קובץ קישורים חייב להסתיים ב־‎_links.json.`);
        continue;
      }
      const parsed = parseLinksJson(f.text);
      if (parsed.issues.some((i) => i.index < 0 && i.level === "error" && (i.code === "file/not-json" || i.code === "file/not-array"))) {
        this.host.notify("error", `"${name}" אינו קובץ קישורים תקין, ולא נטען להשוואה.`);
        continue;
      }
      const src = this.ref(title);
      const n = this.seq++;
      const links = parsed.records.map((r, i) => recordToLink(r, i, src, (t) => this.host.resolveTitle(t), `cmp:${n}:${i}`).link);
      added.push({ id: `file:${n}`, kind: "file", title, name, links, text: f.text });
    }
    if (added.length) this.sets.value = [...this.sets.value, ...added];
    return added.map((s) => s.title);
  }

  forget(id: string): void {
    this.sets.value = this.sets.value.filter((s) => s.id !== id);
  }

  /** Every set of a book that can be compared now: the project's links of it, its database list, its files. */
  setsOf(title: string): LinkSet[] {
    const project = this.host.allLinks.value.filter((l) => l.status !== "deleted" && l.provenance !== "db" && l.source.book.title === title);
    return [...(project.length ? [{ id: PROJECT_SET, kind: "project" as const, title, name: "הפרויקט", links: project }] : []), ...this.sets.value.filter((s) => s.title === title)];
  }

  /** Titles that have something to compare: loaded files, then the project's links files. */
  titles(): string[] {
    return [...new Set([...this.sets.value.map((s) => s.title), ...this.host.linkState.value.files.keys(), ...this.host.allLinks.value.filter((l) => l.provenance === "file").map((l) => l.source.book.title)])];
  }

  /**
   * Reads ALL database links of the book (every page of the worker's listing), as a set. LINKER
   * citations and Sefaria↔Sefaria links are left out and counted: a links file cannot hold them.
   */
  async loadDb(title: string): Promise<boolean> {
    const { dbLinkSummary, dbLinksPage } = this.service;
    const books = this.host.booksByTitle.value.get(title) ?? [];
    if (!dbLinkSummary || !dbLinksPage || !books.length) return void this.host.notify("error", `"${title}" לא פתוח ממסד. פתחו את המסד שבו הוא נמצא.`), false;
    const links = await this.host.runTask(`קורא את קישורי "${title}" מהמסד…`, async (opts) => {
      for (const b of books) {
        const sum = await dbLinkSummary(b.key, opts);
        if (!("total" in sum)) continue;
        const all: Link[] = [];
        while (all.length < sum.total) {
          const page = await dbLinksPage(b.key, { offset: all.length, limit: 1000 }, opts);
          if (!page.links.length) break;
          all.push(...page.links);
          opts.onProgress?.(all.length, sum.total);
        }
        return all;
      }
      return null;
    });
    if (!links) return void this.host.notify("error", `ל"${title}" אין קישורים במסד שנפתח, או שהקריאה בוטלה.`), false;
    const kept = links.filter((l) => {
      const o = dbLinkOrigin(l);
      return o !== "linker" && o !== "sefaria";
    });
    const set: LinkSet = { id: `${DB_SET}:${title}`, kind: "db", title, name: "המסד", links: kept, skipped: links.length - kept.length };
    this.sets.value = [...this.sets.value.filter((s) => s.id !== set.id), set];
    return true;
  }

  compare(title: string, aId: string, bId: string): LinkDiff | null {
    const all = this.setsOf(title);
    const a = all.find((s) => s.id === aId);
    const b = all.find((s) => s.id === bId);
    if (!a || !b) return null;
    const t0 = performance.now();
    const diff = diffLinks(a.links, b.links);
    this.result.value = { a, b, diff, ms: Math.round(performance.now() - t0) };
    return diff;
  }

  saveReport(): void {
    const r = this.result.value;
    if (r) this.saver.save(`השוואת קישורים - ${safeFileTitle(r.a.title)}.csv`, linkDiffCsv(r.diff, r.a.name, r.b.name), "text/csv;charset=utf-8");
  }

  /** The merge of the chosen sets of a book, and what it changes against the preferred one (the preview). */
  planMerge(title: string, ids: readonly string[], preferred: string, keepConflicts: boolean): { merge: LinkMerge; preview: LinkDiff; sources: LinkSet[] } | null {
    const sources = this.setsOf(title).filter((s) => s.kind !== "db" && ids.includes(s.id));
    const p = sources.findIndex((s) => s.id === preferred);
    // the project's links are already in it: when they take part, they are the base
    if (sources.length < 2 || p < 0 || (sources.some((x) => x.kind === "project") && sources[p]!.kind !== "project")) return null;
    const merge = mergeLinkSets(sources, p, keepConflicts);
    return { merge, preview: diffLinks(sources[p]!.links, merge.entries.map((e) => e.link)), sources };
  }

  /**
   * Applies a merge as ONE undoable action. The preferred source stays as it is: the project's links,
   * or a file that becomes the book's library file (as if imported — refused when the project holds
   * an edited copy of that file). Links only the other sources have come in as new links with their
   * origins. Returns how many links were added, or null when nothing was applied.
   */
  applyMerge(title: string, ids: readonly string[], preferred: string, keepConflicts: boolean): number | null {
    const plan = this.planMerge(title, ids, preferred, keepConflicts);
    if (!plan) return null;
    const { merge, sources } = plan;
    const pref = sources.find((s) => s.id === preferred)!;
    const s = this.host.linkState.value;
    const changes: Change[] = [];
    const files: FileChange[] = [];
    const n = this.seq++;
    if (pref.kind === "file") {
      const held = [...s.links.values()].filter((l) => l.provenance === "file" && l.source.book.title === title);
      if (held.some((l) => l.status !== "existing"))
        return void this.host.notify("error", `בפרויקט יש עותק ערוך של קובץ הקישורים של "${title}". כדי לא לדרוס אותו, בחרו את "הפרויקט" כמקור המועדף.`), null;
      changes.push(...held.map((l) => ({ id: l.id, before: l })));
      if (held.length) this.host.notify("info", `העותק הקודם של קובץ הקישורים של "${title}" (${linksCount(held.length)}, בלי שינויים) הוחלף במקור המועדף.`);
      const base = merge.entries.filter((e) => e.base).map((e, i) => ({ ...e.link, id: `file:${title}#m${n}:${i}`, origins: e.origins }));
      changes.push(...addChanges(base));
      files.push(fileChange(s, title, { title, records: pref.links.length, hash: fileFingerprint(pref.text ?? ""), verified: true, layout: detectLayout(pref.text ?? "") }));
    } else
      for (const e of merge.entries)
        if (e.base && e.origins.length > 1) {
          const before = s.links.get(e.link.id)!;
          const origins = [...new Set([...(before.origins ?? []), ...e.origins.filter((o) => o !== pref.name)])];
          if (origins.length !== before.origins?.length) changes.push({ id: before.id, before, after: { ...before, origins } });
        }
    const added = merge.entries
      .filter((e) => !e.base)
      .map((e, i): Link => {
        const { fileIndex: _i, keyOrder: _k, typeNull: _t, fileText: _f, passthrough: _p, ...rest } = e.link;
        return { ...rest, id: `imp:m${n}:${i}`, status: "new", provenance: "import", origins: e.origins };
      });
    changes.push(...addChanges(added));
    this.host.linkState.value = commit(s, `מיזוג ${sources.length} גרסאות של "${title}" (${linksCount(added.length)} נוספו)`, changes, Date.now(), [], files);
    this.host.notify(
      merge.conflicts.length && !keepConflicts ? "warning" : "success",
      `המיזוג הוחל. נוספו: ${linksCount(added.length)}; כפילויות שאוחדו: ${merge.duplicates.toLocaleString("he")}${merge.conflicts.length ? `; סתירות ${keepConflicts ? "שנוספו גם הן" : "שלא נוספו (נשמר המקור המועדף)"}: ${merge.conflicts.length.toLocaleString("he")}` : ""}. Ctrl+Z מבטל.`,
    );
    return added.length;
  }

  private ref(title: string): BookRef {
    return this.host.resolveTitle(title) ?? { key: `unresolved:${title}`, title, origin: "unknown" };
  }
}
