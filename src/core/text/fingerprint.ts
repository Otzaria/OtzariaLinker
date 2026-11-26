/*
 * A book's fingerprint for incremental linking (V5 P1-8, the batch job): two 32-bit FNV-1a hashes over
 * the lines' UTF-16 code units, each line ended by a separator, with the line count in front. Equal
 * text gives an equal fingerprint whatever source the book came from (the same folder picked again, a
 * copy of it); any changed character, added or removed line changes it. Not a security hash: it only
 * tells "the same text as last time" from "changed".
 */
export function linesFingerprint(lines: Iterable<string>): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  let n = 0;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
    }
    a = Math.imul(a ^ 10, 0x01000193);
    b = Math.imul(b ^ 10, 0x01000193) ^ (b >>> 15);
    n++;
  }
  return `${n}:${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * The same two FNV-1a lanes over raw bytes, with the length in front: a cheap identity of a part of a file (a text book's
 * first and last bytes, sources/registry.ts textIdentity). Not a security hash.
 */
export function bytesFingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return `${bytes.length}:${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}

/** One fingerprint of several parts (a book, its bases, the plan of its steps), in the given order. */
export const combineFingerprints = (parts: readonly string[]): string => linesFingerprint(parts);
