import { defineConfig } from "vite";

/*
 * The plugin package (issue 9, V7 §4.15): the headless core (src/headless/plugin-entry.ts) as ONE classic script for an Otzaria
 * plugin — IIFE, no `import`, no Preact, no worker, no WASM, no database reader. A separate build with its own output folder
 * (dist-plugin/): it never touches dist/OtzariaLinker.html or its 2 MiB budget (scripts/package-release.mjs), and
 * tests/unit/headless/plugin-bundle.test.ts builds it, loads it in a bare `vm` context and runs it against a simulated host.
 */
export default defineConfig({
  publicDir: false,
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
