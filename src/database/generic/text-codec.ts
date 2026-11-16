import { Gunzip, Unzlib } from "fflate";
import { LinkerError } from "../../core/errors";
import { isZstdFrame, LineContentCodec, MAX_LINE_BYTES } from "../compression/zstd";
import type { SqlValue } from "../sqlite/lazy/record";

/*
 * Line text of a database we know nothing about. TEXT is taken as is (plain text or HTML — the
 * reader sanitizes HTML for display, and anchors count on the stored string like the generator).
 * A BLOB is accepted when it is UTF-8 text, UTF-16 text (with a byte-order mark, or without one when
 * the bytes clearly are UTF-16 Hebrew/ASCII), text in the Windows-1255 code page (old Hebrew software),
 * or compressed text: zstd without a dictionary, gzip or zlib. Every decompression is capped at MAX_LINE_BYTES and fed in small pieces, so a hostile value
 * cannot expand into gigabytes before the cap is checked.
 */
export type BlobKind = "zstd" | "gzip" | "zlib" | "utf8" | "utf16le" | "utf16be" | "cp1255" | "binary";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf16le = new TextDecoder("utf-16le", { fatal: true });
const utf16be = new TextDecoder("utf-16be", { fatal: true });
let cp1255: TextDecoder | null | undefined;
const cp1255Decoder = () => (cp1255 === undefined ? (cp1255 = tryDecoder("windows-1255")) : cp1255);
const tryDecoder = (label: string) => {
  try {
    return new TextDecoder(label);
  } catch {
    return null; // a runtime without the legacy code pages: the value stays "binary"
  }
};
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

/*
 * UTF-16 without a byte-order mark: an even length, and almost every code unit is ASCII text, Hebrew
 * (U+0590–U+05FF) or general punctuation (U+2000–U+206F). Arbitrary binary data does not look like
 * that; a UTF-8 or Latin text never has the zero bytes this needs.
 */
const PROBE = 4096;
function utf16Order(b: Uint8Array): "utf16le" | "utf16be" | null {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return "utf16le";
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return "utf16be";
  if (b.length < 4 || b.length % 2) return null;
  const n = Math.min(b.length, PROBE) >> 1;
  const plausible = (hi: number, lo: number) => (hi === 0 && (lo >= 0x20 || lo === 9 || lo === 10 || lo === 13)) || hi === 0x05 || (hi === 0x20 && lo <= 0x6f) || hi === 0xfb;
  let le = 0;
  let be = 0;
  for (let i = 0; i < n; i++) {
    const x = b[2 * i]!;
    const y = b[2 * i + 1]!;
    if (plausible(y, x)) le++;
    if (plausible(x, y)) be++;
  }
  if (le >= n * 0.95 && le > be) return "utf16le";
  if (be >= n * 0.95 && be > le) return "utf16be";
  return null;
}

/*
 * Windows-1255 (and ISO-8859-8, which shares its letters): not UTF-8, no zero byte, and the bytes
 * above 0x7F are mostly Hebrew letters (0xE0–0xFA) or points (0xC0–0xD2).
 */
function looksCp1255(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  let high = 0;
  let hebrew = 0;
  const n = Math.min(b.length, PROBE);
  for (let i = 0; i < n; i++) {
    const x = b[i]!;
    if (x < 0x80) continue;
    high++;
    if ((x >= 0xe0 && x <= 0xfa) || (x >= 0xc0 && x <= 0xd2)) hebrew++;
  }
  return high > 0 && hebrew >= high * 0.8 && cp1255Decoder() !== null;
}

/** A known non-text format, for an honest message ("PNG image", "bzip2"); null when unknown. */
export function binaryFormat(b: Uint8Array): string | null {
  const at = (...sig: number[]) => sig.every((x, i) => b[i] === x);
  if (at(0x89, 0x50, 0x4e, 0x47)) return "תמונת PNG";
  if (at(0xff, 0xd8, 0xff)) return "תמונת JPEG";
  if (at(0x47, 0x49, 0x46, 0x38)) return "תמונת GIF";
  if (at(0x25, 0x50, 0x44, 0x46)) return "קובץ PDF";
  if (at(0x42, 0x5a, 0x68)) return "דחיסת bzip2";
  if (at(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return "דחיסת xz";
  if (at(0x04, 0x22, 0x4d, 0x18)) return "דחיסת LZ4";
  if (at(0x50, 0x4b, 0x03, 0x04)) return "ארכיון ZIP";
  if (at(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "ארכיון 7z";
  if (at(0x5d, 0x00, 0x00)) return "דחיסת LZMA";
  return null;
}

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
  if (isUtf8Text(b)) return "utf8";
  const u16 = utf16Order(b);
  if (u16 && decode16(b, u16) !== null) return u16;
  return looksCp1255(b) ? "cp1255" : "binary";
}

function decode16(b: Uint8Array, order: "utf16le" | "utf16be"): string | null {
  try {
    // the decoder drops a matching byte-order mark itself
    return (order === "utf16le" ? utf16le : utf16be).decode(b);
  } catch {
    return null; // an unpaired surrogate: not UTF-16 text
  }
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
    const kind = blobKind(v);
    switch (kind) {
      case "utf8":
        return utf8.decode(v);
      case "zstd":
        // a frame that needs a dictionary fails here with a clear "unknown dictionary" message
        return (this.zstd ??= new LineContentCodec([])).decode(v);
      case "gzip":
        return inflate(v, (cb) => new Gunzip(cb));
      case "utf16le":
      case "utf16be":
        return decode16(v, kind)!;
      case "cp1255":
        return cp1255Decoder()!.decode(v);
      default: {
        const format = binaryFormat(v);
        throw new LinkerError(
          "db/value-not-text",
          format
            ? `בעמודת הטקסט נמצא ערך בפורמט ${format}, שהכלי אינו קורא כטקסט.`
            : "בעמודת הטקסט נמצא ערך בינארי שאינו טקסט (וגם אינו טקסט דחוס ב־zstd, gzip או zlib, UTF-16 או Windows-1255).",
        );
      }
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
