import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { SLICED_IMPORT_CHARS } from "../../../src/state/exchange";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { syntheticLinksFile, SYNTH_SOURCE } from "../../support/synthetic-links";

/*
 * #42 C5: importing a links file of 235,000 records blocked the page in one piece for 1.5–2.6 s. A big file is now imported in
 * slices that give the thread back between them, and still lands as ONE undoable action. Guarded by counting the turns of the
 * event loop that ran during the import (not by timing it): a single block would let none run.
 */
function makeStore() {
  const reg = new SourceRegistry();
  const service = {
    open: (f) => reg.open(f),
    lines: (k, a, b) => reg.lines(k, a, b),
    existingLinks: (k, a, b) => reg.existingLinks(k, a, b),
    headings: (k) => reg.headings(k),
  } as BooksService;
  return new AppStore(service, { save: () => {} }, loadPreferences(null));
}
const DB = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });

describe("a big links file is imported in slices (#42 C5)", () => {
  it("other tasks run while it is imported; the result is one action with every link, and the file is the book's library file", async () => {
    const store = makeStore();
    await store.openFiles([DB()]);
    const text = syntheticLinksFile(60_000);
    expect(text.length).toBeGreaterThan(SLICED_IMPORT_CHARS);
    let turns = 0;
    let running = true;
    const tick = () => {
      turns++;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const undoBefore = store.linkState.value.undo.length;
    const pending = store.exchange.importLinksFile(`${SYNTH_SOURCE}_links.json`, text);
    expect(pending).toBeInstanceOf(Promise);
    // nothing is committed before the end: the project never holds half a file
    expect(store.allLinks.value).toHaveLength(0);
    await pending;
    running = false;
    expect(turns).toBeGreaterThanOrEqual(3);
    expect(store.allLinks.value).toHaveLength(60_000);
    expect(store.linkState.value.undo.length).toBe(undoBefore + 1);
    expect(store.linkState.value.files.get(SYNTH_SOURCE)).toMatchObject({ records: 60_000, verified: true, layout: { indent: "" } });
    // the same file again is recognised as the same (the fingerprint of the sliced read is the whole file's)
    await store.exchange.importLinksFile(`${SYNTH_SOURCE}_links.json`, text);
    expect(store.allLinks.value).toHaveLength(60_000);
    expect(store.linkState.value.undo.length).toBe(undoBefore + 1);
  }, 120_000);

  it("through openFiles too: the links are there when it resolves", async () => {
    const store = makeStore();
    await store.openFiles([DB(), { path: `${SYNTH_SOURCE}_links.json`, blob: new Blob([syntheticLinksFile(20_000)]) }]);
    expect(store.allLinks.value).toHaveLength(20_000);
  }, 120_000);

  it("a small file is still imported at once (no promise)", async () => {
    const store = makeStore();
    await store.openFiles([DB()]);
    expect(store.exchange.importLinksFile(`${SYNTH_SOURCE}_links.json`, syntheticLinksFile(10))).toBeUndefined();
    expect(store.allLinks.value).toHaveLength(10);
  });
});
