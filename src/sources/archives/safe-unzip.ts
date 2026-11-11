import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import { LinkerError } from "../../core/errors";

/*
 * ZIP extraction that is safe against hostile or broken archives (stage 17):
 *   • ZIP Slip — absolute paths, drive letters, ".." segments and NUL are rejected;
 *   • ZIP Bomb — total and per-entry decompressed bytes are counted WHILE inflating, and the
 *     run aborts the moment a limit is crossed (sizes declared in headers are not trusted);
 *   • entry count and compression ratio are capped.
 * The archive is fed in chunks so an abort happens early, before a bomb is fully expanded.
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
  maxTotalBytes: 2 * 1024 ** 3,
  maxEntryBytes: 512 * 1024 ** 2,
  maxRatio: 200,
};

export interface ZipEntry {
  /** normalized, forward slashes, no leading "./" */
  path: string;
  bytes: Uint8Array;
}

/** Normalizes an archive path, or returns null when it would escape the extraction root. */
export function safeArchivePath(name: string): string | null {
  if (name.includes("\0")) return null;
  const p = name.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

export function safeUnzip(
  data: Uint8Array,
  opts: { limits?: Partial<UnzipLimits>; include?: (path: string) => boolean; chunkSize?: number } = {},
): ZipEntry[] {
  const limits = { ...DEFAULT_UNZIP_LIMITS, ...opts.limits };
  const include = opts.include ?? (() => true);
  const out: ZipEntry[] = [];
  let entries = 0;
  let total = 0;
  let failure: LinkerError | null = null;

  const fail = (e: LinkerError, file?: UnzipFile): void => {
    failure ??= e;
    file?.terminate();
  };

  const unzip = new Unzip((file) => {
    if (failure) return;
    if (file.name.endsWith("/")) return; // directory entry
    if (++entries > limits.maxEntries)
      return fail(new LinkerError("archive/too-many-entries", `בארכיון יש יותר מ־${limits.maxEntries} קבצים. פצלו אותו לכמה ארכיונים קטנים יותר.`, { limit: limits.maxEntries }));
    const path = safeArchivePath(file.name);
    if (path == null)
      return fail(new LinkerError("archive/unsafe-path", `בארכיון יש קובץ עם נתיב לא בטוח ("${file.name}"). הארכיון לא נפתח.`, { name: file.name }));
    if (!include(path)) return;
    if (file.compression !== 0 && file.compression !== 8)
      return fail(new LinkerError("archive/unsupported-compression", `הקובץ "${path}" דחוס בשיטה שאינה נתמכת. צרו את הארכיון מחדש בפורמט ZIP רגיל.`, { path, method: file.compression }));

    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) return fail(new LinkerError("archive/corrupt", `הקובץ "${path}" בארכיון פגום.`, { path, cause: err.message }), file);
      size += chunk.length;
      total += chunk.length;
      if (size > limits.maxEntryBytes || total > limits.maxTotalBytes)
        return fail(new LinkerError("archive/too-large", "תוכן הארכיון גדול מדי לפתיחה בדפדפן. חלצו אותו במחשב ובחרו את התיקייה במקום את הקובץ.", { path, size, total }), file);
      if (size > 1024 ** 2 && file.size && size / file.size > limits.maxRatio)
        return fail(new LinkerError("archive/suspicious-ratio", `הקובץ "${path}" בארכיון נראה כמו "פצצת ZIP" (יחס דחיסה חריג), ולכן לא נפתח.`, { path, ratio: size / file.size }), file);
      chunks.push(chunk);
      if (final) out.push({ path, bytes: concat(chunks, size) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const step = opts.chunkSize ?? 1024 ** 2;
  try {
    for (let i = 0; i < data.length && !failure; i += step) {
      const end = Math.min(i + step, data.length);
      unzip.push(data.subarray(i, end), end === data.length);
    }
  } catch (err) {
    fail(new LinkerError("archive/corrupt", "הארכיון פגום ולא ניתן לפתוח אותו.", { cause: String(err) }));
  }
  if (failure) throw failure;
  return out;
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
