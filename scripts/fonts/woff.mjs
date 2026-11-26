// The book fonts as WOFF 1.0 (https://www.w3.org/TR/WOFF/): the sfnt's tables, each zlib-compressed, behind a 44-byte
// header and a 20-byte entry per table. A container, not a modification of the font: every table inflates back to the
// TTF's own bytes (tests/unit/build/woff-fonts.test.ts). Node's zlib only: no package, no network.
//
//   node scripts/fonts/woff.mjs        rewrites src/ui/theme/fonts/<name>.woff from each <name>.ttf there
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const pad4 = (n) => (n + 3) & ~3;

/** A TTF/OTF (sfnt) as WOFF 1.0. Deterministic: the same font gives the same bytes. */
export function ttfToWoff(ttf) {
  const src = Buffer.from(ttf);
  const n = src.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    const tag = src.toString("latin1", r, r + 4);
    const off = src.readUInt32BE(r + 8);
    const len = src.readUInt32BE(r + 12);
    const data = src.subarray(off, off + len);
    const z = deflateSync(data, { level: 9 });
    // a table that does not shrink is stored as it is (compLength == origLength), as the spec says
    tables.push({ tag, checksum: src.readUInt32BE(r + 4), orig: len, data: z.length < len ? z : data });
  }
  // the directory is in ascending tag order; the data follows in the same order, each block on a 4-byte boundary
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  let offset = 44 + 20 * n;
  for (const t of tables) {
    t.offset = offset;
    offset += pad4(t.data.length);
  }
  const out = Buffer.alloc(offset);
  out.write("wOFF", 0, "latin1");
  out.writeUInt32BE(src.readUInt32BE(0), 4); // flavor: the sfnt version
  out.writeUInt32BE(out.length, 8);
  out.writeUInt16BE(n, 12);
  out.writeUInt32BE(12 + 16 * n + tables.reduce((s, t) => s + pad4(t.orig), 0), 16); // totalSfntSize
  // version 0.0, no metadata and no private block: the rest of the header stays zero
  tables.forEach((t, i) => {
    const r = 44 + 20 * i;
    out.write(t.tag, r, "latin1");
    out.writeUInt32BE(t.offset, r + 4);
    out.writeUInt32BE(t.data.length, r + 8);
    out.writeUInt32BE(t.orig, r + 12);
    out.writeUInt32BE(t.checksum, r + 16);
    t.data.copy(out, t.offset);
  });
  return out;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../src/ui/theme/fonts");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ttf"))) {
    const ttf = readFileSync(join(dir, f));
    const woff = ttfToWoff(ttf);
    writeFileSync(join(dir, f.replace(/\.ttf$/, ".woff")), woff);
    console.log(`${f}: ${ttf.length} -> ${woff.length} bytes`);
  }
}
