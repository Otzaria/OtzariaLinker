import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import initSqlJs from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { LinkerError } from "../../../src/core/errors";
import { stripNikud } from "../../../src/core/text/hebrew";
import {
  DictionaryPool,
  LineContentCodec,
  OFFICIAL_DICTIONARY_SHA256,
  dictionaryFingerprint,
  dictionaryId,
  frameHeader,
  isZstdFrame,
} from "../../../src/database/compression/zstd";
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
  it("a decoder built on a pool dictionary stops when a conflicting one arrives later (security review A11)", () => {
    const pool = new DictionaryPool();
    const frame = new Uint8Array(zstdCompressSync(enc.encode("שורה"), { dictionary: dict } as never));
    pool.add(dict, "a");
    const personal = new LineContentCodec([], pool);
    expect(personal.decode(frame)).toBe("שורה"); // decoder built and cached
    const other = dict.slice();
    other[100] = other[100]! ^ 0xff;
    pool.add(other, "b");
    expect(codeOf(() => personal.decode(frame))).toBe("db/compressed-unknown-dictionary");
    // a database's OWN dictionary is not affected by the pool
    const own = new LineContentCodec([dict], pool);
    expect(own.decode(frame)).toBe("שורה");
  });
  it("a dictionary file is recognised by content and reported by the registry", async () => {
    expect(detectKind(dict.subarray(0, 4096), "whatever.bin")).toBe("zstd-dict");
    const res = await new SourceRegistry().open([{ path: "otzaria.dict", blob: new Blob([new Uint8Array(dict)]) }]);
    expect(res.dictionaries).toEqual([{ path: "otzaria.dict", id: 32768 }]);
    expect(res.skipped).toEqual([]);
  });
});

describe("dictID is not identity: a dictionary is bound to its source and fingerprint (B19, issue #41)", () => {
  const enc = new TextEncoder();
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  /* A second dictionary with the SAME dictID 32768 and different content, like the personal database v52 next to
     seforim.db (docs/research/PERSONAL_DB_V52_AUDIT.md §7). It is the official one with its raw-content tail changed
     (the part frames copy matches from): a valid dictionary that decodes most real frames to wrong text, silently. */
  const sameIdOther = () => {
    const o = dict.slice();
    for (let i = o.length - 200_000; i < o.length; i++) o[i] = o[i]! ^ 0x5a;
    return o;
  };
  const blobs = () => rows.map((r) => r.content).filter((c): c is Uint8Array => c instanceof Uint8Array);
  const reference = (frame: Uint8Array) => zstdDecompressSync(frame, { dictionary: dict } as never).toString("utf8");

  it("the official dictionary's fingerprint is pinned, and the worker's SHA-256 agrees with Node's", () => {
    expect(sha(dict)).toBe(OFFICIAL_DICTIONARY_SHA256);
    expect(dictionaryFingerprint(dict)).toBe(sha(dict));
    const other = sameIdOther();
    expect(dictionaryId(other)).toBe(32768);
    expect(dictionaryFingerprint(other)).toBe(sha(other));
  });

  it("a database without its own dictionary never borrows a different dictionary that only shares the dictID", () => {
    const pool = new DictionaryPool();
    new LineContentCodec([sameIdOther()], pool, "v52.db"); // only the other database is open
    const personal = new LineContentCodec([], pool);
    const outcomes = new Set(blobs().map((b) => codeOf(() => personal.decode(b))));
    expect([...outcomes]).toEqual(["db/compressed-unknown-dictionary"]);
    expect(() => personal.decode(blobs()[0]!)).toThrow(/v52\.db/); // names the open database whose dictionary differs
  });

  it("it borrows the official dictionary even when another database brought a different one with the same id", () => {
    const pool = new DictionaryPool();
    new LineContentCodec([sameIdOther()], pool, "v52.db");
    new LineContentCodec([dict], pool, "seforim.db");
    const personal = new LineContentCodec([], pool);
    for (const b of blobs()) expect(personal.decode(b)).toBe(reference(b));
  });

  it("a database with its own dictionary always uses its own, whatever the pool holds", () => {
    const pool = new DictionaryPool();
    new LineContentCodec([dict], pool, "seforim.db");
    const other = sameIdOther();
    const v52 = new LineContentCodec([other], pool, "v52.db");
    const text = blobs().slice(0, 50).map(reference).join("\n");
    expect(v52.decode(new Uint8Array(zstdCompressSync(enc.encode(text), { dictionary: other } as never)))).toBe(text);
    const official = new LineContentCodec([dict], pool);
    for (const b of blobs().slice(0, 50)) expect(official.decode(b)).toBe(reference(b));
  });

  it("a dictionary file the user opened may be borrowed; when it is the wrong one, a line is a coded error, never wrong text", () => {
    const pool = new DictionaryPool();
    pool.add(sameIdOther(), "wrong.dict"); // a file: an explicit association by the user
    const personal = new LineContentCodec([], pool);
    let mismatches = 0;
    for (const b of blobs()) {
      const outcome = codeOf(() => personal.decode(b));
      if (outcome === "none") expect(personal.decode(b)).toBe(reference(b)); // frames that never reach the changed part
      else {
        expect(outcome).toBe("db/dictionary-mismatch");
        mismatches++;
      }
    }
    expect(mismatches).toBeGreaterThan(0);
  });

  it("a frame with a content checksum decoded with the wrong dictionary is a coded error", () => {
    const other = sameIdOther();
    const v52 = new LineContentCodec([other], new DictionaryPool());
    // a real line that the other dictionary decodes to different text when the frame has no checksum
    const text = blobs().map(reference).find((t) => {
      const plain = zstdCompressSync(enc.encode(t), { dictionary: dict } as never);
      return zstdDecompressSync(plain, { dictionary: other } as never).toString("utf8") !== t;
    })!;
    const checked = new Uint8Array(zstdCompressSync(enc.encode(text), { dictionary: dict, params: { [constants.ZSTD_c_checksumFlag]: 1 } } as never));
    expect(checked[4]! & 4).toBe(4); // Content_Checksum_flag
    expect(codeOf(() => v52.decode(checked))).toBe("db/compressed-corrupt");
  });

  it("garbled compressed data is a coded error, not a raw decoder failure", () => {
    const own = new LineContentCodec([dict], new DictionaryPool());
    const bad = blobs().reduce((a, b) => (b.length > a.length ? b : a)).slice(); // the longest real frame
    expect(bad.length).toBeGreaterThan(100);
    for (let i = 12; i < bad.length; i++) bad[i] = bad[i]! ^ 0x33; // the header (dictID, size) stays intact
    expect(codeOf(() => own.decode(bad))).toBe("db/compressed-corrupt");
  });

  it("opening and closing the official database again and again: its dictionary is lent only while it is open", () => {
    const pool = new DictionaryPool();
    const personal = new LineContentCodec([], pool);
    const b = blobs()[3]!;
    for (let i = 0; i < 3; i++) {
      const official = new LineContentCodec([dict], pool, "seforim.db");
      expect(personal.decode(b)).toBe(reference(b));
      official.release();
      expect(pool.get(32768)).toBeUndefined();
      expect(codeOf(() => personal.decode(b))).toBe("db/compressed-unknown-dictionary");
    }
  });
});

describe("a codec that refuses its database leaves nothing in the pool (#41 C3, V7 merge review)", () => {
  it("two dictionaries with one id: the conflict is thrown before any of them is offered to the pool", () => {
    const pool = new DictionaryPool();
    expect(codeOf(() => new LineContentCodec([dict, dict], pool, "פגום.db"))).toBe("db/dictionary-conflict");
    expect(pool.lend(32768)).toBeUndefined();
    expect(pool.unlendableOrigins(32768)).toEqual([]);
  });
});
