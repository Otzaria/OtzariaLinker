import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { mappingProblems, type DbMapping } from "../../../src/core/db-mapping";
import { MappedDbReader } from "../../../src/database/generic/mapped-reader";
import { previewSchema } from "../../../src/database/generic/preview";
import { blobKind, GenericTextCodec } from "../../../src/database/generic/text-codec";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";
import { loadSqlJs } from "../../support/sql-js";

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
        const SQL = await loadSqlJs();
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

describe("BLOB text in other encodings (wizard round V5)", () => {
  const he = "<h1>ספר הדוגמה</h1> בראשית ברא";
  const le = (s: string, bom = false) => {
    const out = new Uint8Array(s.length * 2 + (bom ? 2 : 0));
    let at = 0;
    if (bom) (out[0] = 0xff), (out[1] = 0xfe), (at = 2);
    for (let i = 0; i < s.length; i++) (out[at + 2 * i] = s.charCodeAt(i) & 0xff), (out[at + 2 * i + 1] = s.charCodeAt(i) >> 8);
    return out;
  };
  const be = (s: string) => le(s).map((_, i, a) => a[i ^ 1]!);

  it("UTF-16 with and without a byte-order mark, little- and big-endian", () => {
    const codec = new GenericTextCodec();
    expect(blobKind(le(he, true))).toBe("utf16le");
    expect(blobKind(le(he))).toBe("utf16le");
    expect(blobKind(be(he))).toBe("utf16be");
    expect(codec.decode(le(he, true))).toBe(he);
    expect(codec.decode(le(he))).toBe(he);
    expect(codec.decode(be(he))).toBe(he);
  });

  it("Windows-1255 Hebrew decodes; random high bytes stay binary", () => {
    const cp = new Uint8Array([0xf9, 0xec, 0xe5, 0xed, 0x20, 0xf2, 0xe5, 0xec, 0xed]); // שלום עולם
    expect(blobKind(cp)).toBe("cp1255");
    expect(new GenericTextCodec().decode(cp)).toBe("שלום עולם");
    expect(blobKind(new Uint8Array([0x81, 0x8d, 0x90, 0x9d, 0x41]))).toBe("binary");
  });

  it("a known binary format is named in the message", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(() => new GenericTextCodec().decode(png)).toThrow(/תמונת PNG/);
    expect(() => new GenericTextCodec().decode(new Uint8Array([0x42, 0x5a, 0x68, 0x39, 0x31, 0, 0x41, 0x59]))).toThrow(/bzip2/);
  });

  it("binary that merely has zero bytes is not UTF-16", () => {
    expect(blobKind(new Uint8Array([0, 255, 3, 0x89, 0x50, 0x4e, 0x47, 0]))).toBe("binary");
  });
});
