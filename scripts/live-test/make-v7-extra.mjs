#!/usr/bin/env node
/*
 * Writes the v7 live-test extras (scripts/live-test/v7-extra.ts) to a NEW or empty folder:
 *
 *   node scripts/live-test/make-v7-extra.mjs <out-dir>
 *
 * Loaded through Vite's module runner, like make-bundle.mjs. UTF-8 without BOM (the CSV carries its own BOM).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
if (!process.argv[2]) {
  console.error("usage: node scripts/live-test/make-v7-extra.mjs <out-dir>");
  process.exit(2);
}
const out = resolve(process.argv[2]);
if (existsSync(out) && readdirSync(out).length) {
  console.error(`${out} is not empty. Choose an empty or new folder.`);
  process.exit(2);
}
const { module } = await runnerImport(join(root, "scripts", "live-test", "v7-extra.ts"), { configFile: false, root, logLevel: "error" });
const { files, manifest } = module.buildV7Extra();
for (const f of files) {
  const path = join(out, ...f.path.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, f.text, "utf8");
}
console.log(`${files.length} files → ${out}`);
console.log(JSON.stringify(manifest, null, 2));
