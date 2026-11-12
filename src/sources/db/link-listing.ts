import { CONNECTION_TYPES, parseConnectionType } from "../../core/links/connection-type";
import type { DbLinkPage, DbLinkQuery, DbLinkSummary } from "../../core/links/db-links";
import type { BookOrigin, Link } from "../../core/links/model";

/*
 * One book's database links, held compactly in the worker so the links panel can count, group,
 * filter and page through them without reading the database again (stage 10). Built once per book
 * — from the link table's book indexes for an Otzaria database (DbBookSource), or from every
 * existing link of the book for any other source that has links (SourceRegistry fallback) — and
 * kept until the source closes. A page reads full details only for the links it shows.
 */
export interface ListingRows {
  /** what `fetch` takes back: a database link id, or a position in an in-memory list */
  ref: Int32Array;
  /** 0 = the book is the stored source, 1 = the stored target */
  dir: Uint8Array;
  /** index into `otherKeys` */
  other: Int32Array;
  /** index into CONNECTION_TYPES */
  type: Uint8Array;
  /** 0-based line of the listed book (-1 when unknown) */
  ownIndex: Int32Array;
}

export class LinkListing {
  /** row positions in (own line, ref) order — the order of every page */
  private readonly order: Int32Array;

  constructor(
    readonly bookKey: string,
    private readonly rows: ListingRows,
    private readonly otherKeys: readonly string[],
    private readonly fetch: (refs: number[]) => Promise<Link[]>,
    readonly method: DbLinkSummary["method"],
    readonly ms: number,
  ) {
    const n = rows.ref.length;
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    this.order = order.sort((a, b) => rows.ownIndex[a]! - rows.ownIndex[b]! || rows.ref[a]! - rows.ref[b]!);
  }

  get size(): number {
    return this.rows.ref.length;
  }

  summary(bookInfo: (key: string) => { title: string; origin: BookOrigin }): DbLinkSummary {
    const { dir, type, other } = this.rows;
    const types = CONNECTION_TYPES.map((t) => ({ type: t, out: 0, in: 0 }));
    const books = this.otherKeys.map((k) => ({ bookKey: k, ...bookInfo(k), out: 0, in: 0, commentaryOut: 0, commentaryIn: 0, targumOut: 0, targumIn: 0, midrashOut: 0, midrashIn: 0 }));
    const commentary = CONNECTION_TYPES.indexOf("COMMENTARY");
    const targum = CONNECTION_TYPES.indexOf("TARGUM");
    const midrash = CONNECTION_TYPES.indexOf("MIDRASH");
    let out = 0;
    for (let i = 0; i < dir.length; i++) {
      const key = dir[i] === 0 ? "out" : "in";
      if (key === "out") out++;
      types[type[i]!]![key]++;
      const b = books[other[i]!]!;
      b[key]++;
      if (type[i] === commentary) b[key === "out" ? "commentaryOut" : "commentaryIn"]++;
      else if (type[i] === targum) b[key === "out" ? "targumOut" : "targumIn"]++;
      else if (type[i] === midrash) b[key === "out" ? "midrashOut" : "midrashIn"]++;
    }
    return {
      bookKey: this.bookKey,
      total: dir.length,
      out,
      in: dir.length - out,
      byType: types.filter((t) => t.out + t.in > 0),
      byBook: books.filter((b) => b.out + b.in > 0).sort((a, b) => b.out + b.in - (a.out + a.in) || a.title.localeCompare(b.title, "he")),
      method: this.method,
      ms: this.ms,
    };
  }

  async page(q: DbLinkQuery): Promise<DbLinkPage> {
    const { dir, type, other, ownIndex, ref } = this.rows;
    const wantDir = q.dir === undefined ? -1 : q.dir === "out" ? 0 : 1;
    const wantTypes = q.types?.length ? new Set(q.types.map((t) => CONNECTION_TYPES.indexOf(t))) : null;
    const wantOther = q.otherBookKey === undefined ? -1 : this.otherKeys.indexOf(q.otherBookKey);
    if (q.otherBookKey !== undefined && wantOther < 0) return { total: 0, offset: q.offset, links: [] };
    const offset = Math.max(0, Math.trunc(q.offset));
    const limit = Math.max(0, Math.min(1000, Math.trunc(q.limit)));
    const picked: number[] = [];
    let total = 0;
    for (const i of this.order) {
      if (wantDir >= 0 && dir[i] !== wantDir) continue;
      if (wantTypes && !wantTypes.has(type[i]!)) continue;
      if (wantOther >= 0 && other[i] !== wantOther) continue;
      if (q.lines && (ownIndex[i]! < q.lines.from || ownIndex[i]! > q.lines.to)) continue;
      if (total >= offset && picked.length < limit) picked.push(ref[i]!);
      total++;
    }
    return { total, offset, links: picked.length ? await this.fetch(picked) : [] };
  }
}

/**
 * A listing from links already in memory (a source without book indexes: a mapped database).
 * `links` are the book's existing links in stored direction; a link inside the book counts as "out".
 */
export function listingFromLinks(bookKey: string, links: readonly Link[], ms: number): LinkListing {
  const otherKeys: string[] = [];
  const otherAt = new Map<string, number>();
  const n = links.length;
  const rows: ListingRows = { ref: new Int32Array(n), dir: new Uint8Array(n), other: new Int32Array(n), type: new Uint8Array(n), ownIndex: new Int32Array(n) };
  links.forEach((l, i) => {
    const isOut = l.source.book.key === bookKey;
    const otherKey = (isOut ? l.target : l.source).book.key;
    if (!otherAt.has(otherKey)) otherAt.set(otherKey, otherKeys.push(otherKey) - 1);
    rows.ref[i] = i;
    rows.dir[i] = isOut ? 0 : 1;
    rows.other[i] = otherAt.get(otherKey)!;
    rows.type[i] = CONNECTION_TYPES.indexOf(parseConnectionType(l.declaredType).type);
    rows.ownIndex[i] = (isOut ? l.source : l.target).line;
  });
  return new LinkListing(bookKey, rows, otherKeys, async (refs) => refs.map((r) => links[r]!), "scan", ms);
}
