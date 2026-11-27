import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { licenseBanner } from "./build/plugins/license-notice.ts";
import { wasmBase64 } from "./build/plugins/wasm-base64.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/*
 * The folder-repository runner for Node (V7 §4.16, #46; docs/HEADLESS.md): src/cli/bin.ts as ONE ES module, dist-cli/linker.mjs,
 * with its dependencies inside (Preact signals for the store, fflate, the zstd decoder and its WASM as base64), so it runs with
 * `node dist-cli/linker.mjs` and nothing installed. A separate build: it never touches dist/OtzariaLinker.html or its 2 MiB budget.
 */
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: [{ find: /^zstd-wasm-decoder\/class$/, replacement: fileURLToPath(new URL("./node_modules/zstd-wasm-decoder/_esm/zstd-wasm.js", import.meta.url)) }],
  },
  // the bundle carries the program's notice and the notices of the packages inside it (AGENTS.md §2.7)
  plugins: [wasmBase64(), licenseBanner({ version: pkg.version })],
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: "src/cli/bin.ts",
    target: "node24",
    outDir: "dist-cli",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: { output: { format: "es", entryFileNames: "linker.mjs", inlineDynamicImports: true } },
  },
});
