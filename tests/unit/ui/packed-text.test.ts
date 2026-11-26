import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unpackText } from "../../../src/ui/help/packed-text";

/* #42 C6: the help's Markdown is packed at build time (build/plugins/text-gz.ts) and read back in the page — byte for byte. */
describe("packed help text", () => {
  it("the user guide comes back exactly, Hebrew and all", () => {
    const text = readFileSync("docs/USER_GUIDE.md", "utf8");
    expect(unpackText(gzipSync(Buffer.from(text, "utf8"), { level: 9 }).toString("base64"))).toBe(text);
  });
});
