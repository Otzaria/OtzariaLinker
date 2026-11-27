import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { LineContentCodec } from "../../../src/database/compression/zstd";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { decodeRecord, readVarint } from "../../../src/database/sqlite/lazy/record";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";
import { DbBookSource } from "../../../src/sources/db/db-source";

const require = createRequire(import.meta.url);

/* Regression tests for the security review (2026-11-11): hostile inputs must fail fast and clearly. */
const open = (f: string) => DbBookSource.open("h", f, bytesSource(new Uint8Array(readFileSync(`tests/fixtures/db/hostile/${f}`))));

/** A zstd frame of RLE blocks declaring `fcs` bytes of content (tiny input, huge output). */
function rleFrame(fcs: number): number[] {
  const out = [0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x38, fcs & 255, (fcs >> 8) & 255, (fcs >> 16) & 255, (fcs >>> 24) & 255];
  for (let left = fcs; left > 0; ) {
    const sz = Math.min(131072, left);
    left -= sz;
    const h = (sz << 3) | (1 << 1) | (left === 0 ? 1 : 0);
    out.push(h & 255, (h >> 8) & 255, (h >> 16) & 255, 0x41);
  }
  return out;
}

describe("hostile databases fail fast", () => {
  it("a b-tree that points back at itself is reported as corrupt, not walked forever", async () => {
    await expect(open("cycle.db")).rejects.toThrow(/פגום|מעגל/);
  }, 10_000);

  it("an unterminated [ in a table's SQL does not loop forever", async () => {
    // its line table parses to one odd column, so it is not an Otzaria database (it goes to the mapping wizard)
    await expect(open("bracket.db")).rejects.toMatchObject({ code: "db/no-books" });
  }, 10_000);

  it("a record whose header claims to be larger than the record is rejected", () => {
    expect(() => decodeRecord(new Uint8Array([0x81, 0x80, 0x80, 0x80, 0x00]), 1)).toThrow(expect.objectContaining({ code: "db/corrupt" }));
  });

  it("concatenated zstd frames cannot expand a small value into gigabytes", () => {
    const one = rleFrame(10_000_000);
    const bomb = new Uint8Array(Array.from({ length: 300 }, () => one).flat());
    expect(() => new LineContentCodec([]).decode(bomb)).toThrow(expect.objectContaining({ code: "db/compressed-corrupt" }));
    const smaller = rleFrame(1_000_000);
    const many = new Uint8Array(Array.from({ length: 300 }, () => smaller).flat());
    const t0 = Date.now();
    let len = 0;
    try {
      len = new LineContentCodec([]).decode(many)!.length;
    } catch {
      /* rejecting is fine too */
    }
    expect(len).toBeLessThanOrEqual(1_000_000);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

/*
 * Issue #41 C2: a b-tree whose interior pages share their children (a DAG: every cell of a page points at the same
 * next page) is walked once per path — K^depth leaf visits from a few pages (a 24 KB file took 59 s, only the
 * worker's watchdog stopped it). The files are written by SQLite itself (sql.js) and then damaged by hand, page by
 * page, in the file format (fileformat2.html §1.6): no schema is invented, only the b-tree is broken.
 */
describe("hostile b-trees fail fast (Issue #41 C2)", () => {
  const PAGE = 1024;
  /** a real database: a table of 2,000 short rows (a two-level b-tree) and one row large enough for an overflow chain */
  async function built() {
    const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    db.run(`PRAGMA page_size = ${PAGE}`);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.run("CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)");
    db.run("BEGIN");
    for (let i = 1; i <= 2000; i++) db.run("INSERT INTO t (id, v) VALUES (?, ?)", [i, `row ${i}`]);
    db.run("INSERT INTO big (id, v) VALUES (1, ?)", ["א".repeat(3000)]);
    db.run("COMMIT");
    const root = (name: string) => Number(db.exec(`SELECT rootpage FROM sqlite_master WHERE name = '${name}'`)[0]!.values[0]![0]);
    const out = { bytes: db.export(), t: root("t"), big: root("big") };
    db.close();
    return out;
  }
  const at = (no: number) => (no - 1) * PAGE;
  const u32 = (b: Uint8Array, off: number) => ((b[off]! << 24) >>> 0) + (b[off + 1]! << 16) + (b[off + 2]! << 8) + b[off + 3]!;
  const put32 = (b: Uint8Array, off: number, v: number) => b.set([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255], off);
  /** the child pages of a table-interior page, in order, the right child last */
  const children = (b: Uint8Array, no: number) => {
    const p = at(no);
    expect(b[p]).toBe(0x05);
    const n = (b[p + 3]! << 8) | b[p + 4]!;
    return [...Array.from({ length: n }, (_, i) => u32(b, p + ((b[p + 12 + 2 * i]! << 8) | b[p + 13 + 2 * i]!))), u32(b, p + 8)];
  };
  /** page `no` rewritten as a table-interior page of `k` cells (keys 1..k) whose children are all `child` */
  const fanOut = (b: Uint8Array, no: number, k: number, child: number) => {
    const p = at(no);
    b.fill(0, p, p + PAGE);
    b[p] = 0x05;
    b.set([k >> 8, k & 255], p + 3);
    b.set([((PAGE - 5 * k) >> 8) & 255, (PAGE - 5 * k) & 255], p + 5);
    put32(b, p + 8, child);
    for (let i = 0; i < k; i++) {
      const cell = PAGE - 5 * (i + 1);
      b.set([cell >> 8, cell & 255], p + 12 + 2 * i);
      put32(b, p + cell, child);
      b[p + cell + 4] = i + 1; // the key: a one-byte varint
    }
  };
  const scanAll = async (file: SqliteFile, name: string) => {
    let n = 0;
    for await (const _ of file.scan((await file.table(name))!)) n++;
    return n;
  };

  it("a DAG of interior pages that all point at the same child is refused as corrupt, without walking every path", async () => {
    const { bytes, t } = await built();
    const [leaf, p1, p2] = children(bytes, t); // three pages of the table: one leaf to keep, two to rewrite
    // root → (30 × p1) → (30 × p2) → (30 × leaf): 29,791 visits of one leaf, from four pages
    fanOut(bytes, t, 30, p1!);
    fanOut(bytes, p1!, 30, p2!);
    fanOut(bytes, p2!, 30, leaf!);
    const file = await SqliteFile.open(bytesSource(bytes));
    const t0 = performance.now();
    await expect(scanAll(file, "t")).rejects.toMatchObject({ code: "db/corrupt", message: expect.stringContaining("פגום") });
    expect(performance.now() - t0).toBeLessThan(2000);
  }, 120_000);

  it("a page reached twice in one walk (two cells, one child) is refused: its rows would be read twice", async () => {
    const { bytes, t } = await built();
    const [leaf] = children(bytes, t);
    fanOut(bytes, t, 2, leaf!);
    const file = await SqliteFile.open(bytesSource(bytes));
    await expect(scanAll(file, "t")).rejects.toMatchObject({ code: "db/corrupt" });
    // a lookup by rowid walks the same way: rows 1 and 2 are under two cells that both lead to the one leaf
    await expect(file.getMany((await file.table("t"))!, [1, 2])).rejects.toMatchObject({ code: "db/corrupt" });
  });

  it("an overflow chain that points back at itself is refused, not read as the same page again and again", async () => {
    const { bytes, big } = await built();
    const file0 = await SqliteFile.open(bytesSource(bytes));
    expect(await scanAll(file0, "big")).toBe(1);
    // the leaf of `big` holds one cell: payload size, rowid, the local part, then the first overflow page (§1.6, "Cell Payload Overflow Pages")
    const leafPage = bytes.subarray(at(big), at(big) + PAGE);
    expect(leafPage[0]).toBe(0x0d);
    const cell = (leafPage[8]! << 8) | leafPage[9]!;
    const [size, n1] = readVarint(leafPage, cell);
    const [, n2] = readVarint(leafPage, cell + n1);
    const [U, X, M] = [PAGE, PAGE - 35, Math.floor(((PAGE - 12) * 32) / 255) - 23];
    expect(size).toBeGreaterThan(X);
    const K = M + ((size - M) % (U - 4));
    const first = u32(leafPage, cell + n1 + n2 + (K <= X ? K : M));
    expect(first).toBeGreaterThan(1);
    expect(u32(bytes, at(first))).toBeGreaterThan(0); // a chain of more than one page
    put32(bytes, at(first), first); // the first overflow page's "next" is itself
    const file = await SqliteFile.open(bytesSource(bytes));
    await expect(scanAll(file, "big")).rejects.toMatchObject({ code: "db/corrupt" });
  });

  it("a header that declares more pages than the file holds does not raise the limits sizes are checked against", async () => {
    const { bytes } = await built();
    put32(bytes, 28, 0x7fffffff); // in-header database size, valid while the change counter matches "version-valid-for"
    put32(bytes, 92, u32(bytes, 24));
    const file = await SqliteFile.open(bytesSource(bytes));
    expect(file.header.pageCount).toBe(bytes.length / PAGE);
  });
});
