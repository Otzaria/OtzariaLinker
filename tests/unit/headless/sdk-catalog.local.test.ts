import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLinkerCore } from "../../../src/headless/core";
import { otzariaAdapters, otzariaBookKey, SDK_LIMITS } from "../../../src/headless/otzaria-host";
import { otzariaSim } from "../../support/otzaria-sim";
import { pairTexts } from "./fixture-books";

/*
 * The SDK limits check against Otzaria's own catalog (local only: it reads a checkout of Otzaria/otzaria).
 *
 *   OTZARIA_SRC=Z:/DEV/otzaria npx vitest run tests/unit/headless/sdk-catalog.local.test.ts
 *
 * docs/plugin-sdk/spec.json is generated from the app's constants (tool/plugins/generate_plugin_spec.dart): every method the core
 * calls must be in it, need the permission the simulator grants for it, and the highest "since" version is the plugin's
 * minAppVersion (docs/examples/otzaria-plugin/manifest.json). The documented numeric limits are read from README.md.
 */
const src = process.env.OTZARIA_SRC;
const sdk = src ? join(src, "docs", "plugin-sdk") : "";

describe.skipIf(!src || !existsSync(join(sdk, "spec.json")))("the core against Otzaria's plugin SDK catalog", () => {
  const spec = () => JSON.parse(readFileSync(join(sdk, "spec.json"), "utf8")) as { apiMethods: string[]; methodPermissions: Record<string, string>; methodMinVersions: Record<string, string> };

  it("every method the core calls exists, with the permission the manifest asks for; the example's minAppVersion covers them", async () => {
    const { base, comm } = pairTexts(60);
    const sim = otzariaSim({ books: [{ bookId: "ב", lines: base }, { bookId: "פ על ב", lines: comm }] });
    const a = otzariaAdapters(sim.call, { books: ["פ על ב", "ב"] });
    const core = createLinkerCore(a);
    const run = await core.runPair("dibur-hamatchil", otzariaBookKey("פ על ב"), otzariaBookKey("ב"));
    await core.save(await core.exportFiles(core.approve(run)));
    await a.search!.find(otzariaBookKey("ב"), "פרק");
    const used = [...new Set(sim.log.map((c) => c.method))].sort();
    const s = spec();
    expect(used.filter((m) => !s.apiMethods.includes(m))).toEqual([]);
    const manifest = JSON.parse(readFileSync("docs/examples/otzaria-plugin/manifest.json", "utf8")) as { permissions: string[]; minAppVersion: string };
    const needed = used.map((m) => s.methodPermissions[m]).filter((p): p is string => !!p);
    expect(needed.filter((p) => !manifest.permissions.includes(p))).toEqual([]);
    const newer = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true });
    const newest = used.map((m) => s.methodMinVersions[m]!).sort(newer).at(-1)!;
    expect(newer(manifest.minAppVersion, newest)).toBeGreaterThanOrEqual(0);
  });

  it("the limits the adapter keeps are the documented ones", () => {
    const readme = readFileSync(join(sdk, "README.md"), "utf8");
    expect(readme).toMatch(/`library\.getBookContent`.*max 5000/);
    expect(readme).toMatch(/חלון עד 1000 שורות/);
    expect(readme).toMatch(/קיבולת הדלי: 50 אסימונים/);
    expect(readme).toMatch(/אסימון כל 10ms/);
    expect(readme).toMatch(/מכסה 100MB לתוסף, ותקרה של 10MB/);
    expect(SDK_LIMITS).toMatchObject({ contentChars: 5000, rawLinksWindow: 1000, bucket: 50, refillMs: 10, writeBytes: 10 * 1024 * 1024, quotaBytes: 100 * 1024 * 1024 });
  });
});
