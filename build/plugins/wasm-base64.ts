import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Plugin } from "vite";

/**
 * `import b64 from "virtual:wasm-b64/<package path>.b64"` → the file's bytes as a base64 string.
 *
 * Why not Vite's own `?inline`: on Windows, Vite 8 fails to resolve `*.wasm?inline`
 * (os error 123, verified 2026-11-11), and `?init` emits a separate file, which breaks the
 * single-HTML distribution. The id ends in `.b64` so Vite's built-in wasm plugin does not claim it.
 */
export function wasmBase64(): Plugin {
  const PREFIX = "virtual:wasm-b64/";
  const require = createRequire(import.meta.url);
  return {
    name: "otzaria-linker:wasm-base64",
    resolveId(id) {
      return id.startsWith(PREFIX) ? "\0" + id : null;
    },
    load(id) {
      if (!id.startsWith("\0" + PREFIX)) return null;
      const spec = id.slice(PREFIX.length + 1).replace(/\.b64$/, "");
      // A file outside a package's "exports" map cannot be require.resolve()d; read it from node_modules.
      const direct = join(process.cwd(), "node_modules", spec);
      const file = existsSync(direct) ? direct : require.resolve(spec);
      return `export default ${JSON.stringify(readFileSync(file).toString("base64"))};`;
    },
  };
}
