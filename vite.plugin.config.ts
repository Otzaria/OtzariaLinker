import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { licenseBanner } from "./build/plugins/license-notice.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/*
 * The plugin package (issue 9, V7 §4.15): the headless core (src/headless/plugin-entry.ts) as ONE classic script for an Otzaria
 * plugin — IIFE, no `import`, no Preact, no worker, no WASM, no database reader. A separate build with its own output folder
 * (dist-plugin/): it never touches dist/OtzariaLinker.html or its 2 MiB budget (scripts/package-release.mjs), and
 * tests/unit/headless/plugin-bundle.test.ts builds it, loads it in a bare `vm` context and runs it against a simulated host.
 */
export default defineConfig({
  publicDir: false,
  // the bundle carries the program's notice and the notices of the packages inside it (AGENTS.md §2.7)
  plugins: [licenseBanner({ version: pkg.version })],
  build: {
    target: "es2022",
    outDir: "dist-plugin",
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    reportCompressedSize: true,
    lib: {
      entry: "src/headless/plugin-entry.ts",
      formats: ["iife"],
      name: "OtzariaLinkerCore",
      fileName: () => "otzaria-linker-core.js",
    },
  },
});
