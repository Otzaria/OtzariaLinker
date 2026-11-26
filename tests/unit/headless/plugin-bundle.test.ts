import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEngine } from "../../../src/linking/automatic";
import { otzariaSim } from "../../support/otzaria-sim";
import { asEngineBook, pairTexts } from "./fixture-books";

/*
 * The plugin package (V7 §4.15, docs/PLUGIN_READINESS.md §4): vite.plugin.config.ts builds src/headless/plugin-entry.ts into ONE
 * classic script. Built here into a temporary folder, then:
 *   • it has no `import`, no `require`, no network call and no browser global — Otzaria loads a headless plugin on Linux and
 *     Android as a plain script from file://, where modules are blocked;
 *   • it loads in a bare `vm` context (no window, no document) and defines only OtzariaLinkerCore;
 *   • through it, against the simulated Otzaria.call, the engines give exactly what runEngine gives on the same lines;
 *   • its size is measured and held under PLUGIN_BUDGET.
 */
const PLUGIN_BUDGET = 512 * 1024;
let dir = "";
let code = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "linker-plugin-"));
  await build({ configFile: "vite.plugin.config.ts", logLevel: "silent", build: { outDir: dir, emptyOutDir: true } });
  code = readFileSync(join(dir, "otzaria-linker-core.js"), "utf8");
}, 120_000);
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("the plugin package", () => {
  it(`is one classic script under ${PLUGIN_BUDGET / 1024} KiB, with no import, require, network or browser global`, () => {
    const bytes = Buffer.byteLength(code);
    console.info(`dist-plugin/otzaria-linker-core.js: ${bytes} bytes`);
    expect(bytes).toBeLessThan(PLUGIN_BUDGET);
    expect(code).not.toMatch(/(^|[;\s])import\s*[\s{*"']|\bimport\s*\(|\brequire\s*\(|^\s*export\s/m);
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/);
    expect(code).not.toMatch(/\bdocument\.|\blocalStorage\b|\bindexedDB\b|\bnavigator\./);
    expect(code).not.toMatch(/preact/i);
  });

  it("loads in a bare context and defines only OtzariaLinkerCore", () => {
    const ctx = vm.createContext({});
    const before = new Set(Object.keys(ctx));
    vm.runInContext(code, ctx);
    const added = Object.keys(ctx).filter((k) => !before.has(k));
    expect(added).toEqual(["OtzariaLinkerCore"]);
    const api = (ctx as { OtzariaLinkerCore: Record<string, unknown> }).OtzariaLinkerCore;
    expect(Object.keys(api).sort()).toEqual(["SDK_LIMITS", "createLinkerCore", "engines", "forOtzaria", "otzariaAdapters", "otzariaBookKey", "version"]);
  });

  it("runs the engines through the simulated Otzaria.call exactly as runEngine does, and saves to the private space", async () => {
    const { base, comm } = pairTexts(200);
    const sim = otzariaSim({ books: [{ bookId: "בסיס", lines: base }, { bookId: "פירוש על בסיס", lines: comm }] });
    // the SDK global, as the plugin page has it, and the standard globals every WebView has that the core uses
    const ctx = vm.createContext({ Otzaria: { call: sim.call }, setTimeout, performance, TextEncoder, AbortController });
    vm.runInContext(code, ctx);
    const api = (ctx as unknown as { OtzariaLinkerCore: typeof import("../../../src/headless/plugin-entry") }).OtzariaLinkerCore;
    const core = api.forOtzaria({ books: ["פירוש על בסיס", "בסיס"] });
    const run = await core.runPair("dibur-hamatchil", api.otzariaBookKey("פירוש על בסיס"), api.otzariaBookKey("בסיס"));
    const direct = runEngine("dibur-hamatchil", asEngineBook(run.source, comm), asEngineBook(run.target, base));
    expect(JSON.parse(JSON.stringify(run.result))).toEqual(JSON.parse(JSON.stringify(direct)));
    const names = await core.save(await core.exportFiles(core.approve(run)));
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.endsWith("_links.json"))).toBe(true);
    expect([...sim.files.keys()]).toEqual(names.map((n) => `linker/${n}`)); // into the plugin's own folder, nowhere else
  });

  it("the usage example (docs/examples/otzaria-plugin): main.js = bundle + plugin.js runs on a toolbar click and saves the links", async () => {
    const { base, comm } = pairTexts(120);
    const sim = otzariaSim({ books: [{ bookId: "בסיס", lines: base }, { bookId: "פירוש על בסיס", lines: comm }] });
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    const Otzaria = { call: sim.call, on: (event: string, cb: (e: unknown) => Promise<void>) => void handlers.set(event, cb) };
    const ctx = vm.createContext({ Otzaria, setTimeout, performance, TextEncoder, AbortController });
    vm.runInContext(`${code}\n${readFileSync("docs/examples/otzaria-plugin/plugin.js", "utf8")}`, ctx);
    expect([...handlers.keys()]).toEqual(["reader.toolbar_item_clicked"]);
    await handlers.get("reader.toolbar_item_clicked")!({ itemId: "link-to-base", currentBook: "פירוש על בסיס", currentBookId: "פירוש על בסיס" });
    expect(sim.messages).toEqual([{ kind: "success", message: expect.stringMatching(/^נשמרו \d+ קישורים/) }]);
    expect([...sim.files.keys()].every((p) => p.startsWith("linker/") && p.endsWith("_links.json"))).toBe(true);
    expect(sim.files.size).toBeGreaterThan(0);
    // a book that is not "X על Y" is refused in words, and nothing is read
    const before = sim.log.length;
    await handlers.get("reader.toolbar_item_clicked")!({ itemId: "link-to-base", currentBook: "בסיס", currentBookId: "בסיס" });
    expect(sim.messages.at(-1)).toMatchObject({ kind: "error" });
    expect(sim.log.slice(before).map((c) => c.method)).toEqual(["ui.showError"]);
  });
});
