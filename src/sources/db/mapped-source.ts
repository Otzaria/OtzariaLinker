import type { DbMapping, MappingTest } from "../../core/db-mapping";
import { canonicalTypeString, connectionTypeFromId, parseConnectionType } from "../../core/links/connection-type";
import type { BookRef, Link } from "../../core/links/model";
import { MappedDbReader, type MappedLink, type ReadContext } from "../../database/generic/mapped-reader";
import { bufferedSource, type ByteSource } from "../../database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../database/sqlite/lazy/sqlite-file";
import type { BookSource, SourceBook, SourceInfo, SourceLine } from "../book-source";

/*
 * A SQLite database in someone else's schema, read through a user-confirmed DbMapping (the mapping
 * wizard). Read-only like every database source. Its books are "personal" — not part of the Otzaria
 * library — and its links, when a links table is mapped, come back with provenance "db": shown and
 * compared, never re-exported (LINK_FORMATS §4.4).
 */
export class MappedDbSource implements BookSource {
  private constructor(
    readonly info: SourceInfo,
    private readonly reader: MappedDbReader,
  ) {}

  static async open(id: string, label: string, src: ByteSource, mapping: DbMapping, ctx: ReadContext = {}): Promise<MappedDbSource> {
    // read ahead: without an index the lines table is scanned once, page after page
    const file = await SqliteFile.open(bufferedSource(src));
    const reader = await MappedDbReader.open(file, mapping, ctx);
    const warnings = [...reader.warnings];
    if (file.header.wal) warnings.push({ code: "db/wal", message: "המסד במצב WAL. שינויים שעדיין לא נכתבו לקובץ הראשי (קובץ ‎-wal לידו) לא ייראו." });
    return new MappedDbSource({ id, kind: "mapped-db", label, warnings }, reader);
  }

  get strategy(): "index" | "scan" {
    return this.reader.strategy;
  }

  async books(): Promise<SourceBook[]> {
    return this.reader.books.map((b) => ({
      key: this.keyOf(b.n),
      title: b.title,
      origin: "personal" as const,
      ...(b.lineCount !== null && { lineCount: b.lineCount }),
      ...(b.path && { path: b.path }),
    }));
  }

  async lines(bookKey: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<SourceLine[]> {
    return (await this.reader.lines(this.nOf(bookKey), from, to)).map((l) => ({
      index: l.index,
      text: l.text,
      anchorText: l.text,
      heRef: null,
      heading: l.heading,
      existsInDb: true,
    }));
  }

  async existingLinks(bookKey: string, from: number, to: number): Promise<Link[]> {
    return this.reader.linksAt(this.nOf(bookKey), from, to).map((l) => this.toLink(l));
  }

  close(): void {}

  private toLink(l: MappedLink): Link {
    const ref = (n: number): BookRef => ({ key: this.keyOf(n), title: this.reader.books[n]?.title ?? `#${n}`, origin: "personal" });
    return {
      id: `${this.info.id}:link:${l.id}`,
      status: "existing",
      provenance: "db",
      source: { book: ref(l.source.book), line: l.source.line },
      target: { book: ref(l.target.book), line: l.target.line },
      declaredType: typeOf(l.type),
      heRef2: `${ref(l.target.book).title} ${l.target.line + 1}`,
    };
  }

  private keyOf(n: number): string {
    return `${this.info.id}:${n}`;
  }

  private nOf(bookKey: string): number {
    return Number(bookKey.slice(this.info.id.length + 1));
  }
}

/** rows of each table the wizard's "test the mapping" reads at most: enough for the first books, fast on any size */
const TEST_ROWS = 20_000;
const TEST_BOOKS = 3;
const TEST_LINES = 6;

/**
 * The wizard's "בדיקת המיפוי": opens the database through a mapping that is not confirmed yet and
 * returns the first lines of the first books. Reads at most TEST_ROWS rows of each table, and no
 * links table, so it answers quickly even when opening would scan a large table.
 */
export async function testMapping(src: ByteSource, mapping: DbMapping, ctx: ReadContext = {}): Promise<MappingTest> {
  const file = await SqliteFile.open(bufferedSource(src));
  const { links: _links, ...m } = mapping;
  const reader = await MappedDbReader.open(file, m, { ...ctx, limitRows: TEST_ROWS });
  const sample: MappingTest["sample"] = [];
  for (const b of reader.books.slice(0, TEST_BOOKS)) {
    const lines = (await reader.lines(b.n, 0, TEST_LINES - 1)).map((l) => ({ text: l.text, heading: l.heading }));
    sample.push({ title: b.title, lineCount: reader.partial ? null : await reader.lineCount(b.n), lines });
  }
  return {
    books: reader.books.length,
    partial: reader.partial,
    sample,
    warnings: reader.warnings.filter((w) => w.code !== "db/mapping-no-books").map((w) => w.message),
    undecodable: reader.undecodable,
  };
}

/** A type column may hold a generator type id (1-based) or a type name; anything else is "other". */
function typeOf(v: unknown): string {
  if (typeof v === "number" && Number.isInteger(v)) return canonicalTypeString(connectionTypeFromId(v) ?? "OTHER");
  return canonicalTypeString(parseConnectionType(typeof v === "string" ? v : "").type);
}
