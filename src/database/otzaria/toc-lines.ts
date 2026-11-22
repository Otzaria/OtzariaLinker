import type { SqliteFile } from "../sqlite/lazy/sqlite-file";
import type { DbCapabilities } from "./capabilities";

/*
 * The heading lines of a Personal-DB-Creator database, from its table of contents: every `<h1>`–`<h6>` line has a
 * `tocEntry` whose `lineId` is the line (794,983 entries for 795,007 heading lines in v52, so it is a close PROXY, not
 * a proof — a heading with no entry is not seen). Reading the text of every line to find them would mean decoding
 * millions of lines; this reads one table, once.
 *
 * A (bookId, lineIndex) is recovered from a line id only by the PDC numbering `bookId × 2^20 + lineIndex + 1`
 * (DATABASE_SUPPORT_MATRIX §5.3), so the reader first checks that numbering on the first lines of the `line` table
 * and returns null for a database that does not follow it: no flag is better than a wrong one.
 */
export class TocLines {
  private constructor(private readonly byBook: ReadonlyMap<number, Int32Array>) {}

  /** whether the line has a table-of-contents entry */
  has(bookId: number, lineIndex: number): boolean {
    const a = this.byBook.get(bookId);
    if (!a) return false;
    let lo = 0;
    let hi = a.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid]! === lineIndex) return true;
      if (a[mid]! < lineIndex) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  static async read(file: SqliteFile, caps: DbCapabilities, ctx: { signal?: AbortSignal } = {}): Promise<TocLines | null> {
    if (!caps.toc) return null;
    const toc = await file.table("tocEntry");
    const line = await file.table("line");
    if (!toc || !line) return null;
    const at = (t: { columns: readonly { name: string }[] }, n: string) => t.columns.findIndex((c) => c.name.toLowerCase() === n.toLowerCase());
    const [tb, tl] = [at(toc, "bookId"), at(toc, "lineId")];
    const [lb, li] = [at(line, "bookId"), at(line, "lineIndex")];
    if (tb < 0 || tl < 0 || lb < 0 || li < 0) return null;
    // the numbering rule, on the first lines of the table
    let seen = 0;
    for await (const r of file.scan(line)) {
      if (Number(r.rowid) !== Number(r.values[lb]) * 2 ** 20 + Number(r.values[li]) + 1) return null;
      if (++seen >= 2000) break;
    }
    if (!seen) return null;
    const lists = new Map<number, number[]>();
    let n = 0;
    for await (const r of file.scan(toc)) {
      if (++n % 50_000 === 0) ctx.signal?.throwIfAborted();
      const lineId = r.values[tl];
      if (lineId === null || lineId === undefined) continue;
      const book = Number(r.values[tb]);
      const index = Number(lineId) - book * 2 ** 20 - 1;
      if (index < 0) continue;
      const list = lists.get(book);
      if (list) list.push(index);
      else lists.set(book, [index]);
    }
    return new TocLines(new Map([...lists].map(([b, l]) => [b, Int32Array.from(l).sort()])));
  }
}
