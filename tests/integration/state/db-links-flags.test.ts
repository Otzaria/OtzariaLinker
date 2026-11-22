import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * The flags of a personal database's links in the links tab (V6 3.7): the summary counts them and the list can be narrowed to one
 * flag. The rows are placeholders on the real v52 DDL (tests/fixtures/db/pdc-personal-mini.db), as in external-links-flags.test.ts.
 */
const PERSONAL = { path: "personal.db", blob: new Blob([readFileSync("tests/fixtures/db/pdc-personal-mini.db")]) };
const OFFICIAL = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };

async function opened() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
  await store.openFiles([OFFICIAL, PERSONAL]);
  const book = [...store.books.value.values()].find((b) => b.key.endsWith(":9854"))!;
  store.showBook("source", book.key);
  store.dbLinks.side.value = "source";
  await store.dbLinks.loadSummary(book.key);
  return { store, book };
}

describe("database links — flags", () => {
  it("the summary counts the flags, and a flag in the filter narrows the list to the links that carry it", async () => {
    const { store } = await opened();
    const s = store.dbLinks.summary.value;
    expect(s && "total" in s && Object.fromEntries((s.flags ?? []).map((f) => [f.flag, f.count]))).toEqual({ "target-out-of-range": 1, "reverse-duplicate": 2 });
    await store.dbLinks.loadPage();
    const all = store.dbLinks.list.value!.total;
    store.dbLinks.setFilter({ flag: "reverse-duplicate" });
    await store.dbLinks.loadPage();
    const list = store.dbLinks.list.value!;
    expect(list.total).toBe(2);
    expect(list.total).toBeLessThan(all);
    expect(list.links.every((l) => l.dbFlags?.includes("reverse-duplicate"))).toBe(true);
    store.dbLinks.setFilter({ flag: undefined });
    await store.dbLinks.loadPage();
    expect(store.dbLinks.list.value!.total).toBe(all);
  });
});
