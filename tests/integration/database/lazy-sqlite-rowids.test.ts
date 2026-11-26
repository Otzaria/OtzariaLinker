import type { SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { decodeRecord, readVarint } from "../../../src/database/sqlite/lazy/record";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";
import { loadSqlJs } from "../../support/sql-js";

/*
 * Review C19: a 9-byte varint is a signed 64-bit two's-complement value. Negative rowids are legal
 * in SQLite (always 9 bytes on disk) and used to come back as 18446744073709552000.
 */
let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await loadSqlJs();
});

/** SQLite's varint encoding of a signed 64-bit value. */
function varint(v: bigint): Uint8Array {
  let u = BigInt.asUintN(64, v);
  if (u >> 56n) {
    const out = new Uint8Array(9);
    out[8] = Number(u & 0xffn);
    u >>= 8n;
    for (let i = 7; i >= 0; i--) (out[i] = Number(u & 0x7fn) | 0x80), (u >>= 7n);
    return out;
  }
  const bytes: number[] = [];
  do (bytes.unshift(Number(u & 0x7fn))), (u >>= 7n); while (u);
  return Uint8Array.from(bytes, (b, i) => (i < bytes.length - 1 ? b | 0x80 : b));
}

describe("readVarint (review C19)", () => {
  it.each([0n, 1n, 127n, 128n, 2n ** 31n, 2n ** 53n - 1n, -1n, -2n, -(2n ** 53n) + 1n, -(2n ** 63n) + 1n])("%s", (v) => {
    const b = varint(v);
    expect(readVarint(b, 0)).toEqual([Number(v), b.length]);
  });

  it("a negative serial type in a record header is corruption, not a NaN offset", () => {
    const neg = varint(-5n);
    const rec = new Uint8Array([1 + neg.length, ...neg]);
    expect(() => decodeRecord(rec, 1)).toThrow(/פגום/);
  });
});

describe("negative rowids, read lazily vs SQLite", () => {
  let file: SqliteFile;
  beforeAll(async () => {
    const db = new SQL.Database();
    db.run("CREATE TABLE t (a TEXT)");
    for (const id of [-2, -1, 5, -(2 ** 40), 2 ** 40]) db.run("INSERT INTO t (rowid, a) VALUES (?, ?)", [id, `r${id}`]);
    file = await SqliteFile.open(bytesSource(db.export()));
    db.close();
  });

  it("scan returns every rowid, signed and in order", async () => {
    const t = (await file.table("t"))!;
    const rows: [number | null, unknown][] = [];
    for await (const r of file.scan(t)) rows.push([r.rowid, r.values[0]]);
    expect(rows).toEqual([[-(2 ** 40), `r${-(2 ** 40)}`], [-2, "r-2"], [-1, "r-1"], [5, "r5"], [2 ** 40, `r${2 ** 40}`]]);
  });

  it("get and getMany find negative and positive rowids", async () => {
    const t = (await file.table("t"))!;
    expect((await file.get(t, -1))?.values).toEqual(["r-1"]);
    expect((await file.get(t, 5))?.values).toEqual(["r5"]);
    const many = await file.getMany(t, [5, -2, -1, 7]);
    expect([...many.keys()].sort((a, b) => a - b)).toEqual([-2, -1, 5]);
    const ranged: number[] = [];
    for await (const r of file.scan(t, { from: -2, to: 5 })) ranged.push(r.rowid!);
    expect(ranged).toEqual([-2, -1, 5]);
  });
});
