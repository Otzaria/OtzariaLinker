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

export function blobKind(b: Uint8Array): BlobKind {
  if (isZstdFrame(b)) return "zstd";
  if (b.length >= 18 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8) return "gzip";
  // zlib: CMF 0x78 (deflate, 32K window) and a header checksum divisible by 31 (RFC 1950)
  if (b.length >= 6 && b[0] === 0x78 && ((b[0] << 8) | b[1]!) % 31 === 0) return "zlib";
  if (b.includes(0)) return "binary";
  try {
    utf8.decode(b);
    return "utf8";
  } catch {
    return "binary";
  }
}

export class GenericTextCodec {
  private zstd: LineContentCodec | null = null;

  /** null for NULL; throws LinkerError("db/value-not-text") for a value that is not text. */
  decode(v: SqlValue | undefined): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "bigint") return String(v);
    switch (blobKind(v)) {
      case "utf8":
        return utf8.decode(v);
      case "zstd":
        // a frame that needs a dictionary fails here with a clear "unknown dictionary" message
        return (this.zstd ??= new LineContentCodec([])).decode(v);
      case "gzip":
        return inflate(v, (cb) => new Gunzip(cb));
      case "zlib":
        return inflate(v, (cb) => new Unzlib(cb));
      default:
        throw new LinkerError("db/value-not-text", "בעמודת הטקסט נמצא ערך בינארי שאינו טקסט (וגם אינו טקסט דחוס ב־zstd, gzip או zlib).");
    }
  }
}

function inflate(v: Uint8Array, make: (cb: (chunk: Uint8Array, final: boolean) => void) => { push(d: Uint8Array, final?: boolean): void }): string {
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
  try {
    return utf8.decode(out);
  } catch {
    throw new LinkerError("db/value-not-text", "ערך דחוס במסד נפרס לנתונים שאינם טקסט UTF-8.");
  }
}
