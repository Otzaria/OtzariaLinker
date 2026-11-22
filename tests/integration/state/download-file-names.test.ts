import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * QA round 2, E: a title is the name of a download. Titles come from files and databases nobody vouches for, so
 * the names of the comparison report and of the saved project go through the same sanitiser as the exports.
 */
const BAD = /[/\:*?"<>|\u0000-\u001f]|\.\./;
const rec = { line_index_1: 1, heRef_2: "x", path_2: "בסיס.txt", line_index_2: 1, "Conection Type": "commentary" };

describe("download names from titles", () => {
  it("the link comparison report and the saved project never carry an unsafe title", async () => {
    const saved: string[] = [];
    const store = new AppStore(registryService(new SourceRegistry()), { save: (name) => saved.push(name) }, loadPreferences(null));
    await store.openFiles([{ path: "dir/ספר: א?.txt", blob: new Blob([strToU8("<h1>ספר</h1>\nשורה")]) }]);
    const book = [...store.books.value.values()][0]!;
    expect(book.title).toBe("ספר: א?");

    store.compare.addFiles([{ path: "a/ספר: א?_links.json", text: JSON.stringify([rec]) }, { path: "b/ספר: א?_links.json", text: JSON.stringify([rec, rec]) }]);
    expect(store.compare.compare("ספר: א?", "file:0", "file:1")).not.toBeNull();
    store.compare.saveReport();

    store.view.source.value = book.key;
    store.saveProject();

    expect(saved).toHaveLength(2);
    for (const name of saved) expect(name, name).not.toMatch(BAD);
    expect(saved[0]).toMatch(/\.csv$/);
    expect(saved[1]).toMatch(/\.otzlinker\.json$/);
  });
});
