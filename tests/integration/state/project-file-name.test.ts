import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * #42 C28: the project file was "<book>.otzlinker.json" every time, so saving again gave "(1)", "(2)" — which one is
 * the newest? The name now carries the date and time it was saved.
 */
describe("the saved project's file name (C28)", () => {
  it("has the book's name and the date and time", async () => {
    const saved: string[] = [];
    const store = new AppStore(registryService(new SourceRegistry()), { save: (name) => void saved.push(name) }, loadPreferences(null));
    await store.openFiles([{ path: "ביאור_links.json", blob: new Blob([JSON.stringify([{ line_index_1: 2, heRef_2: "x", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "commentary" }])]) }]);
    store.saveProject();
    expect(saved[0]).toMatch(/^.+ \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.otzlinker\.json$/);
  });
});
