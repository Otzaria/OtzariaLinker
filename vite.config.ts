import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";
import { buildInfo } from "./build/plugins/build-info.ts";
import { licenseNotice } from "./build/plugins/license-notice.ts";
import { wasmBase64 } from "./build/plugins/wasm-base64.ts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/*
 * The source is modular; the distribution is ONE self-contained HTML file (docs/adr/0002).
 * Two constraints verified on Chrome + Edge from file:// (2026-11-11):
 *   • module workers from blob: URLs fail under file:// — workers must be classic (format "iife");
 *   • WASM must be embedded (base64) — there is no server to fetch it from.
 */
export default defineConfig({
  base: "./",
  resolve: {
    alias: [
      // The bare ZstdDecoder class. The package's browser entry also inlines its own WASM and a
      // decoder pool we do not use; we embed the WASM once (wasm-b64) and compile it ourselves.
      { find: /^zstd-wasm-decoder\/class$/, replacement: fileURLToPath(new URL("./node_modules/zstd-wasm-decoder/_esm/zstd-wasm.js", import.meta.url)) },
    ],
  },
  define: buildInfo(pkg.version),
  plugins: [
    wasmBase64(),
    viteSingleFile({ removeViteModuleLoader: true }),
    licenseNotice({ version: pkg.version, packages: ["preact", "@preact/signals", "sql.js", "fflate", "zstd-wasm-decoder"] }),
  ],
  worker: { format: "iife", plugins: () => [wasmBase64()] },
  build: {
    target: "es2022",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: true,
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/contracts/**/*.test.ts"],
    environment: "node",
  },
});
