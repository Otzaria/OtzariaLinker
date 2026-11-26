import { ZstdDecoder } from "zstd-wasm-decoder/class";
import wasmBase64 from "virtual:wasm-b64/zstd-wasm-decoder/_esm/zstd-decoder.wasm.b64";
import { LinkerError } from "../../core/errors";
import { sha256Hex } from "./sha256";

/*
 * Line text compression of Otzaria databases (docs/contracts/DATABASE_SUPPORT_MATRIX.md §3).
 *   • No flag column: a value is compressed iff it is a BLOB starting with the zstd magic 28 B5 2F FD.
 *     TEXT is plain text. Any other BLOB is an error.
 *   • Dictionaries live in zstd_dict(id, dict). Like the app (line_content_codec.dart), a frame's
 *     dictionary is chosen by the dictID in the FRAME HEADER, matched against the dictID in each
 *     DICTIONARY HEADER — never by zstd_dict.id. A database's own dictionaries always win; a dictionary
 *     from elsewhere is used only when it is provably the right one (DictionaryPool: dictID is no identity).
 *   • Every decoder failure is a coded LinkerError; a line decoded with a borrowed dictionary must also
 *     be valid UTF-8 (a wrong dictionary with the same dictID is not text).
 *   • A frame without a content size, decoding to more than 9 MiB, or longer than 2 MiB compressed, is
 *     treated as corrupt (see MAX_LINE_BYTES).
 * Decoder: zstd-wasm-decoder (one instance per dictionary; it caps a dictionary at 2 MiB, which is
 * exactly the size of the official one — see the matrix §3.5).
 */
// 9 MiB: above ~9.4 MB of declared content (or a 2 MiB input) zstd-wasm-decoder switches to its
// streaming path, which decodes EVERY concatenated frame with no output cap — a 95 KB value could
// expand to gigabytes. Staying under both limits keeps the bounded one-shot path (security review #1).
export const MAX_LINE_BYTES = 9 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024 - 1;
const FRAME_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const DICT_MAGIC = [0x37, 0xa4, 0x30, 0xec] as const;
const MAX_DICT_BYTES = 2 * 1024 * 1024;

export const isZstdFrame = (b: Uint8Array): boolean =>
  b.length >= 6 && b[0] === FRAME_MAGIC[0] && b[1] === FRAME_MAGIC[1] && b[2] === FRAME_MAGIC[2] && b[3] === FRAME_MAGIC[3];

/** dictID written in a trained dictionary's header (u32 LE at bytes 4–7), or null for a raw-content dictionary. */
export function dictionaryId(dict: Uint8Array): number | null {
  if (dict.length < 8 || DICT_MAGIC.some((m, i) => dict[i] !== m)) return null;
  return (dict[4]! | (dict[5]! << 8) | (dict[6]! << 16)) + dict[7]! * 2 ** 24;
}

export interface FrameHeader {
  dictId: number;
  /** decompressed size, or null when the frame does not declare it */
  contentSize: number | null;
}

/** Reads dictID and Frame_Content_Size from a zstd frame header without decompressing (RFC 8878 §3.1.1.1). */
export function frameHeader(b: Uint8Array): FrameHeader {
  const fhd = b[4]!;
  const fcsFlag = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const dictFlag = fhd & 3;
  let p = 5 + (singleSegment ? 0 : 1);
  const dictBytes = [0, 1, 2, 4][dictFlag]!;
  let dictId = 0;
  for (let i = 0; i < dictBytes; i++) dictId += b[p + i]! * 2 ** (8 * i);
  p += dictBytes;
  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!;
  if (!fcsBytes) return { dictId, contentSize: null };
  let size = 0;
  for (let i = 0; i < fcsBytes; i++) size += b[p + i]! * 2 ** (8 * i);
  if (fcsBytes === 2) size += 256;
  return { dictId, contentSize: size };
}

let wasmModule: WebAssembly.Module | undefined;
function module(): WebAssembly.Module {
  if (!wasmModule) {
    const bin = atob(wasmBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    wasmModule = new WebAssembly.Module(bytes); // synchronous compile: fine inside a Worker
  }
  return wasmModule;
}


/**
 * SHA-256 of the official library dictionary (DATABASE_SUPPORT_MATRIX §3.1, `line_content.zdict`): the only
 * dictionary a database that lacks one may borrow without the user naming it. Measured 2026-11-26 on the local
 * official seforim.db (zstd_dict: one row, id 32768, 2,097,152 bytes), opened read-only with node:sqlite
 * (`new DatabaseSync(path, { readOnly: true })`) and hashed with node:crypto; it matches the matrix's
 * `7b08b7c3…a396` and the dictionary of tests/fixtures/db/seforim-v7-mini.db (zstd.test.ts pins both).
 * The dictionary is frozen (LineContentCompression.kt:11-18): replacing it takes a new schema number, and this
 * constant changes with it.
 */
export const OFFICIAL_DICTIONARY_SHA256 = "7b08b7c3534c9f9cd0e8f18414b4326aeeb64cfd574cc0f12d83b6f92bd6a396";

/** The identity of a dictionary: SHA-256 of its bytes (hex). Its dictID is NOT one (see DictionaryPool). */
export const dictionaryFingerprint = (dict: Uint8Array): string => sha256Hex(dict);

/** A dictionary the pool lends to a database that lacks it, with where it came from. */
export interface LentDictionary {
  dict: Uint8Array;
  sha256: string;
  /** the database or file it came from, for messages */
  origin: string;
}

interface PoolEntry {
  dict: Uint8Array;
  sha256: string;
  /** who brought it → its name for the user. The key undefined is a dictionary FILE the user opened (never released). */
  owners: Map<object | undefined, string>;
}

/**
 * Dictionaries known to the whole worker. A personal database is often compressed with the OFFICIAL dictionary
 * without carrying it in its own zstd_dict; it can be read once that dictionary is available from elsewhere —
 * the open seforim.db, or a dictionary file the user opens.
 *
 * A dictID is not an identity (B19, issue #41): the personal database v52 carries its OWN dictionary with the same
 * dictID 32768 as the official one, and frames of one decoded with the other give errors or, worse, different text
 * with no error (measured on 400 real frames of the official database decoded with v52's dictionary: 2 identical,
 * 2 silently different, 396 failed). So every dictionary is kept with its fingerprint (SHA-256) and with the owners
 * that brought it, and the pool LENDS only:
 *   • the official dictionary (OFFICIAL_DICTIONARY_SHA256), whichever database brought it, or
 *   • a dictionary file the user opened: the user's explicit association;
 * and only when exactly one such dictionary has that id (never guess). Another database's own, different dictionary
 * is never lent — it is kept only to name it in the error. A database's own dictionaries never come from the pool
 * (LineContentCodec). When a database closes it `release`s what it brought (QA round 2, H8).
 */
export class DictionaryPool {
  /** per dictID: the DISTINCT dictionaries seen with it (by fingerprint) */
  private readonly byId = new Map<number, PoolEntry[]>();

  /** Adds a trained dictionary; returns its id, or null when it is not one (raw content). `owner` can `release` it later. */
  add(dict: Uint8Array, origin: string, owner?: object): number | null {
    const id = dictionaryId(dict);
    if (id === null) return null;
    if (dict.length > MAX_DICT_BYTES)
      throw new LinkerError("db/dictionary-too-large", `מילון הדחיסה "${origin}" גדול מ־2MB (${dict.length} בתים), ומפענח הדפדפן אינו תומך בו עדיין.`, { size: dict.length });
    const sha256 = dictionaryFingerprint(dict);
    const list = this.byId.get(id) ?? [];
    const same = list.find((e) => e.sha256 === sha256);
    if (!same) list.push({ dict, sha256, owners: new Map([[owner, origin]]) });
    else if (!same.owners.has(owner)) same.owners.set(owner, origin);
    this.byId.set(id, list);
    return id;
  }

  /** Takes back everything `owner` added (its database closed). */
  release(owner: object): void {
    for (const [id, list] of this.byId) {
      for (const e of list) e.owners.delete(owner);
      const rest = list.filter((e) => e.owners.size > 0);
      if (rest.length) this.byId.set(id, rest);
      else this.byId.delete(id);
    }
  }

  /** The dictionary a database without one may use for frames of this id, or undefined (none, or two that may be lent). */
  lend(id: number): LentDictionary | undefined {
    const candidates = this.lendable(id);
    if (candidates.length !== 1) return undefined;
    const e = candidates[0]!;
    return { dict: e.dict, sha256: e.sha256, origin: e.owners.get(undefined) ?? [...e.owners.values()][0]! };
  }

  get(id: number): Uint8Array | undefined {
    return this.lend(id)?.dict;
  }

  /** two different dictionaries with this id may both be lent: the id cannot be resolved */
  isConflicted(id: number): boolean {
    return this.lendable(id).length > 1;
  }

  /** where the dictionaries with this id that are never lent came from (other databases' own dictionaries) */
  unlendableOrigins(id: number): string[] {
    return (this.byId.get(id) ?? []).filter((e) => !isLendable(e)).flatMap((e) => [...e.owners.values()]);
  }

  private lendable(id: number): PoolEntry[] {
    return (this.byId.get(id) ?? []).filter(isLendable);
  }
}

const isLendable = (e: PoolEntry): boolean => e.sha256 === OFFICIAL_DICTIONARY_SHA256 || e.owners.has(undefined);

/** The worker's pool (each worker has its own module instance). */
export const sharedDictionaries = new DictionaryPool();

// ignoreBOM: a line that starts with U+FEFF keeps it — the generator counts it (compatibility review #4)
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
// a line decoded with a BORROWED dictionary must be valid UTF-8: a wrong dictionary with the same dictID mostly
// yields broken sequences, and that is a wrong dictionary, not text with replacement characters
const strictUtf8 = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

type Decoder = InstanceType<typeof ZstdDecoder>;

/** Decodes line values of one database. Create it once per open database, inside the DB worker. */
export class LineContentCodec {
  /** this database's own dictionaries, by dictID */
  private readonly dictionaries = new Map<number, Uint8Array>();
  /** decoders on the database's own dictionaries (and on none, dictID 0), by dictID */
  private readonly ownDecoders = new Map<number, Decoder>();
  /** decoders on a dictionary the pool lent, by dictID, with the fingerprint they were built on */
  private readonly lentDecoders = new Map<number, { sha256: string; origin: string; decoder: Decoder }>();

  /**
   * `dictionaries` = every zstd_dict.dict of the database (any order); they are always the ones used for their
   * ids. With an `origin` (the database's name) they are also offered to `pool`, and a frame whose dictionary the
   * database lacks is decoded with what the pool lends (DictionaryPool: the official dictionary, or a file the
   * user opened). The lending is checked on every line, so a dictionary stops being used once its database closes.
   */
  constructor(dictionaries: readonly Uint8Array[], private readonly pool: DictionaryPool = sharedDictionaries, origin = "") {
    for (const d of dictionaries) {
      const id = dictionaryId(d);
      if (id === null) continue; // raw-content dictionaries are never produced by Otzaria
      if (this.dictionaries.has(id))
        throw new LinkerError("db/dictionary-conflict", `במסד יש שני מילוני דחיסה עם אותו מזהה (${id}). המסד פגום או שנבנה בצורה לא תקינה.`, { dictId: id });
      this.dictionaries.set(id, d);
      if (origin) pool.add(d, origin, this);
    }
  }

  /** The database this codec belongs to closed: its dictionaries leave the pool. */
  release(): void {
    this.pool.release(this);
    this.lentDecoders.clear();
  }

  get dictionaryIds(): number[] {
    return [...this.dictionaries.keys()];
  }

  /** null stays null, TEXT stays as is, a zstd BLOB is decompressed. */
  decode(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (!(value instanceof Uint8Array) || !isZstdFrame(value))
      throw new LinkerError("db/value-not-text", "בשדה הטקסט נמצא ערך בינארי שאינו טקסט דחוס. ייתכן שהמסד אינו מסד אוצריא או שהוא פגום.");
    const { dictId, contentSize } = frameHeader(value);
    if (contentSize === null || contentSize > MAX_LINE_BYTES || value.length > MAX_COMPRESSED_BYTES)
      throw new LinkerError("db/compressed-corrupt", "שורה דחוסה במסד פגומה או גדולה מדי (גודל לא מוצהר, או יותר מ־9MB).", { contentSize, compressed: value.length });
    const { decoder, lent } = this.decoder(dictId);
    let out: Uint8Array;
    try {
      // the decoder verifies the frame's content checksum when it has one (Content_Checksum_flag)
      out = decoder.decompressSync(value, contentSize);
    } catch (err) {
      throw lent ? wrongDictionary(dictId, lent.origin, lent.sha256, err) : corrupt(dictId, err);
    }
    if (out.length !== contentSize) {
      const err = `expected ${contentSize} bytes, got ${out.length}`;
      throw lent ? wrongDictionary(dictId, lent.origin, lent.sha256, err) : corrupt(dictId, err);
    }
    if (!lent) return utf8.decode(out);
    try {
      return strictUtf8.decode(out);
    } catch (err) {
      throw wrongDictionary(dictId, lent.origin, lent.sha256, err);
    }
  }

  private decoder(dictId: number): { decoder: Decoder; lent?: { sha256: string; origin: string } } {
    if (dictId === 0 || this.dictionaries.has(dictId)) {
      let d = this.ownDecoders.get(dictId);
      if (!d) this.ownDecoders.set(dictId, (d = build(this.dictionaries.get(dictId))));
      return { decoder: d };
    }
    // a dictionary the database lacks: asked of the pool on every line, so a dictionary whose database closed, or
    // whose id became ambiguous after the decoder was built (security review A11), is not used any more
    const lent = this.pool.lend(dictId);
    if (!lent) {
      this.lentDecoders.delete(dictId);
      throw this.unknownDictionary(dictId);
    }
    let c = this.lentDecoders.get(dictId);
    if (!c || c.sha256 !== lent.sha256) this.lentDecoders.set(dictId, (c = { sha256: lent.sha256, origin: lent.origin, decoder: build(lent.dict) }));
    return { decoder: c.decoder, lent: c };
  }

  private unknownDictionary(dictId: number): LinkerError {
    if (this.pool.isConflicted(dictId))
      return new LinkerError(
        "db/compressed-unknown-dictionary",
        `שורה במסד דחוסה במילון ${dictId}, ונפתחו שני מילונים שונים עם המזהה הזה. סגרו את הכלי ופתחו רק את המסד ואת המילון הנכון.`,
        { dictId },
      );
    const others = [...new Set(this.pool.unlendableOrigins(dictId))];
    if (others.length)
      return new LinkerError(
        "db/compressed-unknown-dictionary",
        `שורה במסד דחוסה במילון ${dictId}, שאינו קיים במסד הזה. גם ב"${others.join('", "')}" יש מילון עם המזהה הזה, אבל זה מילון אחר (לא המילון של הספרייה הרשמית), ולכן הוא לא משמש כאן: קריאה בו הייתה נותנת טקסט שגוי. אם זה מסד אישי, פתחו גם את seforim.db של אוצריא (או את קובץ המילון שהמסד נדחס בו).`,
        { dictId, others },
      );
    return new LinkerError(
      "db/compressed-unknown-dictionary",
      `שורה במסד דחוסה במילון ${dictId}, שאינו קיים במסד הזה. אם זה מסד אישי, הוא כנראה דחוס במילון של הספרייה הרשמית: פתחו גם את seforim.db של אוצריא (או קובץ המילון עצמו), והספרים ייקראו.`,
      { dictId },
    );
  }
}

function build(dictionary: Uint8Array | undefined): Decoder {
  if (dictionary && dictionary.length > MAX_DICT_BYTES)
    throw new LinkerError("db/dictionary-too-large", `מילון הדחיסה במסד גדול מ־2MB (${dictionary.length} בתים), ומפענח הדפדפן אינו תומך בו עדיין.`, { size: dictionary.length });
  return new ZstdDecoder(dictionary ? { dictionary } : {}).init(module());
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function corrupt(dictId: number, err: unknown): LinkerError {
  return new LinkerError(
    "db/compressed-corrupt",
    "פענוח שורה דחוסה במסד נכשל: הנתונים הדחוסים פגומים, או שאינם תואמים למילון הדחיסה שבמסד. המסד כנראה פגום; הורידו או צרו אותו מחדש.",
    { dictId, zstd: reasonOf(err) },
  );
}

function wrongDictionary(dictId: number, origin: string, sha256: string, err: unknown): LinkerError {
  return new LinkerError(
    "db/dictionary-mismatch",
    `שורה במסד דחוסה במילון ${dictId}, והמילון עם המזהה הזה מ"${origin}" אינו מתאים לה (הפענוח נכשל), כנראה כי המסד לא נדחס בו. סגרו את הכלי, ופתחו את המסד יחד עם המילון שהוא נדחס בו: seforim.db של אוצריא, או קובץ המילון הנכון.`,
    { dictId, origin, sha256, zstd: reasonOf(err) },
  );
}
