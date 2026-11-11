import { rowsToEntries, type LibraryAltTocStructure } from "../../core/alt-toc/model";
import type { SqliteFile, TableInfo } from "../sqlite/lazy/sqlite-file";

/*
 * The alternative TOC structures a database already has for one book (alt_toc_structure →
 * alt_toc_entry → tocText; SeforimLibrary dao Database.sq:542-588), so the editor starts from
 * what the library has instead of from nothing. Read by index (structure by bookId, entries by
 * structureId); a database without the indexes is scanned. Present in schemas 0–7
 * (DATABASE_SUPPORT_MATRIX §2, §9).
 */
export async function readAltToc(file: SqliteFile, bookId: number, lineIndexOf: (lineId: number) => number | undefined): Promise<LibraryAltTocStructure[] | null> {
  const st = await file.table("alt_toc_structure");
  const en = await file.table("alt_toc_entry");
  if (!st || !en) return null;
  const text = await file.table("tocText");

  const structureIds: number[] = [];
  const byBook = await file.findIndex("alt_toc_structure", ["bookId"]);
  if (byBook) for await (const rec of file.seekIndex(byBook, [bookId])) structureIds.push(Number(rec.at(-1)));
  else {
    const b = col(st, "bookId");
    for await (const r of file.scan(st)) if (Number(r.values[b]) === bookId) structureIds.push(Number(r.rowid));
  }
  if (!structureIds.length) return [];
  const structures = await file.getMany(st, structureIds);

  const entryIds: number[] = [];
  const byStructure = await file.findIndex("alt_toc_entry", ["structureId"]);
  const want = new Set(structureIds);
  if (byStructure) for (const rec of await file.seekIndexMany(byStructure, structureIds.map((id) => [id]))) entryIds.push(Number(rec.at(-1)));
  else {
    const s = col(en, "structureId");
    for await (const r of file.scan(en)) if (want.has(Number(r.values[s]))) entryIds.push(Number(r.rowid));
  }
  const entries = await file.getMany(en, entryIds);
  const [eStructure, eParent, eText, eLine] = ["structureId", "parentId", "textId", "lineId"].map((n) => col(en, n));
  const texts = text ? await file.getMany(text, [...entries.values()].map((r) => Number(r.values[eText!]))) : new Map();
  const textAt = text ? col(text, "text") : -1;

  const rowsOf = new Map<number, { id: number; parentId: number | null; line: number | null; text: string }[]>();
  for (const r of entries.values()) {
    const v = r.values;
    const lineId = v[eLine!];
    const index = lineId === null || lineId === undefined ? undefined : lineIndexOf(Number(lineId));
    const t = texts.get(Number(v[eText!]))?.values[textAt];
    const sid = Number(v[eStructure!]);
    rowsOf.set(sid, [
      ...(rowsOf.get(sid) ?? []),
      {
        id: Number(r.rowid),
        parentId: v[eParent!] === null || v[eParent!] === undefined ? null : Number(v[eParent!]),
        line: index === undefined ? null : index + 1,
        text: typeof t === "string" ? t : "",
      },
    ]);
  }

  const [sKey, sTitle, sHeTitle] = ["key", "title", "heTitle"].map((n) => col(st, n));
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  return [...structureIds]
    .sort((a, b) => a - b)
    .map((id): LibraryAltTocStructure | null => {
      const r = structures.get(id);
      if (!r) return null;
      const { entries: list, skipped } = rowsToEntries(rowsOf.get(id) ?? []);
      const title = str(r.values[sTitle!]);
      const heTitle = str(r.values[sHeTitle!]);
      return { key: String(r.values[sKey!] ?? ""), ...(title && { title }), ...(heTitle && { heTitle }), entries: list, skipped };
    })
    .filter((s): s is LibraryAltTocStructure => !!s);
}

function col(t: TableInfo, name: string): number {
  return t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
}
