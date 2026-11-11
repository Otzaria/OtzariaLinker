import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { zstdCompressSync } from "node:zlib";
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { LinkerError } from "../../../src/core/errors";
import { stripNikud } from "../../../src/core/text/hebrew";
import { DictionaryPool, LineContentCodec, dictionaryId, frameHeader, isZstdFrame } from "../../../src/database/compression/zstd";
import { detectKind } from "../../../src/sources/detect";
import { SourceRegistry } from "../../../src/sources/registry";

/* Real data: tests/fixtures/db/seforim-v7-mini.db (scripts/fixtures/make_mini_db.py) carries the
   official dictionary and real compressed rows. Node's zlib (zstd) makes frames for edge cases. */
const require = createRequire(import.meta.url);
let dict: Uint8Array;
let rows: { id: number; content: Uint8Array | string }[];

beforeAll(async () => {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const db = new SQL.Database(readFileSync("tests/fixtures/db/seforim-v7-mini.db"));
  dict = db.exec("SELECT dict FROM zstd_dict")[0]!.values[0]![0] as Uint8Array;
  rows = db.exec("SELECT lc.id, lc.content FROM line_content lc JOIN line l ON l.id = lc.id WHERE l.bookId = 1 ORDER BY l.lineIndex")[0]!
    .values.map(([id, content]) => ({ id: id as number, content: content as Uint8Array | string }));
  db.close();
});

const codeOf = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { return e instanceof LinkerError ? e.code : String(e); } };

describe("zstd line codec — real Otzaria data", () => {
  it("the official dictionary: trained, dictID 32768, 2 MiB", () => {
    expect(dictionaryId(dict)).toBe(32768);
    expect(dict.length).toBe(2 * 1024 * 1024);
  });

  it("decodes every compressed Bereshit row with the real dictionary", () => {
    const codec = new LineContentCodec([dict]);
    const blobs = rows.filter((r) => r.content instanceof Uint8Array);
    expect(blobs.length).toBeGreaterThan(100);
    const texts = blobs.map((r) => codec.decode(r.content)!);
    expect(texts[0]).toBe("<h1>בראשית</h1>");
    // the first letter is <big>-wrapped in the real text: "(א) <big>ב</big>ראשית ברא אלהים…"
    expect(stripNikud(texts.join("\n"))).toContain("ברא אלהים את השמים ואת הארץ");
    for (const r of blobs) expect(frameHeader(r.content as Uint8Array).dictId).toBe(32768);
  });
});

describe("zstd line codec — rules", () => {
  const enc = new TextEncoder();
  it("TEXT passes through, NULL stays null", () => {
    const codec = new LineContentCodec([]);
    expect(codec.decode("טקסט")).toBe("טקסט");
    expect(codec.decode(null)).toBeNull();
  });
  it("a frame made with the dictionary by another zstd encodes the dictID and round-trips", () => {
    const frame = new Uint8Array(zstdCompressSync(enc.encode("<h2>פרק א</h2> שלום"), { dictionary: dict } as never));
    expect(isZstdFrame(frame)).toBe(true);
    expect(frameHeader(frame).dictId).toBe(32768);
    expect(new LineContentCodec([dict]).decode(frame)).toBe("<h2>פרק א</h2> שלום");
  });
  it("a frame without a dictionary decodes too", () => {
    const frame = new Uint8Array(zstdCompressSync(enc.encode("א".repeat(5000))));
    expect(new LineContentCodec([]).decode(frame)).toBe("א".repeat(5000));
  });
  it("a missing dictionary, a non-zstd blob and a conflicting dictionary are coded errors", () => {
    const withDict = new Uint8Array(zstdCompressSync(enc.encode("x"), { dictionary: dict } as never));
    expect(codeOf(() => new LineContentCodec([], new DictionaryPool()).decode(withDict))).toBe("db/compressed-unknown-dictionary");
    expect(codeOf(() => new LineContentCodec([]).decode(new Uint8Array([1, 2, 3])))).toBe("db/value-not-text");
    expect(codeOf(() => new LineContentCodec([dict, dict.slice()]))).toBe("db/dictionary-conflict");
  });
});

describe("zstd dictionaries shared across open databases and files", () => {
  const enc = new TextEncoder();
  it("a database without the dictionary reads frames once another database (or a file) brought it", () => {
    const pool = new DictionaryPool();
    const frame = new Uint8Array(zstdCompressSync(enc.encode("שורה אישית"), { dictionary: dict } as never));
    const personal = new LineContentCodec([], pool);
    expect(codeOf(() => personal.decode(frame))).toBe("db/compressed-unknown-dictionary");
    new LineContentCodec([dict], pool, "seforim.db"); // the official database is opened too
    expect(personal.decode(frame)).toBe("שורה אישית");
  });
  it("a database's own dictionary wins; codecs without an origin never feed the pool", () => {
    const pool = new DictionaryPool();
    new LineContentCodec([dict], pool);
    expect(pool.get(32768)).toBeUndefined();
  });
  it("two different dictionaries with one id are never guessed between", () => {
    const pool = new DictionaryPool();
    const other = dict.slice();
    other[100] = other[100]! ^ 0xff;
    expect(pool.add(dict, "a")).toBe(32768);
    expect(pool.add(other, "b")).toBe(32768);
    expect(pool.get(32768)).toBeUndefined();
    expect(pool.isConflicted(32768)).toBe(true);
    const frame = new Uint8Array(zstdCompressSync(enc.encode("x"), { dictionary: dict } as never));
    expect(codeOf(() => new LineContentCodec([], pool).decode(frame))).toBe("db/compressed-unknown-dictionary");
  });
  it("a dictionary file is recognised by content and reported by the registry", async () => {
    expect(detectKind(dict.subarray(0, 4096), "whatever.bin")).toBe("zstd-dict");
    const res = await new SourceRegistry().open([{ path: "otzaria.dict", blob: new Blob([new Uint8Array(dict)]) }]);
    expect(res.dictionaries).toEqual([{ path: "otzaria.dict", id: 32768 }]);
    expect(res.skipped).toEqual([]);
  });
});
