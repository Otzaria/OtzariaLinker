import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { LinkerError } from "../../core/errors";

/*
 * ZIP extraction that is safe against hostile or broken archives (stage 17):
 *   • ZIP Slip — absolute paths, drive letters, ".." segments, control characters and bidi controls
 *     are rejected, and so are two extracted entries that land on the same path;
 *   • ZIP Bomb — total and per-entry decompressed bytes are counted WHILE inflating, and the
 *     run aborts the moment a limit is crossed (sizes declared in headers are not trusted);
 *   • entry count and compression ratio are capped.
 *
 * fflate inflates everything one push hands it in a single synchronous call and only then reports
 * the output, so a limit can be checked no more often than once per push. The archive is therefore
 * fed in small pieces: one piece expands to at most INFLATE_PIECE × MAX_DEFLATE_RATIO (~16 MiB), and
 * that is the most a bomb can add past a limit before it is stopped. With 1 MiB pushes, a 1.5MB bomb
 * was inflated to ~1.5GB in one call before any check ran (Issue #41 B15).
 */
export interface UnzipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  /** decompressed ÷ compressed, checked once an entry is past 1 MiB */
  maxRatio: number;
}

export const DEFAULT_UNZIP_LIMITS: UnzipLimits = {
  maxEntries: 50_000,
  // everything extracted is held in the worker's memory, so the totals stay well under a GB
  maxTotalBytes: 512 * 1024 ** 2,
  maxEntryBytes: 128 * 1024 ** 2,
  maxRatio: 200,
};

/** The most a deflate stream can expand: a 258-byte match coded in 2 bits. */
export const MAX_DEFLATE_RATIO = 1032;
/**
 * Compressed bytes per push. 16 KiB keeps one push's output under ~16 MiB. Smaller pieces cost more
 * than they save: fflate copies its 32 KiB window on every push, and 1 KiB pieces (the size the
 * database codec uses for single values, text-codec.ts PIECE) were ~4× slower on a text archive,
 * while 16 KiB was as fast as 1 MiB.
 */
export const INFLATE_PIECE = 16 * 1024;
/** Longer than any real book path; a guard against names built to bloat the listing and the messages. */
const MAX_PATH_LENGTH = 1024;
/**
 * C0 controls and DEL (the export side's rule, export.ts isSafeZipPath), and the bidi embedding,
 * override and isolate controls that make a name read as another one in an RTL list.
 */
const ODD_CHARS = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

export interface ZipEntry {
  /** normalized, forward slashes, no leading "./" */
  path: string;
  bytes: Uint8Array;
}

/** Normalizes an archive path, or returns null when it would escape the extraction root or is not a plain name. */
export function safeArchivePath(name: string): string | null {
  if (name.length > MAX_PATH_LENGTH || ODD_CHARS.test(name)) return null;
  const p = name.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

export function safeUnzip(
  data: Uint8Array,
  opts: {
    limits?: Partial<UnzipLimits>;
    include?: (path: string) => boolean;
    /** compressed bytes per push; never more than INFLATE_PIECE */
    chunkSize?: number;
    /** checked between pieces: an aborted run throws the signal's reason */
    signal?: AbortSignal;
  } = {},
): ZipEntry[] {
  const limits = { ...DEFAULT_UNZIP_LIMITS, ...opts.limits };
  const include = opts.include ?? (() => true);
  const signal = opts.signal;
  const out: ZipEntry[] = [];
  const paths = new Set<string>();
  let entries = 0;
  let total = 0;
  let failure: LinkerError | null = null;
  /** compressed bytes handed to the inflater so far */
  let fed = 0;

  const fail = (e: LinkerError, file?: UnzipFile, chunks?: Uint8Array[]): void => {
    failure ??= e;
    file?.terminate();
    // what the failed entry inflated so far is let go now, not when the whole run is collected
    if (chunks) chunks.length = 0;
  };

  const unzip = new Unzip((file) => {
    if (failure) return;
    if (file.name.endsWith("/")) return; // directory entry
    if (++entries > limits.maxEntries)
      return fail(new LinkerError("archive/too-many-entries", `בארכיון יש יותר מ־${limits.maxEntries} קבצים. פצלו אותו לכמה ארכיונים קטנים יותר.`, { limit: limits.maxEntries }));
    const path = safeArchivePath(file.name);
    if (path == null)
      return fail(new LinkerError("archive/unsafe-path", `בארכיון יש קובץ עם נתיב לא בטוח ("${printable(file.name)}"). הארכיון לא נפתח.`, { name: file.name }));
    if (!include(path)) return;
    // "a/b.txt", "./a/b.txt" and "a\b.txt" are one file: which copy is read must not depend on the order in the archive
    if (paths.has(path))
      return fail(new LinkerError("archive/duplicate-path", `בארכיון יש שני קבצים באותו נתיב ("${path}"), ולא ברור איזה מהם לקרוא. צרו את הארכיון מחדש בלי הכפילות.`, { path }));
    paths.add(path);
    if (file.compression !== 0 && file.compression !== 8)
      return fail(new LinkerError("archive/unsupported-compression", `הקובץ "${path}" דחוס בשיטה שאינה נתמכת. צרו את הארכיון מחדש בפורמט ZIP רגיל.`, { path, method: file.compression }));

    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) return fail(new LinkerError("archive/corrupt", `הקובץ "${path}" בארכיון פגום.`, { path, cause: err.message }), file, chunks);
      size += chunk.length;
      total += chunk.length;
      if (size > limits.maxEntryBytes || total > limits.maxTotalBytes)
        return fail(new LinkerError("archive/too-large", "תוכן הארכיון גדול מדי לפתיחה בדפדפן. חלצו אותו במחשב ובחרו את התיקייה במקום את הקובץ.", { path, size, total }), file, chunks);
      // The entry's declared size is 0 when the archive uses data descriptors, so the ratio is also
      // checked against the compressed bytes actually consumed so far (security review #5).
      const ratio = file.size ? size / file.size : 0;
      const overall = total / Math.max(fed, 1);
      if ((size > 1024 ** 2 && ratio > limits.maxRatio) || (total > 8 * 1024 ** 2 && overall > limits.maxRatio))
        return fail(new LinkerError("archive/suspicious-ratio", `הקובץ "${path}" בארכיון נראה כמו "פצצת ZIP" (יחס דחיסה חריג), ולכן לא נפתח.`, { path, ratio: Math.max(ratio, overall) }), file, chunks);
      chunks.push(chunk);
      if (final) {
        out.push({ path, bytes: concat(chunks, size) });
        chunks.length = 0;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const step = Math.max(1, Math.min(opts.chunkSize ?? INFLATE_PIECE, INFLATE_PIECE));
  try {
    for (let i = 0; i < data.length && !failure && !signal?.aborted; i += step) {
      const end = Math.min(i + step, data.length);
      fed = end;
      unzip.push(data.subarray(i, end), end === data.length);
    }
  } catch (err) {
    fail(new LinkerError("archive/corrupt", "הארכיון פגום ולא ניתן לפתוח אותו.", { cause: String(err) }));
  }
  if (signal?.aborted || failure) {
    out.length = 0; // nothing of a stopped run is returned; the entries extracted so far are let go
    signal?.throwIfAborted();
    throw failure;
  }
  return out;
}

/** A name for a message: control and bidi characters shown as code points instead of acting on the text. */
function printable(name: string): string {
  return name.slice(0, 200).replace(new RegExp(ODD_CHARS.source, "g"), (c) => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
