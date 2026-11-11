/**
 * What kind of file is this? Decided by CONTENT (signature, structure), with the extension only as
 * a tie-breaker — users rename files, and a `.db` may be a ZIP or a `.txt` may be JSON.
 */
export type DetectedKind =
  | "sqlite"
  | "zip"
  | "zstd-dict" // a trained zstd dictionary (e.g. the library's), for databases that lack theirs
  | "links-json" // an array of Otzaria link records
  | "alt-toc-json" // alt_toc/<book>_alt_toc.json: alternative TOC structures
  | "project" // a saved OtzariaLinker project
  | "json" // other JSON — needs a mapping
  | "csv"
  | "tsv"
  | "text"
  | "binary";

const SQLITE_MAGIC = "SQLite format 3\u0000";
// A PDF usually has no NUL byte in its first KiB (an ASCII header, then a comment of high bytes), so
// the NUL test below took it for text, and it was refused as "a text file that is not .txt".
const PDF_MAGIC = "%PDF-";

/** `head` = the first few KiB of the file (4 KiB is enough). */
export function detectKind(head: Uint8Array, fileName = ""): DetectedKind {
  if (startsWithAscii(head, SQLITE_MAGIC)) return "sqlite";
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) return "zip";
  if (head[0] === 0x37 && head[1] === 0xa4 && head[2] === 0x30 && head[3] === 0xec) return "zstd-dict";
  if (startsWithAscii(head, PDF_MAGIC)) return "binary";
  if (looksBinary(head)) return "binary";

  const text = new TextDecoder("utf-8").decode(head).replace(/^﻿/, "").trimStart();
  if (text.startsWith("{") && /"format"\s*:\s*"otzaria-linker-project"/.test(text)) return "project";
  if (text.startsWith("[") && /"line_index_1"|"path_2"|"Conection Type"/.test(text)) return "links-json";
  if (text.startsWith("[") && (/_alt_toc\.json$/i.test(fileName) || (/"key"\s*:/.test(text) && /"nodes"\s*:/.test(text)))) return "alt-toc-json";
  if (text.startsWith("{") || text.startsWith("[")) return "json";

  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (ext === "tsv" || (ext !== "txt" && firstLine.split("\t").length >= 3)) return "tsv";
  if (ext === "csv") return "csv";
  return "text";
}

function startsWithAscii(b: Uint8Array, s: string): boolean {
  if (b.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
}

/** NUL bytes in the first KiB mean binary — unless it is UTF-16 text (NULs on alternating bytes). */
function looksBinary(b: Uint8Array): boolean {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return false;
  const n = Math.min(b.length, 1024);
  let nul = 0;
  let oddNul = 0;
  for (let i = 0; i < n; i++) {
    if (b[i] !== 0) continue;
    nul++;
    if (i % 2 === 1) oddNul++;
  }
  if (nul === 0) return false;
  return !(oddNul / nul > 0.95 && nul > n / 4);
}
