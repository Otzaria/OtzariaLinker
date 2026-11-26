import { gunzipSync, strFromU8 } from "fflate";

/** The text of a `virtual:text-gz/…` import (build/plugins/text-gz.ts): base64 of gzip, back to the UTF-8 text. */
export function unpackText(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return strFromU8(gunzipSync(bytes));
}
