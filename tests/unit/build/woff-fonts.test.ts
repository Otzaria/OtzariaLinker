import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs build script, no types
import { ttfToWoff } from "../../../scripts/fonts/woff.mjs";

/*
 * The two book fonts are shipped as WOFF (1.0: each sfnt table zlib-compressed), not TTF: the same glyphs, ~60 KB less in
 * the single HTML file (the size budget, scripts/package-release.mjs). WOFF is a container, not a modification: every
 * table inflates back to the TTF's bytes. The TTFs stay the source; scripts/fonts/woff.mjs makes the .woff from them.
 */
const FONTS = ["FrankRuehlCLM-Medium", "NotoRashiHebrew-VariableFont_wght"];
const dir = "src/ui/theme/fonts/";

function sfntTables(b: Buffer): Map<string, Buffer> {
  const n = b.readUInt16BE(4);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    out.set(b.toString("latin1", r, r + 4), b.subarray(b.readUInt32BE(r + 8), b.readUInt32BE(r + 8) + b.readUInt32BE(r + 12)));
  }
  return out;
}

function woffTables(w: Buffer): Map<string, Buffer> {
  const n = w.readUInt16BE(12);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < n; i++) {
    const r = 44 + 20 * i;
    const [off, comp, orig] = [w.readUInt32BE(r + 4), w.readUInt32BE(r + 8), w.readUInt32BE(r + 12)];
    const data = w.subarray(off, off + comp);
    out.set(w.toString("latin1", r, r + 4), comp < orig ? inflateSync(data) : data);
  }
  return out;
}

describe("the book fonts as WOFF (size budget)", () => {
  for (const name of FONTS) {
    it(`${name}: a valid WOFF whose tables are the TTF's, byte for byte, and the committed file is up to date`, () => {
      const ttf = readFileSync(`${dir}${name}.ttf`);
      const woff: Buffer = Buffer.from(ttfToWoff(ttf));
      expect(woff.toString("latin1", 0, 4)).toBe("wOFF");
      expect(woff.readUInt32BE(4)).toBe(ttf.readUInt32BE(0)); // flavor
      expect(woff.readUInt32BE(8)).toBe(woff.length); // length
      expect(woff.length % 4).toBe(0);
      const tables = sfntTables(ttf);
      expect(woff.readUInt16BE(12)).toBe(tables.size);
      const padded = [...tables.values()].reduce((s, t) => s + ((t.length + 3) & ~3), 0);
      expect(woff.readUInt32BE(16)).toBe(12 + 16 * tables.size + padded); // totalSfntSize
      const back = woffTables(woff);
      expect([...back.keys()]).toEqual([...tables.keys()].sort());
      for (const [tag, bytes] of tables) expect(Buffer.compare(back.get(tag)!, bytes), tag).toBe(0);
      expect(woff.length).toBeLessThan(ttf.length * 0.7);
      expect(Buffer.compare(readFileSync(`${dir}${name}.woff`), woff), "run: node scripts/fonts/woff.mjs").toBe(0);
    });
  }

  it("the stylesheet loads the WOFF files, and no TTF", () => {
    const css = readFileSync("src/ui/theme/app.css", "utf8");
    for (const name of FONTS) expect(css).toContain(`url("./fonts/${name}.woff") format("woff")`);
    expect(css).not.toMatch(/\.ttf"\)/);
  });
});
