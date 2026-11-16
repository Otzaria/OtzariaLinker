import { Gunzip, Unzlib } from "fflate";
import { LinkerError } from "../../core/errors";
import { isZstdFrame, LineContentCodec, MAX_LINE_BYTES } from "../compression/zstd";
import type { SqlValue } from "../sqlite/lazy/record";

/*
 * Line text of a database we know nothing about. TEXT is taken as is (plain text or HTML — the
 * reader sanitizes HTML for display, and anchors count on the stored string like the generator).
 * A BLOB is accepted when it is UTF-8 text, or compressed text: zstd without a dictionary, gzip or
 * zlib. Every decompression is capped at MAX_LINE_BYTES and fed in small pieces, so a hostile value
 * cannot expand into gigabytes before the cap is checked.
 */
export type BlobKind = "zstd" | "gzip" | "zlib" | "utf8" | "binary";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const PIECE = 1024; // a deflate stream expands at most ~1032:1, so one piece yields ≤ ~1 MiB

/*
 * zlib (RFC 1950): CMF 0x78 (deflate, 32K window) and a header checksum divisible by 31. That header
 * is also plain text — "x ", "x?", "x^", "x}" all pass it (review C14) — so a value is zlib only when
 * it inflates AND its Adler-32 trailer matches (fflate does not check the trailer itself).
 */
const zlibHeader = (b: Uint8Array) => b.length >= 6 && b[0] === 0x78 && ((b[0] << 8) | b[1]!) % 31 === 0;

const isUtf8Text = (b: Uint8Array) => {
  if (b.includes(0)) return false;
  try {
    utf8.decode(b);
    return true;
  } catch {
    return false;
  }
};

export function blobKind(b: Uint8Array): BlobKind {
  if (isZstdFrame(b)) return "zstd";
  if (b.length >= 18 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8) return "gzip";
  if (zlibHeader(b)) {
    try {
      inflateZlib(b);
      return "zlib";
    } catch {
      // not a zlib stream after all: text that starts with "x", or binary
    }
  }
  return isUtf8Text(b) ? "utf8" : "binary";
}

export class GenericTextCodec {
  private zstd: LineContentCodec | null = null;

  /** null for NULL; throws LinkerError("db/value-not-text") for a value that is not text. */
  decode(v: SqlValue | undefined): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    if (zlibHeader(v)) {
      try {
        return inflateZlib(v);
      } catch (err) {
        if (isUtf8Text(v)) return utf8.decode(v);
        throw err;
      }
    }
    switch (blobKind(v)) {
      case "utf8":
        return utf8.decode(v);
      case "zstd":
        // a frame that needs a dictionary fails here with a clear "unknown dictionary" message
        return (this.zstd ??= new LineContentCodec([])).decode(v);
      case "gzip":
        return inflate(v, (cb) => new Gunzip(cb));
      default:
        throw new LinkerError("db/value-not-text", "בעמודת הטקסט נמצא ערך בינארי שאינו טקסט (וגם אינו טקסט דחוס ב־zstd, gzip או zlib).");
    }
  }
}

function inflateZlib(v: Uint8Array): string {
  return inflate(v, (cb) => new Unzlib(cb), (out) => {
    const want = ((v[v.length - 4]! << 24) | (v[v.length - 3]! << 16) | (v[v.length - 2]! << 8) | v[v.length - 1]!) >>> 0;
    if (adler32(out) !== want) throw new LinkerError("db/compressed-corrupt", "ערך דחוס במסד (zlib) פגום: סכום הביקורת שלו אינו תואם.");
  });
}

function adler32(b: Uint8Array): number {
  let a = 1;
  let s = 0;
  for (let i = 0; i < b.length; ) {
    const end = Math.min(b.length, i + 5552); // zlib's NMAX: the sums stay exact between two reductions
    for (; i < end; i++) (a += b[i]!), (s += a);
    (a %= 65521), (s %= 65521);
  }
  return ((s << 16) | a) >>> 0;
}

function inflate(
  v: Uint8Array,
  make: (cb: (chunk: Uint8Array, final: boolean) => void) => { push(d: Uint8Array, final?: boolean): void },
  verify?: (out: Uint8Array) => void,
): string {
  const parts: Uint8Array[] = [];
  let size = 0;
  const stream = make((chunk) => {
    size += chunk.length;
    if (size > MAX_LINE_BYTES) throw new LinkerError("db/compressed-corrupt", "ערך דחוס במסד נפרס ליותר מ־9MB — הוא פגום או חשוד, ולא נקרא.");
    parts.push(chunk);
  });
  try {
    for (let at = 0; at < v.length; at += PIECE) stream.push(v.subarray(at, at + PIECE), at + PIECE >= v.length);
  } catch (err) {
    if (err instanceof LinkerError) throw err;
    throw new LinkerError("db/compressed-corrupt", `ערך דחוס במסד פגום (${err instanceof Error ? err.message : String(err)}).`);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  verify?.(out);
  try {
    return utf8.decode(out);
  } catch {
    throw new LinkerError("db/value-not-text", "ערך דחוס במסד נפרס לנתונים שאינם טקסט UTF-8.");
  }
}
