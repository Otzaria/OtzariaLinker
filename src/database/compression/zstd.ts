import { ZstdDecoder } from "zstd-wasm-decoder/class";
import wasmBase64 from "virtual:wasm-b64/zstd-wasm-decoder/_esm/zstd-decoder.wasm.b64";
import { LinkerError } from "../../core/errors";

/*
 * Line text compression of Otzaria databases (docs/contracts/DATABASE_SUPPORT_MATRIX.md §3).
 *   • No flag column: a value is compressed iff it is a BLOB starting with the zstd magic 28 B5 2F FD.
 *     TEXT is plain text. Any other BLOB is an error.
 *   • Dictionaries live in zstd_dict(id, dict). Like the app (line_content_codec.dart), a frame's
 *     dictionary is chosen by the dictID in the FRAME HEADER, matched against the dictID in each
 *     DICTIONARY HEADER — never by zstd_dict.id.
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
 * Dictionaries known to the whole worker, by dictID. A personal database is often compressed with
 * the OFFICIAL dictionary without carrying it in its own zstd_dict; it can be read as soon as the
 * dictionary is available from anywhere — another open database (seforim.db) or a dictionary file
 * the user opens. A database's own dictionaries always win; the pool is only a fallback.
 * Two different dictionaries with the same id make that id unusable from the pool (never guess).
 */
export class DictionaryPool {
  private readonly byId = new Map<number, { dict: Uint8Array; origin: string } | "conflict">();

  /** Adds a trained dictionary; returns its id, or null when it is not one (raw content). */
  add(dict: Uint8Array, origin: string): number | null {
    const id = dictionaryId(dict);
    if (id === null) return null;
    if (dict.length > MAX_DICT_BYTES)
      throw new LinkerError("db/dictionary-too-large", `מילון הדחיסה "${origin}" גדול מ־2MB (${dict.length} בתים), ומפענח הדפדפן אינו תומך בו עדיין.`, { size: dict.length });
    const had = this.byId.get(id);
    if (had === undefined) this.byId.set(id, { dict, origin });
    else if (had !== "conflict" && !sameBytes(had.dict, dict)) this.byId.set(id, "conflict");
    return id;
  }

  get(id: number): Uint8Array | undefined {
    const e = this.byId.get(id);
    return e && e !== "conflict" ? e.dict : undefined;
  }

  isConflicted(id: number): boolean {
    return this.byId.get(id) === "conflict";
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The worker's pool (each worker has its own module instance). */
export const sharedDictionaries = new DictionaryPool();

// ignoreBOM: a line that starts with U+FEFF keeps it — the generator counts it (compatibility review #4)
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** Decodes line values of one database. Create it once per open database, inside the DB worker. */
export class LineContentCodec {
  private readonly decoders = new Map<number, InstanceType<typeof ZstdDecoder>>();
  private readonly dictionaries = new Map<number, Uint8Array>();

  /**
   * `dictionaries` = every zstd_dict.dict of the database (any order). They are also offered to
   * `pool`, and a frame whose dictionary the database lacks is decoded with the pool's.
   */
  constructor(dictionaries: readonly Uint8Array[], private readonly pool: DictionaryPool = sharedDictionaries, origin = "") {
    for (const d of dictionaries) {
      const id = dictionaryId(d);
      if (id === null) continue; // raw-content dictionaries are never produced by Otzaria
      if (this.dictionaries.has(id))
        throw new LinkerError("db/dictionary-conflict", `במסד יש שני מילוני דחיסה עם אותו מזהה (${id}). המסד פגום או שנבנה בצורה לא תקינה.`, { dictId: id });
      this.dictionaries.set(id, d);
      if (origin) pool.add(d, origin);
    }
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
    const out = this.decoder(dictId).decompressSync(value, contentSize);
    if (out.length !== contentSize)
      throw new LinkerError("db/compressed-corrupt", "פענוח שורה דחוסה במסד החזיר אורך שגוי. המסד כנראה פגום.", { expected: contentSize, got: out.length });
    return utf8.decode(out);
  }

  private decoder(dictId: number): InstanceType<typeof ZstdDecoder> {
    let d = this.decoders.get(dictId);
    if (d) return d;
    let dictionary: Uint8Array | undefined;
    if (dictId !== 0) {
      dictionary = this.dictionaries.get(dictId) ?? this.pool.get(dictId);
      if (!dictionary)
        throw new LinkerError(
          "db/compressed-unknown-dictionary",
          this.pool.isConflicted(dictId)
            ? `שורה במסד דחוסה במילון ${dictId}, ונפתחו שני מילונים שונים עם המזהה הזה. סגרו את הכלי ופתחו רק את המסד ואת המילון הנכון.`
            : `שורה במסד דחוסה במילון ${dictId}, שאינו קיים במסד הזה. אם זה מסד אישי, הוא כנראה דחוס במילון של הספרייה הרשמית: פתחו גם את seforim.db של אוצריא (או קובץ המילון עצמו), והספרים ייקראו.`,
          { dictId },
        );
      if (dictionary.length > MAX_DICT_BYTES)
        throw new LinkerError("db/dictionary-too-large", `מילון הדחיסה במסד גדול מ־2MB (${dictionary.length} בתים), ומפענח הדפדפן אינו תומך בו עדיין.`, { size: dictionary.length });
    }
    d = new ZstdDecoder(dictionary ? { dictionary } : {}).init(module());
    this.decoders.set(dictId, d);
    return d;
  }
}
