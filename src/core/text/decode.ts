/**
 * Bytes of a book/text file → string. Books in the wild come as UTF-8 (with or without BOM),
 * UTF-16 (Windows "Unicode") and legacy windows-1255 (older Hebrew editors and DOS-era exports).
 */
export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "windows-1255";

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
  hadBom: boolean;
}

export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8", hadBom: true };
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le", hadBom: true };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be", hadBom: true };
  if (looksLikeBomlessUtf16le(bytes))
    return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le", hadBom: false };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", hadBom: false };
  } catch {
    // Not valid UTF-8. windows-1255 maps every byte, so it never throws; the caller can still
    // judge the result (e.g. by the share of Hebrew letters) and ask the user.
    return { text: new TextDecoder("windows-1255").decode(bytes), encoding: "windows-1255", hadBom: false };
  }
}

/** Hebrew/ASCII UTF-16LE without BOM: almost every odd byte is 0x00 (ASCII) or 0x05 (Hebrew block). */
function looksLikeBomlessUtf16le(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 16) return false;
  let hits = 0;
  for (let i = 1; i < n; i += 2) if (bytes[i] === 0x00 || bytes[i] === 0x05) hits++;
  return hits / (n / 2) > 0.9;
}
