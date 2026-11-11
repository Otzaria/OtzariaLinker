/*
 * SQLite record format (https://www.sqlite.org/fileformat2.html §2.1): varints and serial types.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type TextEncodingId = 1 | 2 | 3; // UTF-8, UTF-16le, UTF-16be

/** Reads a SQLite varint (1–9 bytes, big-endian, 7 bits per byte, 9th byte full). Returns [value, bytesRead]. */
export function readVarint(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const byte = b[at + i]!;
    v = v * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [v, i + 1];
  }
  return [v * 256 + b[at + 8]!, 9];
}

const DECODERS: Record<TextEncodingId, TextDecoder> = {
  1: new TextDecoder("utf-8"),
  2: new TextDecoder("utf-16le"),
  3: new TextDecoder("utf-16be"),
};

/** Content size in bytes for a serial type. */
export function serialSize(t: number): number {
  if (t >= 12) return (t - (t % 2 === 0 ? 12 : 13)) / 2;
  return [0, 1, 2, 3, 4, 6, 8, 8, 0, 0, 0, 0][t]!;
}

/** Decodes a full record payload into its values. */
export function decodeRecord(p: Uint8Array, enc: TextEncodingId): SqlValue[] {
  const [headerSize, n0] = readVarint(p, 0);
  const types: number[] = [];
  for (let at = n0; at < headerSize; ) {
    const [t, n] = readVarint(p, at);
    types.push(t);
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

/** SQLite's cross-type ordering: NULL < numbers < text < blob. Text compares as BINARY (code units). */
export function compareValues(a: SqlValue, b: SqlValue): number {
  const rank = (v: SqlValue) => (v === null ? 0 : typeof v === "number" || typeof v === "bigint" ? 1 : typeof v === "string" ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ra === 2) return compareUtf8(a as string, b as string);
  const x = a as Uint8Array;
  const y = b as Uint8Array;
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
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
