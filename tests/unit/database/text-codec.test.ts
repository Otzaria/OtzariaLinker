import { createRequire } from "node:module";
import { zlibSync } from "fflate";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { mappingProblems, type DbMapping } from "../../../src/core/db-mapping";
import { MappedDbReader } from "../../../src/database/generic/mapped-reader";
import { previewSchema } from "../../../src/database/generic/preview";
import { blobKind, GenericTextCodec } from "../../../src/database/generic/text-codec";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";

/*
 * Review C14: 0x78 followed by a byte that makes the 16-bit header divisible by 31 is the zlib
 * header — and also "x ", "x?", "x^", "x}" in plain text. A BLOB is zlib only when it actually
 * inflates and its Adler-32 trailer matches; otherwise UTF-8 text stays text.
 */
const enc = (s: string) => new TextEncoder().encode(s);

describe("text BLOBs that start like a zlib header (review C14)", () => {
  const texts = ["x marks the spot", "x y z", "x^2 + 1", "x?", "x} y", "x^ab", "x^ab שלום"];

  it.each(texts)("%j is text, not zlib", (s) => {
    const b = enc(s);
    expect(((b[0]! << 8) | b[1]!) % 31).toBe(0); // the old header test matched every one of these
    expect(blobKind(b)).toBe("utf8");
    expect(new GenericTextCodec().decode(b)).toBe(s);
  });

  it("real zlib still decodes, and a zlib value with a broken checksum is corrupt, not text", () => {
    const z = zlibSync(enc("שלום עולם ".repeat(20)));
    expect(blobKind(z)).toBe("zlib");
    expect(new GenericTextCodec().decode(z)).toBe("שלום עולם ".repeat(20));
    const bad = z.slice();
    bad[bad.length - 1]! ^= 1;
    expect(blobKind(bad)).toBe("binary");
    expect(() => new GenericTextCodec().decode(bad)).toThrow(expect.objectContaining({ code: "db/compressed-corrupt" }));
  });
});

describe("a BLOB text column of such values, end to end (review C14)", () => {
  it("is previewed as text, the mapping is not blocked, and the lines read back", async () => {
    const require = createRequire(import.meta.url);
    const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    db.run("CREATE TABLE t (book TEXT, n INTEGER, body BLOB)");
    const lines = ["x marks the spot", "x^2 + 1 = y", "x} closes it"];
    lines.forEach((l, i) => db.run("INSERT INTO t VALUES (?,?,?)", ["ספר", i, enc(l)]));
    const file = await SqliteFile.open(bytesSource(db.export()));
    db.close();
    const p = await previewSchema(file);
    expect(p.tables[0]!.columns.find((c) => c.name === "body")!.kind).toBe("text");
    const m: DbMapping = { layout: "single-table", lines: { table: "t", book: "book", order: "n", text: "body" } };
    expect(mappingProblems(p, m).filter((x) => x.level === "error")).toEqual([]);
    const r = await MappedDbReader.open(file, m);
    expect((await r.lines(0)).map((l) => l.text)).toEqual(lines);
    expect(r.undecodable).toBe(0);
  });
});
