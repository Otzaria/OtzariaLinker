import { CONNECTION_TYPES, parseConnectionType, type ConnectionType } from "../../core/links/connection-type";
import type { DbAnchor } from "../../core/links/model";
import type { IndexInfo, SqliteFile, TableInfo } from "../sqlite/lazy/sqlite-file";
import type { DbCapabilities } from "./capabilities";

/*
 * Existing links of an Otzaria database, read BY LINES — a base book like בראשית has hundreds of
 * thousands of incoming links, so a whole-book read is never the default. For a set of line ids it
 * returns every link that starts there, ends there, or covers the line through a range
 * (link_coverage), in the STORED direction, with anchors, range ends and suppressed sides.
 * (docs/contracts/LINK_FORMATS.md §2, LINK_SCHEMA_MATRIX.md)
 */
export interface DbLinkEnd {
  bookId: number;
  lineId: number;
  lineIndex: number;
  /** inclusive last lineIndex of a range on this side */
  endIndex?: number;
}

export interface DbLinkRow {
  id: number;
  /** stored type; OTHER when the stored name is unknown (`typeName` keeps the original) */
  type: ConnectionType;
  typeName: string;
  source: DbLinkEnd;
  target: DbLinkEnd;
  anchors: DbAnchor[];
  suppressedSides: (0 | 1)[];
}

export class DbLinksReader {
  private constructor(
    private readonly file: SqliteFile,
    private readonly t: { link: TableInfo; line: TableInfo; anchor: TableInfo | null; range: TableInfo | null },
    private readonly ix: { out: IndexInfo | null; in: IndexInfo | null; coverage: IndexInfo | null; anchor: IndexInfo | null; range: IndexInfo | null; suppressed: IndexInfo | null },
    private readonly typeNames: ReadonlyMap<number, string>,
  ) {}

  static async open(file: SqliteFile, caps: DbCapabilities): Promise<DbLinksReader | null> {
    if (!caps.links) return null;
    const link = (await file.table("link"))!;
    const line = (await file.table("line"))!;
    const typeNames = new Map<number, string>();
    if (await file.table("connection_type")) {
      for await (const r of file.scan((await file.table("connection_type"))!)) typeNames.set(Number(r.rowid), String(r.values[1]));
    }
    return new DbLinksReader(
      file,
      { link, line, anchor: caps.anchors ? await file.table("link_anchor") : null, range: caps.ranges ? await file.table("link_range") : null },
      {
        out: await file.findIndex("link", ["sourceLineId"]),
        in: await file.findIndex("link", ["targetLineId"]),
        coverage: caps.coverage ? await file.findIndex("link_coverage", ["lineId"]) : null,
        anchor: caps.anchors ? await file.findIndex("link_anchor", ["linkId"]) : null,
        range: caps.ranges ? await file.findIndex("link_range", ["linkId"]) : null,
        suppressed: caps.suppressedSides ? await file.findIndex("link_suppressed_side", ["linkId"]) : null,
      },
      typeNames,
    );
  }

  /** Whether reading by line can use indexes (false → a full scan of `link`, slow on a big database). */
  get indexed(): boolean {
    return !!(this.ix.out && this.ix.in);
  }

  async atLines(lineIds: Iterable<number>): Promise<DbLinkRow[]> {
    const lines = [...new Set(lineIds)].sort((a, b) => a - b);
    const linkIds = new Set<number>();
    if (this.indexed) {
      const keys = lines.map((id) => [id]);
      for (const rec of await this.file.seekIndexMany(this.ix.out!, keys)) linkIds.add(Number(rec.at(-1)));
      for (const rec of await this.file.seekIndexMany(this.ix.in!, keys)) linkIds.add(Number(rec.at(-1)));
      if (this.ix.coverage) for (const rec of await this.file.seekIndexMany(this.ix.coverage, keys)) linkIds.add(Number(rec[1]));
    } else {
      const wanted = new Set(lines);
      const [s, t] = [col(this.t.link, "sourceLineId"), col(this.t.link, "targetLineId")];
      for await (const r of this.file.scan(this.t.link)) if (wanted.has(Number(r.values[s])) || wanted.has(Number(r.values[t]))) linkIds.add(Number(r.rowid));
    }
    return this.rows(linkIds);
  }

  private async rows(linkIds: Set<number>): Promise<DbLinkRow[]> {
    const links = await this.file.getMany(this.t.link, linkIds);
    const L = (n: string) => col(this.t.link, n);
    const [sb, tb, sl, tl, tli, cti, ctText] = [L("sourceBookId"), L("targetBookId"), L("sourceLineId"), L("targetLineId"), L("targetLineIndex"), L("connectionTypeId"), L("connectionType")];

    // line indexes of every end (targetLineIndex is denormalized on link when the column exists)
    const needLines = new Set<number>();
    for (const r of links.values()) {
      needLines.add(Number(r.values[sl]));
      if (tli < 0) needLines.add(Number(r.values[tl]));
    }
    const lineRows = await this.file.getMany(this.t.line, needLines);
    const li = col(this.t.line, "lineIndex");
    const indexOf = (lineId: number) => Number(lineRows.get(lineId)?.values[li] ?? -1);

    const out: DbLinkRow[] = [];
    for (const [id, r] of links) {
      const v = r.values;
      const name = cti >= 0 ? (this.typeNames.get(Number(v[cti])) ?? "") : String(v[ctText] ?? "");
      const type = (CONNECTION_TYPES as readonly string[]).includes(name) ? (name as ConnectionType) : parseConnectionType(name).type;
      out.push({
        id,
        type,
        typeName: name,
        source: { bookId: Number(v[sb]), lineId: Number(v[sl]), lineIndex: indexOf(Number(v[sl])) },
        target: { bookId: Number(v[tb]), lineId: Number(v[tl]), lineIndex: tli >= 0 ? Number(v[tli]) : indexOf(Number(v[tl])) },
        anchors: [],
        suppressedSides: [],
      });
    }
    await this.attachDetails(out);
    return out.sort((a, b) => a.id - b.id);
  }

  /** Anchors, range ends and suppressed sides of all rows, each table read in ONE ordered walk. */
  private async attachDetails(rows: DbLinkRow[]): Promise<void> {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const keys = rows.map((r) => [r.id]);
    if (!keys.length) return;
    if (this.ix.anchor && this.t.anchor) {
      const recs = await this.file.seekIndexMany(this.ix.anchor, keys);
      const got = await this.file.getMany(this.t.anchor, recs.map((r) => Number(r.at(-1))));
      const [linkId, side, cs, ce, label] = ["linkId", "side", "charStart", "charEnd", "label"].map((n) => col(this.t.anchor!, n));
      for (const a of got.values()) {
        const v = a.values;
        byId.get(Number(v[linkId!]))?.anchors.push({
          side: Number(v[side!]) === 1 ? 1 : 0,
          charStart: Number(v[cs!]),
          ...(v[ce!] !== null && v[ce!] !== undefined && { charEnd: Number(v[ce!]) }),
          ...(typeof v[label!] === "string" && { label: v[label!] as string }),
        });
      }
      for (const r of rows) r.anchors.sort((a, b) => a.side - b.side || a.charStart - b.charStart);
    }
    if (this.ix.range && this.t.range) {
      const recs = await this.file.seekIndexMany(this.ix.range, keys);
      const got = await this.file.getMany(this.t.range, recs.map((r) => Number(r.at(-1))));
      const [linkId, side, end] = ["linkId", "side", "endLineIndex"].map((n) => col(this.t.range!, n));
      for (const r of got.values()) {
        const row = byId.get(Number(r.values[linkId!]));
        if (row) (Number(r.values[side!]) === 1 ? row.target : row.source).endIndex = Number(r.values[end!]);
      }
    }
    if (this.ix.suppressed) {
      for (const rec of await this.file.seekIndexMany(this.ix.suppressed, keys)) byId.get(Number(rec[0]))?.suppressedSides.push(Number(rec[1]) === 1 ? 1 : 0);
    }
  }
}

function col(t: TableInfo, name: string): number {
  return t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
}

