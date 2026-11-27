import type { ReadonlySignal, Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import { identicalLinkKey } from "../core/links/equality";
import type { BookRef, Link, LinkSide } from "../core/links/model";
import { sefariaRefFromHeRef } from "../core/links/sefaria-ref";
import { storedForm } from "../core/links/stored-form";
import { titleDeclaresDependencyOn } from "../core/links/titles";
import { commit, deleteChange, editChange, linksCount, type Change, type LinkState } from "./history";
import type { LineStore } from "./lines";
import type { CallOptions } from "./services";
import type { NoticeKind } from "./store";

/*
 * Group fixes on many links at once (V5 P1-9, the links table): another target book, the Sefaria
 * refs, the direction of a commentary record, duplicates, ranges. Each is ONE undoable action
 * (history.commit) over the chosen links, and says what it changed and what it left. Changing the
 * type, deleting and restoring are the store's own actions (setType, deleteLinks, restoreLinks);
 * approving and rejecting suggestions are store.suggestions'.
 */
export interface LinkFixesHost {
  readonly linkState: Signal<LinkState>;
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  readonly lines: Pick<LineStore, "load" | "peek" | "count">;
  readonly exportPurpose: ReadonlySignal<"submission" | "private">;
  bookOf(ref: BookRef): SourceBook | undefined;
  resolveTitle(title: string): BookRef | null;
  isSefariaOwned(book: { readonly title: string; readonly key?: string }): boolean;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

type Patch = Partial<Omit<Link, "id" | "provenance">>;

export class LinkFixes {
  constructor(private readonly host: LinkFixesHost) {}

  /** The editable links among `ids`: not a database link, not deleted. */
  private editable(ids: readonly string[]): Link[] {
    const { links } = this.host.linkState.value;
    return ids.map((id) => links.get(id)).filter((l): l is Link => !!l && l.provenance !== "db" && l.status !== "deleted");
  }

  /** Commits per-link patches as one action and reports; returns how many links changed. */
  private apply(label: (n: number) => string, patches: Iterable<[string, Patch]>, extra: Change[] = []): number {
    const s = this.host.linkState.value;
    const changes = [...patches].map(([id, p]) => editChange(s, id, p)).filter((c): c is Change => !!c);
    changes.push(...extra);
    if (changes.length) this.host.linkState.value = commit(s, label(changes.length), changes);
    return changes.length;
  }

  private told(n: number, of: number, what: string): void {
    this.host.notify(n ? "success" : "info", n ? `${what}: ${linksCount(n)}${n < of ? ` מתוך ${of.toLocaleString("he")} שנבחרו (בשאר לא היה מה לתקן)` : ""}. Ctrl+Z מבטל.` : `${what}: לא היה מה לשנות ב־${linksCount(of)} שנבחרו.`);
  }

  /** Points the links at another target book (by exact title), keeping the lines; heRef_2 follows when it began with the old title. */
  retarget(ids: readonly string[], title: string): number {
    const t = title.trim();
    if (!t) return 0;
    const book = this.host.resolveTitle(t) ?? { key: `unresolved:${t}`, title: t, origin: "unknown" as const };
    const list = this.editable(ids);
    const n = this.apply(
      (k) => `החלפת ספר היעד של ${linksCount(k)} ל"${t}"`,
      list
        .filter((l) => l.target.book.title !== t)
        .map((l) => {
          const old = l.target.book.title;
          return [l.id, { target: { ...l.target, book }, targetPath: undefined, ...(l.heRef2.startsWith(old) && { heRef2: t + l.heRef2.slice(old.length) }) }];
        }),
    );
    this.told(n, list.length, "ספר היעד הוחלף");
    if (n && !this.host.resolveTitle(t)) this.host.notify("warning", `אין ספר פתוח בשם "${t}". אוצריא מדלגת על קישור לספר שאינו בספרייה בשם הזה בדיוק.`);
    return n;
  }

  /**
   * The library's ref rules (validate.ts "sefaria/*"): a ref only on the Sefaria side, and the missing
   * one built from the database heRef of the line (core/links/sefaria-ref.ts). Reads the lines first.
   */
  async fixRefs(ids: readonly string[]): Promise<number> {
    const { host } = this;
    const list = this.editable(ids);
    const sef = (side: LinkSide) => host.isSefariaOwned(side.book);
    const ok = await host.runTask(`קורא את השורות של ${linksCount(list.length)}…`, async (opts) => {
      let done = 0;
      for (const l of list) {
        opts.signal?.throwIfAborted();
        for (const side of [l.source, l.target]) {
          const b = sef(side) && host.bookOf(side.book);
          if (b) await host.lines.load(b.key, side.line, side.line);
        }
        if (++done % 200 === 0) opts.onProgress?.(done, list.length);
      }
      return true;
    });
    if (!ok) return 0;
    const fromLine = (side: LinkSide) => {
      const b = host.bookOf(side.book);
      return (b && sefariaRefFromHeRef(host.lines.peek(b.key, side.line)?.heRef)) ?? undefined;
    };
    const patches: [string, Patch][] = [];
    for (const l of list) {
      const srcSef = sef(l.source);
      const tgtSef = sef(l.target);
      let ref1 = srcSef ? l.ref1 : undefined;
      let ref2 = tgtSef ? l.ref2 : undefined;
      if (srcSef && !tgtSef) ref1 ??= fromLine(l.source);
      if (tgtSef && !srcSef) ref2 ??= fromLine(l.target);
      if (ref1 !== l.ref1 || ref2 !== l.ref2) patches.push([l.id, { ref1, ref2 }]);
    }
    const n = this.apply((k) => `תיקון ציוני ספריא של ${linksCount(k)}`, patches);
    this.told(n, list.length, "ציוני ספריא תוקנו");
    return n;
  }

  /**
   * A commentary record written from the commentary to its base as "commentary" is stored the wrong
   * way round (validate.ts export/reversed-dependency): the library writes it "source". And a "source"
   * record from the base to its commentary flips the other way: it becomes "commentary".
   */
  fixDirection(ids: readonly string[]): number {
    const list = this.editable(ids);
    const patches: [string, Patch][] = [];
    for (const l of list) {
      const f = storedForm(l);
      if (f.skipped) continue;
      const s = l.source.book.title;
      const t = l.target.book.title;
      if (!f.flipped && f.declared === "COMMENTARY" && titleDeclaresDependencyOn(s, t)) patches.push([l.id, { declaredType: "source" }]);
      else if (f.declared === "SOURCE" && titleDeclaresDependencyOn(t, s)) patches.push([l.id, { declaredType: "commentary" }]);
    }
    const n = this.apply((k) => `תיקון הכיוון של ${linksCount(k)}`, patches);
    this.told(n, list.length, "הכיוון תוקן");
    return n;
  }

  /**
   * Links that are ONE link in the database (equality.ts identicalLinkKey, as export/duplicate) — the chosen ones among
   * all the project's links — keep one: the library's record first, then one with an anchor. The rest
   * of the chosen are deleted.
   */
  removeDuplicates(ids: readonly string[]): number {
    const s = this.host.linkState.value;
    const chosen = new Set(ids);
    const groups = new Map<string, Link[]>();
    for (const l of s.links.values()) {
      if (l.status === "deleted" || l.provenance === "db") continue;
      const k = identicalLinkKey(l);
      if (k === null) continue;
      const g = groups.get(k);
      if (g) g.push(l);
      else groups.set(k, [l]);
    }
    const rank = (l: Link) => (l.provenance === "file" ? 4 : 0) + (l.status === "existing" ? 2 : 0) + (l.anchor ? 1 : 0);
    const gone: Change[] = [];
    for (const g of groups.values()) {
      if (g.length < 2 || !g.some((l) => chosen.has(l.id))) continue;
      const keep = g.reduce((a, b) => (rank(b) > rank(a) ? b : a));
      for (const l of g) if (l !== keep && chosen.has(l.id)) gone.push(deleteChange(s, l.id)!);
    }
    const n = this.apply((k) => `הסרת ${linksCount(k)} כפולים`, [], gone.filter(Boolean));
    this.told(n, ids.length, "כפילויות הוסרו");
    return n;
  }

  /**
   * Ranges the library would refuse or misread: an end not after its start is dropped, an end past the
   * book is cut to its last line, a range on a Sefaria side (submission only: the sync remaps only the
   * start) becomes its start line, and among the chosen links, a range that runs over the next link on
   * the same book is cut one line before it (like "השלמת טווחים").
   */
  fixRanges(ids: readonly string[]): number {
    const { host } = this;
    const list = this.editable(ids);
    const submission = host.exportPurpose.value === "submission";
    const ends = new Map<string, { source?: number | null; target?: number | null }>();
    const fixed = (l: Link, side: "source" | "target"): number | undefined => {
      const e = ends.get(l.id)?.[side];
      return e === undefined ? l[side].end : e === null ? undefined : e;
    };
    const set = (l: Link, side: "source" | "target", end: number | undefined) => {
      if (end === l[side].end) return;
      ends.set(l.id, { ...ends.get(l.id), [side]: end ?? null });
    };
    for (const l of list)
      for (const side of ["source", "target"] as const) {
        const x = l[side];
        if (x.end === undefined) continue;
        const b = host.bookOf(x.book);
        const count = b?.lineCount ?? (b && host.lines.count(b.key));
        let end: number | undefined = x.end;
        if (count && end >= count) end = count - 1;
        if (end <= x.line || (submission && host.isSefariaOwned(x.book))) end = undefined;
        set(l, side, end);
      }
    for (const side of ["source", "target"] as const) {
      const byBook = new Map<string, Link[]>();
      for (const l of list) {
        const g = byBook.get(l[side].book.title);
        if (g) g.push(l);
        else byBook.set(l[side].book.title, [l]);
      }
      for (const g of byBook.values()) {
        g.sort((a, b) => a[side].line - b[side].line);
        for (let i = 0; i + 1 < g.length; i++) {
          const a = g[i]!;
          const next = g[i + 1]!;
          const end = fixed(a, side);
          if (end !== undefined && next[side].line > a[side].line && end >= next[side].line) set(a, side, next[side].line - 1 > a[side].line ? next[side].line - 1 : undefined);
        }
      }
    }
    const byId = new Map(list.map((l) => [l.id, l]));
    const patches: [string, Patch][] = [...ends].map(([id, e]) => {
      const l = byId.get(id)!;
      const side = (k: "source" | "target"): LinkSide => {
        const end = fixed(l, k);
        return { book: l[k].book, line: l[k].line, ...(end !== undefined && { end }) };
      };
      return [id, { ...(e.source !== undefined && { source: side("source") }), ...(e.target !== undefined && { target: side("target") }) }];
    });
    const n = this.apply((k) => `תיקון הטווחים של ${linksCount(k)}`, patches);
    this.told(n, list.length, "טווחים תוקנו");
    return n;
  }
}
