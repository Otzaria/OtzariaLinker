import { LinkerError } from "../../../core/errors";
/*
 * SQLite record format (https://www.sqlite.org/fileformat2.html §2.1): varints and serial types.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type TextEncodingId = 1 | 2 | 3; // UTF-8, UTF-16le, UTF-16be

/**
 * Reads a SQLite varint (1–9 bytes, big-endian, 7 bits per byte, 9th byte full). Returns [value, bytesRead].
 * The value is a signed 64-bit two's-complement integer: a negative rowid is a 9-byte varint with
 * the top bit set (review C19). Values beyond ±2^53 come back as the nearest double.
 */
export function readVarint(b: Uint8Array, at: number): [number, number] {
  if (at < 0 || at >= b.length) throw corrupt("varint outside the page");
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const byte = b[at + i];
    if (byte === undefined) throw corrupt("varint runs past the end");
    v = v * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [v, i + 1];
  }
  const last = b[at + 8];
  if (last === undefined) throw corrupt("varint runs past the end");
  let big = 0n;
  for (let i = 0; i < 8; i++) big = (big << 7n) | BigInt(b[at + i]! & 0x7f);
  return [Number(BigInt.asIntN(64, (big << 8n) | BigInt(last))), 9];
}

/** SQLite's own limit on columns per table (SQLITE_MAX_COLUMN). */
const MAX_COLUMNS = 32767;

function corrupt(what: string): LinkerError {
  return new LinkerError("db/corrupt", `המסד פגום (${what}). אי אפשר לקרוא אותו בבטחה.`);
}

const DECODERS: Record<TextEncodingId, TextDecoder> = {
  // ignoreBOM: a value that starts with U+FEFF keeps it — the generator counts it (compatibility review #4)
  1: new TextDecoder("utf-8", { ignoreBOM: true }),
  2: new TextDecoder("utf-16le", { ignoreBOM: true }),
  3: new TextDecoder("utf-16be", { ignoreBOM: true }),
};

/** Content size in bytes for a serial type. */
export function serialSize(t: number): number {
  if (t >= 12) return (t - (t % 2 === 0 ? 12 : 13)) / 2;
  return [0, 1, 2, 3, 4, 6, 8, 8, 0, 0, 0, 0][t]!;
}

/** Decodes a full record payload into its values. */
export function decodeRecord(p: Uint8Array, enc: TextEncodingId): SqlValue[] {
  const [headerSize, n0] = readVarint(p, 0);
  // a hostile headerSize used to read "undefined" bytes as zeros until memory ran out (review #4)
  if (headerSize > p.length || headerSize < n0) throw corrupt("record header larger than the record");
  const types: number[] = [];
  for (let at = n0; at < headerSize; ) {
    const [t, n] = readVarint(p, at);
    if (t < 0) throw corrupt("negative serial type");
    types.push(t);
    if (types.length > MAX_COLUMNS) throw corrupt("too many columns in a record");
    at += n;
  }
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const out: SqlValue[] = [];
  let at = headerSize;
  for (const t of types) {
    out.push(readValue(p, view, at, t, enc));
    at += serialSize(t);
  }
  return out;
}

function readValue(p: Uint8Array, view: DataView, at: number, t: number, enc: TextEncodingId): SqlValue {
  switch (t) {
    case 0: return null;
    case 1: return view.getInt8(at);
    case 2: return view.getInt16(at);
    case 3: return (view.getInt8(at) * 65536) + view.getUint16(at + 1);
    case 4: return view.getInt32(at);
    case 5: return view.getInt16(at) * 2 ** 32 + view.getUint32(at + 2);
    case 6: {
      const v = view.getBigInt64(at);
      return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    }
    case 7: return view.getFloat64(at);
    case 8: return 0;
    case 9: return 1;
    case 10:
    case 11: throw new Error(`reserved serial type ${t}`);
    default: {
      const len = serialSize(t);
      const bytes = p.subarray(at, at + len);
      return t % 2 === 0 ? bytes.slice() : DECODERS[enc].decode(bytes);
    }
  }
}

/**
 * SQLite's cross-type ordering: NULL < numbers < text < blob. Text compares as BINARY: memcmp of
 * the stored bytes, so the order depends on the database's text encoding (review C12).
 */
export function compareValues(a: SqlValue, b: SqlValue, enc: TextEncodingId = 1): number {
  const rank = (v: SqlValue) => (v === null ? 0 : typeof v === "number" || typeof v === "bigint" ? 1 : typeof v === "string" ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ra === 2) return enc === 1 ? compareUtf8(a as string, b as string) : compareUtf16(a as string, b as string, enc === 2);
  const x = a as Uint8Array;
  const y = b as Uint8Array;
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/**
 * memcmp order of the UTF-16 encodings: code-unit order for big-endian; for little-endian each
 * code unit compares by its low byte first ('é' U+00E9 sorts after 'א' U+05D0).
 */
function compareUtf16(a: string, b: string, littleEndian: boolean): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (littleEndian) (x = ((x & 0xff) << 8) | (x >> 8)), (y = ((y & 0xff) << 8) | (y >> 8));
    return x - y;
  }
  return a.length - b.length;
}

/** memcmp order of the UTF-8 encodings == code-point order (not UTF-16 code-unit order). */
function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ca = ia.next();
    const cb = ib.next();
    if (ca.done || cb.done) return ca.done ? (cb.done ? 0 : -1) : 1;
    const d = ca.value.codePointAt(0)! - cb.value.codePointAt(0)!;
    if (d) return d;
  }
}
