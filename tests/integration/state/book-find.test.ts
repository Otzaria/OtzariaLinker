import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

describe("AppStore.find — searching a reader's book through the worker job", () => {
  it("finds a word in בראשית, shows the reader that line, and steps to the next hit", async () => {
    const reg = new SourceRegistry();
    const service = registryService(reg);
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await store.openFiles([{ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) }]);
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    store.showBook("target", bereshit.key);

    await store.find.target.search(bereshit.key, "ויאמר אלהים");
    const lines = store.find.target.result.value!.hits.map((h) => h.line);
    expect(lines.length).toBeGreaterThan(3);
    expect(store.focus.target.value?.line).toBe(lines[0]);
    store.find.target.step(1);
    expect(store.focus.target.value?.line).toBe(lines[1]);
    expect(store.find.source.result.value).toBeNull(); // each reader has its own box
  });
});
