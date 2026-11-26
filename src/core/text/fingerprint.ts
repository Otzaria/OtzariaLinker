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

/**
 * The lines an EDITION fingerprint reads (V7 §1.1): the first, the last, and evenly between them, EDITION_SAMPLES in all (every
 * line of a shorter book). Few on purpose: a project binds hundreds of books, and a database book is read lazily, line by line.
 */
export const EDITION_SAMPLES = 32;
export function editionSampleLines(count: number): number[] {
  if (count <= EDITION_SAMPLES) return Array.from({ length: Math.max(0, count) }, (_, i) => i);
  const out = new Set<number>();
  for (let i = 0; i < EDITION_SAMPLES; i++) out.add(Math.floor((i * (count - 1)) / (EDITION_SAMPLES - 1)));
  return [...out];
}

/**
 * A book's edition (V7 §1.1, docs/contracts/DATABASE_SUPPORT_MATRIX.md §9): its line count, and a fingerprint of the sampled
 * lines (editionSampleLines), each with its number. Equal text gives an equal edition from any source (a renamed or copied
 * file); another line count, or a change in a sampled line, gives another. A change between the samples that keeps the count
 * is not seen: the edition tells "the same book" from "another edition", it does not prove that no character changed.
 */
export function editionFingerprint(count: number, lines: readonly number[], texts: readonly (string | undefined)[]): string {
  return `${count}:${linesFingerprint(lines.map((n, i) => `${n}\t${texts[i] ?? "\u0000"}`)).split(":")[1]}`;
}
