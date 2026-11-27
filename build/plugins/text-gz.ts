import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/**
 * `import packed from "virtual:text-gz/<path from the repository root>"` → the file's text, gzipped at level 9, as base64.
 * The page reads it back with `unpackText` (src/ui/help/packed-text.ts, fflate's gunzip — already in the bundle for ZIPs).
 *
 * Why: the in-file help is the user guide and the troubleshooting guide, ~150 KB of Markdown as a plain string. Hebrew text
 * compresses about 4:1, so the help costs ~50 KB of the single HTML file instead of ~150 KB (V7 #42 C6: the file stood within
 * 20 KB of its size budget, and the budget is not raised to make room). Deterministic: zlib's output for the same input and
 * level does not change, and the gzip header's time field is zero.
 */
export function textGz(): Plugin {
  const PREFIX = "virtual:text-gz/";
  return {
    name: "otzaria-linker:text-gz",
    resolveId(id) {
      return id.startsWith(PREFIX) ? "\0" + id : null;
    },
    load(id) {
      if (!id.startsWith("\0" + PREFIX)) return null;
      const file = join(process.cwd(), id.slice(PREFIX.length + 1));
      this.addWatchFile(file);
      const packed = gzipSync(readFileSync(file), { level: 9 });
      return `export default ${JSON.stringify(packed.toString("base64"))};`;
    },
  };
}
