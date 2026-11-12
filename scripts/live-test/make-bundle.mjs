#!/usr/bin/env node
/*
 * Writes the stage-20 test bundle (docs/LIVE_TESTING.md) to a folder:
 *
 *   node scripts/live-test/make-bundle.mjs [out-dir]
 *
 * Default out-dir: live-test-bundle/ at the repository root (git-ignored). Not under dist/: every
 * `npm run build` empties dist/, and Otzaria would lose the books of a folder registered there.
 *
 * The bundle itself is built by scripts/live-test/bundle.ts with the tool's own code (TypeScript),
 * loaded here through Vite's module runner — no build step and no extra dependency. The output is
 * deterministic: running it twice gives identical bytes. An existing out-dir is replaced only when it
 * holds a previous bundle (its manifest.json), so a wrong path cannot wipe an unrelated folder.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(process.argv[2] ?? join(root, "live-test-bundle"));

if (existsSync(out)) {
  const manifest = join(out, "manifest.json");
  let ours = false;
  try {
    ours = JSON.parse(readFileSync(manifest, "utf8")).format === "otzaria-linker-live-test";
  } catch {
    ours = false;
  }
  if (!ours) {
    console.error(`${out} exists and is not a previous live-test bundle (no manifest.json). Choose an empty or new folder.`);
    process.exit(2);
  }
  rmSync(out, { recursive: true });
}

const { module } = await runnerImport(join(root, "scripts", "live-test", "bundle.ts"), { configFile: false, root, logLevel: "error" });
const bundle = module.buildLiveTestBundle();
for (const f of bundle.files) {
  const path = join(out, ...f.path.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, f.text, "utf8"); // UTF-8 without BOM, LF only
}

const held = bundle.plans.main.heldBack.length + bundle.plans.update.heldBack.length + bundle.plans.negative.heldBack.length;
console.log(`${bundle.files.length} files → ${out}`);
console.log(`  ${module.BOOKS_DIR}/  ${bundle.plans.main.files.length} links files, ${bundle.plans.main.written.length} links (add this folder in Otzaria)`);
console.log(`  update/   the base book's new edition and ${Object.keys(bundle.relinked).length} moved links (check 15)`);
console.log(`  negative/ a file the app must reject whole (check N1)`);
if (held) {
  console.error(`${held} links were held back by the tool's validation — the bundle is incomplete.`);
  process.exit(1);
}
